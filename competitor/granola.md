# Granola (granola.ai)

> **一句话定位**：面向"背靠背开会"人群的 AI 笔记本 —— 在 Mac/Windows 本地监听系统音频，**不派机器人入会**，把你自己潦草的笔记增强成结构化纪要。
>
> **最近调研日期**：2026-06-11
>
> **置信度说明**：融资、估值、产品时间线、社媒账号均来自一手/权威来源（TechCrunch、Bloomberg、Granola 官网 updates、官方 LinkedIn），置信度高。粉丝数、员工数、ARR、评分为"截至某日"的快照，会随时间变化，已逐项标注 as-of 日期。凡未能核实的数据均明确标注"**未能核实**"，不做臆测。

---

## 1. 团队 / 创始人

| 项目 | 内容 | 来源 |
|------|------|------|
| 成立时间 | 2023 年 | TechCrunch / BusinessCloud |
| 总部 | 英国伦敦（68 Hanbury St, London, E1 5JL） | 官方 LinkedIn |
| 员工数 | LinkedIn 标注 "11–50 人"；第三方（getlatka）称截至 2026-05-31 约 **116 人** | LinkedIn / getlatka（116 这一数字未在官方一手来源核实） |

**联合创始人**

- **Chris Pedregal（CEO）**：斯坦福计算机科学背景，曾在 Google 任产品经理，参与过 Gmail、Search、Maps。2013 年离职创办 AI 教育产品 **Socratic**（高中生 AI 辅导），2018 年被 **Google 收购**。
- **Sam Stephenson（设计/产品）**：英国 Falmouth 平面设计出身，曾在旧金山设计公司、教育非营利组织工作，后加入笔记创业公司 **Ideaflow**。

> 二人是典型的"产品 + 设计"双核组合，这也是 Granola 一贯被夸"设计精致、克制"的根源。

**其他关键人物**

- **Jack Cully** —— 创始市场营销（founding marketer / PMM），主导了爆款 "Crunched" 年度回顾营销。

来源：Lightspeed 博客、Digital Frontier 访谈、BusinessCloud。

---

## 2. 融资 / 财务

| 轮次 | 时间 | 金额 | 估值 | 领投 / 主要投资人 | 来源 |
|------|------|------|------|------------------|------|
| Seed | 2023-05 | $4.25M | 未披露 | **Lightspeed** + betaworks | Lightspeed / 多家媒体 |
| Series A | 2024-10 | $20M | 未披露（当时约 5,000 周活） | Lightspeed（持续） | TechCrunch |
| Series B | 2025-05 | **$43M** | **$250M** | NFDG（Nat Friedman & Daniel Gross）；Lightspeed、Spark Capital 跟投 | TechCrunch |
| Series C | 2026-03-25 | **$125M** | **$1.5B**（独角兽） | **Index Ventures（Danny Rimer 领投）** + Kleiner Perkins（Mamoon Hamid）；Lightspeed、Spark、NFDG 跟投 | TechCrunch / Bloomberg / 官方博客 |

