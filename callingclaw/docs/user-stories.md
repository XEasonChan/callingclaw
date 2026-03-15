# CallingClaw 2.0 — 用户用例与用户故事

> CallingClaw 是一个拥有独立电脑的 AI 会议助手。它可以加入 Google Meet、用语音交流、
> 控制屏幕进行演示、记录会议笔记、创建任务，并通过 OpenClaw 代理执行复杂工作。

---

## 角色定义

| 角色 | 描述 |
|------|------|
| **用户 (User)** | CallingClaw 的主人，通过语音或面板控制 CallingClaw |
| **会议参与者 (Participant)** | 与 CallingClaw 同在一个 Meet 会议中的其他人 |
| **CallingClaw (Agent)** | AI 助手本体，拥有独立屏幕、音频和浏览器 |

---

## 场景一：会议汇报演示 (Presentation & Report)

### US-1.1 浏览器多 Tab 切换汇报
> **作为** 用户，**我想** 在会议中让 CallingClaw 打开多个浏览器标签页并按我的指令切换，
> **以便** 我可以语音控制幻灯片/页面的展示节奏，不需要自己操作电脑。

**验收标准:**
- [ ] 用户语音说"打开这三个链接"，CallingClaw 在 Chrome 中依次打开三个 Tab
- [ ] 用户说"切到第二个 Tab"或"下一个"，CallingClaw 切换对应标签
- [ ] 用户说"往下滚"，CallingClaw 在当前页面向下滚动
- [ ] 用户说"滚到顶部"，CallingClaw 回到页面顶部
- [ ] 屏幕共享状态下，会议参与者实时看到 Tab 切换和滚动
- [ ] Activity Feed 显示每次操作的实时状态

**推荐实现层:**
- Playwright MCP: `browser_tab_new`, `browser_navigate`, `browser_press_key(Ctrl+Tab)`, `browser_evaluate(window.scrollBy)`

---

### US-1.2 Figma 设计稿演示
> **作为** 用户，**我想** 让 CallingClaw 打开 Figma 设计稿链接并在会议中展示，
> **以便** 团队可以看到最新的设计，而我专注于讲解。

**验收标准:**
- [ ] 用户说"打开这个 Figma 链接"，CallingClaw 在浏览器中打开
- [ ] 用户说"放大右边的那个组件"，CallingClaw 在 Figma 中缩放/平移到对应区域
- [ ] 用户说"切到下一个 Frame"，CallingClaw 在 Figma 左侧面板点击下一个 Frame
- [ ] 用户说"全屏展示"，CallingClaw 按 Figma 的 Presentation mode (F 键) 进入演示
- [ ] 支持 Figma prototype 播放模式的前进/后退

**推荐实现层:**
- Playwright MCP: 导航和基础交互
- Computer Use (视觉 fallback): Figma Canvas 内的精确定位（Canvas 元素不在 DOM 中）

---

### US-1.3 Notion 文档走查
> **作为** 用户，**我想** 让 CallingClaw 打开 Notion 页面并按章节滚动展示，
> **以便** 我在会议中逐节讲解 PRD/技术方案。

**验收标准:**
- [ ] 用户说"打开 Notion 的这个页面"，CallingClaw 在 Chrome 中打开
- [ ] 用户说"滚到下一个标题"，CallingClaw 定位到页面中下一个 H1/H2
- [ ] 用户说"展开这个 toggle"，CallingClaw 点击 Notion 的折叠块
- [ ] 用户说"打开这个子页面"，CallingClaw 点击 Notion 内链跳转
- [ ] 支持在不同 Notion 页面间前进/后退

**推荐实现层:**
- Playwright MCP: Notion 是标准 Web 应用，DOM 可访问
- AgentQL: 语义化定位 Notion 元素（"下一个标题"这类自然语言查询）

---

### US-1.4 代码走查 (Code Walkthrough)
> **作为** 用户，**我想** 让 CallingClaw 在 VS Code 或 GitHub 上打开代码文件并滚动展示，
> **以便** 我在技术评审会议中展示代码变更。

**验收标准:**
- [ ] 用户说"打开这个 PR"，CallingClaw 在浏览器打开 GitHub PR 页面
- [ ] 用户说"看看文件变更"，CallingClaw 点击 Files changed Tab
- [ ] 用户说"跳到 config.ts 的修改"，CallingClaw 滚动到对应文件的 diff
- [ ] 用户说"在 VS Code 打开这个文件"，CallingClaw 用 `code` 命令打开
- [ ] 用户说"跳到第 120 行"，CallingClaw 在 VS Code 中 Ctrl+G 跳转

