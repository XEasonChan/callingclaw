# CallingClaw E2E Acceptance Test Plan

> 完整端到端验收流程，覆盖 Onboarding → 入会 → 会中 → 会后 四个阶段。
> 每个 checkpoint 标注 **[MUST]** (必须通过) 或 **[SHOULD]** (建议通过)。

---

## Phase 0: Onboarding (新用户新电脑)

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 0.1 | **[MUST] 安装依赖** | `./scripts/setup.sh` 一键完成: Bun 安装、依赖安装、.env 生成 | setup.sh |  |
| 0.2 | **[MUST] macOS 权限获取** | 首次启动弹出权限请求: 麦克风、屏幕录制、辅助功能。PermissionChecker 检测 + 引导 | permission-checker.js |  |
| 0.3 | **[MUST] API Key 配置** | .env 中配置 OPENAI_API_KEY / XAI_API_KEY / OPENROUTER_API_KEY，启动后 `/api/status` 显示可用 | config.ts |  |
| 0.4 | **[MUST] Claude Code / OpenClaw 连接** | AgentAdapter 检测到可用 agent backend。`/api/status` 显示 `openclaw: "connected"` 或 agent adapter 可用 | agent-adapter.ts |  |
| 0.5 | **[SHOULD] Google Calendar OAuth** | Settings 页面完成 OAuth 授权，`/api/status` 显示 `calendar: "connected"`，日历事件在首页显示 | google_cal.ts |  |
| 0.6 | **[MUST] Desktop 启动正常** | Electron 窗口打开，首页渲染正常，状态栏显示 "Running" | main/index.js, renderer/index.html |  |
| 0.7 | **[SHOULD] 健康检查** | `curl http://localhost:4000/api/status` 返回所有子系统状态，无 error | config_server.ts |  |

---

## Phase 1: 入会 (三条链路)

### 链路 A: Talk Locally (本地对话)

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 1A.1 | **[MUST] 点击 Talk Locally** | Desktop 首页点击某个会议的 "Talk Locally"，侧边栏打开 tabbed panel | renderer/index.html |  |
| 1A.2 | **[MUST] 语音连接** | Voice session 启动 (OpenAI / Grok / Gemini)，`/api/voice/session/status` 显示 connected=true | voice.ts, realtime_client.ts |  |
| 1A.3 | **[MUST] 麦克风工作** | 说话后 transcript 出现在 Live Feed tab，AI 回应出现在 transcript | audio-bridge.js |  |
| 1A.4 | **[MUST] 扬声器工作** | AI 语音通过系统默认扬声器播放，音量正常 | audio-bridge.js |  |
| 1A.5 | **[SHOULD] Prep 注入** | 如果该会议有 prep brief，voice context 包含会议上下文 | voice-persona.ts |  |

### 链路 B: 日历自动加入

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 1B.1 | **[MUST] Scheduler 检测** | MeetingScheduler 从日历中检测到即将开始的会议 (< 5min) | meeting-scheduler.ts |  |
| 1B.2 | **[MUST] 自动 Prep 生成** | 会议前自动生成 prep brief (如果没有现成的) | meeting-prep.ts |  |
| 1B.3 | **[MUST] 自动加入 Meet** | ChromeLauncher 自动打开 Chrome，导航到 Meet URL，点击加入 | chrome-launcher.ts |  |
| 1B.4 | **[MUST] 音频配置正确** | 加入时: 摄像头关闭、麦克风打开、音频通过 Playwright 注入 (非 BlackHole) | chrome-launcher.ts |  |
| 1B.5 | **[SHOULD] Desktop 状态同步** | Desktop 首页显示 "进行中" badge，侧边栏自动切到会议 panel | renderer/index.html |  |

### 链路 C: 手动 Join Meeting

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 1C.1 | **[MUST] 点击 Join Meeting** | Desktop 首页点击 "Join Meeting"，触发 `/api/meeting/join` | renderer/index.html, meeting-routes.ts |  |
| 1C.2 | **[MUST] Chrome 启动 + 入会** | ChromeLauncher 启动 Chrome，navigatePresentingPage → joinGoogleMeet | chrome-launcher.ts |  |
| 1C.3 | **[MUST] 音频管道激活** | Playwright 音频注入激活，capture 到非零幅度音频 | chrome-launcher.ts |  |
| 1C.4 | **[MUST] Voice AI 启动** | Realtime voice session 连接，provider 正确 (默认 OpenAI 或用户选择的) | realtime_client.ts |  |
| 1C.5 | **[MUST] Prep dedup** | 如果 delegate 已生成 prep，join 不重复调用 prepareMeeting() | meeting-routes.ts |  |
| 1C.6 | **[MUST] 无重复卡片** | Desktop 只显示一张会议卡片，不因 calendar poll 和 WS 竞争产生重复 | renderer/index.html |  |

