# 截图流 & AI 理解流改造 PRD (精简版)

> CallingClaw 2.0 | 2026-03-18 | Status: **Approved — 3 Reviews Cleared**
> Eng Review: CLEAR | CEO Review: CLEAR (HOLD SCOPE) | Design Review: CLEAR (6/10, deferred)

---

## 1. 背景 & 目标

Python sidecar 同时跑 CoreAudio (PyAudio) 和 CoreGraphics (mss) → 线程冲突 → segfault。

**目标**: Python sidecar 只做音频，截图完全在 Bun 侧完成。

---

## 2. 精简架构

```
voice.started / meeting.started
  │
  ▼
VisionModule (改造后，仍是调度中心)
  │
  ├── 1s 定时 ──→ BrowserCaptureProvider (CDP WebSocket 直连)
  │                 │
  │                 ├── Page.captureScreenshot → JPEG base64 (~30ms)
  │                 └── Runtime.evaluate → URL + title
  │                 │
  │                 ▼
  │              变化检测 (isSimilarDescription 复用 + URL/title diff)
  │                 │ changed only
  │                 ▼
  │              Gemini Flash 分析 (复用现有 analyzeMeetingScreen)
  │                 │ 节流: _analyzing 锁 + 3s 最小间隔
  │                 ▼
  │              SharedContext.updateScreen(screenshot, description)
  │                 │
  │                 ├──→ EventBus "screen.updated"
  │                 ├──→ pushContextUpdate → Voice session.update
  │                 └──→ Transcript [Screen] entry
  │
  └── CU 按需 ──→ DesktopCaptureProvider (screencapture CLI)
                    │
                    ├── screencapture -x -t jpg /tmp/cc_{id}.jpg
                    ├── sips resize 1280×800
                    ├── 灰图检测 (权限丢失)
                    └── → Claude API (不过 Gemini)

voice.stopped / meeting.ended
  │
  ▼
VisionModule.stopScreenCapture()
```

### 设计原则

1. **复用现有模块** — VisionModule 保留 Gemini 分析 + 相似度去重，只换截图源
2. **CDP 直连不走 CLI** — 1s 截图 ~30ms，不和 Playwright CLI (join/evaluate) 竞争
3. **CU 走 screencapture** — 全屏桌面截图 + sips resize，不过 Gemini（Claude 直接看图）
4. **统一触发** — voice.started 启动截图（会议和 Talk Locally 共用），voice.stopped 停止

---

## 3. 新建文件 (3 个)

### 3.1 `src/types/screen.ts`

```typescript
export type CaptureSource = "browser" | "desktop";

export interface CaptureProvider {
  readonly source: CaptureSource;
  capture(options?: Record<string, unknown>): Promise<CaptureResult | null>;
  isAvailable(): Promise<boolean>;
}

export interface CaptureResult {
  image: string;        // base64 JPEG
  width: number;
  height: number;
  metadata: {
    url?: string;
    title?: string;
    displayIndex?: number;
  };
}
```

### 3.2 `src/capture/browser-capture-provider.ts`

**底层**: CDP WebSocket 直连 Chrome DevTools Protocol

```typescript
export class BrowserCaptureProvider implements CaptureProvider {
  readonly source = "browser" as const;
  private ws: WebSocket | null = null;
  private _msgId = 0;
  private _pending = new Map<number, { resolve, reject, timer }>();

  constructor(private cdpUrl: string);

  async connect(): Promise<void>;       // WebSocket → cdpUrl
  async capture(): Promise<CaptureResult | null> {
    // 并发调用:
    //   Page.captureScreenshot { format: "jpeg", quality: 80 }
    //   Runtime.evaluate { expression: "[location.href, document.title]" }
    // 合并结果 → CaptureResult
  }
  async isAvailable(): Promise<boolean>;  // ws.readyState === OPEN
  private reconnect(): void;              // 断连后 3s 重试
}
```

**CDP URL 获取**: Playwright CLI 启动 Chrome 时 `--remote-debugging-port=0`，
从 `http://localhost:{port}/json/version` 获取 `webSocketDebuggerUrl`。

### 3.3 `src/capture/desktop-capture-provider.ts`

**底层**: macOS `screencapture` CLI + `sips` resize

```typescript
export class DesktopCaptureProvider implements CaptureProvider {
  readonly source = "desktop" as const;

  async capture(options?: {
    targetWidth?: number;   // 默认 1280
    targetHeight?: number;  // 默认 800
  }): Promise<CaptureResult | null> {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const path = `/tmp/callingclaw_cap_${id}.jpg`;
    try {
      // 1. screencapture -x -t jpg {path}
      // 2. 灰图检测: sample pixels → std deviation < 5 → permission error
      // 3. sips --resampleWidth 1280 --resampleHeight 800 {path}
      // 4. Bun.file(path) → base64
      // 5. return CaptureResult
    } finally {
      // cleanup: rm {path}
    }
  }

  async isAvailable(): Promise<boolean>;  // 检查 screencapture 是否可用
}
```

---

## 4. 改造文件 (~8 个)

### 4.1 VisionModule — 换截图源，保留分析逻辑

**文件**: `src/modules/vision.ts`

