# Presentation Script Spec v1

> OpenClaw produces this JSON. CallingClaw PresentationEngine consumes it.
> The script is a time-series of steps. Each step has an action + voice prompt.
> Interruptions pause the sequence; resume picks up from the current step.

## Format

```jsonc
{
  "version": 1,
  "id": "pres_xxx",
  "topic": "Tanka Action Card Phase I PRD",
  "goal": "让老板理解 Action Card 的三种语义和权限分层设计",
  "totalDurationMs": 300000,  // ~5 min estimate

  // Voice AI context — injected as Layer 2 BEFORE presentation starts
  "presenterContext": {
    "role": "你是产品经理，正在向 CEO 汇报 Action Card Phase I 的设计方案",
    "keyDecisions": [
      "一套 Action Card 覆盖 60+ Tool，不逐个设计表单",
      "Read 操作 Always Allow，Write/Delete 每次审批"
    ],
    "qaStrategies": [
      { "q": "为什么不让用户 Always Allow Write?", "a": "每次写入内容不同，用户需要审核具体执行内容" },
      { "q": "这个能覆盖多少 Tool?", "a": "204 Essential + 98 Nice-to-Have，50+ App" }
    ],
    "tone": "professional, concise, decision-driven"
  },

  // Time-series steps — executed sequentially, interruptible
  "steps": [
    {
      "action": "navigate",
      "url": "http://localhost:4000/prd-phase1.html",
      "waitMs": 2000                           // wait for page load
    },
    {
      "action": "scroll",
      "target": "背景与目标",                    // text match in DOM → scrollIntoView
      "prompt": "先给大家介绍一下背景。Tanka 已经对接了 50+ 外部 MCP，共计 60+ 可执行 Action。逐个为每个 Tool 设计表单不可维护。我们参考了 Claude Code 的通用审核模式，设计了统一的 Action Card。",
      "durationMs": 15000
    },
    {
      "action": "scroll",
      "target": "核心原则",
      "prompt": "核心原则是：AI 执行任何外部操作前必须通过 Action Card 让用户审核。一套卡片覆盖所有 Tool，同时内建功能保留 Edit Manually 的精细编辑能力。",
      "durationMs": 12000
    },
    {
      "action": "click",
      "selector": ".step-tab:nth-child(3)",     // CSS selector
      "fallbackText": "Connect",                // text match fallback
      "prompt": "我们来看 Connect 卡片的交互流程。用户首次使用时，AI 会引导连接对应的 App。",
      "durationMs": 10000
    },
    {
      "action": "scroll",
      "target": "三种语义区分",
      "prompt": "Action Card 有三种语义：Connect 引导连接、Permission 请求权限、Vote 审批执行方案。统一的卡片 UI，通过字段区分语义。",
      "durationMs": 12000
    },
    {
      "action": "navigate",
      "url": "http://localhost:4000/prd-phase1.html#permissions",
      "prompt": "接下来看权限分层。我们设计了三层模型：Tier 1 静默通过、Tier 2 仅时间线可见、Tier 3 展示 Permission Card。",
      "durationMs": 15000,
      "decisionPoint": "这里需要确认：Read 操作默认 Auto 还是 Ask？"
    },
    {
      "action": "scroll",
      "target": "端到端示例",
      "prompt": "最后看一个完整的端到端示例：从群聊信号检测到会议创建完成的流程。",
      "durationMs": 10000
    },
    {
      "action": "idle",
      "prompt": "以上就是 Action Card Phase I 的核心设计。有什么问题吗？",
      "durationMs": 30000                       // wait for Q&A
    }
  ]
}
```

## Step Actions

| Action | Required Fields | Description |
|--------|----------------|-------------|
| `navigate` | `url` | Open URL in Playwright. `waitMs` for page load (default 2000) |
| `scroll` | `target` | scrollIntoView by text match in `h1-h6, section, [id], p`. Smooth scroll. |
| `click` | `selector` or `fallbackText` | Click element. `selector` = CSS, `fallbackText` = text match fallback. |
| `idle` | — | Do nothing on screen. Wait for user interaction or timer. |

