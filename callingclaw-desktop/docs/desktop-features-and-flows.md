# CallingClaw Desktop — 功能点与流程文档

> 更新时间: 2026-03-17 | 版本: v2.4.1

---

## 1. 首页 — Meeting Hub

### 1.1 界面结构

```
┌─ Titlebar (52px) ─────────────────────────────────────┐
│  🦞 CallingClaw  v2.4.1              [overlay] [⚙]    │
├───────────────────────────────────────────────────────┤
│                                                        │
│         🦞 Hey Andrew,                                 │
│         What's our next meeting topic?                 │
│                                                        │
│  ┌──────────────────────────────────┐ ┌──────────┐    │
│  │ 告诉 CallingClaw 你想讨论什么话题... │ │ 准备会议  │    │
│  └──────────────────────────────────┘ └──────────┘    │
│                                                        │
│  Coming up                                             │
│  ┌────────────────────────────────────────────┐       │
│  │ 17   CallingClaw官网讨论        已安排       │       │
│  │ Mon  20:00 - 20:30                          │       │
│  │      📋 Meeting Prep — ✅ 点击查看           │       │
│  │      Talk Locally   Join Meeting            │       │
│  ├────────────────────────────────────────────┤       │
│  │ 18   Hackathon Demo 方案        即将开始     │       │
│  │ Tue  10:00 - 10:30                          │       │
│  │      Talk Locally   Join Meeting            │       │
│  └────────────────────────────────────────────┘       │
│                                                        │
│  Past meetings                                         │
│  ┌────────────────────────────────────────────┐       │
│  │ 📄 CallingClaw Context Sync Discussion      │       │
│  │    2026-03-15 23:26                         │       │
│  └────────────────────────────────────────────┘       │
│                                                        │
├─ Status Bar (32px) ───────────────────────────────────┤
│  🟢运行中  🟢语音  🟢OpenClaw  🟢音频   v2.4.1       │
└───────────────────────────────────────────────────────┘
```

### 1.2 右侧面板 (Side Panel, 460px)

点击会议卡片或 prep 附件时从右侧滑入，显示：
- Meeting Prep Brief (markdown 渲染)
- 或 Meeting Notes (会后总结)
- 或 Agent Activity Feed (研究进行中)

---

## 2. 完整功能清单

| 功能 | 触发方式 | 后端 API | 状态 |
|------|----------|----------|------|
| 输入会议话题 | 首页输入框 + Enter/按钮 | POST /api/meeting/prepare | ✅ |
| 快速标题生成 | 自动（话题>30字） | OpenClaw sendTask | ✅ |
| 自然语言时间解析 | 自动（从话题提取） | OpenClaw sendTask | ✅ |
| 创建 Google Calendar | 自动（prepare 内） | POST /api/calendar/create | ✅ |
| 生成 Meet 链接 | 自动（含 conferenceData） | Google Calendar API | ✅ |
| 自动邀请用户邮箱 | 自动（CONFIG.userEmail） | 日历 attendees | ✅ |
| OpenClaw 深度调研 | 后台异步 | MeetingPrepSkill.generate | ✅ |
| Agent Activity Feed | 侧面板实时显示 | WS openclaw.delta | ✅ |
| 调研完成自动展示 | WS meeting.prep_ready | EventBus | ✅ |
| Prep 本地缓存 | localStorage | — | ✅ |
| Coming up 列表 | 自动加载 | GET /api/calendar/events | ✅ |
| Past meetings 列表 | 自动加载 | GET /api/meeting/notes | ✅ |
| Talk Locally | 卡片按钮 | POST /api/voice/start | ✅ |
| Join Meeting | 卡片按钮 | POST /api/meeting/join | ✅ |
| Leave Meeting | 进行中卡片按钮 | POST /api/meeting/leave | ✅ |
| 查看会后总结 | 点击 past meeting | GET /api/meeting/notes/:file | ✅ |
| 设置/邮箱配置 | ⚙ 齿轮图标 | GET/POST /api/config/user-email | ✅ |
| 引擎启停 | 状态栏/首页 | IPC daemon:start/stop | ✅ |
| 健康检查 | 状态栏自动 | GET /api/status (每10s) | ✅ |
| IME 中文兼容 | 输入框 | event.isComposing 检测 | ✅ |

---

## 3. 核心流程图

### 3.1 会议准备流程 (submitTopic)

