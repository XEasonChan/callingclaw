# 竞品研究：平台原生会议 AI（Zoom / Teams / Meet）

> **品类**：Platform-native meeting AI —— 会议平台自带的内置 AI 助手
> **一句话定位**：免费、捆绑、默认开启的"开箱即用"会议 AI（纪要 + 实时笔记 + 聊天问答），靠零边际成本分发，对 CallingClaw 构成最大的"够用即免费"结构性威胁。
> **重点对象**：Zoom AI Companion（主）、Microsoft Copilot in Teams、Google Gemini in Meet
> **最后研究日期**：2026-06-11
> **置信度说明**：公司财报/官方公告类数据置信度高（一手 SEC/官方博客）；用户口碑为样本性引用（Reddit/G2/媒体评测），不代表整体分布；标注"未能核实"处为公开渠道未找到可靠来源。竞品迭代极快，功能清单按本日期快照。

---

## 0. 核心结论（TL;DR）

这三家不是"创业公司竞品"，而是会议平台巨头把 AI 作为**免费捆绑功能**塞进既有的几亿用户分发渠道。它们的共同形态是**被动的纪要 / 实时笔记 / 聊天问答助手**：

- **不在会议里实时"说话"**——三家的会中 AI 都通过文字面板/聊天框输出，不发声（唯一例外是 Teams 的"音频回顾 Audio Recap"，但那是**会后**生成的播客式总结，不是会中发言）。
- **不能"看"共享屏幕并据此操作电脑**——它们消费的是音频/转录文本，不做屏幕视觉理解，更不控制本机。
- **跨平台能力弱**——各自锁死在自家会议产品里（Gemini 只认 Meet，Copilot 偏向 Teams/M365，Zoom 偏向 Zoom）。

这恰好是 CallingClaw 的差异化护城河：**主动参会者 + 会中真人发声 + 看共享屏幕 + 控制 macOS + 本地隐私 + 跨平台（Meet/Zoom）+ 中英双语**。威胁本质是"商品化/够用即免费"，而非功能对位。

---

## 1. 公司 / 团队

这一品类背后是三家市值/营收量级远超任何会议 AI 创业公司的巨头。所谓"团队/融资"应理解为**公司体量、市值、研发投入**。

| 维度 | Zoom (Zoom Communications) | Microsoft | Google (Alphabet) |
|---|---|---|---|
| 关键人物 | Eric Yuan（创始人/董事长/总裁/CEO），将 FY2026 定义为转向 "AI-powered system of action for modern work" 的转折年 | Satya Nadella（CEO），公开为 AI 资本开支辩护，称将带来长期回报 | Sundar Pichai（CEO）；Gemini 模型由 Google DeepMind 驱动 |
| 性质 | 上市公司（NASDAQ: ZM） | 上市巨头（NASDAQ: MSFT） | 上市巨头（NASDAQ: GOOGL） |
| 市值（约） | ~$25B（2025-09，较 2020 峰值 $159B 大幅回落） | 一度跌破 $3T（2026 初，AI 投入引发投资者顾虑） | 数万亿美元级；2026Q1 在三巨头中被认为最能让投资者相信 AI 投入在变现 |
| 研发/资本开支 | 未单列 AI 研发；以"联邦式 AI"复用第三方模型为主 | 资本开支年化达 ~$150B（2026 初），全年预计约 $190B（>2024 的三倍），约 2/3 投向 GPU/CPU | 与 MSFT/Meta 同级别的数百亿美元 AI 资本开支 |

**对 CallingClaw 的含义**：对手有近乎无限的算力、分销与品牌信任。无法在"规模/资源"维度竞争，只能在"它们做不到的形态"（主动发声、看屏、控机、本地、跨平台）上竞争。

---

## 2. 财务 / 规模

