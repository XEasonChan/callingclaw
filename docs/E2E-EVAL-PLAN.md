# CallingClaw E2E Eval Plan

> 参考 autoresearch 模式：每轮实验有明确的验证指标和 prompt，可以反复迭代优化。

## 测试架构

```text
测试脚本 (e2e-presentation-test.ts)
  ├── 驱动层：直接调 API 执行 action (share/scroll/click/navigate)
  ├── 语音层：sendText 模拟用户语音指令，验证 voice model 响应
  ├── 监控层：读 transcript + log，验证预期行为
  └── Eval：对比预期 vs 实际，输出 pass/fail + 发现新 bug
```

***

## Eval 用例

### Category 1: 语音 → 工具调用（TranscriptAuditor 链路）

测试 voice model 或 TranscriptAuditor 是否能从自然语言触发正确的 tool call。

| ID    | 语音输入                  | 预期 Tool Call                                        | 预期 Log Pattern                        | 预期 Voice Response |
| ----- | --------------------- | --------------------------------------------------- | ------------------------------------- | ----------------- |
| V-001 | "帮我投屏 CallingClaw 官网" | `share_screen({url:"https://www.callingclaw.com"})` | `[ShareScreen] Opened presenting tab` | 包含"投屏"或"共享"       |
| V-002 | "向下滚动"                | `interact({action:"scroll_down"})` 或 auditor scroll | `scrolled_down`                       | 描述新出现的内容          |
| V-003 | "点击 Vision 链接"        | `interact({action:"click",target:"Vision"})`        | `clicked` 或 `scrolled_to`             | 包含"愿景"或"Vision"   |
| V-004 | "打开 Google 搜索 manus"  | `share_screen` 或 `open_url`                         | `Opened presenting tab.*google`       | 描述搜索结果            |
| V-005 | "退出会议"                | `leave_meeting({})`                                 | `Left meeting`                        | 包含"再见"或无          |
| V-006 | "打开那个 PRD 文件"         | `open_file` 或 `search_files` + `open_file`          | `prd-phase1`                          | 包含"PRD"或"文档"      |
| V-007 | "把这个 PRD 投屏到 Stage 上" | `share_screen({target:"iframe"})`                   | `loadSlideFrame`                      | 包含"加载"或"投屏"       |

### Category 2: Prep Script → 自主演示（PresentationEngine 链路）

测试从 meeting prep 的 speakingPlan 驱动 voice model 自主执行演示。

| ID    | Prep 内容                                                                  | 预期行为           | 预期 Log                   | 验证                         |
| ----- | ------------------------------------------------------------------------ | -------------- | ------------------------ | -------------------------- |
| P-001 | speakingPlan: [{phase:"开场", points:"介绍 CallingClaw"}]                    | voice 自动开始介绍   | `[Voice] Speech started` | transcript 包含"CallingClaw" |
| P-002 | scenes: [{url:"localhost:4000/prd-phase1.html", talkingPoints:"介绍 PRD"}] | 加载 iframe + 介绍 | `loadSlideFrame.*prd`    | voice 描述 PRD 内容            |
| P-003 | decisionPoints: ["确认视频脚本方案"]                                             | voice 主动询问决策   | transcript 包含"确认"        | voice 包含"方案"或"决定"          |

### Category 3: 屏幕感知 → 语音描述（Vision 链路）

测试 voice model 能否基于实际屏幕内容进行准确描述。

| ID    | 屏幕状态               | Voice 指令   | 预期 Response         | 验证方法                |
| ----- | ------------------ | ---------- | ------------------- | ------------------- |
| S-001 | callingclaw.com 首页 | "描述屏幕上的内容" | 包含"CallingClaw"相关描述 | response 不含"会议界面"   |
| S-002 | Google 搜索结果页       | "搜索结果有什么"  | 描述搜索结果条目            | response 包含搜索相关词    |
| S-003 | prd-phase1.html    | "这个文档讲了什么" | 描述 PRD 内容           | response 包含 PRD 关键词 |
| S-004 | 滚动后的新内容            | "新出现了什么"   | 描述视口内容              | response 不同于滚动前     |

### Category 4: Action 执行验证（DOM 操作链路）

测试 interact/scroll/click 是否真正执行并改变页面状态。

| ID    | Action    | API Call                                   | 预期 Result             | 验证                    |
| ----- | --------- | ------------------------------------------ | --------------------- | --------------------- |
| A-001 | 投屏        | POST /api/screen/share                     | `{success:true}`      | presenting tab 存在     |
| A-002 | 滚动        | POST /api/screen/scroll {down:600}         | `scrolled_down_600px` | scroll position 变化    |
| A-003 | 目标滚动      | POST /api/screen/scroll {target:"pricing"} | `scrolled_to:Pricing` | 元素在视口内                |
| A-004 | iframe 加载 | POST /api/screen/iframe/load               | `{success:true}`      | iframe src 已更新        |
| A-005 | 页面切换      | POST /api/screen/share {url:google.com}    | `{success:true}`      | presenting tab URL 变化 |
| A-006 | 点击链接      | interact click "Pricing"                   | `clicked`             | URL 或页面内容变化           |

***

## 当前阻塞项

### BUG-005: BrowserCapture CDP 连接失败

* **影响**: take_screenshot 返回空，voice model 看不到屏幕

* **症状**: voice 一直说"还是会议界面"

* **根因**: ChromeLauncher 用随机 port 启动 Chrome，BrowserCapture 找不到 debug port

* **修复方向**: ChromeLauncher.launch() 返回 port → 传给 BrowserCapture

### BUG-007: VisionModule 网络问题

* **影响**: Gemini Flash (OpenRouter) 连不上

* **缓解**: 已加 gpt-4o-mini fallback，但需要 BUG-005 先修

* **验证**: 修完 BUG-005 后，S-001~S-004 应该全通

### BUG-006: Voice model 不自驱

* **影响**: 注入 program 后 voice 只聊天不调工具

* **分析**: OpenAI Realtime 是对话优化，不适合 imperative execution

* **方案**: 用 API 驱动 action + voice 负责解说（当前 harness 已实现）

* **长期**: TranscriptAuditor 闭环（已加 response.create）让用户自然语音触发

### BUG-009: interact 不能操作 iframe

* **影响**: Stage iframe 内的内容不能点击/滚动

* **方案**: 加 `/api/screen/iframe/eval` endpoint + interact tool 支持 target="iframe"

***

## 迭代计划

### 第 1 轮: 修 BrowserCapture CDP (BUG-005)

* 目标: S-001 通过（voice 能描述 callingclaw.com 内容）

* 验证: voice response 包含 "CallingClaw" 且不含 "会议界面"

### 第 2 轮: 验证 Vision fallback (BUG-007)

* 目标: S-001~S-004 全通

* 验证: `[Vision] Fallback to gpt-4o-mini succeeded` 出现在 log

### 第 3 轮: 语音 → 工具调用 (V-001~V-007)

* 目标: TranscriptAuditor 从自然语音触发正确 action

* 验证: transcript 中出现 [Tool Call] + voice response 匹配

### 第 4 轮: iframe 交互 (BUG-009)

* 目标: Stage iframe 内容可点击/滚动

* 验证: A-004 + P-002 通过

### 第 5 轮: 全链路 prep-driven 演示 (P-001~P-003)

* 目标: 从 prep script 自动驱动完整演示

* 验证: voice 按 speakingPlan 顺序执行

⠀