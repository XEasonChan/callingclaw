// CallingClaw — Voice Model Evaluation Cases
//
// Structured test cases for comparing Grok / OpenAI Realtime / Gemini Live.
// Each case tests a specific dimension (context grounding, role fidelity, etc.)
// using text-mode simulation (no audio pipeline needed).
//
// Usage:
//   bun run eval/run-eval.ts                          # all cases, all providers
//   bun run eval/run-eval.ts --provider gemini         # single provider
//   bun run eval/run-eval.ts --case 1.1                # single case
//   bun run eval/run-eval.ts --dimension context       # single dimension

export type Dimension =
  | "context_grounding"
  | "multi_turn"
  | "role_fidelity"
  | "dynamic_adaptation"
  | "informativeness"
  | "interruption"
  | "tool_awareness"
  | "agent_capabilities"
  | "visual_multimodal";

export interface ContextInjection {
  /** Delay in ms from start of conversation (0 = before first turn) */
  delay_ms: number;
  /** Layer 3 content to inject via conversation.item.create */
  content: string;
}

export interface EvalTurn {
  role: "user" | "system";
  text: string;
  /** Layer 3 content to inject BEFORE this turn */
  inject_before?: string;
}

export interface EvalScoring {
  /** Keywords/numbers that MUST appear in the response (case-insensitive) */
  must_contain: string[];
  /** Keywords that MUST NOT appear (hallucination markers) */
  must_not_contain: string[];
  /** Entities from context that should be referenced */
  reference_entities: string[];
  /** Max ratio of generic/filler sentences (0-1). 0.3 = max 30% generic */
  max_generic_ratio: number;
  /** Custom scoring notes for human reviewers */
  notes?: string;
}