| 指标 | 数值 | as-of | 来源 |
|---|---|---|---|
| Zoom FY2026 全年营收 | $4,868.8M，同比 +4.4% | 公布于 2026-02-25 | Zoom 8-K / nojitter |
| Zoom FY2026 Q4 营收 | $1,247.0M，同比 +5.3% | 2026-02-25 | 同上 |
| Zoom 在线业务流失率 | 历史低点 2.7%（AI Companion 采用一年内增长 >4 倍，被称为"防御性护城河"） | FY2026 末 | financialcontent |
| Zoom MAU（口径不一） | 估计 450M+（核心平台）；另有口径称 ~700M MAU；日活参会 ~300M | 2025 | demandsage / 第三方统计（口径需谨慎） |
| Zoom 视频会议市占 | ~55.9% 全球视频会议软件市场；~192,600 家企业客户 | 2025 | demandsage |
| Microsoft 365 Copilot 付费席位 | 20M（FY26 Q3，2026-04-29 财报）；此前 16.1M（截至 2025-12-31）、15M（2026-01）；同比 +160%+ | 各财报披露 | nojitter / office365itpros |
| M365 Copilot 隐含营收（按 $30/席/月列表价） | 16.1M 席位约对应 $5.8B 年化上限；考虑 40–60% 企业折扣，现实约 $1.5–2.5B（微软不单列） | 2026 | nojitter（分析师估算） |
| M365 Copilot 渗透率隐忧 | 仅约 **3.3%** 的 M365 商用装机量转化为付费 Copilot 席位（"shelfware"质疑） | 2026 | tech-insider / alphastreet |
| Microsoft Teams MAU | 320M+ | 2024 | sqmagazine |
| Microsoft 365 总席位 | 450M | FY26 Q2（2026-01-30） | office365itpros |
| Google Workspace + Gemini 定价变化 | 2025-01 起 Gemini 捆绑进所有付费 Workspace；Business Standard 由"+Gemini 加购 $32/席/月" → $14/席/月（仅比无 AI 时贵 $2） | 2025-01 | Google Workspace Updates |

**关键竞争含义**：这些公司不靠"会议 AI"单独赚钱，而是把它作为**留存/抗流失工具**（Zoom 明说 AI 拉低了流失率）和**席位升级诱因**（微软）。它们能把会议 AI 的边际价格压到 0（捆绑），CallingClaw 不能在价格上正面对刚。

---

## 3. 产品功能 + 最新动态（2024–2026 时间线）

### 3.1 时间线

| 日期 | 厂商 | 事件 |
|---|---|---|
| 2023-09 | Zoom | 推出 AI Companion，**对付费账户零额外费用** |
| 2024-10 (Zoomtopia) | Zoom | AI Companion **2.0**：扩展上下文、综合信息、采取行动（Zoom Tasks）；强调"联邦式 AI"动态选用 OpenAI/Anthropic/Meta/Perplexity 等模型 |
| 2025-01 | Google | Gemini 捆绑进所有付费 Workspace 计划；2025-01-31 后停止单独售卖 Gemini 加购 |
| 2025-03 | Google | "Take Notes for Me" 扩展到法/德/意/日/韩/葡/西等语言 |
| 2025-05 | Google | Meet 实时语音翻译进入测试 |
| 2025-09 | Google | "Ask Gemini in Meet" 上线（先 Enterprise） |
| 2025-09 (Zoomtopia 2025) | Zoom | 预告 AI Companion **3.0**，强化跨平台 agentic |
| 2025-12-15 | Zoom | AI Companion **3.0 正式发布**：agentic workflows、Web 界面、agentic retrieval、agentic writing |
| 2026-01 (late) | Google | "Ask Gemini in Meet" 扩展到 Business Standard 域、更多语言、移动端 |
| 2026-04~05 | Microsoft | Teams **视频回顾（Video Recap）** 推出（需 M365 Copilot 许可） |
| 2026 内 | Microsoft | Interpreter Agent 实时翻译支持 9 种语言；Facilitator Agent 实时记笔记 |

