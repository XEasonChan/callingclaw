# Voice Model Evaluation Framework

## 目标

评估实时语音模型在 CallingClaw 会议场景下的表现，重点对标：
- **Context Grounding**: 注入的 context 是否被真正使用（而非泛泛回答）
- **Multi-Turn Coherence**: 多轮对话中是否维持上下文一致性
- **Role Fidelity**: 是否忠实于 Presenter / Reviewer 角色设定
- **Dynamic Adaptation**: 中途注入新 context 后，是否及时更新认知

## 评分标准（每个 case 0-5 分）

| 分数 | 含义 |
|------|------|
| 5 | 引用具体 context 数据，自然融入回答，无泛泛之谈 |
| 4 | 使用了 context 但不够具体（如只说"根据数据"但没说哪个数据） |
| 3 | 回答正确方向但明显没用 context，靠常识/猜测 |
| 2 | 部分忽略 context，给出通用脚本式回答 |
| 1 | 完全无视 context，回答与注入信息矛盾 |
| 0 | 幻觉/编造数据 |

---

## Dimension 1: Context Grounding（注入 context 的使用率）

### Case 1.1 — 带数字的 context 引用

**Setup:**
- Layer 2 注入 meeting brief:
  ```
  ═══ MEETING CONTEXT ═══
  Topic: Q1 营收复盘
  Key points:
  - ARR 从 $2.1M 增长到 $2.8M（+33%）
  - 企业客户从 12 家增长到 19 家
  - Churn rate 从 8% 降到 4.2%
  - 最大新客户: ByteDance（$180K ACV）
  ═══ END MEETING CONTEXT ═══
  ```

**Turn 1 (User):** "先给大家过一下 Q1 的整体情况吧"

**Expected (5分):** 引用具体数字 — "$2.8M ARR，环比增长 33%，企业客户增加了 7 家到 19 家，churn 降到了 4.2%"
**Red Flag (2分):** "Q1 整体表现不错，营收和客户数都有增长" ← 没引用任何具体数字
**Fail (1分):** "让我来看看最新的数据..." ← 无视已注入的 brief

### Case 1.2 — Context 中的否定信息

**Setup:**
- Layer 2 brief 包含: "APAC 市场 Q1 零营收，团队刚组建，预计 Q3 才有 pipeline"

**Turn (User):** "APAC 那边进展怎么样？"

**Expected (5分):** 诚实引用 — "APAC Q1 还没有营收，团队刚组建，pipeline 预计要到 Q3"
**Red Flag (2分):** "APAC 市场正在积极拓展中，前景很好" ← 回避负面事实，用模型本能的乐观回答
**Fail (1分):** 编造 APAC 数据

### Case 1.3 — 矛盾信息检测

**Setup:**
- Layer 2 注入: "当前 DAU: 1,200"
- Layer 3 中途注入: "[CONTEXT] metrics_update: DAU 已更新为 3,500（产品 Hunt 流量）"

**Turn (在 Layer 3 注入后):** "现在日活多少？"

**Expected (5分):** "DAU 现在是 3,500，Product Hunt 带来了一波流量"
**Red Flag (2分):** "DAU 大概在 1,200 左右" ← 用了旧 context，忽略了最新注入
**Fail (0分):** 编造一个完全不同的数字

---

## Dimension 2: Multi-Turn Coherence（多轮上下文一致性）

### Case 2.1 — 5 轮后回引早期 context

**Setup:** Layer 2 brief 包含项目列表和负责人

**Turn 1:** "先过一下 Project Alpha 的进度"
**Turn 2:** AI presents Alpha 进度
**Turn 3:** "那 Beta 呢？"
**Turn 4:** AI presents Beta 进度
**Turn 5:** "回到 Alpha，刚才说的那个 blocker，你觉得该怎么处理？"

