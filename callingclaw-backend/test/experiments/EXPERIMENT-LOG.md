# CallingClaw AutoEval Experiment Log

> autoresearch 风格：每轮实验有明确目标 → 执行 → 验证 → keep/revert → 下一轮

## Current Score: 75% best (2497ad5) | v2.9.0 released

## P0 Open Bug: Audio Truncation (5 rounds of fixes, unresolved)
- AI says half a sentence then gets cut off by next response
- Last sentence repeats
- Root cause: response.create cancels in-progress audio playback
- 5 fix attempts: audioState check → queue → response.done flush → dual-flag → text-only handling
- All partially helped but none fully solved
- Research subagent investigating OpenAI Realtime API lifecycle + industry approaches
- See memory: bug_audio_truncation_investigation.md

## Latest Run (EXP-2 audio fix)
- product_presentation: 83% (A-01~A-04 all pass) ✅
- Chrome crashed at B-01 → rest of tests got 0
- Echo debounce NOT testable via autoeval (sendText doesn't trigger VAD)
- Need real voice meeting to verify audio truncation fix
- silence_duration_ms 800→1200 applied but untestable without voice

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

### EXP-7B-run3~6: Prompt Iteration (Natural PM Style)
- **Runs**: 6 total, scores: 80 → 82 → 71 → 76 → 67 → 66
- **Learning**: Prompt 措辞优化 ROI 递减。Why-What-How 结构 prompt 让回复模板化，Natural PM 风格更好但 eval 分数反而低（eval matcher 太严格）
- **Decision**: 停止 prompt 措辞迭代。转向验证注入机制 + agent 链路

### EXP-7C: Multi-turn Injection Test (NEXT)
- **Goal**: 验证 compiled script 能否通过 replaceContext 逐段可靠注入
- **Approach**: 用 Realtime 1.5 text mode 跑 6 段连续 presentation：
  - Section 1 注入 → model 回复 → 验证收到 → 替换为 Section 2 → model 回复 → ...
  - 验证：model 不重复已讲内容 + 知道自己在第几段
- **Status**: IN PROGRESS

### EXP-7C-run4: BREAKTHROUGH — Primer message fixes hallucination ⭐
- **Date**: 2026-04-06
- **Result**: Section 1-6 ALL correctly use injected content (was 3-5 only)
- **Fix**: Added primer message before Section 1: "你即将进行N部分汇报，只讲提供的内容"
- **Pika pricing**: ✅ "每分钟0.5美金，一小时30美金，对比我们19.99买断" — first time correct!
- **Interruption**: ✅ Correct answer + resume signal
- **No repetition**: ✅
- **Relevance**: 5/6 (Section 6 too short, timeout issue)
- **Key learning**: Realtime model needs explicit framework primer before multi-turn injection. Without it, model halluccinates for first 2 turns.

### EXP-7D: Agent Pipeline — Intent Classification
- **Date**: 2026-04-07
- **Score**: 4/8 raw (50%), adjusted 6/8 (75%) after correcting eval expectations
- **Good**: share_url ✅, click ✅, stop_sharing ✅, opinion-ignore ✅
- **Issues**:
  - D-02 "往下滚动" → null (0 confidence) — need Chinese scroll patterns in prompt
  - D-04 share_file vs search_and_open — functional equivalent, eval too strict
  - D-05 navigate vs share_url — same result, different tool name
- **Bug found**: OpenAI chat completions REST API blocked (ConnectionRefused), but Realtime WebSocket works. Same OpenAI key, different protocol paths. Affects VisionModule fallback + any HTTP-based LLM calls.
- **Next**: Fix D-02 scroll recognition + adjust eval to accept functional equivalents

### Haiku + Transcript Pipeline Status (verified 2026-04-07)
- **Intent classification**: ✅ Working — share_url/scroll/click/search/open all correct (0.92-0.95)
- **File search**: ✅ "video-plan-overview" found and opened
- **ContextRetriever**: ✅ Topic shift detection + keyword fallback 3/3
- **DOM injection**: ✅ 191 chars injected after share_file
- **Dedup**: ✅ Skipping duplicate actions
- **Issues**: OpenRouter agentic search 400 error (falls back to keyword), DOM context too short (empty Stage page?)

### BUG-016: OpenAI REST API (chat/completions) ConnectionRefused
- **Impact**: VisionModule gpt-4o-mini fallback, TranscriptAuditor Haiku calls (if via OpenRouter REST)
- **Root cause**: Network/proxy routes HTTP and WebSocket differently
- **Workaround**: Use Realtime WebSocket text mode for all LLM calls that need OpenAI

## Learnings

1. **gpt-realtime-1.5 支持纯文本模式** — `output_modalities: ["text"]`，可以做快速 eval
2. **replaceContext 固定 ID** 是最佳注入方式 — 每次只占 ~200 tokens
3. **不能一次灌所有 section** — 会超 Layer 3 的 3000 token 预算
4. **已讲内容需要累积摘要** — `[PRESENTED]` 固定 ID 防止重复
5. **Claude Code 本身就是 Opus** — 不需要调 API，直接在进程里编译