### 3.2 三家会中 AI 能力对照（核心：是否"说话/看屏/控机"）

| 能力 | Zoom AI Companion (2.0/3.0) | MS Copilot in Teams | Google Gemini in Meet | **CallingClaw** |
|---|---|---|---|---|
| 会议纪要 / 行动项 | 有 | 有（含 speaker summary / executive report） | 有（"Take Notes for Me"，结果存进 Google Docs） | 有 |
| 会中实时笔记 | 有 | 有（Facilitator 共享笔记面板） | 有（实时高亮要点/决策/行动项） | 有 |
| 会中问答 | 有（文字，"这个缩写啥意思"） | 有（聊天框内问答，全员可见） | 有（Ask Gemini，侧栏文字） | 有 |
| **会中实时"开口说话"（语音参与）** | **无**（官方 3.0 公告未提及实时语音/会中发声） | **无**（Facilitator"不在音频上发言"，只在聊天/面板输出）。注：Audio Recap 是**会后**播客式音频，非会中发言 | **无**（仅文字侧栏 + 翻译字幕） | **有 —— 真人语音实时参会发言（核心差异）** |
| **看共享屏幕并理解 / 据此行动** | **无**（消费音频/转录，不做屏幕视觉） | **无** | **无** | **有（VisionModule 视觉理解共享屏幕）** |
| **控制电脑 / 执行本机操作** | 部分"agentic"是**应用内**任务编排（拉取 Salesforce/Slack/ServiceNow），非控制本机 OS | Agent 在 M365 生态内编排，非控制用户本机 | 无 | **有（ComputerUse + 浏览器操作控制 macOS）** |
| 实时翻译字幕 | 部分支持 | Interpreter Agent（9 语言，2026） | 60+ 语言字幕；Gemini 3.5 原生语音翻译（私测） | EN/中文 双语 |
| 跨会议平台 | 锁 Zoom（3.0 "My Notes" 拟支持转录他平台/线下会，coming soon） | 偏 Teams / M365 | **仅 Google Meet**（Zoom/Teams 用户用不了） | **跨 Meet + Zoom** |
| 本地 / 隐私 | 云端 | 云端（企业租户） | 云端 | **本地运行（macOS）** |

### 3.3 三家"agentic"到底是什么

- **Zoom AI Companion 3.0（2025-12-15）**：四大 agentic 能力＝推理 / 记忆 / 任务执行 / 编排。新增 agentic retrieval（跨 Zoom + Google Drive/OneDrive 检索，Gmail/Outlook coming soon）、agentic writing（canvas 协作改稿）、个人工作流 beta（自动生成每日反思报告、follow-up 草稿）、Custom AI Companion 可搭自定义 agent 跨 Salesforce/Slack/ServiceNow。Web 入口 ai.zoom.us。**但所有"agentic"都是应用层任务编排/检索/写作，不是会中实时语音参与，也不是看屏控本机。**
- **Microsoft Teams**：Facilitator agent（实时记笔记、聊天答疑、盯议程，**不发声**）；Interpreter Agent（实时翻译）；Video/Audio Recap（会后）。全部需 M365 Copilot 许可才解锁完整体验。
- **Google Gemini in Meet**："Take Notes for Me" + "Ask Gemini"（侧栏文字）+ 实时翻译字幕。Fellow/tldv 评测指出它"只记会中说了什么"，不做会前简报，follow-up 邮件只是文件链接堆叠、缺上下文与下一步。

### 3.4 与 CallingClaw 的对比要点

CallingClaw 的形态在这三家里**没有对位**：作为**主动参会者实时开口发言**、**用视觉看共享屏幕**、**控制 macOS 执行操作**、**本地运行**、**同时支持 Meet 与 Zoom**、**中英双语**。三家是"会议结束后给你一份纪要 + 会中一个静默的文字助手"；CallingClaw 是"一个会说话、会看、会动手的同事坐进了你的会"。

---

## 4. Marketing 账号 / 渠道

