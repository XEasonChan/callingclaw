# CallingClaw GTM — 竞品情报与市场舆情报告

**日期**: 2026-04-04\
**主题**: Pika PikaStream 会议AI发布后48小时舆情分析\
**撰写**: CallingClaw GTM 团队 (AI辅助调研)

***

## 摘要

Pika Labs 于 2026年4月2日发布 PikaStream Video Meeting — 一个云端AI虚拟形象，可以加入 Google Meet 进行实时语音视频对话。发布后在 Twitter/X 上引爆传播，成功建立了"AI Agent加入会议"这个品类认知。但48小时后暴露出关键问题：音频功能对部分用户不可用、定价昂贵($0.50/分钟)、无法看到屏幕内容、无法控制电脑、无法共享文档。

**CallingClaw的机会**: Pika 帮我们做了品类教育。我们填补它做不到的空白 — 本地运行、电脑控制、屏幕视觉、极速文件访问。

***

## 一、Pika PikaStream 产品分析

### 产品概述

* 云端AI虚拟形象加入 Google Meet，支持实时语音视频

* 基于 PikaStream 1.0 实时视觉引擎

* 24帧/秒视频，约1.5秒延迟，单张 H100 GPU 渲染

* 持久记忆、跨对话保持人格一致性

* 支持用户录音克隆声音

* 开源 GitHub Skill，可接入 Claude Code / OpenClaw

### 定价

* **$0.50/分钟** (1小时会议 = $30)

* 需要 Pika 开发者 API Key + 充值余额

* 加入前检查余额

### 目标用户

* 仅面向开发者（需要 Python + GitHub + API Key 配置）

* 普通用户目前无法使用

* 该功能暂无消费级应用入口

### 技术架构

* **纯云端**: 虚拟形象在 Pika 的 H100 GPU 上渲染

* Bot 从云端加入会议，不在用户本地运行

* 上下文从工作区文件合成到系统提示词

* 使用 ElevenLabs 克隆声音（克隆声音7天不使用会过期）

### 数据来源

* GitHub: <https://github.com/Pika-Labs/Pika-Skills>

* 技术规格: pikastream-video-meeting/SKILL.md

* 截至4月4日: 185 stars, 12 forks

***

## 二、发布后48小时舆情反馈

### 正面反馈 (Twitter/X)

| 来源              | 原文                                                                                                                                            | 传播度    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| @HeyToha        | "This is actually crazy... it literally joined like a human. Face-to-face convo, remembers things, keeps personality... this feels different" | 爆款帖    |
| @tomosman       | "Zero-human company tech! ...not only hold video calls but also perform actions on the call too"                                              | 高互动    |
| @roastedtwit_   | "Pika just launched something that feels like it's from 2030"                                                                                 | 大量转发   |
| InterestHive 文章 | "PikaStream is trying to move AI into the 'participant' category"                                                                             | 行业媒体报道 |

### 负面信号（这是我们的机会）

#### GitHub Issues (严重问题)

**Issue #3: Bot加入会议但不说话、不回应音频** (4月3日)

* 报告人: @eboziev

* 环境: macOS arm64, Python 3.9

* 问题: Bot 成功加入 Google Meet，但没有任何音频输出，也不处理输入音频

* 状态: 未解决，1条评论

* **影响**: 核心功能在发布第一天就对部分用户失效

**Issue #2: 不支持中文/日文** (4月3日)

* 报告人: @Hansuku

* 需求: 将虚拟人的语音默认设为中文或日文

* 状态: 未解决，1条评论

* **影响**: 非英语市场完全被排斥在外

#### 公众质疑

* AlternativeTo 评论: "Well, it took many years but we've finally have stupider and uglier than the metaverse"（比元宇宙还蠢还丑）

* Pika 整体品牌: **Trustpilot 1.6星** (87%一星差评，用户投诉积分系统混乱、客服不回复)

#### 定价争议 (Pika 全平台)

* 用户持续投诉积分系统混乱

* "结果和宣传示例不一致"

* "改错误还得额外花钱，贵得离谱"

* $0.50/分钟的会议定价很可能遭遇类似反弹

***

## 三、竞品格局 — 会议AI Agent (2026年4月)

### 品类定位图

```text
                        被动型                      主动型
                    (只听不做)                  (能采取行动)
                         |                         |
  云端产品        Otter/Fireflies           Pika PikaStream
                 (转录+笔记)              (虚拟形象+语音，不能操作)
                         |                         |
  本地产品        Screenpipe/Granola         CallingClaw <<<
                 (屏幕录制)              (语音+视觉+电脑控制)
```

### 详细对比