**Expected (5分):** 准确回引 Turn 2 中 Alpha 的 blocker 细节，并给出建议
**Red Flag (3分):** 模糊地说"Alpha 确实有些问题" 但不记得具体 blocker
**Fail (1分):** 把 Beta 的问题混淆为 Alpha 的

### Case 2.2 — 隐式决策追踪

**Turn 1 (User):** "我觉得价格应该从 $49 提到 $79"
**Turn 2 (AI):** "明白，提到 $79。这个变动对现有客户怎么处理？"
**Turn 3 (User):** "老客户保持原价一年"
... 5 轮后 ...
**Turn 8 (User):** "总结一下今天定了什么"

**Expected (5分):** "价格从 $49 调到 $79，老客户原价保留一年" — 精确追踪到两个决策点
**Red Flag (3分):** 只记得提价，忘了老客户策略
**Fail (1分):** 决策内容错误

### Case 2.3 — 跨语言上下文保持

**Turn 1 (中文):** "我们聊一下这个 API 的设计"
**Turn 2 (AI回应中文)**
**Turn 3 (切英文):** "Actually, let's switch to English for this part. What were the three endpoints we discussed?"

**Expected (5分):** 无缝切英文，准确回引之前中文讨论的 endpoint 细节
**Red Flag (3分):** 切了英文但丢失了前几轮的具体内容
**Fail (1分):** 继续用中文回答 / 无法回引

---

## Dimension 3: Role Fidelity（角色忠诚度）

### Case 3.1 — PRESENTER Mode: 主动汇报 vs 等待提问

**Setup:**
- Layer 0 CORE_IDENTITY active, PRESENTER mode
- Layer 2 包含完整的项目汇报 brief（5 个 key points）

**Turn 1 (User):** "开始吧"

**Expected (5分):** 主动按结构汇报 — "好，先说整体进度。第一..." 无需等用户逐条问
**Red Flag (2分):** "好的，你想先听哪部分？" ← Reviewer 行为，不是 Presenter
**Fail (1分):** "你好！有什么我可以帮你的？" ← 完全脱离会议角色，回到通用 assistant

### Case 3.2 — REVIEWER Mode: 质疑 vs 附和

**Setup:** REVIEWER mode

**Turn 1 (User):** "我们打算用 microservices 重构整个后端"

**Expected (5分):** 提出具体质疑 — "现在的 monolith 有什么具体痛点？团队有多少人？microservices 的运维开销你们评估过吗？"
**Red Flag (2分):** "听起来是个好方向，microservices 确实有很多优势" ← 附和而非 review
**Fail (1分):** "好的，我来帮你制定 microservices 方案" ← 变成了执行者

### Case 3.3 — 角色边界：拒绝脱角色请求

**Setup:** 会议进行中

**Turn (User):** "给我写一首关于今天天气的诗吧"

**Expected (5分):** 轻松带回 — "有趣，不过我们先把这个 review 收尾？还有两个 action items 没确认"
**Red Flag (2分):** 真的写了一首诗
**Fail (1分):** 写诗并且完全忘记了会议 context

---

## Dimension 4: Dynamic Context Adaptation（动态 context 适应）

### Case 4.1 — Layer 3 注入后的即时使用

**Setup:**
- 会议正在讨论架构方案
- 中途 Layer 3 注入: `[CONTEXT] architecture_doc: "当前系统使用 PostgreSQL 16 + pgvector，QPS 峰值 2,300，P99 延迟 45ms"`

**Turn (注入后第一轮):** "现在的数据库能不能扛住这个量？"

**Expected (5分):** "现在 PostgreSQL 16 加 pgvector，QPS 峰值 2,300，P99 在 45ms。如果新功能加 30% 查询量，大概 3,000 QPS，得看看索引策略够不够"
**Red Flag (2分):** "要看具体的 QPS 和延迟数据才能判断" ← context 刚注入但没用
**Fail (1分):** "PostgreSQL 通常在中等负载下表现很好" ← 纯常识回答

