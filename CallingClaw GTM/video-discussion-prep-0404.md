# 视频讨论准备 — 2026-04-04 20:00

---

## 一、Personal 视频 — Aha Moment 分析

### 当前 v1 分镜的 Aha Moment 是什么？

v1 开场 3 帧 (9秒) 的震撼点:
1. AI 在 Google Meet 里跟你语音对话 (帧1)
2. AI 同时操作电脑 — 打开文件、点击、滚动 (帧2)
3. 兼容你现有的 Agent 平台 (帧3)

### 这超越了什么？

**当前主流 AI 模型能做的:**
| 能力 | ChatGPT/Claude/Gemini | CallingClaw |
|------|----------------------|-------------|
| 文字对话 | ✅ | ✅ |
| 语音对话 | ✅ (ChatGPT Voice, Gemini Live) | ✅ |
| 看屏幕 | ❌ (只能看截图) | ✅ 实时 |
| 操作电脑 | ❌ (Claude Computer Use 是单帧截图循环) | ✅ 实时+语音同步 |
| 加入会议 | ❌ | ✅ |
| 和别人对话 | ❌ (只能和你) | ✅ 对话第三方 |
| 跨会议记忆 | ❌ (每次新对话) | ✅ Tanka Memory |
| 会后执行 | ❌ | ✅ 自动执行 action items |

### 真正的 Aha Moment — 超越「模型」的体验

普通用户对 AI 的认知边界是: **"AI 是我对面的聊天框"**

CallingClaw 打破的认知是: **"AI 像同事一样坐在会议里，有自己的电脑，能跟所有人说话"**

这不是模型能力的提升(更聪明/更快/更长上下文)，而是**交互范式的跃迁**:
- 从 1:1 对话 → 多人协作
- 从 你→AI 提问 → AI 主动参与
- 从 纯文字/语音 → 语音+视觉+操作 同时进行
- 从 会话即焚 → 跨会议累积记忆

### v1 分镜的 Aha Moment 是否到位？

**到位的部分:**
- ✅ 帧1 开门见山，没有废话
- ✅ 帧2 操作电脑是最直观的震撼
- ✅ 彩蛋 (空工位) 是最强的情感锚点

**可以强化的:**
- ⚠️ 帧1 目前只是"AI在对话"——和 ChatGPT Voice 差不多，震撼不够
- 💡 **建议**: 帧1 的画面应该是 AI 正在回答第三方的问题(不是用户)，一上来就展示"它在和别人开会"——这才是真正超越模型的画面
- ⚠️ 帧2 "操作电脑"——Claude Computer Use 也能做，需要强调**实时+语音同步**
- 💡 **建议**: 帧2 展示 AI 一边跟人说话一边操作，画面里语音波形和鼠标同时在动，而不是静默操作

### Aha Moment 递进设计

```
Level 1: "AI 在开会？"          → 认知: AI 不只是聊天框
Level 2: "它在跟别人说话？"      → 认知: AI 能和第三方交流
Level 3: "它边说边操作电脑？"    → 认知: 多模态同步，不是轮流
Level 4: "它记得上次会议的事？"  → 认知: 累积记忆，越来越懂你
Level 5: "它自己约了下次会？"    → 认知: 自主行为，不需要指令
```

v1 已经覆盖了 Level 1/3/5，**建议强化 Level 2 (和第三方对话)**。

---

## 二、Team/Business 视频 — 企业隔离+本地+邮箱提效

### 红杉文章核心论点 — "From Hierarchy to Intelligence"

**作者**: Jack (Sequoia) + Block/Square
**核心论点**: 2000年来组织架构的本质是**信息路由协议**——罗马军团的层级制度是因为"一个人只能管 3-8 个人"。层级存在的唯一原因是**协调**（路由信息、预处理决策、维持对齐）。

**Jack 的关键洞察**:
> "Most companies using AI today are giving everyone a copilot, which makes the existing structure work slightly better without changing it. We're after something different: a company built as an intelligence."

**Block 的模型 — 四层架构**:
1. **Capabilities** — 原子能力（支付、借贷等），不是产品，是积木
2. **World Model** — 公司世界模型(替代管理层的信息路由) + 客户世界模型(交易数据)
3. **Intelligence Layer** — 自动组合能力为解决方案，主动推送（不需要 PM 写 roadmap）
4. **Interfaces** — 交付面（Square, Cash App 等），价值不在这里

**组织结构颠覆**:
> "In a conventional company, the intelligence is spread throughout the people and the hierarchy routes it. In this model, the intelligence lives in the system. The people are on the edge."