这三家**不为"会议 AI 功能"单独运营社媒矩阵**，分发逻辑与创业公司截然不同：

- **捆绑分发（零边际成本）**：功能直接出现在用户已经在用的产品里。Zoom AI Companion 对所有付费账户默认可用且零额外费用；Gemini 自 2025-01 捆绑进所有付费 Workspace；Copilot 通过 M365 席位升级触达。
- **默认开启 / 管理员可控**：功能在产品 UI 内直接弹出（Meet 里"Take Notes for Me"按钮、Teams 里 Facilitator 作为"新参会者"出现、Zoom 会议内 AI Companion 按钮），靠产品内曝光而非广告获客。
- **企业直销 + 渠道伙伴**：主战场是企业 IT/采购，靠现有客户关系、Microsoft/Google 渠道伙伴体系、企业合规背书，而非 TikTok/X 网红营销。
- **品牌主渠道**：官方 newsroom / 产品博客（news.zoom.com、workspaceupdates.googleblog.com、Microsoft 365 Message Center / Tech Community）+ 年度大会（Zoomtopia、Microsoft Ignite/Build、Google Cloud Next）+ 主品牌社媒账号（@Zoom、@Microsoft365、@GoogleWorkspace），而非功能专属账号。

**含义**：CallingClaw 无法靠"被默认装进每个会议"获客，必须靠**形态差异的可演示性**（真的开口说话、真的操作屏幕）做内容病毒传播，走 bottom-up / 产品自传播路线。

---

## 5. Marketing 内容 / 策略

三家的核心叙事高度一致，可归纳为三板斧：

1. **"它已经在你的会议里了"（捆绑 / 零额外成本）**：Zoom——"included at no additional cost with paid accounts"；Google——把 Business Standard 从 +$32 Gemini 加购降到内含、仅贵 $2；微软——把 Copilot 作为 M365 席位升级。核心是**消除采购决策**：不用再选第三方、不用过供应商安全审查。
2. **企业信任 / 合规 / 数据驻留**：主打"数据不出你已信任的租户"。对企业 IT 而言，"再引入一个第三方录音机器人进会议"是合规/安全负担，而原生 AI 没有这个摩擦——这是它们对 Otter/Fathom/Fireflies 等第三方的最强武器，**对 CallingClaw 同样适用**。
3. **抗流失 / 平台粘性叙事**：Zoom 在财报里把 AI Companion 采用与历史低位流失率（2.7%）直接挂钩，对外讲"AI-first system of action"；微软讲"450M M365 席位 + Copilot 升级"；Google 讲"全套 Google AI 已含在 Workspace 里"。AI 是留人和涨价的杠杆，不是单独盈利的产品。

**对 CallingClaw 的启示**：不要在"会议纪要"这个已被免费商品化的层面打。要把叙事钉在"**它们做不到的事**"——主动发声参与、看屏、替你操作电脑、本地隐私、跨 Meet/Zoom、中文母语级——并强调这些是平台原生 AI 因结构原因短期难以提供的。

---

## 6. 评论区反馈

> 以下为样本性引用（Reddit / Zoom 社区 / G2 / 第三方评测），非整体分布统计。

**普遍好评（共性）**
- **免费 / 已集成 / 零摩擦**：不用装第三方、不用额外付费、不用 IT 审批，是被反复提到的最大优点（捆绑红利）。
- **够用的基础纪要**：对低风险、信息密度低的会议，纪要"够用"。

