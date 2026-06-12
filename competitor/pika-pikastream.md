# Pika Labs — PikaStream Video Meeting 竞品档案

| 字段 | 内容 |
|------|------|
| **竞品名称** | Pika Labs — PikaStream Video Meeting（PikaStream 1.0 实时视频引擎 + Google Meet Skill） |
| **一句话定位** | 云端 AI 虚拟形象，以你的脸和声音加入 Google Meet 实时语音视频对话——目前是"最接近 CallingClaw 的 AI 参会者"竞品。 |
| **最近调研日期** | 2026-06-11 |
| **置信度说明** | 公司/融资数据来自 Sacra、VentureBeat、TechCrunch、Maginative，置信度高。产品规格来自 Pika 官方博客 + GitHub Skill + 多家测评，置信度中高（多为 Pika 单方面宣称，缺乏独立基准）。社媒粉丝数为不同时点快照，部分为 2024 旧数据，已标注。GitHub/Trustpilot 为 2026-06-11 实时核实。凡未能交叉验证者标注「未能核实」。 |

> 本档案在内部 2026-04-04《PikaStream 发布 48 小时舆情报告》基础上刷新至 2026-06-11。关键变化：**定价下调**、**GitHub 星标增长 6 倍**、**音频/语言 Bug 仍未修复**、**新增大量服务端不稳定 Issue**。

---

## 一、团队 / 公司

| 项目 | 内容 | 来源 |
|------|------|------|
| 公司 | Pika Labs（Pika） | — |
| 成立 | 2023 年 4 月 | Sacra |
| 总部 | 美国加州 Palo Alto | Sacra |
| 联合创始人 | **Demi Guo（郭文景，CEO）** + **Chenlin Meng（孟晨林，CTO）** | Sacra / FemWealth |
| 创始人背景 | 两人均为**斯坦福大学 AI 方向博士在读时退学创业**。Demi Guo 创业时 26 岁，被 Inc. 报道为"26 岁首次创业即融资 5500 万美元"。Chenlin Meng 在扩散模型/生成方向有学术积累。 | Inc. / Sacra / Fast Company |
| 业务定位 | 起家于文生视频（text-to-video），对标 Runway / Pika.art 创作工具；2025-07 推出 iPhone App，2026 年转向"AI Selves / AI Agents"消费社交方向。PikaStream 是其实时视频技术的延伸。 | Sacra / Fast Company |
| 用户规模 | 平台累计 50 万+ 用户，每周生成数百万条视频 | Sacra |
| 员工人数 | **未能核实**（公开资料未披露准确 headcount） | — |

**判断**：Pika 是一家以"消费级生成视频"起家的明星 AI 公司，PikaStream 会议形象更像是其实时模型能力的"开发者向技术展示 / 流量产品"，而非核心商业重心——这与 CallingClaw 把"会议生产力"作为唯一焦点形成根本差异。

---

## 二、融资 / 财务

| 轮次 | 金额 | 时间 | 领投/主要投资人 | 来源 |
|------|------|------|----------------|------|
| 种子 + Series A | 5500 万美元（合计） | 2023-11 | Lightspeed Venture Partners 领投；含天使阶段 | TechCrunch / VentureBeat / Lightspeed |
| Series B | 8000 万美元 | 2024-06 | Spark Capital 领投 | Maginative / VentureBeat |
| **累计** | **约 1.35 亿美元** | — | — | Sacra |

| 估值 | 内容 | 来源 |
|------|------|------|
| 2024 Series B 后 | **约 4.7 亿美元** | Sacra |
| 后续传闻 | 有报道称估值或达 **7 亿美元**（未坐实） | Sacra（标注为 "reports suggesting"） |

**主要投资人**：Lightspeed Venture Partners、Spark Capital、Greycroft，以及个人投资人 **Jared Leto（演员）**、**Adam D'Angelo（Quora 创始人 / OpenAI 董事）**。

**收入**：未公开披露（**未能核实**）。

---

## 三、产品功能 + 最新动态（时间线）

### 3.1 PikaStream 是什么

PikaStream 1.0 是一个**实时视觉引擎**，生成"身份一致的会说话虚拟形象"，用于实时视频通话。配套发布一个开源 **GitHub Skill（`pikastream-video-meeting`）**，让任意支持 Pika Developer API 的 AI Agent（Claude Code / OpenClaw / Cursor 等能读 `SKILL.md` 的）都能以虚拟形象加入 Google Meet。

### 3.2 技术规格

