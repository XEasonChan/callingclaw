# CallingClaw E2E Acceptance Test Plan

> 完整端到端验收流程。
> 核心理念：**创建入口多样，入会动作统一**。
> CallingClaw 不关心会议怎么来的，只关心日历里有没有会议、到时间了就自己加入。
> 每个 checkpoint 标注 **[MUST]** (必须通过) 或 **[SHOULD]** (建议通过)。

---

## Phase 0: Onboarding (新用户新电脑)


| #   | Checkpoint                         | 验收标准                                                                                                                  | 涉及模块                               | Status |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------ |
| 0.1 | **[MUST] 安装依赖**                    | `./scripts/setup.sh` 一键完成: Bun 安装、依赖安装、.env 生成                                                                        | setup.sh                           |        |
| 0.2 | **[MUST] macOS 权限获取**              | 首次启动弹出权限请求: 麦克风、屏幕录制、辅助功能。PermissionChecker 检测 + 引导                                                                   | permission-checker.js              |        |
| 0.3 | **[MUST] API Key 配置**              | .env 中配置 OPENAI_API_KEY / XAI_API_KEY / OPENROUTER_API_KEY，启动后 `/api/status` 显示可用                                     | config.ts                          |        |
| 0.4 | **[MUST] Agent Backend 连接**        | AgentAdapter 检测到可用 agent backend (OpenClaw / Claude Code)。`/api/status` 显示 `openclaw: "connected"` 或 agent adapter 可用 | agent-adapter.ts                   |        |
| 0.5 | **[SHOULD] Google Calendar OAuth** | Settings 页面完成 OAuth 授权，`/api/status` 显示 `calendar: "connected"`，日历事件在首页显示                                             | google_cal.ts                      | done   |
| 0.6 | **[MUST] Desktop 启动正常**            | Electron 窗口打开，首页渲染正常，状态栏显示 "Running"                                                                                  | main/index.js, renderer/index.html | done   |
| 0.7 | **[SHOULD] 健康检查**                  | `curl http://localhost:4000/api/status` 返回所有子系统状态，无 error                                                             | config_server.ts                   | done   |


---

## Phase 1: 会议创建 (多入口，统一进日历)

> **核心原则**：不管从哪里创建会议，最终都是一条日历记录 + 一个 Meet 链接。
> CallingClaw 只消费日历，不关心会议怎么来的。

### 创建入口


| #   | 入口                              | 流程                                                                | 最终结果                        | Status             |
| --- | ------------------------------- | ----------------------------------------------------------------- | --------------------------- | ------------------ |
| 1.1 | **[MUST] Desktop 输入框**          | 用户输入话题 → `/api/meeting/delegate` → OpenClaw 调研 + CallingClaw 创建日历 | 日历里出现事件 + Meet 链接 + prep 文件 | done               |
| 1.2 | **[MUST] Google Calendar 直接创建** | 用户在 Google Calendar 手动创建会议 (加 Meet 链接)                            | CallingClaw 通过日历 poll 发现事件  |                    |
| 1.3 | **[SHOULD] Slack 通知**           | Slack 里收到会议邀请 → 自动同步到 Google Calendar                             | CallingClaw 通过日历 poll 发现事件  | N/A — OpenClaw 侧实现 |
| 1.4 | **[SHOULD] API 调用**             | 外部系统调用 `/api/meeting/join` 传入 Meet URL                            | 直接入会 (跳过日历)                 | done               |
| 1.5 | **[SHOULD] 被邀请参会**              | 别人创建会议，CallingClaw 的 Google 账号在邀请列表中                              | 自动出现在日历中                    |                    |


### 创建后验证


| #    | Checkpoint              | 验收标准                                                           | Status                                                                                                                                                                                    |
| ---- | ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.6  | **[MUST] 单卡片原则**        | 任何入口创建的会议，Desktop 只显示一张卡片，不因 calendar poll / WS 竞争产生重复         | 我在4.2日18:48创建的会议有很多空的meeting title的会议when I click "talk locally," it automatically generates a lot of empty meetings with title "Meeting" with in the list, and I feel like that's bugged |
| 1.7  | **[MUST] Prep 不重复**     | delegate 生成 prep 后，join 不再重复调用 prepareMeeting()                |                                                                                                                                                                                           |
| 1.8  | **[SHOULD] Prep 自动生成**  | Desktop 入口创建的会议自动触发 prep。日历直接创建的会议，scheduler 检测到后自动 prep       | done                                                                                                                                                                                      |
| 1.9  | **[SHOULD] 侧边栏 tab 稳定** | 切换到 Prep tab 后 WS 事件不会闪回 Agent Activity                        |                                                                                                                                                                                           |
| 1.10 | **[SHOULD] 旧 prep 可打开** | 过去的会议 prep 文件点击后可以在侧边栏正常展示                                     | couldn't show correctly after it was generated                                                                                                                                            |
| 1.11 | **[MUST] 太近的会议自动推迟**    | 用户创建 <10min 后开始的会议 → 自动推迟到 10min 后 + 通知用户 "CallingClaw 需要时间准备" | 代码已实现                                                                                                                                                                                     |