### Case 4.2 — 连续 context 更新（3 次注入，每次覆盖前一次）

**Setup:**
- T=0min: Layer 3 注入 `[CONTEXT] build_status: CI 正在跑，预计 5 分钟`
- T=3min: Layer 3 注入 `[CONTEXT] build_status: 测试通过，部署中`
- T=6min: Layer 3 注入 `[CONTEXT] build_status: 部署完成，staging 环境已更新`

**Turn (T=7min):** "现在 build 什么状态？"

**Expected (5分):** "已经部署完了，staging 环境已经更新好了"
**Red Flag (3分):** "CI 正在跑" ← 用了最早的 context
**Fail (1分):** "我不确定 build 状态" ← 完全忽略三次注入

### Case 4.3 — Screen Context + Voice 联动

**Setup:**
- Layer 3 注入: `[SCREEN] 当前屏幕显示 Grafana dashboard，P99 延迟图出现明显尖峰（从 45ms 跳到 320ms），时间戳 14:32`

**Turn (User):** "你看到了吗？刚才那个尖峰"

**Expected (5分):** "看到了，14:32 那个 P99 从 45ms 跳到 320ms，7 倍的飙升。需要查一下这个时间段的 deploy log 吗？"
**Red Flag (2分):** "确实看到有延迟尖峰，我们可以分析一下" ← 没引用具体数值
**Fail (1分):** "抱歉，我看不到屏幕" ← 无视 screen context 注入

---

## Dimension 5: Informativeness vs Scripted Response（信息密度 vs 脚本式回答）

### Case 5.1 — 技术问题需要 context-dense 回答

**Setup:**
- Layer 2 brief 包含: 技术架构详情（Redis 缓存策略、CDN 配置、DB 分片方案）
- Layer 3 注入: `[CONTEXT] incident_log: 昨天 Redis 缓存雪崩，root cause 是 TTL 统一设置 1h 导致集中过期`

**Turn (User):** "昨天那个事故复盘一下"

**Expected (5分):** "昨天 Redis 缓存雪崩，根本原因是 TTL 统一设为 1 小时导致大量 key 同时过期。建议改成 TTL 加随机 jitter，比如 50-70 分钟区间。另外架构里的 CDN 层可以做一层降级方案..."
**Red Flag (2分):** "缓存雪崩通常是因为大量缓存同时失效，建议使用随机过期时间" ← 教科书答案，没用注入的 root cause
**Fail (1分):** "发生了什么事故？能详细说说吗？" ← 完全没读 context

### Case 5.2 — 拒绝编造（context 中没有的信息）

**Setup:**
- Layer 2 brief 只包含 Q1 数据
- 无 Q2 相关 context

**Turn (User):** "Q2 预测怎么样？"

**Expected (5分):** "Brief 里没有 Q2 预测数据。基于 Q1 的 33% 增长趋势，你们内部有做预测模型吗？还是需要我让 agent 去查一下？"
**Red Flag (2分):** "根据市场趋势，Q2 应该会继续增长，预计..." ← 编造预测
**Fail (0分):** 给出具体数字 — "Q2 预计 $3.5M" ← 幻觉

### Case 5.3 — 主动关联 context 中的相关信息

**Setup:**
- Layer 2 brief 包含:
  ```
  - 产品 A：月活 5K，ARPU $120，续约率 92%
  - 产品 B：月活 50K，ARPU $12，续约率 65%
  ```

**Turn (User):** "产品 B 怎么提升收入？"

**Expected (5分):** "产品 B 月活 50K 但 ARPU 只有 $12，是产品 A 的十分之一。但产品 A 续约率 92% 说明高 ARPU 客户粘性强。建议两个方向：一是提 ARPU——做 premium tier，二是提续约率——从 65% 到 80% 就多出 17.5% 的营收。优先哪个？"
**Red Flag (3分):** "可以考虑提高 ARPU 或降低 churn" ← 方向对但没有数据支撑对比
**Fail (1分):** 不引用任何产品数据

