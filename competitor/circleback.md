# Circleback (circleback.ai)

> **一句话定位**：主打"业界最佳准确度"的 AI 会议记录工具，会后通过自动化（automations）把会议内容转成 CRM 更新、任务、邮件等动作。YC W24，a16z **未**参投。
>
> **最近研究日期**：2026-06-11
>
> **信心说明**：团队/融资/产品/发布时间线均有官方一手来源（YC、官网博客、releases 页），信心高。社交粉丝数为搜索快照（约 2026-06），未逐一登录核实，信心中。G2/Capterra 具体星级与评论数因 403/页面动态加载，仅得二手聚合数据，标注为"未能完全核实"。**重要更正**：任务下达时假设的两点有误——(1) 联合创始人是 **Kevin Jacyna**，并非 "Kevin Yang"；(2) **未找到 a16z / Andreessen Horowitz 投资 Circleback 的任何证据**，公开融资为 250 万美元种子轮，由 YC 领投。详见各节。

---

## 1. 团队 / 创始人

| 项目 | 内容 | 来源 |
|------|------|------|
| 成立年份 | 2023 | YC |
| YC 批次 | Winter 2024 (W24) | YC |
| 总部 | 美国加州旧金山 (San Francisco, CA) | YC |
| 员工数 | 约 **8 人**（YC 页显示）| YC |
| 联合创始人 & CEO | **Ali Haghani** | YC / LinkedIn |
| 联合创始人 | **Kevin Jacyna** | YC |
| YC 负责合伙人 | Gustaf Alstromer | YC |

**创始人背景**
- **Ali Haghani（CEO）**：曾在 Stripe 任工程师，主导首次将 LLM 引入客服体验，号称每年降低 200 万美元以上运营成本；更早在 Twitter 做广告与实验平台（广告 A/B 测试系统）。
- **Kevin Jacyna**：曾任 Tableau 高级软件工程师，负责把预测分析引入 Tableau，并改善桌面端与 Web 端兼容性。

> **更正说明**：任务指定的 "Kevin Yang" 在所有一手来源中均查无此人；联合创始人确为 **Kevin Jacyna**。团队规模很小（约 8 人），属精干创业团队。

---

## 2. 融资 / 财务

| 项目 | 内容 | 来源 |
|------|------|------|
| 已披露轮次 | 种子轮（Seed）| 官网博客 |
| 金额 | **250 万美元 (US$2.5M)** | 官网博客 |
| 公布日期 | 2024-11-26 | 官网博客 |
| 领投/机构 | **Y Combinator**、Rebel Fund、Pioneer Fund、Transpose Platform | 官网博客 |
| 天使投资人 | Kulveer Taggar、Oliver Jung、JJ Fliegelman、Rich Aberman、Jason Freedman 等 | 官网博客 |
| 估值 | 未披露（未能核实）| — |
| 收入 / ARR | 未披露具体数字；官方仅称"被数千客户使用"(thousands of customers) | 官网博客 |

> **关于 a16z 的更正**：任务假设 "a16z 参投"。经检索 a16z portfolio、Crunchbase、各融资新闻，**未发现 Andreessen Horowitz 投资 Circleback 的任何记录**。公开可核实的唯一融资是上述 250 万美元 YC 种子轮。a16z 的关联消息均指向其 2025 年 150 亿美元基金等无关事件。若内部有未公开的后续轮（如 a16z 私下参与），目前**未能核实**——应视为未证实传闻。

---

## 3. 产品功能 + 最新动态（timeline）

### 核心功能
- **会议记录 / 转录**：跨 Zoom、Google Meet、Microsoft Teams、Slack huddles 及线下会议；自动按主题组织的"细致笔记"。
- **准确度定位**：官网首页大字标语 **"Unbelievably good meeting notes"**，主打 **"state-of-the-art transcription accuracy"**，强调专业术语与口音识别、说话人自动命名识别、支持 **100+ 种语言**。
- **Action items（行动项）**：自动抽取、分派、组织会后待办。
- **Automations（自动化 / 工作流）**：会议结束后根据规则触发动作——同步行动项到 Linear、Notion、Monday；更新 HubSpot、Salesforce、Attio、Zoho 等 CRM；推送 Slack；经 Zapier / Make 扩展。例：产品 demo 中识别功能请求 → 自动在 Linear 建任务；销售电话后 → 自动更新 CRM 客户信息。
- **Search（搜索）**：跨所有会议的自然语言搜索。
- **集成生态**：Slack、HubSpot、Salesforce、Attio、Linear、Notion、Monday、Zoho、Zapier、Make 等 1000+ 应用。
- **合规**：SOC 2 Type II 认证、HIPAA 合规。
- **平台**：Web、桌面 App、移动 App（iOS/Android）、MCP + CLI（供 AI agent 接入）。