**推荐实现层:**
- Playwright MCP: GitHub Web 页面
- macos-automator-mcp: VS Code 控制 (AppleScript `tell application "Visual Studio Code"`)

---

## 场景二：会议全生命周期 (Meeting Lifecycle)

### US-2.1 自动加入即将开始的会议
> **作为** 用户，**我想** CallingClaw 在会议开始前 1 分钟自动加入 Google Meet，
> **以便** 我不需要手动操作，CallingClaw 已经在会议室等着了。

**验收标准:**
- [ ] CallingClaw 每分钟轮询 Google Calendar，检查未来 5 分钟内的会议
- [ ] 检测到有 Meet 链接的会议，自动执行 joinMeeting 流程
- [ ] 加入时自动关闭摄像头、静音麦克风
- [ ] 加入后语音通知用户："我已经加入了 [会议名称]"
- [ ] 如果用户说"不用加入这个会"，CallingClaw 跳过

**推荐实现层:**
- Google Calendar API (已有): 拿会议列表和 Meet URL
- MeetJoiner (已有): 加入流程

---

### US-2.2 会议中实时记笔记
> **作为** 用户，**我想** CallingClaw 在会议过程中自动记录要点、决策和待办事项，
> **以便** 会后我能直接拿到结构化的会议纪要。

**验收标准:**
- [ ] 会议开始后自动启动 transcript 录制
- [ ] 每 2 分钟自动提取 action items
- [ ] 检测到"跟进"、"待办"、"action item"等关键词时立即标记
- [ ] 会议结束时生成包含 要点/决策/待办/全文 的 Markdown 文件
- [ ] 待办自动创建为 TaskStore 中的任务

**推荐实现层:**
- MeetingModule (已有): transcript + GPT-4o 提取
- TaskStore (已有): 自动创建任务

---

### US-2.3 会后任务追踪
> **作为** 用户，**我想** CallingClaw 将会议中产生的任务自动同步到项目管理工具，
> **以便** 任务不会遗漏。

**验收标准:**
- [ ] 会议结束后，从 MeetingSummary.actionItems 自动创建任务
- [ ] 每个任务包含：描述、负责人、截止日期、来源会议
- [ ] 通过 EventBus webhook 推送任务到外部系统 (Notion, Linear, Jira)
- [ ] 用户可语音查询："这周会议产生了哪些待办？"

**推荐实现层:**
- TaskStore (已有) + EventBus webhook
- OpenClaw: 代理执行 Notion/Linear API 调用

---

## 场景三：实时信息检索 (Live Information Retrieval)

### US-3.1 会议中查找并展示资料
> **作为** 用户，**我想** 在会议中说"帮我找一下上周的竞品分析报告"，
> CallingClaw 立即搜索并打开对应文件，**以便** 讨论不中断。

**验收标准:**
- [ ] 用户语音描述需要的资料
- [ ] CallingClaw 搜索本地文件系统 / Google Drive / Notion
- [ ] 找到后自动在浏览器或 VS Code 中打开
- [ ] 如果正在共享屏幕，参与者立即看到
- [ ] 如果找不到，语音回复"没有找到匹配的文件"

**推荐实现层:**
- macos-automator-mcp: Finder 搜索 (`mdfind` Spotlight)
- Playwright MCP: 打开 Google Drive / Notion 搜索

---

### US-3.2 实时查数据回答问题
> **作为** 用户，**我想** 在会议中说"上个月的活跃用户数是多少"，
> CallingClaw 去数据看板查到数字并语音回答。

**验收标准:**
- [ ] 用户提出数据查询
- [ ] CallingClaw 打开预配置的数据看板 URL (Mixpanel, Grafana, etc.)
- [ ] 通过 Playwright 读取页面中的数据
- [ ] 语音回答："上个月活跃用户数是 12,450"
- [ ] 可选：共享屏幕让参与者看到看板

**推荐实现层:**
- Playwright MCP: `browser_navigate` + `browser_snapshot` 读取数据

---

### US-3.3 会议中打开日历查看时间安排
> **作为** 用户，**我想** 说"看看我明天下午有没有空"，
> CallingClaw 查询日历并语音回答。

**验收标准:**
- [ ] 用户语音询问日程
- [ ] CallingClaw 通过 Google Calendar API 查询（不需要截图）
- [ ] 语音回答："明天下午 2-3 点有 Design Review，3:30-4 点有 Standup，其他时间空闲"
- [ ] 如果用户说"帮我约明天下午 4 点的会"，直接调用 Calendar API 创建

**推荐实现层:**
- Google Calendar API (已有): 最快路径，<1 秒

---