- 删除: `bridge.on("screenshot")` 监听
- 新增: `BrowserCaptureProvider` 实例 + 1s 定时截图
- 保留: `analyzeMeetingScreen()` / `isSimilarDescription()` / Gemini 调用
- 新增: `startScreenCapture(mode: "meeting" | "talk_locally")`
- 新增: `stopScreenCapture()`
- 新增: URL/title 变化检测 (在 isSimilar 之前)
- 新增: Gemini 节流 (3s 最小间隔)

### 4.2 ComputerUseModule — screencapture 替代 Python bridge

**文件**: `src/modules/computer-use.ts`

- `requestScreenshot()`: 从 `bridge.sendAction("screenshot")` → `desktopCapture.capture({ targetWidth: 1280, targetHeight: 800 })`
- 删除: `compressScreenshot()` (provider 已 resize)
- CU 截图不过 Gemini，Claude CU reasoning 通过 EventBus 推送给 Voice/sidebar

### 4.3 SharedContext — ScreenState 扩展 metadata

**文件**: `src/modules/shared-context.ts`

```typescript
interface ScreenState {
  latestScreenshot: string | null;  // base64 JPEG (was PNG)
  capturedAt: number;
  description?: string;
  url?: string;      // 新增
  title?: string;    // 新增
}
```

### 4.4 callingclaw.ts — 生命周期绑定

- `voice.started` → `vision.startScreenCapture("talk_locally")`
- `meeting.started` → `vision.startScreenCapture("meeting")` (替代直接调 startMeetingVision)
- `voice.stopped` / `meeting.ended` → `vision.stopScreenCapture()`
- `screen` event → 重建 voice instructions → `pushContextUpdate`
- `take_screenshot` tool → 改为 `check_screen` tool (返回文本)

### 4.5 Python sidecar — 删除截屏

**文件**: `python_sidecar/main.py`

删除: `take_screenshot()`, `screen_capture_loop()`, `_get_monitor_for_app()`,
`_get_monitor_for_mouse()`, `_resolve_capture_monitor()`, `simple_hash()`,
`mss` import, `threading` import, 截屏相关全局变量, debug logging (_cap_count 等)

保留: `AudioBridge`, `execute_action()` (screenshot action → return error msg)

### 4.6 bridge.ts — 移除截图消息

- 删除 `type: "screenshot"` 消息处理
- 保留 `sendAction` 其他 action 类型

### 4.7 config_server.ts — 新增端点

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/screen/context` | 当前屏幕 description + url + title |
| POST | `/api/screen/capture` | 触发一次截图 `{ source: "browser" | "desktop" }` |

### 4.8 voice-routes.ts / config_server.ts — 恢复 audio_mode 默认值

恢复 `audio_mode` 默认值为 `"meet_bridge"` (上一轮调试改成了 "default")。

---

## 5. 数据流 (按场景)

### 会议 / Talk Locally (统一)

```
每 1s:
  BrowserCapture (CDP) → JPEG + URL + title
    → URL/title 变了? → changed
    → isSimilarDescription(hash) → changed?
    → 3s 节流 + _analyzing 锁
    → Gemini Flash → description
    → SharedContext.updateScreen()
    → EventBus "screen.updated"
    → pushContextUpdate → Voice session.update
```

### Computer Use

```
CU click(500,300) → pyautogui
  → DesktopCapture: screencapture + sips 1280×800
    → 灰图检测 → ok
    → base64 JPEG → Claude API (直接，不过 Gemini)
  → Claude reasoning → EventBus "computer.task_step"
  → Voice/sidebar 看到 CU 步骤摘要
```

### Voice "看看屏幕"

```
User: "现在屏幕上是什么"
  → check_screen tool
  → SharedContext.screen.description (最近的 Gemini 分析结果)
  → Voice 文本回答
```

---

## 6. 实施顺序

| Phase | 内容 | 新文件 | 改文件 |
|-------|------|--------|--------|
| **1** | Capture Providers | types/screen.ts, browser-capture-provider.ts, desktop-capture-provider.ts | — |
| **2** | VisionModule 换源 | — | vision.ts, shared-context.ts |
| **3** | CU + 生命周期 | — | computer-use.ts, callingclaw.ts |
| **4** | Python 清理 | — | main.py, bridge.ts |
| **5** | API + 恢复 | — | config_server.ts, voice-routes.ts |
| **6** | Unit Tests | test/capture/*.test.ts | — |

---

## 7. 测试

```
test/capture/browser-capture-provider.test.ts
  └─ CDP connect, capture, reconnect, error handling

test/capture/desktop-capture-provider.test.ts
  └─ screencapture cmd, sips resize, gray image detection, cleanup

test/modules/vision-change-detect.test.ts
  └─ URL change, title change, hash threshold, Gemini throttle
```

---

## 8. 风险 & 兜底

| 风险 | 兜底 |
|------|------|
| CDP 断连 | 3s auto-reconnect + screencapture fallback |
| screencapture 权限丢失 | 灰图检测 → EventBus 警告 |
| Gemini 超时 | 保持上次 state，_analyzing 锁 |
| 并发 screencapture | 唯一文件名 (id = timestamp + random) |

---

## 9. 不做的事

- CaptureManager / SnapshotStore / ChangeDetector / ScreenContextStore (独立类) — 复用 VisionModule
- Electron desktopCapturer — 太慢
- node-screenshots (napi-rs) — 本期不引入
- ScreenCaptureKit native addon — 工程投入过大
- Voice 直接看图 — 只消费文本上下文
- Structured metrics — EventBus + console.log 够用