---

## Dimension 6: Interruption & Recovery（打断与恢复）

### Case 6.1 — 打断后记住已说内容

**Setup:** AI 正在汇报 5 个 key points，说到第 3 个时被打断

**Turn (User, 打断):** "等等，第二点你说的那个数字对吗？"

**Expected (5分):** 回答第二点的质疑，然后 "回到第三点..." 继续从断点汇报
**Red Flag (3分):** 回答了质疑但从头开始汇报
**Fail (1分):** 忘记在汇报什么，等待新指令

### Case 6.2 — 高频打断不崩溃

**Setup:** 用户在 5 轮内打断 AI 4 次

**Expected (5分):** 每次被打断后准确回应，核心 context 不丢失
**Red Flag (3分):** 到第 3-4 次打断时开始丢失早期 context
**Fail (1分):** 进入循环/卡顿/回到通用 assistant 模式

---

## Dimension 7: Tool Awareness（工具认知）

### Case 7.1 — 知道何时该用 recall_context

**Setup:** 会议中用户问了一个 Layer 2/3 中没有的具体信息

**Turn (User):** "上次跟 ByteDance 谈的那个集成方案，具体怎么做的来着？"

**Expected (5分):** "我让 agent 查一下上次的会议记录"（调用 recall_context） → 拿到结果后自然回答
**Red Flag (2分):** "ByteDance 的集成方案通常会涉及..." ← 编造，不调用工具
**Fail (1分):** "我没有这个信息" ← 不知道可以调用工具

### Case 7.2 — 不滥用工具（context 中已有答案）

**Setup:** Layer 2 brief 明确包含 "ByteDance ACV: $180K，签约日期: 2024-01-15"

**Turn (User):** "ByteDance 的合同金额多少？"

**Expected (5分):** 直接回答 "$180K ACV" — 不触发任何工具调用
**Red Flag (2分):** 调用 recall_context 去查 brief 中已有的信息 ← 浪费时间和 token

---

## Dimension 8: Agent Capabilities（自主 Agent 能力）

> 语音模型不只是"回答问题"，还需要在会议中自主执行多步骤操作。

### Case 8.1 — 多步 Tool Chain（信息获取 → 分析 → 行动）

**Setup:**
- 可用工具: `recall_context`, `open_file`, `save_meeting_notes`
- Layer 2 brief: 产品路线图讨论

**Turn (User):** "帮我查一下上次讨论的优先级排序，然后打开那个 roadmap 文件，我们对着看"

**Expected (5分):**
1. 调用 `recall_context` 查上次讨论 → 拿到结果
2. 说 "找到了，上次排的是 A > B > C"
3. 调用 `open_file` 打开 roadmap
4. "已经打开了，你看一下跟上次讨论的顺序对不对"
**Red Flag (2分):** 只完成第一步就停了，等用户手动触发第二步
**Fail (1分):** "你可以去找一下之前的记录" ← 不调用工具，变成建议者

### Case 8.2 — 异步 Tool 结果的自然融入

**Setup:**
- 用户问了一个需要 `recall_context(urgency: "thorough")` 的问题
- Tool 预计 5-8 秒返回

**Turn (User):** "我们跟 Stripe 的集成那次讨论了什么技术方案？"

**Expected (5分):**
1. "我让 agent 查一下那次的记录"（先给反馈）
2. [5 秒后工具返回]
3. 自然地继续："找到了——上次讨论了两个方案：webhook 回调和轮询。最终选的是 webhook，因为实时性更好。需要展开讲讲具体实现吗？"
**Red Flag (2分):** 工具返回后只说 "查到了，上次讨论了一些技术方案" ← 不引用具体内容
**Fail (1分):** 5 秒沉默后直接开始说下一个话题 ← 丢弃了工具结果

### Case 8.3 — 工具失败时的 Graceful Degradation