## 场景四：屏幕共享演示控制 (Screen Sharing & Presentation)

### US-4.1 共享屏幕 + 语音导航
> **作为** 用户，**我想** 让 CallingClaw 共享它的屏幕，并通过我的语音指令控制展示内容，
> **以便** 我像有一个实时助手帮我操作幻灯片。

**验收标准:**
- [ ] 用户说"共享屏幕"，CallingClaw 在 Meet 中开始屏幕共享
- [ ] 用户说"打开演示文稿"，CallingClaw 打开 Google Slides / Keynote
- [ ] 用户说"下一页"，CallingClaw 翻到下一张
- [ ] 用户说"停止共享"，CallingClaw 结束屏幕共享
- [ ] 全程语音控制，不需要用户动手

**推荐实现层:**
- MeetJoiner.shareScreen (已有)
- Playwright MCP: Google Slides 翻页
- macos-automator-mcp: Keynote AppleScript 控制

---

### US-4.2 动态调整展示布局
> **作为** 用户，**我想** 在共享屏幕时让 CallingClaw 并排放置两个窗口进行对比，
> **以便** 会议参与者能同时看到设计稿和实现效果。

**验收标准:**
- [ ] 用户说"左边放 Figma，右边放浏览器"
- [ ] CallingClaw 将两个窗口分屏排列 (Split View)
- [ ] 用户说"把 Figma 放大"，CallingClaw 调整窗口大小
- [ ] 用户说"全屏浏览器"，CallingClaw 最大化浏览器窗口

**推荐实现层:**
- macos-automator-mcp: AppleScript 窗口管理 (`set bounds of window 1`)
- Peekaboo: `window` 命令 (move/resize/focus)

---

### US-4.3 多应用间快速切换
> **作为** 用户，**我想** 通过语音让 CallingClaw 在不同应用间快速切换，
> **以便** 汇报时能流畅地展示跨应用的工作流。

**验收标准:**
- [ ] 用户说"切到 Figma"，CallingClaw 激活 Figma 窗口
- [ ] 用户说"打开终端"，CallingClaw 激活/打开 Terminal
- [ ] 用户说"回到 Chrome"，CallingClaw 切回浏览器
- [ ] 切换延迟 < 1 秒
- [ ] 支持常见应用：Chrome, Figma, VS Code, Terminal, Finder, Notion, Slack

**推荐实现层:**
- macos-automator-mcp: `open_app` / AppleScript `activate`（即时，确定性）

---

## 场景五：异步任务执行 (Async Task Execution)

### US-5.1 会议中下达后台任务
> **作为** 用户，**我想** 在会议中说"帮我把这个方案写成 PRD 发到 Notion"，
> CallingClaw 在后台执行，不影响会议进行。

**验收标准:**
- [ ] 用户下达任务指令
- [ ] CallingClaw 语音确认"好的，我在后台处理"
- [ ] 通过 OpenClaw 代理执行写作 + 发布任务
- [ ] 完成后语音通知"PRD 已发布到 Notion"
- [ ] Activity Feed 实时显示后台任务进度

**推荐实现层:**
- OpenClaw Bridge (已有): 复杂文本生成任务
- EventBus: 进度通知

---

### US-5.2 会后自动执行 Follow-up
> **作为** 用户，**我想** CallingClaw 在会议结束后自动执行会议中分配的简单任务，
> **以便** 常规事务不需要我手动处理。

**验收标准:**
- [ ] 会议结束后，CallingClaw 分析 actionItems 中的可自动化任务
- [ ] 自动化任务示例：发邮件、创建日历事件、更新 Notion 文档、发 Slack 消息
- [ ] 需要判断的复杂任务保留为待办，语音提醒用户
- [ ] 每个自动执行的任务都记录在 TaskStore 中并标记完成

**推荐实现层:**
- OpenClaw Bridge: 执行写邮件/发消息等
- Google Calendar API: 创建后续会议
- macos-automator-mcp: 打开并操作 Mac 原生应用

---

## 场景六：日常语音助手 (Daily Voice Assistant)

### US-6.1 晨间简报
> **作为** 用户，**我想** 每天早上对 CallingClaw 说"今天有什么安排"，
> 它帮我总结当天日程和待办。

**验收标准:**
- [ ] CallingClaw 查询 Google Calendar 今日事件
- [ ] 查询 TaskStore 中的未完成任务
- [ ] 语音播报："今天有 3 个会议，第一个是 10 点的 Standup……你还有 2 个待办未完成"
- [ ] 如果有冲突会议，主动提醒

**推荐实现层:**
- Google Calendar API (已有)
- TaskStore (已有)