```
用户输入话题（如"今晚八点讨论callingclaw官网"）
  │
  ├─ [前端即时] 显示卡片 (--/创建中)
  │   └─ 📋 Meeting Prep — shimmer 动画
  │
  ▼
POST /api/meeting/prepare { topic }
  │
  ├─ Step 1: 快速标题生成 (<2s)
  │   └─ OpenClaw: "今晚八点讨论..." → "CallingClaw官网讨论"
  │
  ├─ Step 2: 自然语言时间解析 (<2s)
  │   └─ OpenClaw: "今晚八点" → 2026-03-17T20:00:00+08:00
  │
  ├─ Step 3: 创建 Google Calendar (<1s)
  │   ├─ summary: "CallingClaw官网讨论"
  │   ├─ start: 20:00, end: 20:30
  │   ├─ attendees: [CONFIG.userEmail]
  │   ├─ conferenceData → 生成 Meet 链接
  │   └─ 返回: { id, meetLink, start, end }
  │
  ├─ [同步返回给前端] (~3-5s)
  │   {
  │     title: "CallingClaw官网讨论",
  │     meetUrl: "https://meet.google.com/xxx",
  │     calendarEventId: "abc123",
  │     startTime: "2026-03-17T20:00:00+08:00",
  │     prepStatus: "researching"
  │   }
  │
  ├─ [前端更新卡片]
  │   ├─ 左侧: 17 / Mon
  │   ├─ 标题: CallingClaw官网讨论
  │   ├─ 时间: 20:00
  │   ├─ 按钮: Talk Locally + Join Meeting
  │   └─ 附件: 📋 Meeting Prep — shimmer
  │
  └─ Step 4: 后台 OpenClaw 深度调研 (异步, 不限时)
      │
      ├─ MeetingPrepSkill.generate(topic, context, attendees)
      │   └─ OpenClawBridge.sendTask(MEETING_PREP_PROMPT)
      │       └─ OpenClaw 读取:
      │           ├─ MEMORY.md (用户记忆)
      │           ├─ 项目文件 (git 仓库)
      │           ├─ 相关文档 (PRD, README)
      │           └─ 历史会议笔记
      │
      ├─ [WebSocket 实时推送]
      │   ├─ openclaw.delta → 前端 Agent Feed 更新
      │   └─ meeting.prep_ready → 前端收到完整 brief
      │
      └─ 返回结构化 JSON:
          {
            topic, goal, summary,
            keyPoints[5-8],
            architectureDecisions[{decision, rationale}],
            expectedQuestions[{question, suggestedAnswer}],
            filePaths[{path, description, action}],
            browserUrls[{url, description, action}],
            previousContext
          }

  ▼
[前端收到 meeting.prep_ready]
  ├─ 附件变: ✅ Meeting Prep — 调研完成
  ├─ 自动打开侧面板显示完整 brief
  ├─ 缓存到 localStorage
  └─ 500ms 后移除临时卡片, renderMeetings() 接管
```

### 3.2 加入会议流程 (joinMeeting)

```
用户点击 "Join Meeting"
  │
  ▼
POST /api/meeting/join { url }
  │
  ├─ Step 1: 配置音频桥 (meet_bridge)
  │   └─ bridge.sendConfigAndVerify({ audio_mode: "meet_bridge" })
  │
  ├─ Step 2: Playwright 快速加入 (无 AI)
  │   ├─ 导航到 Meet URL
  │   ├─ 关闭弹窗 (Got it, Cookie, Notification)
  │   ├─ 设置: camera OFF, mic ON (BlackHole 16ch)
  │   ├─ 设置: speaker = BlackHole 2ch
  │   └─ 点击 Join now / Ask to join
  │
  ├─ Step 3: 启动 admission monitor (3s 间隔)
  │   └─ 自动准入参会人 + 检测会议结束
  │
  ├─ Step 4: 启动 Voice AI (OpenAI Realtime)
  │   ├─ 注入 MEETING_PERSONA + Prep Brief
  │   └─ 音频: BlackHole 2ch (听) → Realtime → BlackHole 16ch (说)
  │
  └─ Step 5: 启动会议模块
      ├─ TranscriptAuditor (Claude Haiku 意图识别)
      ├─ ContextRetriever (知识空白填补)
      ├─ MeetingVision (Gemini Flash 截图分析, 1s)
      └─ Meeting recording (transcript)
```

### 3.3 会议结束流程

```
触发方式:
  A. 用户点击 "Leave" 按钮
  B. 主持人结束会议 (DOM 检测 "meeting has ended")
  C. CallingClaw 被踢出

  │
  ▼
Auto Leave / Manual Leave
  │
  ├─ 停止 admission monitor
  ├─ 停止 TranscriptAuditor + ContextRetriever
  ├─ 停止 MeetingVision + flush buffer to OpenClaw
  │
  ├─ 生成会议总结 (GPT-4o)
  │   ├─ title, participants, keyPoints
  │   ├─ decisions, actionItems, followUps
  │   └─ duration
  │
  ├─ 导出 markdown → meeting_notes/
  │
  ├─ 从 action items 创建 tasks
  │
  ├─ PostMeetingDelivery → Telegram
  │   ├─ 压缩 todo 列表 + ✅/❌ 按钮
  │   └─ 用户确认 → OpenClaw 执行
  │
  ├─ EventBus emit "meeting.ended"
  │   → Desktop UI 更新卡片为 "已结束"
  │   → 显示 "会后总结" 附件
  │
  └─ Voice AI 恢复 DEFAULT_PERSONA
```