| 维度 | 规格 | 备注 |
|------|------|------|
| 渲染 | 单张 **H100 GPU** 云端渲染 | 相比旧 Pikaformance（8 GPU、~4.5s 延迟）大幅优化 |
| 帧率/分辨率 | **24 fps @ 480p** | progressiverobot 测评确认 480p |
| 延迟 | **约 1.5 秒**端到端（语音→视频） | Pika 官方宣称；快节奏对话中"可察觉" |
| 声音 | **声音克隆**（skill 内置 `clone-voice` 子命令，支持降噪）；历史资料指向 ElevenLabs 技术栈（**voice provider 当前未在官方文档明确，标注未能核实**） | 克隆声音长期不用会过期 |
| 记忆 | **持久记忆**，跨对话保持人格/上下文一致；支持会中切换身份数据而不中断流 | Pika 官方 |
| 上下文 | 从工作区文件合成进系统提示词 | SKILL.md |
| 平台 | **仅 Google Meet**（无 Zoom / Teams），Beta 状态 | — |
| 接入门槛 | 需 Pika Developer Key（`dk_` 开头，pika.me/dev）+ Python 环境 + 预充值余额，**仅面向开发者** | — |

### 3.3 定价（重要变化）

| 时点 | 价格 | 1 小时会议成本 |
|------|------|----------------|
| 2026-04 发布时 | **$0.50/分钟** | $30 |
| **2026-06-11 现状** | **$0.275/分钟**（GitHub Skill 页现价） | $16.5 |

定价较发布时**下调约 45%**，但仍属高价，且需预充值、加入前检查余额、余额不足直接生成付款链接。

### 3.4 时间线

| 日期 | 事件 | 来源 |
|------|------|------|
| 2026-04-02 | PikaStream 1.0 + Google Meet Skill 正式发布；官方 X 发布帖 + 博客；发布视频 **2M+ 播放** | Pika X / 官方博客 |
| 2026-04-03 | GitHub Issue **#2（中/日文语言设置）**、**#3（Bot 加入但不说话/无音频）** 同日提出 | GitHub |
| 2026-04-05 | Issue **#6 / #7**：每次加入 Google Meet 都 "Worker disconnected unexpectedly"（连续 3 次失败） | GitHub |
| 2026-04-06 | Issue **#9**：`AUTHENTICATION_FAILED / Invalid API balance` | GitHub |
| 2026-04-19 | progressiverobot 等媒体测评（确认 480p、1.5s 延迟、Beta 毛刺） | progressiverobot |
| 2026-04-23 | Issue **#12**：加入失败，后端拒绝 DevKey multipart | GitHub |
| 2026-05-03 | Issue **#13**："Propaganda"（疑似垃圾/抗议帖） | GitHub |
| **2026-06-09** | Issue **#14**：`POST /proxy/realtime/meeting-session` **全区域返回 HTTP 522**（新加坡 + 美国西海岸均复现，~21s 超时，连 1×1px 负载也报错），余额接口正常——**强烈指向会议服务端持续不稳定/宕机**，由港大用户 mollyzhou-hku 报告 | GitHub |
| 2026-06-11 | 调研当日：GitHub **1.1k stars / 173 forks / 8 个 open issues**；定价 **$0.275/min** | GitHub |

### 3.5 它做不到什么（对比 CallingClaw 的核心空白）

| 能力 | PikaStream | CallingClaw |
|------|-----------|-------------|
| 加入会议 | 可以（**仅云端 Google Meet**） | 可以（**本地**，Meet/Zoom） |
| 实时语音对话 | 可以（音频对部分用户失效，见 Issue #3） | 可以（稳定） |
| 虚拟形象/视频脸 | **可以**（这是其唯一独占优势） | 不做（聚焦干活） |
| **看到共享屏幕** | **不能** | 可以（Gemini Flash 实时视觉） |
| **控制电脑** | **不能** | 可以（5 层路由 + cliclick/osascript） |
| **共享屏幕/演示** | **不能** | 可以（自动屏幕共享 + Stage 工作台） |
| **语音打开文件** | **不能** | 可以（FileAliasIndex ~2ms） |
| 会议准备/研究 | 不能 | 可以（Agent 驱动 prep） |
| **中文支持** | **不能**（Issue #2 未解决） | 原生中英双语 |
| 本地运行/隐私 | **不能**（音视频全程上 Pika 云端 H100） | 可以（本地处理） |
| 部署门槛 | 仅开发者（API Key + Python + 充值） | 桌面 App，普通用户可用 |
| 成本 | $0.275/min（1h ≈ $16.5） | 仅 API 调用，约 $0.05–0.10/场 |

