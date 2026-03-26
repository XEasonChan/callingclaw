# CallingClaw 2.0 — Pre-Presentation QA Checklist

> 两个核心场景：**Local**（日常待机）和 **Meeting**（会议全流程）
> 每项标注 `curl` 或手动操作方式，方便快速验证

---

## Phase 0: 基础设施（5 min）

```bash
# 启动后端
cd callingclaw && bun run src/callingclaw.ts
```

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 0.1 | 后端启动无报错 | 看终端 log | `[Init]` 全部通过，无 ERROR |
| 0.2 | 全局状态正常 | `curl localhost:4000/api/status` | 所有 service 显示 connected/running |
| 0.3 | API Key 已配置 | `curl localhost:4000/api/keys` | OpenAI + Anthropic 不为空 |
| 0.4 | OpenClaw 已连接 | 看 status 里 `openclaw` | `"connected": true` |
| 0.5 | 日历已授权 | 看 status 里 `calendar` | `"connected": true`，无 auth_error |
| 0.6 | Desktop App 启动 | 打开 Electron app | 状态显示绿色，daemon running |
| 0.7 | EventBus WebSocket | 浏览器连 `ws://localhost:4000/ws/events` | 连接成功，收到 heartbeat |

---

## Phase 1: Local 场景（10 min）

### 1A. Voice 基础

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 1.1 | 启动语音 | `curl -X POST localhost:4000/api/voice/start -H 'Content-Type: application/json' -d '{"mode":"local"}'` | 返回 `ok`，log 显示 `[Voice] connected` |
| 1.2 | 语音识别 | 对麦克风说话 | 终端显示 transcript，延迟 <2s |
| 1.3 | AI 回复 | 问 "你好" | 听到 AI 回复语音 + 终端显示 assistant transcript |
| 1.4 | 打断能力 | AI 说话时打断它 | 立即停止播放，开始听你说 |
| 1.5 | 停止语音 | `curl -X POST localhost:4000/api/voice/stop` | EventBus 收到 `voice.stopped` |

### 1B. Context Recall

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 1.6 | recall_context 调用 | 语音问 "我们上次讨论的架构决策是什么？" | AI 调用 recall_context → 搜索 memory → 给出具体答案 |
| 1.7 | 本地搜索 | 同上，但问简单问题 | log 显示 `[RecallContext] quick` (本地搜索，非 OpenClaw) |
| 1.8 | OpenClaw 深度搜索 | 问复杂/模糊问题 | log 显示 `[RecallContext] thorough` → OC-002 调用 |

### 1C. Workspace Context

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 1.9 | 注入 workspace | `curl -X POST localhost:4000/api/context/workspace -H 'Content-Type: application/json' -d '{"topic":"test","files":[{"path":"/tmp/test.ts","summary":"test file"}]}'` | EventBus 收到 `workspace.updated` |
| 1.10 | Pin 文件 | `curl -X POST localhost:4000/api/context/pin -H 'Content-Type: application/json' -d '{"path":"/tmp/test.ts","summary":"test"}'` | 返回 ok |
| 1.11 | Voice 感知 context | 语音问 "我们现在在看什么文件？" | AI 提到 pinned 文件 |

### 1D. Calendar & Scheduler

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 1.12 | 日历事件列表 | `curl localhost:4000/api/calendar/events` | 返回近期会议列表 |
| 1.13 | Scheduler 启动 | `curl -X POST localhost:4000/api/scheduler/start` | 返回 ok |
| 1.14 | Scheduler 状态 | `curl localhost:4000/api/scheduler/status` | 显示 scheduled meetings（如有 2h 内会议） |
| 1.15 | 手动 poll | `curl -X POST localhost:4000/api/scheduler/poll` | log 显示 poll 结果，每个会议只注册 1 个 cron（不重复！） |

---

## Phase 2: Meeting 场景（20 min）

> 需要一个真实的 Google Meet 链接（可以自己创建一个 solo meeting）

### 2A. 会前调研

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 2.1 | 手动 prep | `curl -X POST localhost:4000/api/meeting/prepare -H 'Content-Type: application/json' -d '{"topic":"CallingClaw PRD review","url":"MEET_URL"}'` | 返回 agenda + prep brief JSON |
| 2.2 | Prep brief 内容 | 检查返回的 JSON | 包含 keyPoints、filePaths、expectedQuestions |
| 2.3 | Prep brief 持久化 | `ls ~/.callingclaw/shared/prep-*` | 有对应的 .json 文件 |
| 2.4 | Scheduler 触发 prep | 看 Scheduler poll 后的 log | `[MeetingScheduler] Triggering meeting prep` → `prep ready` |
| 2.5 | EventBus prep 事件 | WebSocket | 收到 `scheduler.prep_ready` 事件 |

