# CallingClaw Roadmap

## Completed in v2.5 (2026-03-21)

- Grok (xAI) voice integration — switchable provider with capability matrix
- AudioWorklet capture + ring buffer playback (replaced ScriptProcessor)
- 5-layer context engineering model with token budget management
- Audio state machine: idle → listening → thinking → speaking → interrupted
- Heard transcript truncation on user interrupt
- Fast/slow tool dispatch (fast inline <1s, slow async with filler)
- VoiceTracer: 9 per-turn timing metrics
- Provider/voice selector in Electron status bar
- Mic device selector (auto-skip virtual devices)
- 11 context lifecycle fixes (SharedContext.off(), cross-session leak prevention)
- Multimodal meeting timeline (KeyFrameStore + OC-010 protocol)
- meeting.summary_ready WebSocket event for desktop notification
- Haiku-based title/time extraction (replaced OpenClaw sendTask)
- Scheduler dedup (prevent flooding repeated join messages)

## Completed in v2.6-v2.7 (2026-03-21/23)

- Python sidecar eliminated — NativeBridge (osascript + cliclick) replaces 552 lines of Python
- Voice persona depth-matching — insightful advisor style, not rigid sentence caps
- Granular memory search — bullet-point splitting, match-centered excerpts
- Meeting delegation to OpenClaw — isolated sessions prevent context pollution
- Meeting summary/extraction via OpenClaw — no longer direct OpenAI
- Past mistakes/lessons surfaced in meeting prep and summary
- Grok API Key UI in Desktop Settings
- New desktop icon with macOS-style rounded corners
- Audio entitlements for macOS mic permission dialog
- Daemon directory fallback for DMG installs
- Multiple onboarding, settings, and calendar fixes
- Reuse existing session on repeated join of same Meet URL

## Completed in v2.8.2 (2026-04-01)

- **Gemini 3.1 Flash Live** — one of the first production applications of Google's real-time voice API
- GeminiProtocolAdapter: envelope protocol transform, 24kHz→16kHz resampling, instruction compaction
- 3-provider voice switching (Gemini/Grok/OpenAI) in Desktop UI + voice-test.html
- Session resumption for Gemini's 15-min session limit
- Async tool dispatch for Gemini (recall_context, save_meeting_notes)
- Gemini eval framework (14 dimensions) + connectivity test scripts
- Default voice provider changed from Grok → Gemini (10x cheaper than OpenAI)

---

## v3.0 — Post-Sidecar Improvements

> **Status: Python sidecar fully eliminated in v2.6.1.** NativeBridge (osascript + cliclick) replaced all Python functionality. Remaining items below are further improvements.

### Goal
~~Fully eliminate Python sidecar.~~ **DONE (v2.6.1).** NativeBridge replaced all Python sidecar functionality. Remaining focus: Playwright migration for meet_joiner, further reliability improvements.

### 推荐方案：A — 保留 Bun + 消灭 Python
Bun 继续做 AI 编排/API，硬件 I/O 移到 Electron。
- Bun 代码几乎不改（50+ 处 API 调用保留）
- 只改 Python 相关的桥接代码
- 改动量最小，风险最低

### 备选方案：B — 全部合并到 Electron/Node
所有逻辑迁入 Electron main process（Node.js）。
- 改动量大（Bun→Node 机械转换 50+ 处）
- 最简单的架构（1 个进程）
- 失去 Bun 的性能和语法优势

### 决策前置条件
- [ ] **音频 spike 测试**：在 Electron 用 Web Audio 捕获 BlackHole 2ch，测延迟和质量
  - 延迟 < 50ms → 方案 A 可行，完全消灭 Python
  - 延迟 > 50ms → 混合方案（保留 Python 仅做音频，200 行）

### Python sidecar 三个功能的替代评估

| 功能 | 当前 | 替代 | 风险 |
|------|------|------|------|
| 截图 | Python mss | Electron desktopCapturer | **零风险**，立刻可替代 |
| 鼠标键盘 | Python pyautogui | robotjs（但几乎不用了，L2/L4 已替代） | **低风险** |
| 音频 I/O | Python pyaudio + BlackHole | node-portaudio 或 Web Audio | **中风险，需 spike** |

### 当前架构 (v2.x)
```
Electron shell → spawn Bun (:4000) → spawn Python sidecar (:4001)
  ↑ 两层 WebSocket 桥接，任一断开全链路瘫痪
```

### 目标架构 (v3.0)
```
Electron main process
  ├─ Express HTTP server (:4000) ← 替代 Bun.serve()
  ├─ OpenAI Realtime WebSocket ← ws 包
  ├─ desktopCapturer ← 替代 Python mss
  ├─ robotjs ← 替代 Python pyautogui
  ├─ node-portaudio / Web Audio ← 替代 Python pyaudio + BlackHole
  └─ Playwright CLI ← 不变
```

### 迁移范围

