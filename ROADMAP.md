# CallingClaw Roadmap

## v3.0 — 消灭 Python Sidecar (Branch: `refactor/electron-consolidation`)

> **状态：调研完成，待决策。** 音频方案需先做 spike 测试。

### 目标
消灭 Python sidecar，解决 WebSocket 频繁断连的根本问题。

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

## v2.x — 当前版本维护

### v2.2.4 (当前)
- Desktop Meeting Hub
- Talk Locally 完整会议栈
- OpenClaw `/callingclaw prepare` 命令
- Sidecar 稳定性修复

### 近期 TODO
- [ ] 会议卡片持久化 bug（renderMeetings 覆盖 prep card）
- [ ] 音频管道端到端可靠性
- [ ] Hackathon demo 准备 (2026-03-22)