---

## Phase 2: 会中 (Meeting In Progress)

### 2.1 入会初始化

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 2.1.1 | **[MUST] 摄像头关闭** | 入会时 `muteCamera: true`，Meet 界面显示摄像头已关 | chrome-launcher.ts |  |
| 2.1.2 | **[MUST] 麦克风打开** | 入会时 `muteMic: false`，Meet 界面显示麦克风已开 | chrome-launcher.ts |  |
| 2.1.3 | **[MUST] 等候室处理** | 如果被放入等候室，后台轮询直到被放入 (最长 5min)，入会后触发 meeting.started | meeting-routes.ts |  |
| 2.1.4 | **[MUST] 准入监控** | 其他参会者请求加入时，自动点击 "允许" (admission monitor) | chrome-launcher.ts |  |
| 2.1.5 | **[MUST] 自动打招呼** | 检测到真人参会者后，Voice AI 自动发出 self-introduction | voice-persona.ts |  |

### 2.2 语音对话

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 2.2.1 | **[MUST] 双向语音** | 用户说话 → AI 听到 → AI 回应 → 用户听到。全双工无明显延迟 | realtime_client.ts, audio-bridge |  |
| 2.2.2 | **[MUST] System instruction 生效** | Voice AI 的人设 (CORE_IDENTITY) 正确加载，行为符合 facilitator 角色 | voice-persona.ts, prompt-constants.ts |  |
| 2.2.3 | **[MUST] Prep context 注入** | Meeting prep brief / playbook 通过 Layer 2 conversation.item.create 注入，AI 知道会议主题和要点 | voice-persona.ts |  |
| 2.2.4 | **[SHOULD] Playbook 驱动** | 如果 prep 有 speakingPlan，Voice AI 按计划发言，不只是被动回答 | voice-persona.ts |  |
| 2.2.5 | **[SHOULD] 打断处理** | 用户打断 AI 说话时，AI 停止当前发言并回应 | voice.ts |  |

### 2.3 投屏演示

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 2.3.1 | **[MUST] 手动投屏** | 用户说 "投屏/share" + URL → TranscriptAuditor 检测 → ChromeLauncher 打开并分享 | transcript-auditor.ts, chrome-launcher.ts |  |
| 2.3.2 | **[SHOULD] Auto-present** | 如果 playbook 有 scenes，入会后自动分享第一个 scene URL | meeting-routes.ts, presentation-engine.ts |  |
| 2.3.3 | **[SHOULD] 多页面跳转** | PresentationEngine.runScenes() 按 scene 序列在不同 URL 间导航 | presentation-engine.ts |  |
| 2.3.4 | **[SHOULD] 滚动同步** | 每个 scene 的 scrollTarget 触发页面滚动到指定位置 | presentation-engine.ts |  |
| 2.3.5 | **[MUST] 停止投屏** | 用户说 "停止投屏/stop sharing" → 停止屏幕共享 | transcript-auditor.ts |  |
| 2.3.6 | **[SHOULD] Progressive injection** | Scene 切换时，新 scene 的 talkingPoints 注入 voice context | voice-persona.ts (buildSceneContext) |  |

### 2.4 电脑操作 (Haiku + Playwright)

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 2.4.1 | **[MUST] Fast lane 点击** | 用户说 "点击那个按钮" → regex 匹配 → <500ms 执行 Playwright click | transcript-auditor.ts (fast lane) |  |
| 2.4.2 | **[MUST] Medium lane 操作** | 用户说 "打开那个 PRD 文件" → Haiku 分类 → search_and_open → 浏览器打开 | transcript-auditor.ts, automation-router.ts |  |
| 2.4.3 | **[MUST] Presenting tab 操作** | click/scroll 操作在投屏页面执行 (不是 Meet 页面) | transcript-auditor.ts, chrome-launcher.ts |  |
| 2.4.4 | **[MUST] currentScene 同步** | Haiku 知道当前投屏的是哪个 URL (SharedContext.currentScene) | shared-context.ts, transcript-auditor.ts |  |
| 2.4.5 | **[SHOULD] 动态 hints** | Haiku prompt 中的文件/URL 列表来自 brief (非硬编码) | transcript-auditor.ts |  |