---

## Phase 2: 入会 (核心只有一个动作)

> **CallingClaw 入会 = 日历里有会议 + 到时间了 → 自己加入**
> 其他入会方式 (手动 Join、Talk Locally) 是快捷方式，不是核心链路。

### 主链路：日历自动加入


| #   | Checkpoint                | 验收标准                                              | 涉及模块                                 | Status                                                   |
| --- | ------------------------- | ------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| 2.1 | **[MUST] Scheduler 检测**   | MeetingScheduler 从日历中检测到即将开始的会议 (< 5min)，自动触发加入流程 | meeting-scheduler.ts                 | done                                                     |
| 2.2 | **[MUST] Prep 就绪**        | 入会前 prep brief 已就绪 (日历检测时提前生成)，如果没有则快速生成          | meeting-prep.ts                      | done                                                     |
| 2.3 | **[MUST] Chrome 启动 + 入会** | ChromeLauncher 启动 Chrome，导航到 Meet URL，自动点击加入      | chrome-launcher.ts                   | done                                                     |
| 2.4 | **[MUST] 音频配置**           | 入会时: 摄像头关闭、麦克风打开、音频通过 Playwright 注入               | chrome-launcher.ts                   | done                                                     |
| 2.5 | **[MUST] Voice AI 启动**    | Realtime voice session 连接，prep context 注入完成       | realtime_client.ts, voice-persona.ts | grok worked but didn't stable and gemini 3.1 didn't work |
| 2.6 | **[MUST] Desktop 状态同步**   | Desktop 首页显示 "进行中" badge，侧边栏自动切到会议 panel          | renderer/index.html                  | done                                                     |


### 快捷方式 A: 手动 Join Meeting


| #   | Checkpoint                 | 验收标准                                              | Status |
| --- | -------------------------- | ------------------------------------------------- | ------ |
| 2.7 | **[MUST] 点击 Join Meeting** | Desktop 点击 "Join Meeting" → 同样的 Chrome + audio 流程 | done   |
| 2.8 | **[MUST] 等候室处理**           | 如果被放入等候室，后台轮询直到被放入 (最长 5min)                      |        |


### 快捷方式 B: Talk Locally (无需 Meet)


| #    | Checkpoint                 | 验收标准                               | Status                                                                                                                     |
| ---- | -------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 2.9  | **[MUST] 点击 Talk Locally** | 侧边栏打开，Voice session 启动，本地麦克风 + 扬声器 | when I click Top-Lowerly, I could see some EventBus showing that it's connecting, however I didn't hear any sound from it. |
| 2.10 | **[MUST] 双向语音**            | 说话 → AI 听到 → AI 回应 → 用户听到          |                                                                                                                            |


---

## Phase 3: 会中 (Meeting In Progress)

### 3.1 入会初始化


| #     | Checkpoint                 | 验收标准                                      | 涉及模块               | Status                                                                                                                                                                           |
| ----- | -------------------------- | ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1 | **[MUST] 准入监控**            | 其他参会者请求加入时，自动在浏览器中点击 "允许"                 | chrome-launcher.ts | done                                                                                                                                                                             |
| 3.1.2 | **[MUST] 自动打招呼**           | 检测到真人参会者后，Voice AI 自动发出 self-introduction | voice-persona.ts   | I didn't hear the self-introduction after I joined.but it could automatically see the greeting word when it joined. At that time, probably there was nothing in the meeting room |
| 3.1.3 | **[MUST] Prep context 生效** | Voice AI 知道会议主题、要点、Q&A 策略 (Layer 2 注入)    | voice-persona.ts   | yes, it could automatically prepare the meeting, and the AI knows the contest when it first joins the meeting                                                                    |


### 3.2 语音对话