三个角色: IC(深度专家) → DRI(跨职能问题 owner, 90天制) → Player-Coach(替代传统 manager)

**与 CallingClaw 的 Echo 点**:
- Jack 说层级的本质是"信息路由"→ CallingClaw 的 AI 参加会议 = **重新定义信息路由**
- Jack 说"world model"替代管理层 → Tanka Memory = 公司的 world model
- Jack 说"intelligence layer 主动组合能力" → CallingClaw 会前准备+会中操作+会后执行 = intelligence layer 的会议态
- Jack 说"copilot 不够，要重构组织" → CallingClaw 不是会议 copilot（记笔记），是**会议参与者**

### 核心叙事方向

聚焦**企业实际提效**，用 Jack 的框架做底层支撑:
- **隔离的本地电脑**: AI 运行在公司本地环境，数据不出企业 → 安全的 world model
- **邮箱系统**: 结合企业邮箱(Gmail/Outlook)做会议管理 → 信息路由
- **内部会议提效**: 周会/评审/客户 Demo → 从 copilot 到 intelligence

### 企业痛点

1. **会议太多，准备太慢**
   - 每周 10-20 个会议
   - 每个会前要翻 Jira/Slack/邮件 准备 30min+
   - 会中手动记录，会后 30min 整理纪要

2. **信息在系统间割裂**
   - 客户信息在 CRM
   - 任务在 Jira/Linear
   - 讨论在 Slack
   - 文档在 Notion/Google Docs
   - 会议里需要所有这些，但得来回切窗口

3. **企业数据不能上云**
   - 金融/医疗/法律 合规要求
   - 代码仓库不能传到第三方 AI
   - 客户数据不能离开企业网络

### CallingClaw 企业版怎么解决

#### 场景 A: 企业内部周会 / Standup

```
会前 10min:
  → CallingClaw 自动扫 Jira ticket 状态变更
  → 拉取上周会议 action items 的执行情况
  → 从 Git 获取本周代码合并情况
  → 生成 2 页 prep brief 推送到与会者邮箱

会中:
  → AI 作为参会者加入 Meet
  → 主动汇报准备好的内容 (不需要人读 PPT)
  → 实时回答"上周那个 bug 修了吗？"→ 直接查 Jira 展示
  → 会中决策实时更新到 Jira/Notion

会后 5min:
  → 自动生成会议纪要 → 发邮件给全组
  → Action items 自动创建 Jira ticket
  → 下次会议议题自动生成
```

#### 场景 B: 客户 Demo / 售前会议

```
会前:
  → 从 CRM 拉客户背景 (公司规模/行业/上次沟通内容)
  → 从 Knowledge Base 准备产品 FAQ
  → 生成个性化 demo 流程

会中:
  → AI 代替/协助 Sales 做产品演示
  → 投屏操作产品界面，边演示边讲解
  → 客户提问 → AI 实时搜索文档回答
  → 价格问题 → 根据客户规模推荐方案

会后:
  → 生成客户跟进邮件草稿
  → 更新 CRM 客户状态
  → 创建 follow-up 日程
```

#### 场景 C: 1:1 / Performance Review

```
会前:
  → 汇总员工近期 PR、Jira 完成量、Slack 活跃度
  → 对比上次 1:1 设定的目标

会中:
  → AI 作为"隐形助手"不发言，只记录
  → Manager 可以说"帮我记一下这个 action item"
  → 实时生成结构化笔记

会后:
  → 1:1 笔记存入 HR 系统
  → Action items 自动 follow up
```

### 企业安全卖点

| 特性 | CallingClaw | Otter/Fireflies/Pika |
|------|-------------|---------------------|
| 运行位置 | 本地 Mac/PC | 云端 |
| 数据传输 | 不离开企业网络 | 上传到第三方云 |
| AI 模型 | 可用本地模型 / 企业 API | SaaS 只能用他们的 |
| 录音存储 | 本地磁盘 | 他们的服务器 |
| 合规 | 满足金融/医疗/法律 | 难以通过 SOC2/HIPAA |
| 成本 | $19.99 买断 + 自带 API key | $20-40/月/人 |

### Business 视频分镜草案

#### 第一幕: 企业痛点 (15s)

- **帧 B1** (3s): 一个人面前打开 8 个窗口 — Jira, Slack, Gmail, Google Docs, CRM, Calendar...
  - 文字: "Your team spends 30% of work time preparing for meetings"
  
- **帧 B2** (3s): 会议中，有人说"上次那个客户的反馈呢？" → 所有人开始翻电脑找
  - 文字: "And another 20% switching between tools during them"

- **帧 B3** (3s): 会后，一封邮件 "Meeting notes" → 打开是空的或者很潦草
  - 文字: "Meeting notes? If they exist at all."