---

### US-6.2 快速操作电脑
> **作为** 用户，**我想** 通过语音让 CallingClaw 执行日常电脑操作，
> **以便** 我不需要走到 CallingClaw 的电脑前手动操作。

**验收标准:**
- [ ] "打开 Chrome 搜索 xxx" → 打开浏览器并搜索
- [ ] "截个屏" → 截图并保存
- [ ] "播放音乐" → 打开 Music.app 播放
- [ ] "把 xx 文件发给 xx" → 通过 Mail/Slack 发送
- [ ] "关闭所有窗口" → 关闭当前桌面所有窗口

**推荐实现层:**
- macos-automator-mcp: 系统级操作
- Playwright MCP: 浏览器操作

---

## 场景七：AI 辅助会议 (AI-Assisted Meeting with Fast/Slow Thinking)

### US-7.0 会议准备 Brief + AI 引导讨论
> **作为** 用户，**我想** 在开会前让 OpenClaw 帮我准备一份结构化的会议 Brief，
> 然后 CallingClaw 的语音 AI 用这份 Brief 来引导讨论、回答架构问题、操控屏幕演示，
> **以便** 我能够更自信、更高效地进行技术汇报。

**验收标准:**
- [ ] 用户说"帮我准备一下 CallingClaw PRD 的会议"
- [ ] OpenClaw (慢思考) 读取 MEMORY.md + PRD 文件 → 生成 MeetingPrepBrief
- [ ] Brief 包含: summary, keyPoints, architectureDecisions, expectedQuestions, filePaths, browserUrls
- [ ] Brief 注入 Voice AI 的 system prompt → Voice 知道讨论内容
- [ ] Voice AI 用 keyPoints 引导讨论："接下来我们看一下音频桥接的架构..."
- [ ] 参与者问"为什么用 BlackHole?"，Voice 参考 architectureDecisions 回答
- [ ] Voice 触发 Computer Use 打开 filePaths 中的文件进行演示
- [ ] 会中 OpenClaw 添加 live notes → pushContextUpdate → Voice 实时看到
- [ ] 任务完成后 Voice 播报 "[DONE] 已打开 PRD 文件"

**推荐实现层:**
- MeetingPrepSkill (meeting-prep.ts): 生成 Brief
- Voice Persona (voice-persona.ts): 注入 Brief + 动态 context push
- AutomationRouter L1-L4: 打开文件/URL

---

### US-7.0b 一键加入会议 + 语音 AI 参与
> **作为** 用户/Agent，**我想** 用一个 API 调用就能完成"启动 AI 语音 + 配置音频 + 加入会议"的全部流程，
> **以便** 不需要分步手动启动各个组件。

**验收标准:**
- [ ] `POST /api/meeting/join { url: "https://meet.google.com/xxx" }` 一次调用
- [ ] 自动启动 OpenAI Realtime voice session
- [ ] 自动配置 Python sidecar 为 meet_bridge 音频模式
- [ ] 自动打开 Chrome 加入会议（关闭摄像头、静音麦克风）
- [ ] 返回 `{ status: "in_meeting", voice: "connected", audio_mode: "meet_bridge" }`
- [ ] 支持 Google Meet 和 Zoom 两种平台

**推荐实现层:**
- config_server.ts: 集成 meeting/join 端点
- MeetJoiner: 平台自动检测 + 加入流程
- VoiceModule: 自动启动

---

## 场景八：多人协作场景 (Multi-party Collaboration)

### US-8.1 会议中代替用户演示
> **作为** 用户，**我想** 告诉 CallingClaw "帮我演示一下新功能的原型"，
> CallingClaw 自主打开原型页面，按照预设流程点击演示。

**验收标准:**
- [ ] 用户提供原型 URL 或文件路径
- [ ] CallingClaw 打开页面并共享屏幕
- [ ] CallingClaw 按预设脚本/用户实时指令操作原型
- [ ] 支持 Figma prototype、HTML prototype、Web 应用
- [ ] 用户可随时语音插入"等一下"、"回到上一步"

**推荐实现层:**
- Playwright MCP: Web 原型交互
- Computer Use: Figma prototype 模式（Canvas 内操作）

---

### US-8.2 会议中实时画图/标注
> **作为** 用户，**我想** 让 CallingClaw 在 Excalidraw/FigJam 中画示意图来辅助讨论，
> **以便** 会议参与者能看到可视化的概念。

**验收标准:**
- [ ] 用户说"画一个系统架构图"
- [ ] CallingClaw 打开 Excalidraw/FigJam 并开始绘制
- [ ] 用户说"加一个数据库组件在右边"，CallingClaw 添加元素
- [ ] 绘制过程通过屏幕共享实时展示
- [ ] 完成后自动保存/导出