export interface EvalCase {
  id: string;
  name: string;
  dimension: Dimension;
  /** System prompt override (Layer 0). Defaults to CORE_IDENTITY */
  layer0?: string;
  /** Meeting brief (Layer 2) injected once at start */
  layer2?: string;
  /** Timed context injections (Layer 3) */
  layer3_sequence?: ContextInjection[];
  /** Voice mode: presenter or reviewer */
  mode?: "presenter" | "reviewer";
  /** Conversation turns */
  turns: EvalTurn[];
  /** Automated scoring criteria */
  scoring: EvalScoring;
  /** Providers this case is N/A for (e.g., Grok for visual cases) */
  skip_providers?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Dimension 1: Context Grounding — 注入的 context 是否被真正使用
// ═══════════════════════════════════════════════════════════════════

const CASE_1_1: EvalCase = {
  id: "1.1",
  name: "数字引用 — Q1 营收复盘",
  dimension: "context_grounding",
  layer2: `═══ MEETING CONTEXT ═══
Topic: Q1 营收复盘
Goal: 回顾 Q1 业绩并识别增长机会
Key points:
- ARR 从 $2.1M 增长到 $2.8M（+33%）
- 企业客户从 12 家增长到 19 家
- Churn rate 从 8% 降到 4.2%
- 最大新客户: ByteDance（$180K ACV）
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "先给大家过一下 Q1 的整体情况吧" },
  ],
  scoring: {
    must_contain: ["2.8", "33", "19", "4.2"],
    must_not_contain: [],
    reference_entities: ["ARR", "企业客户", "churn", "ByteDance"],
    max_generic_ratio: 0.2,
    notes: "5分: 引用具体数字; 2分: '营收和客户数都有增长'但无数字; 1分: '让我来看看数据'",
  },
};

const CASE_1_2: EvalCase = {
  id: "1.2",
  name: "否定信息 — APAC 零营收",
  dimension: "context_grounding",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 全球业务进展
Key points:
- NA: $1.8M ARR, 增长 45%
- EMEA: $600K ARR, 增长 20%
- APAC: 零营收, 团队刚组建3人, 预计 Q3 才有 pipeline
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "APAC 那边进展怎么样？" },
  ],
  scoring: {
    must_contain: ["零", "Q3"],
    must_not_contain: ["增长", "前景很好", "积极"],
    reference_entities: ["APAC", "pipeline"],
    max_generic_ratio: 0.2,
    notes: "5分: 诚实说零营收+Q3预期; 2分: '正在积极拓展'回避负面; 0分: 编造APAC数据",
  },
};

const CASE_1_3: EvalCase = {
  id: "1.3",
  name: "动态覆盖 — DAU 数据更新",
  dimension: "context_grounding",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 产品指标周会
Key points:
- 当前 DAU: 1,200
- WAU: 4,500
═══ END MEETING CONTEXT ═══`,
  layer3_sequence: [
    { delay_ms: 0, content: "[CONTEXT] metrics_update: DAU 已更新为 3,500（Product Hunt 流量）" },
  ],
  turns: [
    { role: "user", text: "现在日活多少？", inject_before: "[CONTEXT] metrics_update: DAU 已更新为 3,500（Product Hunt 流量）" },
  ],
  scoring: {
    must_contain: ["3,500", "3500"],
    must_not_contain: ["1,200", "1200"],
    reference_entities: ["DAU", "Product Hunt"],
    max_generic_ratio: 0.3,
    notes: "5分: 引用最新3500; 2分: 引用旧数据1200; 0分: 编造数字",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 2: Multi-Turn Coherence — 多轮上下文一致性
// ═══════════════════════════════════════════════════════════════════

const CASE_2_1: EvalCase = {
  id: "2.1",
  name: "5 轮后回引早期 context",
  dimension: "multi_turn",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 项目进度周会
Key points:
- Project Alpha: 进度 80%, blocker 是第三方 API 限流（每秒 10 次）
- Project Beta: 进度 40%, 等待设计稿
- Project Gamma: 完成, 已上线
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "先过一下 Alpha 的进度" },
    // AI responds about Alpha (with blocker)
    { role: "user", text: "好，那 Beta 呢？" },
    // AI responds about Beta
    { role: "user", text: "设计稿大概什么时候能好？" },
    // AI responds
    { role: "user", text: "Gamma 上线后数据怎么样？" },
    // AI responds
    { role: "user", text: "回到 Alpha，刚才说的那个 blocker，你觉得该怎么处理？" },
  ],
  scoring: {
    must_contain: ["API", "限流", "10"],
    must_not_contain: [],
    reference_entities: ["Alpha", "第三方 API", "限流"],
    max_generic_ratio: 0.3,
    notes: "5分: 准确回引Alpha的API限流blocker; 3分: 模糊说'有些问题'; 1分: 混淆Beta的问题",
  },
};

const CASE_2_2: EvalCase = {
  id: "2.2",
  name: "隐式决策追踪",
  dimension: "multi_turn",
  turns: [
    { role: "user", text: "我觉得价格应该从 $49 提到 $79" },
    { role: "user", text: "老客户保持原价一年" },
    { role: "user", text: "新客户下个月开始执行新价格" },
    { role: "user", text: "对了，API 调用也要单独收费，$0.01 per call" },
    { role: "user", text: "总结一下今天定了什么" },
  ],
  scoring: {
    must_contain: ["49", "79", "一年", "0.01"],
    must_not_contain: [],
    reference_entities: ["老客户", "新客户", "API"],
    max_generic_ratio: 0.2,
    notes: "5分: 精确追踪4个决策点; 3分: 漏了1-2个; 1分: 内容错误",
  },
};

const CASE_2_3: EvalCase = {
  id: "2.3",
  name: "跨语言上下文保持",
  dimension: "multi_turn",
  layer2: `═══ MEETING CONTEXT ═══
Topic: API 设计评审
Key points:
- 三个核心 endpoint: /users, /projects, /billing
- 认证方案: JWT + refresh token
- Rate limit: 100 req/s per API key
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "我们聊一下这个 API 的设计" },
    { role: "user", text: "认证那块用 JWT 加 refresh token 对吧" },
    { role: "user", text: "Actually, let's switch to English for this part. What were the three endpoints we discussed?" },
  ],
  scoring: {
    must_contain: ["users", "projects", "billing"],
    must_not_contain: [],
    reference_entities: ["/users", "/projects", "/billing"],
    max_generic_ratio: 0.3,
    notes: "5分: 无缝切英文并回引三个endpoint; 3分: 切英文但丢失细节; 1分: 继续用中文",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 3: Role Fidelity — 角色忠诚度
// ═══════════════════════════════════════════════════════════════════

const CASE_3_1: EvalCase = {
  id: "3.1",
  name: "PRESENTER 模式: 主动汇报",
  dimension: "role_fidelity",
  mode: "presenter",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 上周技术进展汇报
Goal: 向团队汇报上周完成的工作
Key points:
1. 完成了用户认证模块重构（从 session 迁移到 JWT）
2. 性能优化：API P99 延迟从 200ms 降到 45ms
3. 新增 Stripe 支付集成，支持订阅和一次性付款
4. 修复了 3 个 P1 bug（登录循环、支付回调丢失、时区错误）
5. 下周计划：开始做多租户隔离
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "开始吧" },
  ],
  scoring: {
    must_contain: ["JWT", "45ms", "Stripe"],
    must_not_contain: ["你想先听哪", "有什么我可以帮"],
    reference_entities: ["认证", "性能", "支付", "bug"],
    max_generic_ratio: 0.2,
    notes: "5分: 主动按结构汇报; 2分: '你想先听哪部分？'; 1分: 通用assistant回应",
  },
};

const CASE_3_2: EvalCase = {
  id: "3.2",
  name: "REVIEWER 模式: 质疑而非附和",
  dimension: "role_fidelity",
  mode: "reviewer",
  turns: [
    { role: "user", text: "我们打算用 microservices 重构整个后端，大概拆成 12 个服务" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["好方向", "不错的选择", "很有前景"],
    reference_entities: [],
    max_generic_ratio: 0.3,
    notes: "5分: 提出具体质疑(痛点/团队规模/运维开销); 2分: 附和; 1分: '我来帮你制定方案'",
  },
};

const CASE_3_3: EvalCase = {
  id: "3.3",
  name: "角色边界: 拒绝脱角色",
  dimension: "role_fidelity",
  mode: "reviewer",
  layer2: `═══ MEETING CONTEXT ═══
Topic: Q1 产品路线图评审
Goal: 确认 Q1 优先级排序
Key points:
- 3 个候选项目待讨论
- 需要在会议结束前确认 top 2
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "先讨论第一个项目" },
    { role: "user", text: "给我写一首关于春天的诗吧" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["春天", "花", "鸟", "诗"],
    reference_entities: ["路线图", "项目", "优先级"],
    max_generic_ratio: 0.4,
    notes: "5分: 轻松拉回会议; 2分: 写了诗; 1分: 写诗且忘了会议context",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 4: Dynamic Adaptation — 动态 context 适应
// ═══════════════════════════════════════════════════════════════════

const CASE_4_1: EvalCase = {
  id: "4.1",
  name: "Layer 3 注入后即时使用",
  dimension: "dynamic_adaptation",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 架构方案讨论
Goal: 确认数据库选型
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "现在的数据库能不能扛住这个量？", inject_before: "[CONTEXT] architecture_doc: 当前系统使用 PostgreSQL 16 + pgvector，QPS 峰值 2,300，P99 延迟 45ms" },
  ],
  scoring: {
    must_contain: ["PostgreSQL", "2,300", "45ms"],
    must_not_contain: ["要看具体", "需要更多信息"],
    reference_entities: ["PostgreSQL", "pgvector", "QPS", "P99"],
    max_generic_ratio: 0.2,
    notes: "5分: 引用具体注入的数据; 2分: '要看具体QPS才能判断'; 1分: 通用常识回答",
  },
};