| #     | Checkpoint                       | 验收标准                                                  | 涉及模块                             | Status                                                                                                                                                                                                                                        |
| ----- | -------------------------------- | ----------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.2.1 | **[MUST] 双向语音**                  | 全双工对话，无明显延迟，音频质量清晰                                    | realtime_client.ts, audio-bridge | yeah, I could hear it clearly, but sometimes I would keep repeating, saying the same words once and once again. I'm not sure if that's because the WebSocket delay or we are saying the voice at each bunch and it got this duplication error |
| 3.2.2 | **[MUST] System instruction 生效** | Voice AI 的人设 (CORE_IDENTITY) 正确加载，行为符合 facilitator 角色 | prompt-constants.ts              | done                                                                                                                                                                                                                                          |
| 3.2.3 | **[SHOULD] Playbook 驱动**         | 如果 prep 有 speakingPlan，Voice AI 按计划发言，主动推进会议          | voice-persona.ts                 |                                                                                                                                                                                                                                               |
| 3.2.4 | **[SHOULD] 打断处理**                | 用户打断 AI 说话时，AI 停止当前发言并回应                              | voice.ts                         | done, but some delay could feels like the AI is 和用户抢话                                                                                                                                                                                         |


### 3.3 投屏演示


| #     | Checkpoint                         | 验收标准                                          | 涉及模块                                      | Status |
| ----- | ---------------------------------- | --------------------------------------------- | ----------------------------------------- | ------ |
| 3.3.1 | **[MUST] 语音触发投屏**                  | 用户说 "投屏/share" + URL → 检测 → 打开并分享             | transcript-auditor.ts, chrome-launcher.ts |        |
| 3.3.2 | **[SHOULD] Auto-present**          | playbook 有 scenes → 入会后自动分享第一个 scene URL      | meeting-routes.ts, presentation-engine.ts |        |
| 3.3.3 | **[SHOULD] 多页面跳转**                 | PresentationEngine 按 scene 序列在不同 URL 间导航 + 滚动 | presentation-engine.ts                    |        |
| 3.3.4 | **[SHOULD] Progressive injection** | Scene 切换时，新 talkingPoints 注入 voice context    | voice-persona.ts                          |        |
| 3.3.5 | **[MUST] 停止投屏**                    | 用户说 "停止投屏" → 停止屏幕共享                           | transcript-auditor.ts                     |        |


### 3.4 电脑操作 (Haiku + Playwright)


| #     | Checkpoint                   | 验收标准                                          | 涉及模块                                        | Status |
| ----- | ---------------------------- | --------------------------------------------- | ------------------------------------------- | ------ |
| 3.4.1 | **[MUST] Fast lane 点击**      | "点击那个按钮" → regex 匹配 → <500ms Playwright click | transcript-auditor.ts                       |        |
| 3.4.2 | **[MUST] Medium lane 操作**    | "打开那个 PRD 文件" → Haiku 分类 → search + open      | transcript-auditor.ts, automation-router.ts |        |
| 3.4.3 | **[MUST] Presenting tab 操作** | click/scroll 在投屏页面执行 (不是 Meet 页面)             | chrome-launcher.ts                          |        |
| 3.4.4 | **[MUST] currentScene 同步**   | Haiku 知道当前投屏 URL (SharedContext.currentScene) | shared-context.ts                           |        |


### 3.5 实时监控


| #     | Checkpoint                           | 验收标准                                                 | 涉及模块                                  | Status                                                                                                                                                                                    |
| ----- | ------------------------------------ | ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.5.1 | **[MUST] Transcript 实时记录**           | 所有发言实时记录在 SharedContext.transcript                   | shared-context.ts                     | you can see the contacts and transcript in the voice test HTML. However, when I joined a real-time meeting, the transcript had some bugs showing that there are some errors and conflicts |
| 3.5.2 | **[SHOULD] 屏幕截图**                    | VisionModule 1s 间隔截图，dedup 后存入 KeyFrameStore         | vision.ts, key-frame-store.ts         | done                                                                                                                                                                                      |
| 3.5.3 | **[SHOULD] 意图识别 (ContextRetriever)** | 话题变化 → gap 检测 → 本地搜索 → context + hint 注入             | context-retriever.ts                  |                                                                                                                                                                                           |
| 3.5.4 | **[MUST] Desktop 事件展示**              | EventBus 事件通过 WS 推送到 Desktop，Live Feed tab 实时更新      | config_server.ts, renderer/index.html | done                                                                                                                                                                                      |
| 3.5.5 | **[SHOULD] liveNotes TTL**           | >5min 的 [CONTEXT]/[SUGGEST] notes 自动 evict，[DONE] 保留 | meeting-prep.ts                       |                                                                                                                                                                                           |


---

## Phase 4: 会后 (Post-Meeting)