**推荐实现层:**
- Excalidraw MCP (已配置): 生成图表
- FigJam MCP (已配置): `generate_diagram`
- Playwright MCP: 在 Web 版 Excalidraw 中操作

---

### US-8.3 多 Agent 协作 — CallingClaw + OpenClaw
> **作为** 用户，**我想** CallingClaw 在会议中接收需求，然后把编码任务分派给 OpenClaw 执行，
> **以便** 会议中讨论出的方案能立即开始开发。

**验收标准:**
- [ ] 用户说"让 OpenClaw 开始写这个功能"
- [ ] CallingClaw 通过 OpenClaw Bridge 发送任务
- [ ] Activity Feed 实时显示 OpenClaw 的执行进度（thinking → coding → testing）
- [ ] 完成后 CallingClaw 语音通知："OpenClaw 已经完成了，你要看看代码吗？"
- [ ] 用户说"看看"，CallingClaw 在 VS Code 中打开相关文件

**推荐实现层:**
- OpenClaw Bridge (已有): 任务分派
- EventBus (已有): 进度追踪
- macos-automator-mcp: 打开 VS Code 查看结果

---

## 自动化层选择矩阵 (AutomationRouter)

> 所有操作通过 `POST /api/automation/run` 自动路由，也可通过 Voice AI 语音触发。
> AutomationRouter 自动分类指令并选择最优层，失败时自动降级到下一层。

| 操作类型 | L1: Shortcuts | L2: Playwright MCP | L3: Peekaboo | L4: Computer Use |
|---------|:----:|:----:|:----:|:----:|
| 查日历 | ✅ 首选 | | | |
| 创建会议 | ✅ 首选 | | | |
| Zoom 控制 (mute/share/record) | ✅ 首选 | | | |
| Meet 控制 (mute/video) | ✅ 首选 | | | |
| 打开应用/URL | ✅ 首选 | | | |
| 浏览器 Tab 切换 | | ✅ 首选 | | |
| 浏览器滚动 | | ✅ 首选 | | |
| Notion 页面操作 | | ✅ 首选 | | |
| GitHub PR 浏览 | | ✅ 首选 | | |
| Google Slides 翻页 | | ✅ 首选 | | |
| Figma Canvas 操作 | | △ 部分 | | ✅ 兜底 |
| VS Code 打开文件 | | | ✅ 首选 | |
| 窗口分屏/大小调整 | | | ✅ 首选 | |
| 应用切换/Focus | | | ✅ 首选 | |
| Finder 文件搜索 | | | ✅ 首选 | |
| 系统设置/权限 | | | ✅ 首选 | |
| Excalidraw 画图 | | △ Web | | ✅ 兜底 |
| 非标准 GUI (游戏等) | | | | ✅ 唯一 |

**图例:** ✅ = 推荐首选 | △ = 部分支持 | (空) = 不适用
**降级链:** L1 失败 → L2 → L3 → L4 (自动)

---

## 优先级排序 (Implementation Roadmap)

### P0 — 核心会议+演示 ✅ 已完成基础架构
1. ✅ **US-7.0b** 一键加入会议 + 语音 AI 参与 (集成 meeting/join)
2. ✅ **US-2.2** 会议中实时记笔记 (MeetingModule + transcript)
3. ✅ **US-2.3** 会后任务追踪 (TaskStore + EventBus webhook)
4. ✅ **US-3.3** 查日历 (Google Calendar API)
5. **US-1.1** 浏览器多 Tab 切换汇报 (Playwright MCP 已集成)
6. **US-4.1** 共享屏幕 + 语音导航

### P1 — AI 辅助会议 (Fast/Slow Thinking)
7. **US-7.0** 会议准备 Brief + AI 引导讨论
8. **US-4.3** 多应用间快速切换
9. **US-1.3** Notion 文档走查
10. **US-1.4** 代码走查

### P2 — 完善演示 + 自动化
11. **US-4.2** 动态调整展示布局
12. **US-1.2** Figma 设计稿演示
13. **US-2.1** 自动加入即将开始的会议
14. **US-5.2** 会后自动执行 Follow-up

### P3 — 高级场景
15. **US-8.3** Multi-Agent 协作
16. **US-8.1** 代替用户演示原型
17. **US-8.2** 实时画图/标注
18. **US-3.2** 实时查数据
19. **US-6.1** 晨间简报
20. **US-5.1** 后台异步任务

---

_Generated for CallingClaw 2.0 — 2026-03-11_