**普遍抱怨（共性）**
- **纪要泛化 / 失真**：Zoom 社区帖 *"Why is the AI Meeting Summary So Inaccurate?"* —— 用户称 Zoom 把次要评论拔高成主要观点、改变原意；行动项"严重不准"，把会上已完成的事列成 next steps，或安排从未讨论过的任务。（来源：Zoom Community）
- **不如专业第三方**：用户直言 Fathom 的总结和行动项"WAY more accurate"，明显优于 Zoom AI Companion。（来源：tldv / Circleback 对比）
- **Gemini 锁死单平台 + 浅**：评测指 Gemini "只记会中说了什么"，不做会前简报；follow-up 邮件只是文件链接堆叠、无上下文/下一步；且只认 Google Meet，Zoom/Teams 用户无法用；语言支持窄（约 8 种 vs 竞品 90+）。（来源：tldv / fellow.ai）
- **Copilot：付费墙 + 渗透率低**："shelfware"质疑——仅 ~3.3% M365 商用装机转化为付费 Copilot；完整体验（视频回顾、Facilitator、Interpreter）几乎都要 M365 Copilot 许可，免费 Teams 用户拿不到。（来源：tech-insider / alphastreet / Microsoft 支持文档）
- **管理员门控 / 隐私顾虑**：功能常被企业管理员控制开关，且都是云端处理（CallingClaw 的本地处理在此是反向卖点）。

**一句话总结口碑**：被夸"免费、已经在那"，被骂"泛、不准、不如专业工具、锁平台、要加钱"。这正是"够用即免费"商品化的典型口碑画像。

---

## 7. 对 CallingClaw 的威胁评估

**威胁等级：高（结构性 / 长期最大威胁）**，但威胁性质是**商品化挤压**，而非功能正面对位。

### 威胁来源
1. **价格归零**：会议纪要/笔记/问答已被三家捆绑成免费功能，CallingClaw 不能把这层当卖点或收费点。
2. **零采购摩擦**：原生 AI 没有"第三方进会议"的安全/合规审查负担，企业默认就有——这是对所有第三方会议 AI（含 CallingClaw）的共同压制。
3. **分发碾压**：几亿席位 + 默认开启，用户不需要主动选择就会被动接触到对手。
4. **持续吞噬边缘功能**：3.0/Facilitator 等正逐步把"行动项执行""检索""翻译"纳入捆绑，会持续侵蚀第三方的功能溢价空间。

### CallingClaw 必须死守/放大的差异化（对手结构性做不到）
| 差异点 | 为何对手短期难追 |
|---|---|
| **主动参会者 + 会中真人语音发言** | 三家会中 AI 都是静默文字助手；"会开口的 AI 同事"是完全不同的产品形态与体验 |
| **看共享屏幕（视觉理解）** | 原生 AI 只消费音频/转录，不做屏幕视觉 |
| **控制电脑 / 执行本机操作** | 原生 AI 的"agentic"是应用内/租户内任务编排，不触达本机 OS |
| **本地运行 / 隐私** | 三家全是云端；本地处理对隐私敏感场景是反向卖点 |
| **跨平台（Meet + Zoom）** | Gemini 锁 Meet、Copilot 偏 Teams、Zoom 锁 Zoom；没有一家中立跨平台 |
| **中英双语母语级** | Gemini Meet 语言窄（~8）；中文场景体验差 |

### 战略建议（要点）
- **绝不在"纪要"层面竞争或定价**——把它当免费基础能力，叙事重心全部转向"会说话/会看/会动手/本地/跨平台/中文"。
- **可演示性即营销**：把"AI 在会里开口回答""AI 看着共享屏幕替你点按操作"做成可疯传的演示，这正是平台原生 AI 拿不出的画面。
- **把"第三方进会议"的合规摩擦反转为"本地不上云"卖点**，正面化解对手对第三方的最强攻击点。
- **盯紧 Zoom 3.0 "My Notes（转录他平台/线下会）" 与微软 Interpreter/Facilitator 的扩张**——若它们开始向"会中主动语音"或"跨平台"靠拢，差异化窗口会收窄，需提前在体验深度（中文、实时性、控机可靠性）上拉开身位。

---

## 信息来源