### 关键对比：Circleback **不能**做什么（vs CallingClaw）
| 能力 | Circleback | CallingClaw |
|------|-----------|-------------|
| 以 bot 身份加入会议 | ✅ 是（通过日历连接派 bot 加入）| ✅ 是 |
| 实时**开口说话** | ❌ 否——只听只记，会后处理 | ✅ 是（实时语音对话） |
| **看到**共享屏幕 | ⚠️ 部分——2026-05-28 起可被动"捕获屏幕上分享的内容"（幻灯片/仪表盘/文档的细节写入笔记并可搜索），但仅供记录与检索 | ✅ 是（VisionModule 主动理解屏幕） |
| 实时**执行动作 / 控制电脑** | ❌ 否——其"actions/automations"是**会后**触发的工作流（建任务、更新 CRM、发邮件），不是会中实时操控 | ✅ 是（ComputerUseModule 实时控制 macOS） |
| 双语 EN/中文 | ✅ 支持 100+ 语言 | ✅ EN/中文 |
| 本地运行 | ❌ 云端 SaaS | ✅ 本地运行（macOS） |

> **关键澄清**：Circleback 的 "automations" 是**事后自动化触发器**（post-meeting workflow triggers），而非会中实时计算机操控。它本质是一个"超强笔记 + 会后工作流引擎"，不是会中实时的语音 Agent。这正是与 CallingClaw 定位的根本分野。

### 更新时间线（2025–2026）
> 注：releases 页未列出 2025 年条目（可能已归档或未公开早期日志，**未能核实** 2025 全年明细）；以下为 2026 年可核实条目，按时间倒序。

| 日期 | 更新 |
|------|------|
| 2026-06-09 | Ask Circleback about Linear——可在助手内查询 Linear issue 并直接创建，无需切换应用 |
| 2026-05-31 | MCP / CLI 可访问会议录音，附可下载链接 |
| 2026-05-29 | 工作区支持多个邮箱域名 |
| 2026-05-29 | 桌面端常驻最小化录制指示面板，悬停展开可记笔记 |
| **2026-05-28** | **屏幕内容捕获**——自动把共享屏幕（幻灯片/仪表盘/时间线/文档）的关键细节写入笔记，且可搜索、对接入的 AI agent 可见（"即使没人念出来"）|
| 2026-05-25 | 转录搜索带上下文高亮 |
| 2026-05-19 | 按公司筛选行动项（跨多场会议）|
| 2026-04-30 | People & Companies 空间——人/公司档案聚合行动项、会议、邮件、日历 |
| 2026-04-08 | 桌面端会中自动切换麦克风设备 |
| 2026-04-03 | 行动项多选 / 批量操作 |
| 2026-03-22 | 自动化新增按"受邀人数"触发条件 |
| 2026-03-19 | Views——把会议/行动项的筛选组合存为视图，一键切换 |

---

## 4. Marketing 账号（粉丝数 as-of ≈ 2026-06）