### 2B. 加入会议

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 2.6 | Join 会议 | `curl -X POST localhost:4000/api/meeting/join -H 'Content-Type: application/json' -d '{"url":"MEET_URL"}'` | 返回 ok |
| 2.7 | Playwright 加入 | 看 log | `[Meeting] joining` → join steps → `admitted` |
| 2.8 | 等候室处理 | 如有等候室 | log 显示 waiting_room → 被 admit 后继续 |
| 2.9 | Audio injection 激活 | 看 log | Playwright addInitScript 注入，getUserMedia 拦截成功，remote track `muted=false` 捕获 |
| 2.10 | Voice AI 问候 | 在 Meet 里听 | AI 发出开场白 |
| 2.11 | EventBus 事件 | WebSocket | 依次收到 `meeting.joining` → `meeting.started` |
| 2.12 | Prep brief 注入 | `curl localhost:4000/api/meeting/prep-brief` | 返回完整 brief + pinned files |

### 2C. 会议中

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 2.13 | 实时转录 | 在 Meet 说话 | `curl localhost:4000/api/meeting/transcript` 返回 entries |
| 2.14 | Desktop 实时显示 | 看 Electron app | transcript 逐条刷新 |
| 2.15 | EventBus 转录流 | WebSocket | 每 2-4s 收到 `meeting.live_entry` |
| 2.16 | AI 自然回复 | 在 Meet 讨论 | AI 基于 prep brief 参与讨论 |
| 2.17 | recall_context | 问 "上次这个功能的技术决策是什么？" | AI 调用 recall_context → 给出答案 |
| 2.18 | ContextRetriever 补盲 | 偏离 prep 话题聊新内容 | log 显示 `[ContextRetriever] gap detected` → 自动补充 context |
| 2.19 | Computer action | 语音说 "打开 VS Code" | 4 层 router 分发 → 执行 |
| 2.20 | 截图 | 语音说 "截个图" | `take_screenshot` tool 调用 → 截图分析结果 |

### 2D. 离开会议 & 会后

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 2.21 | Leave 会议 | `curl -X POST localhost:4000/api/meeting/leave` | 返回 ok |
| 2.22 | 摘要生成 | 看 log | `[Meeting] Generating summary` → 完成 |
| 2.23 | Markdown 导出 | `ls ~/.callingclaw/shared/meeting-*` | 有 .md 文件，包含摘要 + action items |
| 2.24 | Tasks 提取 | `curl localhost:4000/api/tasks` | 自动创建的 task 出现 |
| 2.25 | EventBus 结束事件 | WebSocket | 收到 `meeting.ended`，payload 含 filepath + taskCount |
| 2.26 | Telegram 推送 | 检查 Telegram | 收到 todo 列表 + inline buttons（✅/❌） |
| 2.27 | Todo callback | 在 Telegram 点 ✅ | OpenClaw 收到 callback → 启动深度执行 |
| 2.28 | 会议笔记完整性 | 读 .md 文件 | 标题、时间、参与者、摘要、决策、action items 齐全 |

---

## Phase 3: 边界情况（可选，5 min）

| # | 检查项 | 验证方式 | 预期结果 |
|---|--------|----------|----------|
| 3.1 | Scheduler 去重 | 连续 poll 3 次同一个会议 | log 只显示 1 次 `Scheduled:`，不重复 |
| 3.2 | 无效 Meet URL | join 一个假链接 | 返回错误，不崩溃 |
| 3.3 | OpenClaw 断连时 | 关掉 OpenClaw，再问问题 | recall_context 降级到本地搜索，不 hang |
| 3.4 | 长对话 token | 连续聊 10+ 轮 | 无 OOM，transcript 持续正常 |
| 3.5 | 重启恢复 | 杀掉后端再启动 | cache 恢复，不重复注册 cron |

---

## 快速验证脚本

```bash
#!/bin/bash
# quick-qa.sh — 一键检查基础设施
BASE="http://localhost:4000"

echo "=== 0. Health Check ==="
curl -s $BASE/api/status | jq '{
  callingclaw: .callingclaw,
  voice: .realtime,
  calendar: .calendar,
  openclaw: .openclaw,
  meeting: .meeting
}'

echo -e "\n=== 1. API Keys ==="
curl -s $BASE/api/keys | jq '.openai, .anthropic'

echo -e "\n=== 2. Calendar Events ==="
curl -s $BASE/api/calendar/events | jq '.[0:3] | .[] | .summary'

echo -e "\n=== 3. Scheduler Status ==="
curl -s $BASE/api/scheduler/status | jq '.'

echo -e "\n=== 4. Tasks ==="
curl -s $BASE/api/tasks | jq 'length'

echo -e "\n=== 5. EventBus (5s sample) ==="
timeout 5 websocat ws://localhost:4000/ws/events 2>/dev/null || echo "(install websocat for WS test)"

echo -e "\n✅ Quick QA done"
```

---

## Scoring

| 阶段 | 项数 | 通过标准 |
|-------|------|----------|
| Phase 0: 基础设施 | 7 | **全部通过** 才继续 |
| Phase 1: Local | 15 | ≥13/15 可 present |
| Phase 2: Meeting | 28 | ≥25/28 可 present |
| Phase 3: 边界 | 5 | 加分项 |
| **总计** | **55** | **≥45/55 = 可 present** |