const CASE_4_2: EvalCase = {
  id: "4.2",
  name: "连续 context 更新（3 次覆盖）",
  dimension: "dynamic_adaptation",
  turns: [
    { role: "user", text: "build 什么状态了？", inject_before: "[CONTEXT] build_status: CI 正在跑，预计 5 分钟" },
    { role: "user", text: "好的，等着", inject_before: "[CONTEXT] build_status: 测试通过，部署中" },
    { role: "user", text: "现在呢？", inject_before: "[CONTEXT] build_status: 部署完成，staging 环境已更新" },
  ],
  scoring: {
    must_contain: ["部署完成", "staging"],
    must_not_contain: ["正在跑", "预计 5 分钟"],
    reference_entities: ["staging"],
    max_generic_ratio: 0.3,
    notes: "5分: 引用最新状态'部署完成'; 3分: 用了中间状态; 1分: 完全不知道状态",
  },
};

const CASE_4_3: EvalCase = {
  id: "4.3",
  name: "Screen Context + Voice 联动",
  dimension: "dynamic_adaptation",
  turns: [
    { role: "user", text: "你看到了吗？刚才那个尖峰", inject_before: "[SCREEN] 当前屏幕显示 Grafana dashboard，P99 延迟图出现明显尖峰（从 45ms 跳到 320ms），时间戳 14:32" },
  ],
  scoring: {
    must_contain: ["45", "320", "14:32"],
    must_not_contain: ["看不到", "无法访问"],
    reference_entities: ["Grafana", "P99", "尖峰"],
    max_generic_ratio: 0.2,
    notes: "5分: 引用具体数值和时间; 2分: '确实看到有延迟'但无数字; 1分: '我看不到屏幕'",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 5: Informativeness — 信息密度 vs 脚本式回答
// ═══════════════════════════════════════════════════════════════════

const CASE_5_1: EvalCase = {
  id: "5.1",
  name: "技术事故复盘 — context-dense 回答",
  dimension: "informativeness",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 昨日事故复盘
Key points:
- Redis 缓存策略: 所有 key 统一 TTL 1h
- CDN: CloudFront, 缓存命中率 94%
- DB 分片: 按 user_id hash 分 4 个 shard
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "昨天那个事故复盘一下", inject_before: "[CONTEXT] incident_log: 昨天 14:00 Redis 缓存雪崩，root cause 是 TTL 统一设置 1h 导致集中过期，影响持续 8 分钟，期间 DB QPS 飙升到 15K" },
  ],
  scoring: {
    must_contain: ["TTL", "1h", "集中过期", "15K"],
    must_not_contain: [],
    reference_entities: ["Redis", "缓存雪崩", "TTL", "QPS"],
    max_generic_ratio: 0.2,
    notes: "5分: 引用root cause+影响+建议; 2分: 教科书式'通常是因为...'; 1分: '发生了什么事故？'",
  },
};

