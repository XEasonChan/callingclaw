# CallingClaw AutoEval Experiment Log

> autoresearch 风格：每轮实验有明确目标 → 执行 → 验证 → keep/revert → 下一轮

## Current Score: 72% (v2.8.14, commit 117a917)

---

## Experiment Queue (按优先级)

- [ ] **EXP-7A**: Compiled narration — Opus 预编译解说词，Realtime 只做 TTS
- [ ] **EXP-7B**: Text simulation eval — 用 Realtime 1.5 text mode 跑多轮对话验证注入效果
- [ ] **EXP-1**: Insight prompt — [PAGE] context 加 insight 引导，不读 DOM 文字
- [ ] **EXP-2**: Audio truncation — VAD debounce + echo suppression
- [ ] **EXP-3**: Screen-voice sync — currentSection 标记 + scroll 后 DOM 同步
- [ ] **EXP-6**: User responsive — 用户打断时暂停演示回应
- [ ] **EXP-5**: Completeness — phase 进度注入
- [ ] **EXP-4**: Stage iframe — click/scroll inside iframe

## Ideas Backlog (待验证价值后进入 Queue)

- [ ] 按受众调整 narration 风格（CTO vs CEO vs 投资人）
- [ ] narration 的 full/brief 两版自动切换（基于剩余时间）
- [ ] 迟到者自动 recap
- [ ] demo 失败 graceful degradation（切换到口述模式）
- [ ] 动态 FAQ 关联（用户问的问题匹配到当前 section 的 FAQ）

---

## Completed Experiments

### EXP-7A-prep: Compiled Narration Generation
- **Date**: 2026-04-06
- **What**: Opus 直接编译 launch-video-brief.html 的 6 个 section
- **Output**: `~/.callingclaw/shared/launch_video_brief_compiled.json`
- **Result**: 6 sections × full/brief narration + FAQ + resume_hint 生成完成
- **Next**: 需要用 Realtime 1.5 text mode 验证注入效果

---

### EXP-7B-run1: Text Simulation Eval Baseline
- **Date**: 2026-04-06
- **Score**: 80% avg (6 sections + 1 interruption test)
- **Good**: Original 6/6, Chinese 6/6, No filler 6/6, Interruption handled ✅
- **Gaps**: Insight only 3/6 (sections 3,4,5 lack why/because words), Length 3/6 (too long)
- **Pika pricing question**: Model answered but made up numbers ("每月几十美元") instead of using prep FAQ data ($0.50/min). Need to inject FAQ alongside narration.
- **Next**: Adjust prompt to emphasize insight words + inject FAQ as context + cap response length

### EXP-7B-run2: Why-What-How Prompt + FAQ Injection
- **Date**: 2026-04-06
- **Score**: 82% avg (+2 from run1)
- **Why**: 2.0/2 ✅ (was 0.5/1 — Why-What-How prompt works!)
- **How**: 2.0/2 ✅ (all sections have steps/flow)
- **What**: 0.5/2 ❌ (key data points like "23帧、74秒、$19.99" not mentioned)
- **Pika pricing**: Still fabricated ("没有具体数据") despite FAQ being injected
- **Diagnosis**: Model prioritizes narrative over data. Need to add key_points as mandatory callouts.
- **Next**: Add "[MUST MENTION]" prefix for key_points in injection prompt

## Learnings

1. **gpt-realtime-1.5 支持纯文本模式** — `output_modalities: ["text"]`，可以做快速 eval
2. **replaceContext 固定 ID** 是最佳注入方式 — 每次只占 ~200 tokens
3. **不能一次灌所有 section** — 会超 Layer 3 的 3000 token 预算
4. **已讲内容需要累积摘要** — `[PRESENTED]` 固定 ID 防止重复
5. **Claude Code 本身就是 Opus** — 不需要调 API，直接在进程里编译