**Setup:**
- `recall_context` 返回 "No relevant context found"
- 但 Layer 2 brief 中有一些相关的基础信息

**Turn (User):** "上次那个 API rate limit 的解决方案是什么来着？"

**Expected (5分):** "agent 没有找到专门讨论 rate limit 的记录。不过 brief 里提到了你们用的是 Redis 做限流——是不是这个方向？还是说是另一个场景？"
**Red Flag (2分):** "没有找到相关信息" ← 不尝试从已有 context 中推断
**Fail (1分):** 编造一个方案

### Case 8.4 — 主动触发工具（不等用户要求）

**Setup:**
- REVIEWER mode
- 用户在讲架构方案，提到了 "跟上次的设计文档不太一样"

**Turn (User):** "这次我们改成了 event sourcing，跟上次那个方案不太一样"

**Expected (5分):** 主动说 "我查一下上次的方案做个对比"（调用 `recall_context`）→ 返回后: "上次的方案是 CQRS + 传统事件表。这次改 event sourcing 的话，replay 和 snapshot 策略想好了吗？"
**Red Flag (3分):** 没有主动查，但是问了好问题: "event sourcing 相比之前的方案有什么考虑？"
**Fail (1分):** "好的，event sourcing 是个不错的架构模式" ← 无 review，无对比

### Case 8.5 — 并行工具调用（如果 provider 支持）

**Setup:**
- 用户请求同时需要两个独立信息

**Turn (User):** "帮我查一下上次的技术方案，同时打开 Grafana 看看现在的延迟"

**Expected (5分):** 同时触发 `recall_context` + 浏览器操作，先完成的先汇报
**Red Flag (3分):** 串行执行（查完再打开），但都完成了
**Fail (1分):** 只做了一个就停了

---

## Dimension 9: Visual & Multimodal Understanding（视觉多模态理解）

> 评估模型在 presentation 场景下"看到"屏幕内容的能力。
> 注意：Grok 无视觉能力，此维度 Grok 全部 N/A。

### Case 9.1 — 截图理解：识别当前展示内容

**Setup:**
- 通过 `input_image`（OpenAI）或 `realtimeInput.video`（Gemini）发送一张包含代码的截图
- 或通过 Layer 3 文本注入: `[SCREEN] VS Code 打开了 auth-middleware.ts，可见代码是 JWT 验证逻辑，第 45-80 行`

**Turn (User):** "你看到我现在展示的代码了吗？有什么问题？"

**Expected (5分，原生视觉):** "看到了，这是 auth-middleware.ts 的 JWT 验证。第 62 行的 `verify()` 没有 catch 过期 token 的异常，如果 JWT 过期了会直接 500 而不是返回 401"
**Expected (5分，文本注入):** 基于注入的 screen description 准确回答代码内容
**Red Flag (2分):** "看起来是一些身份验证的代码" ← 太模糊
**Fail (1分):** "我看不到你的屏幕" ← 无视注入的视觉 context

### Case 9.2 — Presentation 翻页感知

**Setup:**
- T=0: 注入/发送 Slide 3 的截图: 包含 "Q1 Revenue: $2.8M" 的图表
- T=30s: 注入/发送 Slide 4 的截图: 包含 "Q2 Forecast" 的空白模板

**Turn (在 Slide 4 时):** "我们继续"

**Expected (5分):** "好，刚才 Q1 的 $2.8M 过完了。这页是 Q2 forecast——你们内部预测的数字是多少？" ← 知道翻页了，承上启下
**Red Flag (2分):** 继续讲 Q1 的内容 ← 没感知到翻页
**Fail (1分):** "好的，你想讨论什么？" ← 完全不知道当前展示的是什么

### Case 9.3 — DOM Context 注入：知道"下面还有什么"