## Common Fields (all steps)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `navigate` / `scroll` / `click` / `idle` |
| `prompt` | string | no | Injected to voice AI as `[PRESENT NOW]` system context. AI speaks FROM this. |
| `durationMs` | number | no | How long to stay on this step before advancing. Default: wait for voice to finish. |
| `decisionPoint` | string | no | A decision to explicitly drive. Voice AI will ask for confirmation. |

## Execution Model

```
PresentationEngine.runScript(script)
  │
  for step in script.steps:
  │   ├── Execute action (navigate/scroll/click/idle)
  │   ├── Wait action settle (scroll animation, page load)
  │   ├── voice.presentSlide(step.prompt)     // role:"system" + response.create
  │   ├── Wait for speech done OR durationMs timeout
  │   ├── Check interruption (user spoke?)
  │   │     yes → voice responds naturally → waitForSpeechDone(10s)
  │   │     no  → continue
  │   ├── If decisionPoint → inject decision context, wait longer
  │   └── Brief pause (800ms) → next step
  │
  done → voice: "以上就是我的汇报，有什么问题吗？"
```

## Interruption & Resume

- **User speaks during a step**: Engine detects via SharedContext transcript. Pauses advancing. Voice AI responds naturally (it has full presenterContext). After voice finishes responding, engine resumes from the SAME step's next sibling.
- **User says "scroll up" / "click that"**: TranscriptAuditor handles this independently. Engine stays paused. After TranscriptAuditor executes, engine remains on current step — does NOT re-narrate.
- **User says "go back to the permissions section"**: TranscriptAuditor navigates/scrolls. Engine does NOT rewind. Voice AI can reference the content from presenterContext.
- **User says "skip" / "next"**: Engine advances to next step.
- **User says "stop" / "enough"**: Engine stops. Voice AI wraps up.

## presenterContext → Layer 2 Injection

Before execution, the full `presenterContext` is injected into the voice AI as Layer 2:

```
═══ PRESENTATION CONTEXT ═══
Role: {presenterContext.role}
Topic: {topic}
Goal: {goal}

KEY DECISIONS TO DRIVE:
- {keyDecisions[0]}
- {keyDecisions[1]}

Q&A STRATEGIES:
Q: {qaStrategies[0].q} → {qaStrategies[0].a}

SPEAKING PLAN ({steps.length} steps):
1. {steps[0].action}: {steps[0].prompt?.slice(0, 60)}...
2. {steps[1].action}: {steps[1].prompt?.slice(0, 60)}...
═══ END ═══
You are in PRESENTER mode. Present each step naturally.
The user may interrupt — answer from context, then resume.
```

## OpenClaw Contract

OpenClaw receives a task:
```
Prepare a presentation script for: {topic}
Source: {url or file paths}
Audience: {attendees}
Context: {previous meeting notes, MEMORY.md}

Output format: see presentation-script-spec.md
Save to: ~/.callingclaw/shared/presentations/{prepId}.json
```

OpenClaw has 30 minutes to:
1. Read all source documents thoroughly
2. Understand the audience (from MEMORY.md + attendee info)
3. Design narrative arc (what story to tell, what decisions to drive)
4. Map story beats to specific page locations (scroll targets, click targets)
5. Write voice prompts in natural speech style
6. Prepare Q&A strategies
7. Output the script JSON

CallingClaw sends OC task → waits for file → `presentation.prepared` event → ready to start.

## Migration from Current Formats

| Current | Maps to Script |
|---------|---------------|
| `PresentationSlide.scrollTarget` | `step.action: "scroll", step.target` |
| `PresentationSlide.talkingPoints` | `step.prompt` |
| `PresentationSlide.estimatedDurationMs` | `step.durationMs` |
| `scenes[].url` | `step.action: "navigate", step.url` |
| `scenes[].scrollTarget` | `step.action: "scroll", step.target` |
| `speakingPlan[].phase` | Encoded in `presenterContext` |
| `speakingPlan[].points` | `step.prompt` |
| `decisionPoints[]` | `step.decisionPoint` |

## File Locations

- Spec: `callingclaw-backend/docs/presentation-script-spec.md` (this file)
- Scripts: `~/.callingclaw/shared/presentations/{prepId}.json`
- Engine: `src/modules/presentation-engine.ts` → new `runScript()` method