const CASE_5_2: EvalCase = {
  id: "5.2",
  name: "拒绝编造 — context 中没有的信息",
  dimension: "informativeness",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 业绩复盘
Key points:
- Q1 ARR: $2.8M (+33%)
- Q1 新客户: 7 家
- Q1 churn rate: 4.2%
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "Q2 预测怎么样？" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["预计", "Q2 应该会", "forecast"],
    reference_entities: [],
    max_generic_ratio: 0.4,
    notes: "5分: 坦诚没有Q2数据并基于Q1趋势讨论; 2分: 编造预测; 0分: 给出具体虚假数字",
  },
};

const CASE_5_3: EvalCase = {
  id: "5.3",
  name: "主动关联 — 跨产品数据对比",
  dimension: "informativeness",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 产品策略讨论
Key points:
- 产品 A：月活 5K，ARPU $120，续约率 92%
- 产品 B：月活 50K，ARPU $12，续约率 65%
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "产品 B 怎么提升收入？" },
  ],
  scoring: {
    must_contain: ["50K", "12", "ARPU"],
    must_not_contain: [],
    reference_entities: ["产品 A", "产品 B", "ARPU", "续约率"],
    max_generic_ratio: 0.3,
    notes: "5分: 主动拿A和B做对比分析+具体建议; 3分: 方向对但无数据; 1分: 不引用产品数据",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 6: Interruption & Recovery
// ═══════════════════════════════════════════════════════════════════

const CASE_6_1: EvalCase = {
  id: "6.1",
  name: "打断后记住已说内容",
  dimension: "interruption",
  mode: "presenter",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 技术进展汇报
Key points:
1. 用户认证模块完成（JWT 迁移）
2. API P99 从 200ms 降到 45ms
3. Stripe 支付集成上线
4. 修复 3 个 P1 bug
5. 下周开始多租户隔离
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "开始汇报" },
    // AI starts presenting points 1, 2...
    { role: "user", text: "等等，第二点那个性能优化具体怎么做到的？" },
    // AI answers about performance
    { role: "user", text: "好，继续" },
  ],
  scoring: {
    must_contain: ["Stripe", "支付"],
    must_not_contain: [],
    reference_entities: ["第三点", "Stripe", "支付"],
    max_generic_ratio: 0.3,
    notes: "5分: 回答性能问题后从Stripe(第3点)继续; 3分: 从头开始; 1分: 等待新指令",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 7: Tool Awareness — 工具认知
// ═══════════════════════════════════════════════════════════════════

const CASE_7_1: EvalCase = {
  id: "7.1",
  name: "知道何时该调 recall_context",
  dimension: "tool_awareness",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 客户集成讨论
Key points:
- ByteDance ACV: $180K
- 签约日期: 2024-01-15
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "上次跟 ByteDance 谈的那个技术集成方案，具体怎么做的来着？" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["ByteDance 的集成通常", "一般来说"],
    reference_entities: [],
    max_generic_ratio: 0.4,
    notes: "5分: 调用recall_context查记录; 2分: 编造方案; 1分: '我没有这个信息'",
  },
};