**Setup:**
- 当前可视区域是文章的"Introduction"部分
- Layer 3 注入:
  ```
  [DOM_STRUCTURE] 当前页面结构:
  ✓ Introduction (当前可见)
  → Architecture Overview (下一个)
  → Performance Benchmarks (未滚动到)
  → Deployment Guide (未滚动到)
  → FAQ (未滚动到)
  ```

**Turn (User):** "这个页面后面还有什么内容？"

**Expected (5分):** "后面还有四个部分——架构概览、性能基准测试、部署指南和 FAQ。你想跳到哪一部分？还是按顺序往下走？"
**Red Flag (2分):** "让我看看..." 然后不引用具体章节
**Fail (1分):** "我不确定后面有什么内容" ← 忽略 DOM 结构注入

### Case 9.4 — 视觉+语音联动：描述图表

**Setup:**
- 发送/注入包含折线图的截图
- Layer 3 注入: `[SCREEN] Grafana dashboard: 请求延迟折线图，X 轴 00:00-23:59，Y 轴 0-500ms。可见 14:30 有一个尖峰从 45ms 跳到 320ms`

**Turn (User):** "这个图说明了什么？"

**Expected (5分，原生视觉):** 直接从图中读出趋势 + 异常点，不依赖文本注入
**Expected (5分，文本注入):** "14:30 有一个延迟尖峰，从 45ms 跳到 320ms，大概 7 倍。其余时间都很平稳。需要查一下那个时间段的 deploy log 吗？"
**Red Flag (2分):** "图表显示有一些波动" ← 没有具体数值
**Fail (0分):** 描述了一个完全不同的图表 ← 幻觉

### Case 9.5 — Presentation Engine 场景：自主翻页 + 讲解

**Setup:**
- PRESENTER mode
- Layer 2 注入完整 presentation plan:
  ```
  ═══ PRESENTATION PLAN ═══
  Section 1: "项目背景" (scroll target: h2#background)
    - 2023 年启动，解决实时协作痛点
    - 核心用户: 远程团队
  Section 2: "技术架构" (scroll target: h2#architecture)
    - Event sourcing + CQRS
    - 平均延迟 <50ms
  Section 3: "Demo" (scroll target: h2#demo)
    - 实时协作演示
  ═══ END PLAN ═══
  ```
- 当前屏幕可见 Section 1

**Turn (User):** "开始讲吧"

**Expected (5分):**
1. 从 Section 1 开始讲 — "先介绍一下项目背景。这个项目 2023 年启动，目标是解决远程团队的实时协作痛点..."
2. 讲完后主动说 "接下来看技术架构"（触发滚动到 Section 2）
3. 基于 plan 内容 + 可见屏幕内容综合讲解
**Red Flag (3分):** 讲了 Section 1 但不知道要自动翻到 Section 2
**Fail (1分):** "好的，你想从哪里开始？" ← 无 Presenter 行为

### Case 9.6 — 视觉模态缺失时的降级能力

**Setup:**
- Provider 不支持视觉输入（如 Grok）
- 只有文本注入: `[SCREEN] 当前展示的是一个包含 5 列的数据表格，显示各地区 Q1 销售数据`

**Turn (User):** "这个表格里哪个地区表现最好？"

**Expected (5分):** "根据屏幕信息，这是各地区 Q1 销售数据。不过我现在看不到具体数字——你能读一下 top 3 的数据吗？我来帮你分析"  ← 承认局限，引导用户补充
**Red Flag (2分):** "通常来说，一线城市的销售表现会更好" ← 瞎猜
**Fail (0分):** 编造具体地区和数字

---

## 执行方式

### 自动化评测

```typescript
interface EvalCase {
  id: string;                        // "1.1", "2.3", etc.
  dimension: string;                 // "context_grounding"
  setup: {
    layer0?: string;                 // CORE_IDENTITY override
    layer2?: string;                 // Meeting brief
    layer3_sequence?: {              // Timed context injections
      delay_ms: number;
      content: string;
    }[];
    mode?: "presenter" | "reviewer";
  };
  turns: {
    role: "user" | "system";
    text: string;
    inject_before?: string;         // Layer 3 content to inject before this turn
  }[];
  scoring: {
    must_contain: string[];         // 必须包含的关键词/数字
    must_not_contain: string[];     // 不能包含的（如编造数据）
    reference_entities: string[];   // 应引用的 context 实体
    max_generic_ratio: number;      // 通用句子占比上限（0-1）
  };
}
```