| 能力        | Pika PikaStream | Otter.ai | Fireflies | ScreenApp | CallingClaw      |
| --------- | --------------- | -------- | --------- | --------- | ---------------- |
| 加入会议      | 可以(云端)          | 可以(云端)   | 可以(云端)    | 可以(云端)    | 可以(本地)           |
| 实时语音对话    | 可以*             | 不能       | 不能        | 不能        | 可以               |
| 虚拟形象/视频面孔 | 可以              | 不能       | 不能        | 不能        | 不能               |
| 看到共享屏幕    | 不能              | 不能       | 不能        | 可以(OCR)   | 可以(Gemini Flash) |
| 控制电脑      | 不能              | 不能       | 不能        | 不能        | 可以(5层路由)         |
| 共享屏幕      | 不能              | 不能       | 不能        | 不能        | 可以               |
| 语音打开文件    | 不能              | 不能       | 不能        | 不能        | 可以(2ms)          |
| 会议准备/研究   | 不能              | 不能       | 不能        | 不能        | 可以(Agent驱动)      |
| 中文支持      | 不能              | 部分       | 部分        | 不能        | 原生支持             |
| 本地运行/隐私   | 不能              | 不能       | 不能        | 不能        | 可以               |
| 会后执行      | 不能              | 仅转录      | 仅转录       | 仅转录       | 自动生成待办+执行        |
| 价格        | $0.50/分钟        | $20/月    | $19/月     | 免费/开源     | API成本(约$0.08/会)  |