- **帧 B4** (3s): 数据安全警告弹窗 — "Your meeting transcript will be uploaded to..."
  - 文字: "And cloud-based tools? Not an option for regulated industries."

- **帧 B5** (3s): CallingClaw 的本地部署画面 — 一台 Mac 上运行的 Desktop app
  - 文字: "What if there's a better way — one that never leaves your network?"

#### 第二幕: CallingClaw 企业解决方案 (35-40s)

**周会场景 (20s):**

- **帧 B6** (5s): 会前 — CallingClaw 自动生成 prep brief 邮件发给团队
  - 旁白: "10 minutes before your standup, every team member gets a brief — tickets, blockers, code changes — all auto-compiled."

- **帧 B7** (5s): 会中 — AI 参会者在 Meet 里投屏汇报
  - 旁白: "In the meeting, your AI presents the update. You focus on decisions, not data gathering."

- **帧 B8** (5s): 会中 — 有人问问题 → AI 实时查 Jira 展示答案
  - 旁白: "'What's the status on that P0?' Answered in 2 seconds. With the actual ticket."

- **帧 B9** (5s): 会后 — 邮件自动发出会议纪要 + Jira tickets 自动创建
  - 旁白: "After the meeting — notes sent, tickets created, next meeting scheduled. Automatically."

**客户 Demo 场景 (15-20s):**

- **帧 B10** (5s): 客户加入 Meet → CallingClaw AI 作为产品专家在等
  - 旁白: "Your prospect in Singapore wants a demo at 6 AM your time. Your AI is already in the room."

- **帧 B11** (5s): AI 投屏演示产品 + 实时回答客户问题
  - 旁白: "Personalized demo. Real-time Q&A. From product memory that grows with every conversation."

- **帧 B12** (5s): 会后 — 自动更新 CRM + 生成 follow-up 邮件
  - 旁白: "Follow-up drafted. CRM updated. Before you even wake up."

#### 第三幕: 安全+记忆 差异化 (15s)

- **帧 B13** (5s): 本地运行 vs 云端对比
  - 画面: 左边 — 数据流线从电脑到云端(❌)；右边 — 数据在本地循环(✅)
  - 文字: "Runs locally. Data stays on your machine."

- **帧 B14** (5s): Memory 可视化 — 每次会议让 AI 更聪明
  - 画面: 时间轴上多个会议节点，每个节点都有记忆线连接
  - 文字: "Every meeting makes your AI smarter — across teams, clients, and projects."

- **帧 B15** (5s): 成本对比
  - 画面: "$40/month/seat" 划掉 → "$19.99 one-time. Bring your own API key."
  - 文字: "Enterprise AI shouldn't have a per-seat tax."

#### 第四幕: CTA (10s)

- **帧 B16** (5s): CallingClaw Logo + "Self-hosted. Open source. MIT license."
  - 旁白: "Deploy it on your infrastructure. Audit every line of code."

- **帧 B17** (5s): GitHub + callingclaw.com + "Powered by Tanka Memory"
  - 最后 Tanka Logo 出现

---

## 三、两个视频的关系

```
Personal Video                    Business Video
─────────────                     ──────────────
"看，AI 能做到这个！"              "你的公司可以用它做到这些"
  ↓                                  ↓
震撼/好奇/想试                    需求/信任/想部署
  ↓                                  ↓
GitHub Star + 下载               联系我们 / 自部署
  ↓                                  ↓
开发者社区                        企业客户
```

**Personal** = 钩子 (viral, Aha moment)
**Business** = 转化 (practical, ROI)

发布顺序建议: Personal 先 → 3-5 天后 Business

---

## 四、待 8 点讨论的问题清单

1. **Personal 视频**
   - 帧1 是否改为"AI 在和第三方对话"（而不是和用户）？
   - 彩蛋拍摄: 有办公室场地吗？
   - 配音方案: AI 真实语音 or 后期配音？
   - Meeting Stage 目前能录制吗？

2. **Business 视频**
   - 企业用例优先级: 周会 vs 客户 Demo vs 1:1？全放还是挑一个？
   - 邮箱集成画面: 用 Gmail 还是 Outlook？
   - 本地部署画面: 要展示终端安装过程吗？
   - 需要 Jira/Notion 的真实操作录屏吗？还是 mock？
   - 是否需要中文版本？

3. **通用**
   - 两个视频的音乐风格统一还是不同？
   - 发布节奏: Personal 先 HN/GitHub → Business 后 LinkedIn？
   - 红杉 Jack 那篇文章具体是哪篇？怎么引用？