| 类别 | 当前 | 目标 | 改动量 |
|------|------|------|--------|
| HTTP 服务器 | `Bun.serve()` | Express + ws | 1 文件 |
| Shell 命令 | `Bun.$` (50+ 处) | `child_process.execFile` | 10 文件 |
| 文件操作 | `Bun.file/write` (20+ 处) | `fs.promises` | 10 文件 |
| WebSocket 客户端 | Bun native WebSocket | `ws` 包 | 2 文件 |
| 进程启动 | `Bun.spawn` | `child_process.spawn` | 3 文件 |
| 截图 | Python mss | Electron `desktopCapturer` | 2 文件 |
| 鼠标键盘 | Python pyautogui | `robotjs` | 3 文件 |
| 音频 I/O | Python pyaudio + BlackHole | `node-portaudio` 或 Web Audio | 3 文件 |
| 测试 | `bun:test` | `vitest` | 5 文件 |
| .env 加载 | Bun 自动 | `dotenv` | 1 文件 |

### 分阶段执行

#### Phase 1: Bun → Node 机械转换 (3-4 天, 低风险)
- [ ] 替换所有 `Bun.$` → `execFile()` (50+ 处)
- [ ] 替换所有 `Bun.file/write` → `fs.promises` (20+ 处)
- [ ] 替换 `Bun.serve()` → Express + ws
- [ ] 替换 `Bun.spawn` → `child_process.spawn`
- [ ] 替换 WebSocket import → `ws` 包
- [ ] 迁移测试 `bun:test` → `vitest`
- [ ] 添加 `dotenv` 加载 .env

#### Phase 2: 硬件桥接 (5-7 天, 中风险)
- [ ] Electron `desktopCapturer` 替代 Python mss 截图
- [ ] `robotjs` 替代 Python pyautogui 鼠标键盘
- [ ] 创建 `electron-bridge.ts` IPC handler
- [ ] 截图延迟基准测试

#### Phase 3: 模块集成 (4-5 天, 中风险)
- [ ] 更新 computer-use.ts 使用新截图/操作 API
- [ ] 更新 vision.ts 使用 IPC 截图
- [ ] 更新 config-server.ts 硬件操作
- [ ] 图像处理 `sips` → `sharp` 包
- [ ] 测试 4 层自动化

#### Phase 4: 音频管道 (6-8 天, 高风险)
- [ ] 评估方案: node-portaudio vs Web Audio vs 混合
- [ ] 实现音频捕获 (BlackHole 2ch → OpenAI)
- [ ] 实现音频播放 (OpenAI → BlackHole 16ch)
- [ ] 延迟基准测试 vs PyAudio 基线
- [ ] 30 分钟长会议压力测试

#### Phase 5: Electron 集成 (3-4 天, 中风险)
- [ ] 主进程 IPC 接线
- [ ] 移除 Python sidecar 启动器
- [ ] 单进程启动/关闭生命周期
- [ ] 权限提示测试

#### Phase 6: 测试 & 加固 (4-5 天, 低风险)
- [ ] 完整会议生命周期测试
- [ ] 音频延迟 & 质量对比
- [ ] 内存使用分析
- [ ] 错误恢复测试

### 新增依赖
```json
{
  "express": "^4.18",
  "ws": "^8.14",
  "robotjs": "^0.6",
  "sharp": "^0.33",
  "node-portaudio": "^1.1",
  "dotenv": "^16.3",
  "vitest": "^1.0"
}
```

### 风险 & 回退
- **音频延迟不可接受** → 保留 Python sidecar 仅用于音频（混合模式）
- **robotjs 不稳定** → 回退到 AppleScript + osascript
- **desktopCapturer 权限问题** → 保留 screencapture CLI

### 预估工期
- 全职: 4-6 周
- 单人: 6-8 周

---

## v3.0+ Outlook

- [x] ~~Eliminate Python sidecar entirely~~ — **DONE (v2.6.1)** NativeBridge replaced all Python
- [ ] Migrate from file:// to app:// custom protocol in Electron (AudioWorklet, CSP)
- [ ] Haiku context compression for meeting instructions (~300 token target)
- [ ] Generalize tabbed side panel for multi-doc contexts (when second use case appears)
- [ ] Onboarding wizard — connect to `/api/onboarding/ready`
- [ ] Overlay window — floating meeting controls
- [ ] End-to-end integration test (full meeting lifecycle)

## v2.x — Previous Releases

### v2.7.3 (current)
- Python sidecar eliminated, NativeBridge, voice persona depth-matching
- Meeting delegation to OpenClaw, Grok API Key UI, new desktop icon
- Daemon directory fallback, audio entitlements, onboarding/settings fixes

### v2.5.3
- Grok voice + AudioWorklet + 5-layer context + provider matrix
- Audio state machine + heard transcript + fast/slow dispatch
- VoiceTracer + multimodal timeline + 11 lifecycle fixes

### v2.4.16
- Talk Locally audio race fix
- Settings crash fix
- Haiku title/time extraction
- Scheduler dedup

### v2.2.4
- Desktop Meeting Hub
- Talk Locally full meeting stack
- OpenClaw `/callingclaw prepare` command
- Sidecar stability fixes