### 手动评测 Rubric

每个 case 由两人独立评分，取平均。评分时关注：

1. **Specificity Score**: 回答中引用了多少 context 中的具体数据（数字、名称、日期）
2. **Hallucination Check**: 是否编造了 context 中不存在的信息
3. **Staleness Check**: 是否使用了被更新覆盖的旧 context
4. **Role Adherence**: 是否保持 Presenter/Reviewer 角色行为
5. **Recovery Quality**: 打断后恢复的完整度

### 对比矩阵

| Case | Grok | OpenAI Realtime | Gemini Live | 备注 |
|------|------|-----------------|-------------|------|
| **Context Grounding** | | | | |
| 1.1 | | | | 数字引用 |
| 1.2 | | | | 否定信息 |
| 1.3 | | | | 动态覆盖 |
| **Multi-Turn** | | | | |
| 2.1 | | | | 5 轮回引 |
| 2.2 | | | | 决策追踪 |
| 2.3 | | | | 跨语言 |
| **Role Fidelity** | | | | |
| 3.1 | | | | Presenter |
| 3.2 | | | | Reviewer |
| 3.3 | | | | 角色边界 |
| **Dynamic Adaptation** | | | | |
| 4.1 | | | | 即时使用 |
| 4.2 | | | | 连续更新 |
| 4.3 | | | | Screen+Voice |
| **Informativeness** | | | | |
| 5.1 | | | | 信息密度 |
| 5.2 | | | | 拒绝编造 |
| 5.3 | | | | 主动关联 |
| **Interruption** | | | | |
| 6.1 | | | | 打断恢复 |
| 6.2 | | | | 高频打断 |
| **Tool Awareness** | | | | |
| 7.1 | | | | 工具触发 |
| 7.2 | | | | 工具克制 |
| **Agent Capabilities** | | | | |
| 8.1 | | | | 多步 Tool Chain |
| 8.2 | | | | 异步工具融入 |
| 8.3 | | | | 工具失败降级 |
| 8.4 | | | | 主动触发工具 |
| 8.5 | | | | 并行工具调用 |
| **Visual/Multimodal** | | | | |
| 9.1 | N/A | | | 截图识别 |
| 9.2 | N/A | | | 翻页感知 |
| 9.3 | | | | DOM 结构注入 |
| 9.4 | N/A★ | | | 图表描述 |
| 9.5 | | | | 自主翻页讲解 |
| 9.6 | ★重点 | N/A | N/A | 视觉缺失降级 |

> ★ Grok 无原生视觉，9.1/9.2/9.4 的原生视觉测试 N/A，但可测文本注入替代路径
> ★ 9.6 视觉缺失降级 case 只对无视觉的 provider 适用

---

### Provider 多模态能力对比

| 能力 | Grok Voice | OpenAI Realtime | Gemini Live |
|------|-----------|-----------------|-------------|
| 实时 voice session 中接收图片 | **不支持** | 支持（`input_image`） | **原生流式** |
| 视频帧输入 | 不支持 | 手动发截图（~1 FPS） | 原生 1 FPS |
| 输入格式 | N/A | base64 `conversation.item.create` | base64 `realtimeInput.video` |
| 每帧 token 消耗 | N/A | 85-765（分辨率相关） | 258（固定） |
| 视频+音频 session 上限 | N/A | 受 32K context 限制 | **2 分钟**（硬限制）|
| Function calling | 支持 | 支持 | 支持（3.1 改进） |
| 并行 tool calls | 未确认 | 支持 | 支持 |
| 屏幕理解能力 | 完全无 | 能理解截图 | 能理解实时帧 |
| API 状态 | GA（纯音频） | GA | GA(2.5) / Preview(3.1) |
| 成本 | ~$0.05/min | ~$0.30/min | ~$0.04/min(Flash) |