### 3.4 Talk Locally 流程

```
用户点击 "Talk Locally"
  │
  ▼
POST /api/voice/start { audio_mode: "direct" }
  │
  ├─ 启动 Voice AI (直接麦克风/扬声器, 不通过 Meet)
  │
  ├─ 打开侧面板:
  │   ├─ 顶部: 实时截图 (2s 轮询)
  │   └─ 底部: Event Feed (WebSocket)
  │
  └─ 用户点击 "停止" → POST /api/voice/stop
```

---

## 4. 数据流

### 4.1 页面加载

```
Desktop 启动
  │
  ├─ IPC: daemon.status() → 检查 Bun 后端
  │   └─ Fallback: GET /api/status (HTTP 直连)
  │
  ├─ GET /api/status → 健康状态
  ├─ GET /api/calendar/events → Coming up 列表
  ├─ GET /api/meeting/notes → Past meetings 列表
  ├─ GET /api/tasks → 任务列表
  │
  ├─ localStorage: cc_prep_cache → 恢复 prep briefs
  │
  └─ WebSocket ws://localhost:4000/ws/events → 实时事件
```

### 4.2 EventBus 事件 → Desktop UI 映射

| EventBus 事件 | Desktop UI 效果 |
|--------------|-----------------|
| `meeting.agenda` | 刷新会议列表 |
| `meeting.started` | 卡片变 "进行中" + 红色脉冲 |
| `meeting.ended` | 卡片变 "已结束" + 会后总结可查看 |
| `meeting.prep_ready` | prep 附件变 ✅ + 自动打开侧面板 |
| `meeting.vision` | 侧面板截图更新 |
| `meeting.live_note` | Event Feed 显示实时笔记 |
| `meeting.context_pushed` | Event Feed 显示 context 推送 |
| `openclaw.delta` | Agent Activity Feed 实时更新 |
| `postmeeting.todos_sent` | 显示 todo 列表内容 |
| `postmeeting.todo_confirmed` | todo 状态更新 |
| `auditor.intent` | Event Feed 显示意图识别 |
| `retriever.complete` | Event Feed 显示知识检索 |
| `recovery.*` | 状态栏闪烁 |

### 4.3 持久化

| 数据 | 存储位置 | 用途 |
|------|----------|------|
| 用户邮箱 | `~/.callingclaw/user-config.json` | 自动邀请参会 |
| API Keys | `.env` | 各种 AI 服务 |
| Prep Briefs | `localStorage:cc_prep_cache` | Desktop 重启恢复 |
| 会议列表 | Google Calendar API | Coming up 列表 |
| 会议笔记 | `meeting_notes/*.md` | Past meetings |
| Tasks | `data/tasks.json` | 任务管理 |
| Chrome Profile | `~/.callingclaw/browser-profile/` | Google 登录状态 |

---

## 5. 设置面板

通过右上角 ⚙ 齿轮图标打开:

- **Setup Checklist** — 环境检查 (Bun, Python, BlackHole, Chrome)
- **Your Email** — 用户默认邮箱 (用于日历邀请)
- **API Keys** — OpenAI Key 状态
- **Voice Test** — 麦克风/扬声器测试
- **Logs** — 实时日志查看

---

## 6. 已知问题 & TODO

| 问题 | 状态 | 说明 |
|------|------|------|
| Prep 卡片闪退 | 🔧 修复中 | renderMeetings() 覆盖临时卡片 |
| OpenClaw 调研超时 | ✅ 已修 | TASK_TIMEOUT 改为 10 分钟 + 异步化 |
| Meet 链接 null | ✅ 已修 | createEvent 返回 JSON 字符串需 parse |
| 自然语言时间 | ✅ 已修 | OpenClaw 解析 "今晚八点" → ISO |
| 输入法 Enter 冲突 | ✅ 已修 | event.isComposing 检测 |
| Sidecar 频繁断连 | ✅ 已修 | PyAudio 线程池 + ping timeout 30s |
| 会议结束不检测 | ✅ 已修 | DOM 检测 + autoLeaveMeeting() |
| Chrome 启动时打开 | ✅ 已修 | Playwright lazy start |
| Icon 方形 | ✅ 已修 | 824x824 squircle + icns |
