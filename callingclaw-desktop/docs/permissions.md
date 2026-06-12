# CallingClaw 权限清单

CallingClaw 需要以下 macOS 权限才能正常运行。所有权限在 Onboarding 引导流程中检查。

---

## 一、macOS TCC 权限（系统弹窗授权）

### 1. 麦克风 — `com.apple.security.device.audio-input`

| 项目 | 说明 |
|------|------|
| **用途** | Direct 模式下 `getUserMedia()` 采集真实麦克风输入 |
| **Meet 模式需要吗** | 不需要 — Meet 音频通过 Playwright `addInitScript` 在浏览器级别注入，不经过 Electron |
| **可否自动弹窗** | 可以 — `systemPreferences.askForMediaAccess('microphone')` |
| **拒绝后果** | Direct 模式语音对话无法使用（Meet 模式不受影响） |
| **设置路径** | 系统设置 → 隐私与安全性 → 麦克风 |
| **Info.plist** | `NSMicrophoneUsageDescription`: "CallingClaw needs microphone access for AI voice meetings" |

### 2. 屏幕录制 — `com.apple.security.device.screen-capture`

| 项目 | 说明 |
|------|------|
| **用途** | `screencapture` CLI 截屏 → Gemini Flash 视觉分析 → 会议上下文 |
| **可否自动弹窗** | 不能 — 必须用户手动在系统设置中开启 |
| **拒绝后果** | 截屏静默失败，AI 无法看到屏幕内容，视觉上下文缺失 |
| **设置路径** | 系统设置 → 隐私与安全性 → 屏幕与系统音频录制 |
| **Info.plist** | `NSScreenCaptureUsageDescription`: "CallingClaw needs screen recording for meeting analysis" |

### 3. 辅助功能 — Accessibility (AXIsProcessTrusted)

| 项目 | 说明 |
|------|------|
| **用途** | osascript + cliclick 控制鼠标键盘（NativeBridge 自动化操作） |
| **可否自动弹窗** | 不能 — 必须用户手动在系统设置中开启 |
| **拒绝后果** | NativeBridge 所有操作失败：无法点击、输入、打开应用 |
| **设置路径** | 系统设置 → 隐私与安全性 → 辅助功能 |
| **检测方式** | 尝试执行 `osascript -e 'tell application "System Events" to return name of first process'` |

### 4. 摄像头 — `com.apple.security.device.camera`（预留）

| 项目 | 说明 |
|------|------|
| **用途** | 视频会议（当前未使用，预留） |
| **可否自动弹窗** | 可以 — `systemPreferences.askForMediaAccess('camera')` |
| **当前状态** | Entitlement 已声明，Info.plist 已配置，代码未调用 |

---

## 二、音频架构（v2.7.12+）

CallingClaw 使用 **Playwright `addInitScript()` 浏览器级音频注入**，不需要任何虚拟音频驱动。

### Meet Bridge 模式（加入会议）

```
Meet 参与者说话
  → RTCPeerConnection audio track (选择 muted=false 的 track)
    → AudioWorklet capture → PCM16 24kHz
      → WebSocket → Backend → Voice AI (OpenAI Realtime / Gemini Live)

AI 语音回复
  → Backend → WebSocket → base64 audio chunks
    → Ring Buffer AudioWorklet → replaceTrack() on RTCPeerConnection
      → Meet 参与者听到 AI 发言
```

关键实现文件：
- `callingclaw-backend/public/meet-audio-inject.js` — 音频注入编排
- `callingclaw-backend/public/playback-worklet.js` — Ring buffer worklet
- `callingclaw-backend/src/chrome-launcher.ts` — 通过 `addInitScript()` 预加载注入

### Direct 模式（非会议语音对话）

```
真实麦克风
  → getUserMedia()                       ← 需要麦克风 TCC 权限
    → AudioWorklet → WebSocket → Backend → Voice AI

AI 语音响应
  → Backend → WebSocket
    → AudioWorklet ring buffer
      → 系统默认扬声器
```

---

## 三、App 签名 Entitlements

文件：`build/entitlements.mac.plist`

| Entitlement | 用途 |
|-------------|------|
| `com.apple.security.device.audio-input` | 触发 TCC 麦克风授权弹窗的前提 |
| `com.apple.security.device.camera` | 触发 TCC 摄像头授权弹窗的前提 |
| `com.apple.security.device.screen-capture` | 屏幕录制 entitlement |
| `com.apple.security.cs.allow-jit` | Bun / WebAssembly JIT 编译 |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Electron native modules |
| `com.apple.security.cs.disable-library-validation` | 加载未签名动态库 |

---

## 四、Bundle ID 与权限

| 环境 | Bundle ID | 说明 |
|------|-----------|------|
| 开发 | `com.github.electron` | `npm start` 启动时使用 |
| 生产 | `com.tanka.callingclaw` | DMG 安装后使用 |

**重要：** TCC 权限绑定 Bundle ID，开发和生产环境的权限不互通。切换环境后需要重新授权。

---

## 五、Onboarding 检查顺序

| 步骤 | 权限 | 检查方式 | 自动弹窗 |
|------|------|---------|---------|
| 1 | 屏幕录制 | `getMediaAccessStatus('screen')` | 不能，打开系统设置 |
| 2 | 辅助功能 | osascript 测试执行 | 不能，打开系统设置 |
| 3 | 麦克风 | `getMediaAccessStatus('microphone')` | 能，`askForMediaAccess('microphone')` |

---

## 六、常见权限问题排查

| 现象 | 可能原因 | 排查 |
|------|---------|------|
| AI 加入会议但不说话 | replaceTrack 失败 | 检查 `[AudioInject]` 日志 |
| AI 听不到会议内容 | 选中了 muted=true 的 track | 检查日志是否有 `muted=false` track 被选中 |
| 截屏分析无内容 | 屏幕录制权限被拒 | 系统设置 → 屏幕录制 → 勾选 CallingClaw |
| 无法控制鼠标键盘 | 辅助功能权限被拒 | 系统设置 → 辅助功能 → 勾选 CallingClaw |
| 直连模式无声音 | 麦克风权限被拒 | 系统设置 → 麦克风 → 勾选 CallingClaw |
| `setSinkId()` 静默失败 | 调用顺序错误 | `setSinkId()` 必须在 `getUserMedia()` 之前调用 (Electron bug #40704) |