### 已知 Provider 差异（baseline 参考）

**Grok 当前问题（从用户反馈）：**
- 即使注入 context，仍倾向给出"本能"的通用回答（Case 1.1, 5.1 预期低分）
- system prompt 配置后行为不稳定（Case 3.1, 3.2 预期低分）
- 脚本式回答多，informative 内容少（Case 5.1-5.3 预期低分）
- 完全无视觉能力，presentation 全靠 PresentationEngine 预编排（Case 9.x 全 N/A）
- 工具调用行为基本可用但不够主动（Case 8.4 预期中等）

**OpenAI Realtime 预期优势：**
- Instructions following 最强（角色保持好，Case 3.x 预期高分）
- Context grounding 可靠（Case 1.x 预期高分）
- 支持 `input_image` — 可每隔 N 秒发截图，模型直接"看到"屏幕（Case 9.1-9.4 可测原生视觉）
- 工具调用成熟，支持并行 tool calls
- **劣势**: 成本 6x，图片吃 context window（32K 总量）

**Gemini Live 关键发现：**
- **唯一**原生 audio+video 流式 API — 模型真正能"实时看到"屏幕
- 但 **视频+音频 session 限制 2 分钟**，对会议场景致命
- 3.1 Flash Live（2026-03-26 preview）声称 "twice as long"，可能 4 分钟，仍不够
- 成本最低（Flash 级别 ~$0.04/min）
- Function calling 在 3.1 中改进，但实际 tool use 质量待验证
- **最佳使用方式**: 短时视觉 burst（开启 screen share 时临时启用 2 分钟）而非全程开着

### CallingClaw Presentation 场景推荐架构

```
方案 A: OpenAI Realtime（推荐近期实施）
┌──────────────────────────────────────────┐
│  Voice: OpenAI Realtime (gpt-realtime)   │
│  ├─ Audio: 原生双向                       │
│  ├─ Vision: 每 3-5s 发一张截图 (input_image) │
│  ├─ DOM: conversation.item.create 文本注入 │
│  └─ Tools: function calling               │
│                                           │
│  不再需要:                                 │
│  - 单独的 VisionModule sidecar            │
│  - Gemini Flash 做中间翻译                 │
│  - PresentationEngine 预编排 talkingPoints │
│    (模型自己看到屏幕就知道讲什么)           │
└──────────────────────────────────────────┘

方案 B: Grok + Sidecar（当前架构，降级方案）
┌──────────────────────────────────────────┐
│  Voice: Grok (便宜)                       │
│  ├─ Audio: 原生双向                       │
│  ├─ Vision: 无 → 依赖 VisionModule       │
│  ├─ DOM: Layer 3 文本注入                 │
│  └─ Tools: function calling               │
│                                           │
│  Sidecar:                                 │
│  - VisionModule (Gemini Flash batch API)  │
│  - PresentationEngine (Haiku 预编排)      │
│  - 截图 → 描述 → 文本注入到 Grok context  │
└──────────────────────────────────────────┘

方案 C: Gemini Live 混合（未来探索）
┌──────────────────────────────────────────┐
│  Primary Voice: Grok 或 OpenAI (全程)     │
│  Visual Burst: Gemini Live (screen share 时)│
│  ├─ Screen share 开始 → 启动 Gemini Live  │
│  ├─ 2-4 分钟视觉理解                      │
│  ├─ 生成页面结构 + 关键洞察               │
│  ├─ 注入到 Primary Voice 的 Layer 3       │
│  └─ Screen share 结束 → 关闭 Gemini Live  │
└──────────────────────────────────────────┘
```
