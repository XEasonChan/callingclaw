# CallingClaw 权限清单

> **v2.7.12 更新：** BlackHole 虚拟音频驱动已移除。音频注入现在通过 Playwright `addInitScript` 在浏览器级别完成，不需要安装任何音频驱动。以下文档中的 BlackHole 相关内容仅供历史参考。

CallingClaw 需要以下 macOS 权限才能正常运行。所有权限在 Onboarding 引导流程中检查。

---

## 一、macOS TCC 权限（系统弹窗授权）

### 1. 麦克风 — `com.apple.security.device.audio-input`

| 项目 | 说明 |
|------|------|
| **用途** | `getUserMedia()` 采集音频输入（BlackHole 16ch 或真实麦克风） |
| **两种模式都需要** | 是 — macOS TCC 不区分虚拟设备和真实麦克风，`getUserMedia()` 一律触发权限检查 |
| **可否自动弹窗** | 可以 — `systemPreferences.askForMediaAccess('microphone')` |
| **拒绝后果** | `_setupCapture()` 失败，AI 听不到会议音频（Meet Bridge）或用户语音（Direct） |
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
| **Info.plist** | `NSCameraUsageDescription`: "CallingClaw needs camera access for video meetings" |

---

## 二、虚拟音频设备（用户手动安装）

### BlackHole 2ch

| 项目 | 说明 |
|------|------|
| **用途** | AI 语音输出 → Meet/Zoom 麦克风输入 |
| **安装** | `brew install blackhole-2ch` |
| **角色** | AudioBridge 的 `setSinkId()` 目标设备（playback output） |
| **缺失后果** | 回退到 Direct 模式，AI 语音只从本机扬声器播放，Meet 中听不到 |

### BlackHole 16ch

| 项目 | 说明 |
|------|------|
| **用途** | Meet/Zoom 扬声器 → AI 音频输入（让 AI 听到会议中其他人说话） |
| **安装** | `brew install blackhole-16ch` |
| **角色** | AudioBridge 的 `getUserMedia({ deviceId })` 输入源（capture input） |
| **缺失后果** | 回退到 Direct 模式，AI 无法听到会议中其他参与者的声音 |

### 检测方式

```bash
system_profiler SPAudioDataType | grep BlackHole
```

代码中通过 `findBlackHoleDevices()` 枚举音频设备自动检测（`audio-bridge.js:120`）。

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

## 四、音频链路与权限的关系

```
Meet Bridge 模式:

  Meet 音频输出
    → BlackHole 16ch (虚拟扬声器)        ← 需安装 BlackHole 16ch
      → getUserMedia({ deviceId: bh16ch }) ← 需要麦克风 TCC 权限
        → AudioWorklet (PCM16 24kHz)
          → WebSocket → Backend → Grok/OpenAI Realtime API

  AI 语音响应
    → Backend → WebSocket audio_playback
      → AudioWorklet ring buffer
        → setSinkId(BlackHole 2ch)         ← 需安装 BlackHole 2ch
          → Meet 麦克风输入

Direct 模式:

  真实麦克风
    → getUserMedia()                       ← 需要麦克风 TCC 权限
      → AudioWorklet → WebSocket → Backend → Grok/OpenAI

  AI 语音响应
    → Backend → WebSocket
      → AudioWorklet ring buffer
        → 系统默认扬声器
```

---

## 五、Onboarding 检查顺序

| 步骤 | 权限 | 检查方式 | 自动弹窗 |
|------|------|---------|---------|
| 1 | 屏幕录制 | `getMediaAccessStatus('screen')` | 不能，打开系统设置 |
| 2 | 辅助功能 | osascript 测试执行 | 不能，打开系统设置 |
| 3 | 麦克风 | `getMediaAccessStatus('microphone')` | 能，`askForMediaAccess('microphone')` |
| 4 | BlackHole 设备 | `findBlackHoleDevices()` | — 需用户手动安装 |

> **注意：** 当前代码中 `permission-checker.js` 的 `checkAll()` 未包含麦克风检查（注释声称虚拟设备不需要），这是一个 bug — `getUserMedia()` 对虚拟设备同样触发 TCC 检查。需要将麦克风加入 `checkAll()`。

---

## 六、常见权限问题排查

| 现象 | 可能原因 | 排查 |
|------|---------|------|
| AI 加入会议但不说话 | BlackHole 2ch 未安装或 `setSinkId()` 失败 | 检查 `[AudioBridge] Output device:` 日志 |
| AI 说话但 Meet 中听不到 | BlackHole 2ch 未设为 Meet 麦克风 | Meet 设置 → 音频 → 麦克风选 BlackHole 2ch |
| AI 听不到会议内容 | 麦克风权限被拒 或 BlackHole 16ch 未安装 | `[AudioBridge] Capture failed` 日志 |
| 截屏分析无内容 | 屏幕录制权限未授予 | 系统设置 → 屏幕录制 → 勾选 CallingClaw |
| 无法控制鼠标键盘 | 辅助功能权限未授予 | 系统设置 → 辅助功能 → 勾选 CallingClaw |
| `setSinkId()` 静默失败 | `setSinkId()` 在 `getUserMedia()` 之后调用 | Electron bug #40704，检查调用顺序 |