| 平台 | Handle | 粉丝/订阅 | 备注 |
|------|--------|----------|------|
| X / Twitter | [@circlebackai](https://x.com/circlebackai) | **约 1,518** | 搜索快照，未登录核实 |
| LinkedIn | [company/circlebackai](https://www.linkedin.com/company/circlebackai) | **约 647** | 搜索快照 |
| YouTube | [@circlebackai](https://m.youtube.com/@circlebackai) | 未能核实具体订阅数 | 频道存在 |
| Instagram | [@circlebackai](https://www.instagram.com/circlebackai/) | 未能核实 | 账号存在 |
| GitHub | github.com/circlebackai | — | 组织页 |
| 创始人 X | [@iAligator](https://x.com/iAligator) (Ali Haghani) | 未能核实 | CEO 个人号 |

> 总体社交体量**很小**（X ~1.5k、LinkedIn ~647），与产品口碑相比明显偏低，说明其增长主要靠产品本身与口碑/SEO，而非社媒声量。

---

## 5. Marketing 内容 / 策略

- **核心定位**：**准确度 + 自动化** 双卖点。主标语 **"Unbelievably good meeting notes"**、**"Notes a perfectionist would be proud of"**、**"Get the most out of every meeting"**。
- **信息策略**：以"业界最佳笔记/行动项质量"作为差异化锚点，反复强调转录准确度、术语/口音识别、说话人识别——直接对标 Otter、Fireflies、tl;dv、Granola 等。
- **内容类型**：
  - **SEO 比较型博客**：如《The 7 Best AI Meeting Assistants in 2026》《Which tool produces the best AI meeting notes?》——典型"自评对比"获客打法，把自己放进对比并胜出。
  - **Releases 页**：高频产品更新日志（几乎每周），传递"快速迭代"信号。
  - **多语言站点**：含日文 (/ja/) 等本地化页面，面向国际市场。
- **商业模式信号**："Try it free. Subscribe if you love it."——免费试用、无永久免费档（trial-only），靠产品体验转化付费。

### 定价（as-of 2026-06）
| 档位 | 价格 | 关键内容 |
|------|------|----------|
| Individual | **$20.83/用户/月**（年付）| 无限会议 AI 笔记、行动项、转录+说话人识别、自动化、搜索、线下录制、1000+ 集成、100+ 语言、自定义 AI insights |
| Team | **$25/用户/月**（年付）| 含 Individual + 团队共享、跨会议搜索、自定义数据保留、Slack huddles、内联评论、集中计费、用量看板、访问管理 |
| Enterprise | 定制 | 含 Team + 优先支持、onboarding/自动化协助、高级安全控制 |

> 无永久免费版，仅免费试用（trial）。

---

## 6. 评论区反馈

> **数据可靠性**：G2 页面返回 403，未能直接抓取。聚合二手数据显示评分高但**评论样本极少**——一处称 G2 "4.5/5 仅 2–3 条评论"，另有聚合站称"9.4/10，2000+ 评论"（口径不一，**未能核实**）。综合判断：口碑方向偏正面，但 G2 上正式评论数很少，需谨慎。

### 正面（代表性）
- "exceptional setup ease that integrates with calendars and starts working immediately" — 安装/接入极简，连日历即用。（G2 聚合）
- "automatic action item extraction and natural language search across all conversations set it apart from basic transcription tools" — 行动项自动抽取 + 跨会议自然语言搜索是核心差异点。（Reddit/评测聚合）
- "superior note quality compared to competitors, with better action item identification and unique email context integration" — 笔记质量与行动项识别优于同类。（评测聚合）

### 负面 / 常见抱怨（代表性）
- **转录准确度在弱音/低音量下掉链子**："if a speaker's voice is soft or the recording volume is low, the tool can miss or mis-detect certain words" — 软声/低音量会漏词错词。（Reddit/G2 聚合）
- **嘈杂/多人会议室里说话人识别失准**："speaker identification falters in crowded conference rooms"。（评测聚合）
- **线下会议管理仍有较大改进空间**。（G2 聚合）
- **无免费版（只有试用）+ onboarding 薄弱**："no free plan (trial only)"、"UX feels incomplete with barely any onboarding"。（评测聚合）
- **循环会议工作流并非真正自动**："the recurring meeting workflow isn't truly automatic"。（评测聚合）

> Trustpilot、App Store、HN 等渠道存在页面但**未逐一核实具体评分**（trustpilot.com/review/circleback.ai 存在）。

---

## 7. 对 CallingClaw 的威胁评估

### 竞争直接程度：**中等偏高（功能相邻，定位不同）**
两者都"以 bot 身份加入会议、转录、出行动项、跨工具集成"，在**会议记录/会后自动化**这一层高度重叠。但定位根本不同：

| 维度 | Circleback | CallingClaw | 谁赢 |
|------|-----------|-------------|------|
| 会议笔记/转录质量 | 极强（其核心壁垒）| 需直面对标 | **Circleback** |
| 会后自动化（CRM/任务/邮件）| 成熟、集成广（HubSpot/Salesforce/Linear/Notion…）| 较弱/需补 | **Circleback** |
| 实时开口**说话**参与会议 | ❌ 无 | ✅ 有 | **CallingClaw** |
| 会中**实时看屏 + 操控电脑** | ❌ 无（仅被动屏幕内容入笔记）| ✅ 有 | **CallingClaw** |
| 本地运行 / 隐私 | 云端 SaaS | 本地（macOS）| **CallingClaw**（隐私敏感客户）|
| 集成生态广度 | 1000+ 集成、SOC2/HIPAA | 待建 | **Circleback** |
| 团队/资源 | 8 人、$2.5M 种子 | — | 双方均为早期 |
| 社媒声量 | 很小（X~1.5k）| — | 均小 |

### Circleback 的护城河（moat）
1. **笔记/行动项质量的口碑壁垒**——其全部营销都押在"最准的笔记"，且评测普遍认同；这是难以快速复制的"品质感知"。
2. **会后自动化与集成生态**——深度对接 CRM/PM 工具 + Zapier/Make + MCP/CLI，已形成工作流粘性。
3. **合规背书**（SOC2 Type II / HIPAA）——利于企业/医疗销售。

### CallingClaw 的赢面
- **实时交互是 Circleback 完全没有的维度**：能开口说话、实时看屏、实时操控电脑。Circleback 明确是"会后处理 + 会后触发动作"，**会中是哑的**。CallingClaw 应把叙事钉在"会中实时 Agent，而非会后笔记工具"，避免在 Circleback 最强的"笔记质量"正面硬刚。
- **本地运行 / 隐私**：对数据敏感（金融/法律/医疗）客户是差异化卖点。
- **双语 EN/中文 + macOS 计算机控制**：垂直能力 Circleback 无对应。

### CallingClaw 的风险/失分点
- **笔记与会后自动化是 Circleback 的强项**，若 CallingClaw 在"基础笔记质量 + CRM/任务自动同步"上不达标，会在最常见的采购对比清单上吃亏。
- Circleback 的 **2026-05-28 屏幕捕获** + **MCP/CLI agent 接入** 显示它正向"AI agent 可读的会议知识层"演进——若它再叠加实时能力，重叠面会扩大。建议持续监控其 releases 页。

### 一句话结论
Circleback 是"**会后**最强的笔记/自动化工具"，CallingClaw 是"**会中**实时的语音+操控 Agent"。两者在记录/集成层重叠、在实时交互层错位竞争。CallingClaw 应以"实时说话 + 看屏 + 操控 + 本地隐私"为矛，同时把笔记质量和会后自动化做到"够好不掉队"，避免在 Circleback 的主场被对比掉。

---

## 信息来源

- Y Combinator 公司页：https://www.ycombinator.com/companies/circleback
- Circleback 官网首页：https://circleback.ai/
- Circleback 定价页：https://circleback.ai/pricing
- Circleback 种子轮融资博客（$2.5M, 2024-11-26）：https://circleback.ai/blog/seed-funding
- Circleback Releases（更新时间线）：https://circleback.ai/releases
- Circleback 屏幕捕获发布（2026-05-28）：https://circleback.ai/ja/releases/notes-capture-whats-shared-on-screen
- 会中切换麦克风/屏幕发布：https://circleback.ai/releases/change-microphone-and-screen-while-recording
- 桌面 App 发布：https://circleback.ai/releases/desktop-app
- Ali Haghani LinkedIn（Launch YC 帖）：https://www.linkedin.com/posts/alihaghani_launch-yc-circleback-ai-powered-meeting-activity-7158524460063490049-DAUW
- Circleback LinkedIn 公司页：https://www.linkedin.com/company/circlebackai
- Circleback X / Twitter：https://x.com/circlebackai
- Circleback YouTube：https://m.youtube.com/@circlebackai
- Circleback Instagram：https://www.instagram.com/circlebackai/
- 创始人 Ali Haghani X：https://x.com/iAligator
- G2 评论页（403，仅二手聚合）：https://www.g2.com/products/circleback-ai-inc-circleback/reviews
- Trustpilot：https://www.trustpilot.com/review/circleback.ai
- Capterra：https://www.capterra.com/p/160238/CircleBack/reviews/
- Tracxn 公司页：https://tracxn.com/d/companies/circleback/__zr75zBqlIs60JGri-cWuYjnPHmkD15UpaeJi6DOsl2s
- Crunchbase：https://www.crunchbase.com/organization/circleback-6736
- Reddit 用户观点聚合（Evro AI）：https://www.evro.ai/post/the-ultimate-guide-to-ai-meeting-note-takers-what-reddit-users-really-think-in-2026
- Tooliverse 评测：https://tooliverse.ai/tools/circleback
- Happyscribe 竞品对比：https://www.happyscribe.com/blog/circleback-alternatives-for-ai-meeting-notes
- Circleback《2026 最佳 AI 会议助手》博客：https://circleback.ai/blog/best-ai-meeting-assistants