- **累计融资**：约 **$192M**（截至 2026-03）。
- **估值跃迁**：不到一年从 $250M → $1.5B，**6 倍**增长。
- **收入增长**：Series C 公告披露 **250% 营收增长**（具体 ARR 金额官方未公开；arr.club 等第三方页面无法访问/**未能核实**具体数字）。
- **用户数**：官方一直未公开总用户数；早期曾提"自上线以来周活约 10% 周增长"，Series A 时约 5,000 周活。当前总用户数 **未能核实**。

---

## 3. 产品功能 + 最新动态（时间线）

### 核心定位与"无机器人"哲学（关键差异点）

Granola 最核心的卖点：**它不像 Otter/Fireflies/Zoom AI 那样派一个"bot 参会者"进会议**。它是一个本地 Mac/Windows 桌面应用，**直接捕获你电脑的系统音频**（system audio），在本地转写，然后用 GPT / Claude 等大模型把**你自己敲的潦草笔记**增强成干净的结构化纪要（要点、决策、行动项、关键引述）。

设计哲学（来自 Lightspeed 访谈）：

- "**你的笔记，而不是机器人的笔记**"——AI 辅助人的思考，而非替代。
- 极简、隐形的 AI，"简单、不挡道"，刻意避免功能臃肿。
- 不自建底层基础设施，借用第三方大模型；早期甚至**故意不死磕实时转写准确率**，把精力押在总结质量上。

### 核心功能

- 会议本地转写（跨 Zoom / Meet / Teams / Webex，无需 bot；支持 10+ 语言、会中切换语言）。
- AI 把人工笔记 + 转写合成为结构化纪要（"Notion 风格"可编辑界面）。
- **跨会议 AI Chat**：用自然语言在历史会议中检索/提问，可保存为 "Recipes"（常用提示词模板）。
- **文件夹 / Folders**、Team Folders 共享上下文。
- **Spaces**（2026）：带细粒度权限的团队工作区。
- 个人 API / 企业 API、**MCP server**（把会议上下文接入更广的 AI 工作流）。
- 集成：Zapier（8,000+ 应用）、Attio、Slack、Microsoft（Teams/Outlook 登录）、Google Workspace 日历。
- 合规：2025-07 拿到 **SOC 2 Type 2**。
- **重要**：Granola **只生成文字转写，不录制音视频**——这是它弱化隐私顾虑的卖点之一。

### Granola **不具备**的能力（对比 CallingClaw）

| 能力 | Granola | CallingClaw |
|------|---------|-------------|
| 实时**开口说话**参与会议 | ❌ 否（纯被动监听+记笔记） | ✅ 是 |
| 以**参会者身份**加入 Meet/Zoom | ❌ 否（刻意不派 bot） | ✅ 是 |
| **看共享屏幕** / 视觉理解 | ❌ 否 | ✅ 是（VisionModule） |
| **控制电脑 / 执行动作** | ❌ 否（只读笔记+检索） | ✅ 是（ComputerUse） |
| 本地优先 / Mac 原生 | ✅ 是 | ✅ 是 |
| 双语 EN/中文 | ✅ 支持 10+ 语言 | ✅ 是 |

> **结论**：Granola 是"被动的本地笔记增强器"，CallingClaw 是"主动的本地会议 Agent"。二者本地优先哲学最接近，但能力边界完全不同。

### 更新时间线（2025–2026，来自官方 updates 页）

| 日期 | 更新 |
|------|------|
| 2025-05-14 | **Granola 2.0**：团队协作 + 统一对话空间 |
| 2025-05-22 | 10 语言支持、会中多语种切换 |
| 2025-06-05 | 文件上传 |
| 2025-06-11 | **Windows 应用上线** |
| 2025-07-07 | **SOC 2 Type 2** 合规 |
| 2025-07-14 | Team Folders 共享上下文 |
| 2025-07-24 | Chat 自然语言改写笔记 |
| 2025-07-28 | Zapier 连接（8,000+ 应用） |
| 2025-09-08 | People & Companies 视图、Attio + Zapier 集成 |
| 2025-09-15 | 电话通话转写 |
| 2025-09-17 | "Shared with me" 团队协作视图 |
| 2025-09-30 | **Recipes**（重建的 Chat 中保存 AI 提示词） |
| 2025-12-04 | "Granola Crunched" 年度回顾 |
| 2025-12-19 | @Mentions、笔记回收站（删除/恢复） |
| 2025-12-22 | "Heads Up"（在 Labs 中，提示对方正在使用 Granola 的透明度功能） |
| 2026-01-15 | **Microsoft 登录**（Teams / Outlook 用户） |
| 2026-01-16 | Slack 复制粘贴优化、日历权限弹窗刷新 |
| 2026-02（约） | **更新版 MCP server**（支持共享笔记） |
| 2026-03-25 | **Series C $125M / $1.5B**，同步推出 **Spaces**、个人/企业 API、文件夹 |
| 2026-04（约） | 企业版"全组织消息提醒参会者正在使用 Granola"（pilot 阶段） |

平台覆盖：**Mac、Windows、iPhone**。**截至 2026-06 仍无 Android 应用**（用户高频抱怨点）。

---

## 4. Marketing 账号

| 平台 | 账号 | 粉丝/订阅 | as-of | 来源/备注 |
|------|------|-----------|-------|-----------|
| X / Twitter | [@meetgranola](https://x.com/meetgranola) | **未能核实**具体数字（活跃发产品更新） | 2026-06 | x.com |
| LinkedIn | [meetgranola](https://uk.linkedin.com/company/meetgranola) | **54,493** 关注 | 2026-06-11 | 官方 LinkedIn |
| YouTube | [@meetgranola](https://www.youtube.com/@meetgranola) | **未能核实**订阅数 | 2026-06 | 频道简介："The AI notepad for people in meetings" |
| 创始人 X | [@cjpedregal](https://x.com/cjpedregal)（Chris Pedregal） | **未能核实** | 2026-06 | 创始人亲自发产品演示，founder-led |
| TikTok | **未找到**官方账号 | — | — | 未能核实是否存在 |
| Instagram | **未找到**官方账号 | — | — | 未能核实是否存在 |

> 注：LinkedIn 54k 关注与"11–50 员工"标注并存，说明品牌影响力远大于团队规模——典型的产品自带传播型公司。

---

## 5. Marketing 内容 / 策略

**定位 / 调性**

- 高端、设计驱动（design-forward），克制极简。
- 核心 messaging：**"你的笔记，不是机器人的笔记"**、"jetpack for the mind（思维的喷气背包）"、"简单、不挡道"。
- 刻意走"专注做好一件事"路线——创始人原话：低频、非关键场景"会被 ChatGPT/Claude 吃掉"，所以 Granola 只死磕"会议笔记"这一个高频痛点。

**增长打法**

- **Founder-led growth**：CEO Chris Pedregal 亲自上播客、做演示、对接媒体；创始市场人 Jack Cully 主导 PMM。
- **产品自传播**：在 Twitter/LinkedIn 的科技圈"自来水"口碑极强（HN/X 上大量自发安利）。
- **"Crunched" 病毒营销**（2025 年底）：把用户自己的会议数据做成 Spotify Wrapped 式年度回顾，"scrappy、AI 驱动、极易分享"，在 Twitter/LinkedIn 一夜刷屏，带来数百万次自然曝光。官方还专门发博客复盘"Crunched 背后的提示词怎么写"。
- 内容类型：产品博客（含工程/提示词复盘）、播客访谈、年度回顾互动玩法、企业页面 + ROI 计算器。

**定价**（截至 2026-06，第三方汇总，官方 pricing 页为准）

| 计划 | 价格 | 说明 |
|------|------|------|
| Basic（免费） | $0 | 无限会议，历史保留有限 |
| Individual | ~$18/用户/月 | 个人专业用户 |
| Business | ~$14/用户/月 | 集中计费、团队协作 |
| Enterprise | $35+/座席/月 | SSO、全组织 AI 训练 opt-out、优先支持 |

> 注：不同第三方对 Individual/Business 价位描述略有出入（$14–$35），且 Granola **不提供年付折扣**。具体以官网 granola.ai/pricing 为准。

---

## 6. 评论区反馈

### 评分快照（as-of 2026 上半年）

| 平台 | 评分 | 评论数 | 来源 |
|------|------|--------|------|
| G2 | 4.8–5.0 / 5 | 约 11–21 条（数量少，仍在增长） | G2 |
| Product Hunt | 4.8 / 5 | 37 条 | tldv 汇总 |
| 综合（tldv 计算） | 4.85 / 5 | 48 条 | tldv |
| Capterra / Trustpilot | **未收录** | — | 这两个平台尚无 Granola 条目 |
| Mac App Store | **未能核实**具体星级 | — | 未找到可靠数字 |

### 正面评价（代表性引述）

- **无 bot 是第一大转换理由**：客户面对面场景里"会议室里多个机器人"是真实社交摩擦点，Granola 去掉了它。
  > Reddit 用户："I use Granola on my Mac and love it. It has seamlessly logged onto all my meetings without sending a bot. And the transcription is great. I find myself referring to the notes a lot."
- 笔记质量获赞：人工+AI 混合产出"用户真的会回头看"，不像生转写堆着没人读。
- **设计师同行背书**（Linear CEO Karri Saarinen）：
  > "for me, @meetgranola was one of those things that just clicked instantly. It's seamless and very purpose-built... a focused app that sits on the side."
- "This app is perfect. Best AI note taker I've used."（附带吐槽价格"steep"）

### 负面 / 常见抱怨

- **无说话人识别**：转写"像两个没名字的人发短信"，缺 speaker labels。
- **无音频回放**：只有文字，转写出错没法回去听原音。
- **集成不足**：原生 CRM/Google Docs 自动化弱，很多事要靠 Zapier 兜底；笔记容易"孤岛化"，进不了现有工作流（多个 Reddit 讨论的高频痛点）。
- **无 Android**：限制团队全员采用（非全 Apple/Windows 团队）。
- **Google Workspace 依赖**：早期需 Workspace 邮箱，个人 Gmail 支持模糊，被用户称为"必须解决的问题"。
- **默认拿数据训练 AI**：除非 Enterprise 计划，否则默认用会议数据训练模型——隐私敏感点。
- **隐私/合规灰区**：由用户自己负责告知对方"正在被转写"，在部分法域未经同意转写可能违法（Granola 强调自己不录音视频以降低风险，并推出 "Heads Up"/全组织提醒功能缓解）。
- **转写准确率**：被指约 90–92%，数字/技术术语易错，低于部分竞品。
- **UI 偏灰、价格偏贵**（部分评测吐槽 "gray on gray"，与"设计精致"形象有出入；价格观感"steep"）。

---

## 7. 对 CallingClaw 的威胁评估

**威胁等级：中—高（哲学最接近的"本地优先 / 无 bot"竞品，但能力维度错位）**

- **为什么直接竞争**：两者都是 **macOS 本地优先**、都强调隐私/本地处理、都做会议笔记与跨会议检索。Granola 是这一赛道**心智最强、口碑最好、资本最足**（$1.5B 独角兽、Index/Lightspeed/Kleiner 背书）的玩家，且正从"笔记工具"向"企业上下文/AI Agent 平台"扩张（Spaces、API、MCP server），扩张方向**正在逼近 CallingClaw 的 Agent 定位**。

- **CallingClaw 的护城河（Granola 做不到的）**：
  1. **会开口说话**——实时语音参与会议；Granola 纯被动监听。
  2. **以参会者身份入会**——Granola 刻意"永不派 bot"，这是它的卖点也是它的天花板：它永远只能"旁听+整理"，不能"代表你发言/应答"。
  3. **看共享屏幕 + 视觉理解**——Granola 无视觉能力。
  4. **控制 macOS、执行动作**——Granola 只读不动手。
  5. 真正的"会议 Agent"而非"笔记本"。

- **Granola 的优势（CallingClaw 要警惕的）**：
  1. **品牌与口碑**：科技圈自来水、设计师社区背书、"Crunched"病毒营销。
  2. **资本与企业渗透**：Vanta、Gusto、Asana、Cursor、Lovable、Mistral、Decagon 等企业客户。
  3. **极简体验门槛低**：装上就能用、"不挡道"，没有"机器人入会"的社交尴尬——而 CallingClaw"以参会者身份加入"恰恰可能触发同样的社交摩擦/合规顾虑。
  4. 平台更全（Mac+Windows+iPhone），CallingClaw 目前仅 macOS。

- **定位建议**：
  - 不要在"被动笔记"上正面硬刚 Granola（它已赢心智）；强调 CallingClaw 是**"会说话、会看屏、会动手的会议 Agent"**，把 Granola 框定为"高级速记本"。
  - 借鉴 Granola 的成功要素：**设计克制 + founder-led + 病毒式年度回顾营销 + 本地隐私叙事**。
  - 警惕 Granola 借 API/MCP/Spaces 向 Agent 化扩张——这是未来 12 个月的正面交锋方向。
  - 主动解决"以参会者身份入会"的合规/社交摩擦（透明告知、可选隐身模式），否则 Granola 会用"我们不派 bot"持续攻击。

---

## 信息来源

- TechCrunch（Series C，$125M / $1.5B，2026-03-25）：https://techcrunch.com/2026/03/25/granola-raises-125m-hits-1-5b-valuation-as-it-expands-from-meeting-notetaker-to-enterprise-ai-app/
- TechCrunch（Series B，$43M / $250M，2025-05-14）：https://techcrunch.com/2025/05/14/ai-note-taking-app-granola-raises-43m-at-250m-valuation-launches-collaborative-features/
- Bloomberg（$1.5B 估值）：https://www.bloomberg.com/news/articles/2026-03-25/ai-notetaker-granola-hits-1-5-billion-value-in-125-million-funding
- Granola 官方博客（Series C）：https://www.granola.ai/blog/series-c
- Granola 官方更新日志：https://www.granola.ai/updates
- Granola 官方定价页：https://www.granola.ai/pricing
- Granola 官方企业页：https://www.granola.ai/enterprise
- Granola 官网首页：https://www.granola.ai/
- Lightspeed 博客（Generative London / 定位与哲学）：https://lsvp.com/stories/generative-london-how-to-win-ais-app-layer-with-granola/
- Digital Frontier 创始人访谈：https://digitalfrontier.com/articles/granola-ai-note-taking-interview
- BusinessCloud（2023 成立 / 英国独角兽）：https://businesscloud.co.uk/news/granola-founded-in-2023-becomes-latest-uk-unicorn/
- Sifted（独角兽 / Series C）：https://sifted.eu/articles/ai-notetaking-startup-granola-hits-unicorn-status
- Reworked（$125M / 企业上下文工具）：https://www.reworked.co/digital-workplace/granola-raises-125m-launches-enterprise-context-tools/
- 官方 LinkedIn（关注数 / 员工数 / 总部）：https://uk.linkedin.com/company/meetgranola
- 官方 X / Twitter：https://x.com/meetgranola
- 创始人 X（Chris Pedregal）：https://x.com/cjpedregal
- 官方 YouTube：https://www.youtube.com/@meetgranola
- tldv 评测（评分 / 优缺点 / 用户引述）：https://tldv.io/blog/granola-review/
- G2 评论：https://www.g2.com/products/granola/reviews
- Efficient App 评测：https://efficient.app/apps/granola
- Product Marketing Adventures（PMM / Crunched 营销复盘）：https://www.productmarketingadventures.com/podcast/granola
- Granola 博客（Crunched 2025 提示词复盘）：https://www.granola.ai/blog/how-we-wrote-the-prompts-behind-granolas-crunched-2025
- getlatka（第三方员工/营收，部分未核实）：https://getlatka.com/companies/granola.so
- Karri Saarinen（Linear CEO）X 推荐：https://x.com/karrisaarinen/status/1922668975164461079
- Nubia Magazine（2026 综述）：https://nubiapage.com/granola-ai-review-in-2026-windows-android-founder-funding-ai/

---

*调研者：CallingClaw 竞品情报 · 2026-06-11*