### 2.5 实时监控

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 2.5.1 | **[MUST] Transcript 记录** | 所有发言实时记录在 SharedContext.transcript | shared-context.ts |  |
| 2.5.2 | **[SHOULD] 屏幕截图** | VisionModule 以 1s 间隔截图，dedup 后存入 KeyFrameStore | vision.ts, key-frame-store.ts |  |
| 2.5.3 | **[SHOULD] ContextRetriever** | 话题变化时，ContextRetriever 检测 gap → 本地搜索 → 注入 context + hint | context-retriever.ts |  |
| 2.5.4 | **[MUST] Desktop 状态展示** | EventBus 事件通过 WebSocket 推送到 Desktop，Live Feed tab 更新 | config_server.ts, renderer/index.html |  |
| 2.5.5 | **[SHOULD] liveNotes TTL** | 超过 5 分钟的 [CONTEXT]/[SUGGEST] notes 自动 evict，[DONE] 保留 | meeting-prep.ts |  |

---

## Phase 3: 会后 (Post-Meeting)

| # | Checkpoint | 验收标准 | 涉及模块 | Status |
|---|-----------|---------|----------|--------|
| 3.1 | **[MUST] 会议记录生成** | 会议结束后自动生成 summary markdown 文件 | meeting.ts, post-meeting-delivery.ts |  |
| 3.2 | **[SHOULD] 带截图的会议纪要** | Summary 包含关键截屏 (KeyFrameStore) + transcript + action items | key-frame-store.ts, post-meeting-delivery.ts |  |
| 3.3 | **[MUST] 文件存储位置** | 会议文件存储在 `~/.callingclaw/shared/{meetingId}_summary.md` | shared-documents.ts |  |
| 3.4 | **[SHOULD] OC-010 发送** | 会议 timeline + transcript 发送给 OpenClaw 做深度处理 | post-meeting-delivery.ts, openclaw-protocol.ts |  |
| 3.5 | **[SHOULD] Desktop summary 展示** | Desktop 侧边栏 Summary tab 自动加载生成的总结 | renderer/index.html |  |
| 3.6 | **[MUST] meeting.summary_ready 事件** | 后端发出 `meeting.summary_ready` WebSocket 事件，Desktop 刷新 | callingclaw.ts, renderer/index.html |  |
| 3.7 | **[SHOULD] OpenClaw 长期任务** | OpenClaw 接收 OC-010 后执行后续 action items (代码修改、文档更新等) | openclaw (external) |  |

---

## Phase 4: 跨链路验证

| # | Checkpoint | 验收标准 | Status |
|---|-----------|---------|--------|
| 4.1 | **[MUST] Prep → Join 不重复** | delegate 生成 prep 后 join 不再重复调用 prepareMeeting() |  |
| 4.2 | **[MUST] 单卡片原则** | 一个会议在 Desktop 只显示一张卡片，任何时序下不重复 |  |
| 4.3 | **[MUST] 侧边栏 tab 稳定** | 切换到 Prep/Summary tab 后 WS 事件不会闪回 Agent Activity |  |
| 4.4 | **[MUST] 旧 prep 可打开** | 过去的会议 prep 文件点击后可以在侧边栏正常展示 |  |
| 4.5 | **[SHOULD] 多 provider 切换** | 从 OpenAI 切换到 Grok/Gemini 后重新入会，语音正常 |  |
| 4.6 | **[SHOULD] 长会议稳定性** | 30min+ 会议中无崩溃、无内存泄漏、liveNotes 不爆 |  |
| 4.7 | **[SHOULD] Presentation 文件存储** | `{meetingId}_presentation.json` 和 prep/summary 一起存储和加载 |  |

---

## 执行建议

1. **Phase 0 优先**：新电脑 clean install 测一遍 onboarding
2. **Phase 1 按链路测**：先测 1C (手动 Join，最常用)，再测 1A (Talk Locally)，最后测 1B (自动加入)
3. **Phase 2 在真实 Meet 中测**：需要两个 Google 账号，一个人参会一个 AI 参会
4. **Phase 3 会后自动触发**：结束 Phase 2 的会议后检查
5. **Phase 4 是回归测试**：每次发版前跑一遍