---

## 四、Marketing 账号

| 平台 | 账号 | 粉丝/规模 | 截至 | 来源/备注 |
|------|------|-----------|------|-----------|
| X（官方） | [@pika_labs](https://x.com/pika_labs) | 2024 年达 **10 万+**（2026 当前精确值**未能核实**） | 2024 | wifitalents |
| X（创始人） | [@demi_guo_](https://x.com/demi_guo_) | **约 25.5K** | 2026 | 搜索快照 |
| Instagram | [@pika_labs](https://www.instagram.com/pika_labs/) | **约 109K**（历史曾有"100 万+ reels"播放） | 2026 | 搜索快照 |
| TikTok | Pika Labs | 上线 3 个月达 **20 万** | 2024 | wifitalents（旧数据） |
| Discord | Pika 社区 | **50 万+ 成员** | 2024 | wifitalents（旧数据） |
| LinkedIn | [Demi G.（Co-Founder & CEO）](https://www.linkedin.com/in/demi-g-9a9ab6a1/) | 未披露 | — | LinkedIn |
| Facebook | [Pika_Labs](https://www.facebook.com/pikalabs/) | 未披露 | — | Facebook |
| YouTube | **未能核实**官方频道与订阅数 | — | — | — |

**说明**：Pika 的社媒体量主要来自其**消费级生成视频产品**（Instagram/TikTok/Discord），而非 PikaStream 会议形象。PikaStream 的传播集中在 X 上的开发者/AI 圈层。

---

## 五、Marketing 内容 / 策略

1. **X 病毒式发布（launch playbook）**：2026-04-02 官方 [@pika_labs 发布帖](https://x.com/pika_labs/status/2039804583862796345) + 配套 demo 视频，**2M+ 播放**。话术核心："Conversations tend to go better with a face and a voice"——主打"会说话的脸"。
2. **品类创造（category creation）**："the first video chat skill for ANY agent"——抢占"**AI 加入你的会议 / AI 作为参会者**"心智。这一步是其对行业最大的贡献，也直接为 CallingClaw 做了**市场教育**。
3. **开发者杠杆**：开源 GitHub Skill，让 Claude Code / OpenClaw / Cursor 等任意 Agent 接入——把"任何 Agent 都能长出一张脸进会议"作为传播钩子，借开发者社区二次扩散。
4. **行业媒体接力**：InterestHive、AlternativeTo、Superhuman、progressiverobot、Blue Lightning、Efficienist 等多家在 4 月集中报道，统一框定为"AI 进入'参会者'品类"。
5. **创始人 IP + 名人投资人背书**：Demi Guo 个人故事（斯坦福退学、26 岁女性创始人）+ Jared Leto / Adam D'Angelo 投资人光环，持续供给媒体叙事。

---

## 六、评论区反馈

### 6.1 GitHub Issues（2026-06-11 实时核实，全部仍 Open）

| # | 标题 | 状态 | 提出人/日期 | 含义 |
|---|------|------|------------|------|
| #2 | 如何设置数字人语音的语言（中/日文）? | **仍 Open，未解决** | Hansuku / 2026-04-03 | **非英语市场仍被排斥**——这正是 CallingClaw 的中文卖点缺口 |
| #3 | Bot 加入 Google Meet 但不说话/不响应音频 | **仍 Open，未修复** | eboziev（macOS arm64）/ 2026-04-03 | **核心音频 Bug 发布两个多月后仍未解决** |
| #6 | 加入 Google Meet 时 "Worker disconnected"（连续 3 次） | Open | krishome / 2026-04-05 | 加入稳定性差 |
| #7 | 每次加入都 "Worker disconnected unexpectedly" | Open | rafa-ctrl / 2026-04-05 | 同上 |
| #9 | `AUTHENTICATION_FAILED / Invalid API balance` | Open | liyaxuan / 2026-04-06 | 计费/鉴权问题 |
| #12 | 加入失败：后端拒绝 DevKey multipart | Open | iamjoshwilliam / 2026-04-23 | 接入链路 Bug |
| #13 | "Propaganda" | Open | 2026-05-03 | 疑似垃圾/抗议帖 |
| #14 | meeting-session 接口**全区域 HTTP 522** | Open | mollyzhou-hku / **2026-06-09** | **会议服务端持续宕机/不稳定（调研前 2 天）** |

> **结论**：发布时的两大致命缺陷（#2 中文、#3 无音频）至今**双双未修**；且 4 月以来不断新增**服务端稳定性 Issue**，最近一条（#14）就在两天前——说明 PikaStream 仍处于不可靠的 Beta 状态。

### 6.2 Trustpilot（pika.art，2026-06-11 核实）

| 指标 | 数值 |
|------|------|
| TrustScore | **1.7 / 5**（历史报道 1.6，基本持平偏低） |
| 评论数 | 约 **49 条** |
| 一星占比 | **86%**（5★ 8% / 4★ 4% / 3★ 0% / 2★ 2%） |

> 注意：Trustpilot 评价针对 Pika 整体（主要是其消费级视频生成产品的**积分系统混乱、扣费失败仍计费、退订困难、客服几乎不回**），并非专门针对 PikaStream。但反映了 Pika 在**计费透明度与客服**上的系统性口碑问题，PikaStream 的 $0.275/min 预充值模式很可能复制同样的体验风险。

**代表性差评（计费/客服）**："confusing credit system, failed generations still costing credits, near-absent customer support"；"charged after they've canceled and finding it nearly impossible to stop their subscription"。

### 6.3 X / 媒体反应

**正面（发布期）**：
- @HeyToha："This is actually crazy... it literally joined like a human. Face-to-face convo, remembers things, keeps personality... this feels different"
- @tomosman："Zero-human company tech! ...not only hold video calls but also perform actions on the call too"
- @roastedtwit_："Pika just launched something that feels like it's from 2030"
- InterestHive："PikaStream is trying to move AI into the 'participant' category"

**负面/质疑**：
- AlternativeTo 引用的最尖锐评论："Well, it took many years but we've finally have stupider and uglier than the metaverse. It's not because it's technically possible than it must exist."（比元宇宙还蠢还丑）
- progressiverobot 测评：Beta 存在"glitches, quality variance, and workflow friction"；独立基准缺失，"claims come from Pika only"；并提出**冒充风险、知情同意、会议礼仪**的伦理担忧。
- AlternativeTo / Efficienist 等普遍点出：**只是一张脸，看不到屏幕、控制不了电脑**。

---

## 七、对 CallingClaw 的威胁评估

### 7.1 威胁等级：中（战略意义 > 直接产品竞争）

**Pika 不是直接抢用户的对手，而是帮 CallingClaw 完成了品类教育的"先驱"。** 它把"AI 作为会议参会者"这个概念在 X 和媒体上彻底引爆（2M+ 播放、十余家媒体报道），让市场第一次理解"AI 可以加入会议并说话"。但它在产品上留下的空白，几乎逐条对应 CallingClaw 的强项。

### 7.2 Pika 的护城河（CallingClaw 不碰的地方）

- **会说话的虚拟人脸**：这是 PikaStream 唯一的独占能力，背后是 Pika 1.35 亿美元融资 + 实时视频模型积累。CallingClaw 明确不做"脸"，聚焦"干活"。
- **品牌与流量**：Pika 有 10 万+ X、50 万 Discord、名人投资人背书——传播声量远超早期 CallingClaw。

### 7.3 CallingClaw 的可攻击缺口（逐条对应）

| Pika 缺口 | CallingClaw 填补 | 一句话攻击点 |
|-----------|------------------|--------------|
| 看不到共享屏幕（瞎子） | Gemini Flash 实时视觉 | "加入会议却看不见演示文稿的 AI，等于闭眼开会的同事。" |
| 控制不了电脑 | 5 层路由电脑控制 | "你的 AI 不只在会上聊天，它在动手干活。" |
| 不能共享屏幕/打开文件 | 自动屏幕共享 + FileAliasIndex（~2ms） | "说出文件名，它就已经打开了。" |
| 不支持中文（Issue #2 未修） | 原生中英双语 | "为 Pika 遗忘的团队而生。" |
| 纯云端、音视频上传 Pika 服务器 | 本地运行 | "你的会议留在你的电脑上，不是我们的服务器上。" |
| $0.275/min（1h≈$16.5）+ 预充值 | 仅 API 成本，约 $0.08/场 | "这场会议花了 $0.08。Pika 要 $16.5。" |
| 核心音频 Bug #3 / 服务端 522（#14）长期不稳 | 本地音频管线，无云端单点 | "它两个月还没修好'不出声'。我们的不靠它的服务器。" |
| 仅开发者可用（API Key + Python） | 桌面 App，开箱即用 | "不用写 Python，也不用充值。" |

### 7.4 行动建议（GTM 摘要）

1. **借势不踩踏**：公开承认 Pika 做了品类教育，定位 CallingClaw 为"下一步"——"Pika 让 AI 进了会议，CallingClaw 让它真正干活"。
2. **现在是窗口期**：Pika 核心 Bug（#3 音频、#2 中文）超过 2 个月未修 + 最近服务端 522 宕机，可在开发者社区（HN / X）以"稳定、本地、能看屏能动手"切入，承接其失望用户。
3. **主打三件 Pika 永远做不到的**：屏幕视觉 + 电脑控制 + 本地隐私；辅以中文与成本两张差异牌。
4. **避免硬刚"脸"**：不要在虚拟形象赛道与 Pika 正面竞争；用"我们不需要一张假脸，我们需要会干活的 AI"重构话术。

---

## 信息来源

**公司 / 融资**
- Sacra — Pika 估值/融资/团队：https://sacra.com/c/pika/
- VentureBeat — Pika 融资 5500 万美元：https://venturebeat.com/ai/pika-labs-raises-55m-launches-new-ai-video-platform-to-take-on-runway
- TechCrunch — Pika 5500 万美元 A 轮：https://techcrunch.com/2023/11/28/pika-labs-which-is-building-ai-tools-to-generate-and-edit-videos-raises-55m/
- Maginative — Pika 8000 万美元 B 轮：https://www.maginative.com/article/pika-labs-secures-80m-in-series-b-funding/
- Lightspeed — Pika 投资页：https://lsvp.com/company/pika/
- Inc. — Demi Guo 26 岁融资 5500 万：https://www.inc.com/ben-sherry/how-this-26-year-old-first-time-founder-raised-55-million-for-her-ai-startup.html
- Fast Company — Demi Guo 专访：https://www.fastcompany.com/91396771/pika-demi-guo-social-ai-video-app
- FemWealth — Demi Guo & Chenlin Meng 8000 万：https://femwealth.substack.com/p/demi-guo-and-chenlin-mengs-pika-secures
- Tracxn — Pika 公司档案：https://tracxn.com/d/companies/pikalabs/__2zhxvsK8_xk3FaRpKNAgYL0SN_8TY86kzTFfILNVtNE

**产品 / 技术 / 时间线**
- Pika 官方博客 — Introducing Real-Time Video Chat for Agents：https://www.pika.me/blog/introducing-real-time-video-chat
- Pika 平台首页：https://www.pika.me/
- 官方 X 发布帖：https://x.com/pika_labs/status/2039804583862796345
- GitHub — Pika-Labs/Pika-Skills（1.1k stars / 173 forks / 8 open issues / $0.275/min，2026-06-11）：https://github.com/Pika-Labs/Pika-Skills
- GitHub Issues 列表（#2、#3、#6、#7、#9、#12、#13、#14 状态）：https://github.com/Pika-Labs/Pika-Skills/issues
- GitHub Issue #14（meeting-session 全区 522，2026-06-09）：https://github.com/Pika-Labs/Pika-Skills/issues/14
- progressiverobot — PikaStream 1.0 测评（480p / 1.5s / H100 / Beta 缺陷）：https://www.progressiverobot.com/2026/04/19/pikastream-1-0/
- AlternativeTo — 发布报道 + 批评引用：https://alternativeto.net/news/2026/4/pika-labs-launches-real-time-video-chat-with-an-ai-avatar-version-of-yourself-in-meetings/
- Superhuman — PikaStream 报道：https://www.superhuman.ai/p/pikastream-video-chat-with-your-ai
- Efficienist — Pika 让你视频通话你的 AI：https://efficienist.com/pika-labs-now-lets-you-video-call-your-ai-agent/
- Blue Lightning — PikaStream Beta 报道：https://bluelightningtv.com/2026/04/05/pikastream-beta-brings-real-time-video-agents/
- pika-art.net — PikaStream 接入指南（SKILL.md / clone-voice / dk_ Key）：https://pika-art.net/pikastream/

**社媒 / 口碑**
- 官方 X：https://x.com/pika_labs
- 创始人 X（Demi Guo）：https://x.com/demi_guo_
- Instagram：https://www.instagram.com/pika_labs/
- LinkedIn（Demi G.）：https://www.linkedin.com/in/demi-g-9a9ab6a1/
- wifitalents — Pika 社媒/统计数据：https://wifitalents.com/pika-ai-statistics/
- Trustpilot — pika.art（1.7★ / 49 评 / 86% 一星，2026-06-11）：https://www.trustpilot.com/review/pika.art
- 内部报告 — CallingClaw GTM《PikaStream 发布 48 小时舆情》(2026-04-04)：CallingClaw GTM/competitive-intelligence-pika-pikastream-april-2026.md