| #   | Checkpoint                       | 验收标准                                                   | 涉及模块                                         | Status                                |
| --- | -------------------------------- | ------------------------------------------------------ | -------------------------------------------- | ------------------------------------- |
| 4.1 | **[MUST] 会议记录生成**                | 会议结束后自动生成 summary markdown                             | meeting.ts, post-meeting-delivery.ts         | 会后的总结生成的不是会议总结，而是openclaw作为第三方的对会议的理解 |
| 4.2 | **[SHOULD] 带截图的会议纪要**            | Summary 包含关键截屏 + transcript + action items             | key-frame-store.ts, post-meeting-delivery.ts | not impliment                         |
| 4.3 | **[MUST] 文件存储**                  | 会议文件存储在 `~/.callingclaw/shared/{meetingId}_summary.md` | shared-documents.ts                          | done                                  |
| 4.4 | **[MUST] meeting.summary_ready** | 后端发出 WS 事件，Desktop Summary tab 自动加载                    | callingclaw.ts                               | done                                  |
| 4.5 | **[SHOULD] OC-010 发送**           | Timeline + transcript 发送给 OpenClaw 做深度处理               | post-meeting-delivery.ts                     | done                                  |
| 4.6 | **[SHOULD] Desktop summary 展示**  | Desktop 侧边栏 Summary tab 显示生成的总结                        | renderer/index.html                          | done                                  |
| 4.7 | **[SHOULD] 长期任务执行**              | OpenClaw 接收 OC-010 后执行 action items (代码修改、文档更新等)       | openclaw (external)                          | By design: 人工确认后执行                    |


---

## Phase 5: 跨链路回归测试


| #   | Checkpoint                     | 验收标准                                                     | Status                                                         |
| --- | ------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------- |
| 5.1 | **[MUST] 多 provider 切换**       | OpenAI → Grok → Gemini 切换后重新入会，语音正常                      |                                                                |
| 5.2 | **[SHOULD] 长会议稳定性**            | 30min+ 会议无崩溃、无内存泄漏、context 不爆                            | Deferred — Gemini 为默认 provider，Grok 30min rotation 保留 TODOS P2 |
| 5.3 | **[SHOULD] Presentation 文件存储** | `{meetingId}_presentation.json` 和 prep/summary 正确关联      |                                                                |
| 5.4 | **[MUST] 会议结束后清理**             | 会议结束后 voice session 断开、admission monitor 停止、recording 停止 | done                                                           |


---

## 架构图: 创建多入口 → 日历统一 → 自动入会

```
创建入口 (多样)                     统一消费 (日历)                 入会 (一个动作)
═══════════════                    ══════════════                 ══════════════

Desktop 输入框 ─┐
               │
Google Calendar ├── → Google Calendar ──→ MeetingScheduler ──→ 自动加入 Meet
               │     (唯一的真相源)       (poll 日历, 到时间)     (ChromeLauncher)
Slack 通知    ──┤
               │
被人邀请      ──┤
               │
API 调用      ──┘  (可跳过日历直接 join)

快捷方式:
  Talk Locally ── 不需要 Meet，本地麦克风直连 Voice AI
  Join Meeting ── 手动触发，跳过 Scheduler 等待
```

## 独立测试页面 (无需 Meet 即可验证)

| 功能模块 | 测试地址 | 覆盖 Checkpoint |
|---------|---------|----------------|
| AutomationRouter (4层路由) | http://localhost:4000/test-automation-router | 3.4.1, 3.4.2 |
| TranscriptAuditor (意图识别) | http://localhost:4000/test-transcript-auditor | 3.5.1, 3.4.1, 3.4.2 |
| PresentationEngine (投屏演示) | http://localhost:4000/test-presentation-engine | 3.3.2, 3.3.3, 3.3.4 |
| ContextRetriever (知识检索) | http://localhost:4000/test-context-retriever | 3.5.3 |
| Voice Session (语音测试) | http://localhost:4000/voice-test | 2.5, 2.10, 3.2.1 |
| Meeting Join (入会测试) | http://localhost:4000/meeting-join-test | 2.3, 2.4, 2.8 |

## 执行建议

1. **Phase 0 最先**：新电脑 clean install 跑一遍 onboarding
2. **Phase 2 主链路 (日历自动加入)** 是最重要的验收路径
3. **Phase 1 只需验证日历里有记录 + Desktop 不重复**
4. **Phase 3 在真实 Meet 中测**：需要两个 Google 账号
5. **Phase 3 独立测试**：被 Meet 阻塞的功能可用上方独立测试页面验证
6. **Phase 4 会后自动触发**：结束 Phase 3 的会议后检查
7. **Phase 5 是回归测试**：每次发版前跑一遍