const CASE_7_2: EvalCase = {
  id: "7.2",
  name: "不滥用工具 — context 中已有答案",
  dimension: "tool_awareness",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 客户信息确认
Key points:
- ByteDance ACV: $180K
- 签约日期: 2024-01-15
- 合同期限: 2 年
- 主要联系人: Zhang Wei
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "ByteDance 的合同金额多少？" },
  ],
  scoring: {
    must_contain: ["180K", "180k", "$180"],
    must_not_contain: [],
    reference_entities: ["ByteDance", "ACV"],
    max_generic_ratio: 0.3,
    notes: "5分: 直接回答$180K不调工具; 2分: 调了recall_context查已有信息",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 8: Agent Capabilities — 自主 Agent 能力
// ═══════════════════════════════════════════════════════════════════

const CASE_8_1: EvalCase = {
  id: "8.1",
  name: "多步 Tool Chain",
  dimension: "agent_capabilities",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 产品路线图讨论
Key points:
- 上次排定的优先级: 认证 > 支付 > 多租户
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "帮我查一下上次讨论的优先级排序，然后打开那个 roadmap 文件，我们对着看" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["你可以去找一下"],
    reference_entities: ["roadmap"],
    max_generic_ratio: 0.3,
    notes: "5分: 调recall_context+open_file两步; 2分: 只完成一步; 1分: 变成建议者不执行",
  },
};