**Zoom**
- https://news.zoom.com/zoom-launches-ai-companion-3-0/
- https://www.globenewswire.com/news-release/2025/12/15/3205509/0/en/Zoom-launches-AI-Companion-3-0-with-agentic-workflows-transforming-conversations-into-action.html
- https://siliconangle.com/2025/12/15/zoom-rolls-ai-companion-3-0-browser-access-agentic-automation/
- https://www.zoom.com/en/blog/zoom-ai-companion-3-0-agentic-ai-conversation-to-completion/
- https://www.nojitter.com/ai-automation/zoom-ai-companion-3-0-now-generally-available
- https://news.zoom.com/zoomtopia2025/
- https://news.zoom.com/ai-companion-2-0-launch/
- https://news.zoom.com/zoom-introduces-ai-companion-2-0/
- https://news.zoom.com/zoom-ai-companion/ （2023 发布，零额外费用）
- https://www.zoom.com/en/products/ai-assistant/
- https://www.nojitter.com/digital-workplace/zoom-posts-strong-q4-2026-results-powered-by-ai
- https://markets.financialcontent.com/stocks/article/marketminute-2026-2-25-zoom-transcends-its-video-roots-q4-earnings-reveal-a-new-ai-first-powerhouse
- https://www.fool.com/earnings/call-transcripts/2025/11/24/zoom-zm-q3-2026-earnings-call-transcript/
- https://www.demandsage.com/zoom-statistics/
- https://community.zoom.com/t5/Zoom-AI-Companion/Why-is-the-AI-Meeting-Summary-So-Inaccurate/m-p/178437
- https://tldv.io/blog/zoom-ai-companion-review/
- https://circleback.ai/compare/fathom-vs-zoom-ai

**Microsoft / Teams Copilot**
- https://www.nojitter.com/ai-automation/microsoft-365-copilot-hits-20-million-paid-seats
- https://www.nojitter.com/ai-automation/microsoft-365-copilot-hits-15-million-paid-seats
- https://office365itpros.com/2026/01/30/microsoft-fy26-q2-results/
- https://news.alphastreet.com/microsofts-16m-copilot-seats-milestone-enterprise-adoption-or-shelfware-risk/
- https://tech-insider.org/microsoft-ai-spending-azure-copilot-2026/
- https://fortune.com/2026/05/21/microsoft-copilot-ai-openai-satya-nadella-gemini-claude/
- https://cryptobriefing.com/microsoft-falls-below-3t-market-cap/
- https://support.microsoft.com/en-us/teams/copilot/facilitator-in-microsoft-teams-meetings
- https://learn.microsoft.com/en-us/microsoftteams/facilitator-teams
- https://support.microsoft.com/en-us/teams/copilot/catch-up-on-meetings-with-microsoft-365-copilot-in-teams
- https://learn.microsoft.com/en-us/microsoftteams/intelligent-recap-calls-meetings
- https://chrismenardtraining.com/post/new-microsoft-teams-meeting-recap-features-with-copilot-speaker-summary-executive-report-audio-recap/
- https://mc.merill.net/message/MC1261588 （Video Recap，2026-04~05）
- https://sqmagazine.co.uk/microsoft-365-statistics/

**Google / Gemini in Meet**
- https://workspaceupdates.googleblog.com/2025/01/expanding-google-ai-to-more-of-google-workspace.html
- https://workspaceupdates.googleblog.com/2026/01/ask-gemini-google-meet-expansion-business-standard.html
- https://workspaceupdates.googleblog.com/2025/08/more-languages-suggested-next-steps-take-notes-google-meet-gemini.html
- https://workspace.google.com/resources/ai-for-meetings/
- https://workspace.google.com/solutions/ai/ai-note-taking/
- https://9to5google.com/2025/05/20/google-meet-speech-translation/
- https://android.gadgethacks.com/news/google-meet-live-translation-update-70-languages-with-gemini-35/
- https://fellow.ai/blog/google-meet-gemini-ai-note-taker-review/
- https://tldv.io/blog/google-gemini-meeting-notes-review/
- https://www.googally.com/blog/is-gemini-included-in-google-workspace