* Pika 语音功能对部分用户不可用 (GitHub Issue #3)

### 值得关注的竞品

**Screenpipe** (screenpipe.com): 本地优先的屏幕录制+AI自动化。录制屏幕上的一切，AI可搜索。未来可能增加会议加入能力。

**ScreenApp** (screenapp.io): 开源会议Bot，基于 TypeScript + Playwright。可捕获屏幕+幻灯片(OCR)。技术栈与CallingClaw类似，但没有语音和电脑控制。

**Claude Computer Use** (Anthropic): Claude 现在可以控制电脑 — 打开应用、浏览网页、填写表格。如果 Anthropic 增加会议加入功能，将成为直接竞争对手。我们已经在用 Claude 做 Computer Use 模块。

***

## 四、CallingClaw 六大卖点（基于市场空白）

### 卖点一: "不只是说话，而是干活" (核心差异化)

**市场空白**: Pika的bot只能说话不能行动。所有其他会议AI都是被动的（只做转录）。

**CallingClaw**: AI说"我来打开" → 2ms找到文件 → 打开 → 共享屏幕 → 所有人都能看到。

**技术支撑**: FileAliasIndex (2ms) + OpenCLI Layer 1.5 + Chrome自动屏幕共享

**一句话**: "你的AI不只是在会议上聊天，它在干活。"

### 卖点二: "数据留在你的电脑上" (隐私)

**市场空白**: Pika运行在云端GPU。你的会议音视频传到他们的服务器。Otter/Fireflies同理。

**CallingClaw**: 完全运行在你自己的Mac上。音频本地处理，转录本地存储。除了LLM API调用，没有数据离开你的电脑。

**一句话**: "你的会议留在你的电脑上，不是我们的服务器上。"

### 卖点三: "它能看到屏幕" (视觉)

**市场空白**: Pika的bot加入会议但是"瞎的" — 看不到共享的演示文稿、代码或文档。

**CallingClaw**: Gemini Flash 以1帧/秒实时分析屏幕内容。能读幻灯片、理解代码、评论数据。

**一句话**: "加入会议却看不到演示文稿的AI，就像一个闭着眼睛来开会的同事。"

### 卖点四: "2毫秒打开文件" (速度)

**市场空白**: 没有任何竞品能通过语音指令打开文件。Pika不能，Otter不能。

**CallingClaw**: FileAliasIndex 在会议开始时预索引1000+文件。"打开Q1报告" → 2ms匹配 → 文件打开。

**一句话**: "说出文件名，它就已经打开了。"

### 卖点五: "开箱支持中文" (语言)

**市场空白**: Pika的 GitHub Issue #2 请求中文/日文支持。目前不支持。

**CallingClaw**: 中英文混合会议原生支持。语音识别、会前准备、笔记、总结全部支持中文。

**一句话**: "为 Pika 遗忘的团队而生。"

### 卖点六: "三百分之一的成本" (价格)

**市场空白**: Pika收费 $0.50/分钟 = 1小时会议$30。Otter $20/月。

**CallingClaw**: 仅API调用成本。一场典型会议：约$0.05-0.10（Haiku调用 + Gemini Flash视觉）。

**一句话**: "这场会议花了$0.08。用Pika的话，要$30。"

***

## 五、上市时间线

### 第一阶段: 借势 Pika (本周)

| 动作             | 平台        | 内容                                                  |
| -------------- | --------- | --------------------------------------------------- |
| 回复 Pika 爆款帖    | Twitter/X | "很喜欢这个产品。我们进一步问了：如果AI还能看到屏幕、打开文件呢？这就是 CallingClaw。" |
| 对比Demo视频 (45秒) | Twitter/X | 左半屏: Pika bot说话。右半屏: CallingClaw说话 + 打开文件 + 共享屏幕    |
| 发布推文串          | Twitter/X | 8条推文: 痛点 → 演示 → 功能 → 价格对比 → 行动号召                    |

### 第二阶段: 开发者社区 (第二周)

| 动作                     | 平台          | 内容                                       |
| ---------------------- | ----------- | ---------------------------------------- |
| "Show HN: CallingClaw" | HackerNews  | "加入你的会议、看到你的屏幕、控制你的电脑的AI。本地运行，$0.08/场会议" |
| 技术深度文章                 | 博客/Twitter  | "我们如何用双Chrome架构实现故障隔离的会议AI"              |
| ProductHunt 发布         | ProductHunt | 落地页 + 演示视频 + 功能对比表                       |

### 第三阶段: 持续内容营销

| 内容                              | 受众               | 打的卖点 |
| ------------------------------- | ---------------- | ---- |
| "Pika vs CallingClaw: 云端 vs 本地" | Twitter/博客       | 品类定位 |
| "我们的AI这周在会议里干了什么" (真实录屏)        | Twitter/LinkedIn | 社会证明 |
| "为什么你的会议AI需要眼睛，不只是耳朵"           | 博客               | 视觉模块 |
| 中文Demo视频 (用中文指挥AI打开文件)          | Twitter/小红书/即刻   | 中文市场 |
| "如何用$0.08替代$30/小时的会议Bot"        | 博客/HN            | 成本优势 |

***

## 六、Demo视频脚本建议

### 当前落地页

* 标题: "A Meeting Room for Your AI Agent" (很好)

* 缺失: 没有视频展示电脑控制 / 打开文件 / 共享屏幕

### 建议的50秒Demo

**第一幕 — 加入 (0-10秒)**: CallingClaw 加入一个真实的 Google Meet。说"大家好，我是CallingClaw，准备好了。" 画面展示 Meet 参会者网格中有 CallingClaw。

**第二幕 — 核心差异化 (10-25秒)**: 有人说"能把上周的PRD打开看看吗?" → CallingClaw: "好的，我来找一下" → 画面显示文件在2ms内打开 → 自动共享屏幕 → 所有参会者都能看到文档。

**第三幕 — 视觉能力 (25-35秒)**: 有人共享一个图表 → CallingClaw 读出内容: "这个Q1增长率比预期高了15%，主要来自新用户转化。" 画面展示 Gemini Flash 正在分析屏幕内容。

**第四幕 — 收尾 (35-45秒)**: 会议结束 → 自动生成会议纪要 + 待办事项 → 展示品牌化的HTML会议总结页面。

**结束语 (45-50秒)**: "CallingClaw. 你的AI不仅坐在会议桌旁 — 还能动手干活。"

**字幕条**: "$0.08/场会议。本地运行。中英文双语。"

***

## 七、原始数据来源

### 文章报道

* [AI Can Now Join Your Video Calls - InterestHive](https://interesthive.com/ai-can-now-join-your-video-calls-and-that-changes-everything/)

* [Pika Labs launches real-time video chat - AlternativeTo](https://alternativeto.net/news/2026/4/pika-labs-launches-real-time-video-chat-with-an-ai-avatar-version-of-yourself-in-meetings/)

* [Pika AI Selves: living, digital twins - Superhuman](https://www.superhuman.ai/p/pika-labs-launches-ai-selves-living-digital-twins)

* [Best AI Meeting Agents 2026 - ScreenApp](https://screenapp.io/blog/best-ai-meeting-agents)

### GitHub

* [Pika-Labs/Pika-Skills](https://github.com/Pika-Labs/Pika-Skills) — 185 stars, pikastream-video-meeting skill

* [Issue #3: Bot不说话](https://github.com/Pika-Labs/Pika-Skills/issues/3) — 严重音频Bug

* [Issue #2: 语言设置](https://github.com/Pika-Labs/Pika-Skills/issues/2) — 中文/日文需求

### Twitter/X

* [Pika 官方公告](https://x.com/pika_labs/status/2039804585855070256)

* [@HeyToha 爆款反应](https://x.com/HeyToha/status/2039810346287026680)

* [@tomosman "零人类公司"](https://x.com/tomosman/status/2039807091943080298)

### 市场数据

* Pika Trustpilot: 1.6星 (87%一星差评)

* PikaStream 定价: $0.50/分钟

* PikaStream 技术: 24帧/秒, 1.5秒延迟, H100 GPU

* CallingClaw 会议成本: 约$0.05-0.10 (仅API调用)

⠀