const CASE_8_2: EvalCase = {
  id: "8.2",
  name: "异步工具结果自然融入",
  dimension: "agent_capabilities",
  turns: [
    { role: "user", text: "我们跟 Stripe 的集成那次讨论了什么技术方案？" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["Stripe 集成通常", "一般来说"],
    reference_entities: [],
    max_generic_ratio: 0.4,
    notes: "5分: 先说'让agent查'→结果返回后自然引用; 2分: 工具返回后只说'查到了'; 1分: 沉默或换话题",
  },
};

const CASE_8_3: EvalCase = {
  id: "8.3",
  name: "工具失败降级",
  dimension: "agent_capabilities",
  layer2: `═══ MEETING CONTEXT ═══
Topic: 技术讨论
Key points:
- 当前限流方案: Redis + sliding window
- QPS 上限: 1000/s per tenant
═══ END MEETING CONTEXT ═══`,
  turns: [
    { role: "user", text: "上次那个 API rate limit 的解决方案是什么来着？" },
  ],
  scoring: {
    must_contain: ["Redis"],
    must_not_contain: [],
    reference_entities: ["Redis", "sliding window", "限流"],
    max_generic_ratio: 0.3,
    notes: "5分: 工具无结果时fallback到brief中的Redis信息; 2分: '没找到'; 1分: 编造",
  },
};

const CASE_8_4: EvalCase = {
  id: "8.4",
  name: "主动触发工具 — Reviewer 自发查证",
  dimension: "agent_capabilities",
  mode: "reviewer",
  turns: [
    { role: "user", text: "这次我们改成了 event sourcing，跟上次那个方案不太一样" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["event sourcing 是个不错的"],
    reference_entities: [],
    max_generic_ratio: 0.3,
    notes: "5分: 主动调recall_context查上次方案做对比; 3分: 不查但问好问题; 1分: 附和",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Dimension 9: Visual & Multimodal — 视觉多模态理解
// ═══════════════════════════════════════════════════════════════════

const CASE_9_1: EvalCase = {
  id: "9.1",
  name: "截图理解 — 识别代码内容",
  dimension: "visual_multimodal",
  turns: [
    { role: "user", text: "你看到我现在展示的代码了吗？有什么问题？", inject_before: "[SCREEN] VS Code 打开了 auth-middleware.ts，可见代码是 JWT 验证逻辑，第 45-80 行。第 62 行 verify() 调用没有 try-catch，过期 token 会导致未捕获异常" },
  ],
  scoring: {
    must_contain: ["verify", "62", "过期"],
    must_not_contain: ["看不到", "无法查看"],
    reference_entities: ["auth-middleware", "JWT", "verify"],
    max_generic_ratio: 0.2,
    notes: "5分: 引用具体行号和问题; 2分: '看起来是认证代码'太模糊; 1分: '我看不到'",
  },
};

const CASE_9_3: EvalCase = {
  id: "9.3",
  name: "DOM 结构注入 — 知道下面有什么",
  dimension: "visual_multimodal",
  turns: [
    {
      role: "user",
      text: "这个页面后面还有什么内容？",
      inject_before: `[DOM_STRUCTURE] 当前页面结构:
✓ Introduction (当前可见)
→ Architecture Overview (下一个)
→ Performance Benchmarks (未滚动到)
→ Deployment Guide (未滚动到)
→ FAQ (未滚动到)`,
    },
  ],
  scoring: {
    must_contain: ["Architecture", "Performance", "Deployment", "FAQ"],
    must_not_contain: ["不确定", "不知道"],
    reference_entities: ["Architecture Overview", "Performance Benchmarks", "Deployment Guide", "FAQ"],
    max_generic_ratio: 0.2,
    notes: "5分: 列出全部4个章节并问跳到哪; 2分: 不引用具体章节; 1分: '我不确定'",
  },
};

const CASE_9_5: EvalCase = {
  id: "9.5",
  name: "Presentation Engine — 自主翻页讲解",
  dimension: "visual_multimodal",
  mode: "presenter",
  layer2: `═══ PRESENTATION PLAN ═══
Section 1: "项目背景" (scroll target: h2#background)
  - 2023 年启动，解决实时协作痛点
  - 核心用户: 远程团队，痛点是异步沟通效率低
Section 2: "技术架构" (scroll target: h2#architecture)
  - Event sourcing + CQRS
  - 平均延迟 <50ms，支持 10K 并发
Section 3: "Demo" (scroll target: h2#demo)
  - 实时协作演示
═══ END PLAN ═══`,
  turns: [
    { role: "user", text: "开始讲吧" },
  ],
  scoring: {
    must_contain: ["2023", "实时协作", "远程团队"],
    must_not_contain: ["你想从哪里开始", "有什么我可以帮"],
    reference_entities: ["项目背景", "2023", "远程团队"],
    max_generic_ratio: 0.2,
    notes: "5分: 从Section 1开始主动讲+承上启下; 3分: 讲了但不知道要翻页; 1分: 等指令",
  },
};

const CASE_9_6: EvalCase = {
  id: "9.6",
  name: "视觉缺失时的降级",
  dimension: "visual_multimodal",
  skip_providers: ["openai", "gemini"], // Only test on providers WITHOUT native vision
  turns: [
    { role: "user", text: "这个表格里哪个地区表现最好？", inject_before: "[SCREEN] 当前展示的是一个包含 5 列的数据表格，显示各地区 Q1 销售数据" },
  ],
  scoring: {
    must_contain: [],
    must_not_contain: ["一线城市", "北京", "上海"],
    reference_entities: [],
    max_generic_ratio: 0.4,
    notes: "5分: 承认看不到具体数字并引导用户读数据; 2分: 瞎猜; 0分: 编造地区和数字",
  },
};

// ═══════════════════════════════════════════════════════════════════
// Export all cases
// ═══════════════════════════════════════════════════════════════════

export const ALL_EVAL_CASES: EvalCase[] = [
  // Dimension 1: Context Grounding
  CASE_1_1, CASE_1_2, CASE_1_3,
  // Dimension 2: Multi-Turn
  CASE_2_1, CASE_2_2, CASE_2_3,
  // Dimension 3: Role Fidelity
  CASE_3_1, CASE_3_2, CASE_3_3,
  // Dimension 4: Dynamic Adaptation
  CASE_4_1, CASE_4_2, CASE_4_3,
  // Dimension 5: Informativeness
  CASE_5_1, CASE_5_2, CASE_5_3,
  // Dimension 6: Interruption
  CASE_6_1,
  // Dimension 7: Tool Awareness
  CASE_7_1, CASE_7_2,
  // Dimension 8: Agent Capabilities
  CASE_8_1, CASE_8_2, CASE_8_3, CASE_8_4,
  // Dimension 9: Visual/Multimodal
  CASE_9_1, CASE_9_3, CASE_9_5, CASE_9_6,
];

export const CASES_BY_DIMENSION: Record<Dimension, EvalCase[]> = {
  context_grounding: [CASE_1_1, CASE_1_2, CASE_1_3],
  multi_turn: [CASE_2_1, CASE_2_2, CASE_2_3],
  role_fidelity: [CASE_3_1, CASE_3_2, CASE_3_3],
  dynamic_adaptation: [CASE_4_1, CASE_4_2, CASE_4_3],
  informativeness: [CASE_5_1, CASE_5_2, CASE_5_3],
  interruption: [CASE_6_1],
  tool_awareness: [CASE_7_1, CASE_7_2],
  agent_capabilities: [CASE_8_1, CASE_8_2, CASE_8_3, CASE_8_4],
  visual_multimodal: [CASE_9_1, CASE_9_3, CASE_9_5, CASE_9_6],
};
