# Voice Provider Evaluation Plan

> 三家语音模型 (OpenAI gpt-realtime-1.5 / Grok 2 Audio / Gemini 3.1 Flash Live) 的语音效果 + Computer Use 能力对比测试。
> 每个 test case 用**语音输入**，评估从"说出指令"到"动作完成"的全链路。

---

## Provider 基线信息

| 维度 | OpenAI | Grok | Gemini |
|------|--------|------|--------|
| 模型 | gpt-realtime-1.5 | Grok 2 Audio | gemini-3.1-flash-live |
| 成本/min | ~$0.30 | ~$0.05 | ~$0.02 |
| Session 上限 | 120min | 30min | 15min (可续) |
| 工具数量上限 | 无限 | 无限 | **9 个** (hardcoded in gemini-adapter.ts，不含 search_files / browser_action) |
| 原生工具 | - | web_search, x_search | - |
| 视觉能力 | - | - | 1 FPS 截图 |
| VAD 阈值 | 0.6 | 0.9 (激进) | 0.7 |

---

## 测试环境准备

1. 打开 `http://localhost:4000/voice-test.html`
2. 选择 **Talk Locally** 模式（不需要 Meet）
3. 准备好要搜索的本地文件（确保 `~/.callingclaw/shared/` 有 prep 文件）
4. 每个 provider 依次执行相同的 test case
5. 每个 case 执行 **2 次**取平均（消除随机性）

---

## 评分标准

每个 test case 评分 4 个维度，每项 0-3 分：

| 分数 | 含义 |
|------|------|
| 3 | 完美 — 一次成功，延迟 < 3s |
| 2 | 良好 — 一次成功，延迟 3-8s |
| 1 | 勉强 — 需要重说/二次确认，或部分完成 |
| 0 | 失败 — 未理解意图 / 执行错误 / 超时 |

**四个维度：**
- **理解 (U)** — 是否正确理解了语音指令的意图
- **路由 (R)** — 是否选对了执行层（fast lane / Haiku / tool call）
- **执行 (E)** — 动作是否正确完成
- **延迟 (L)** — 从说完话到动作完成的时间

---

## Test Cases

### Category A: 模糊文件搜索 (Fuzzy File Search)

测试路径：语音 → TranscriptAuditor → Haiku 分类 → FileAliasIndex / search_files → 打开文件

| # | 语音指令 (中文) | 语音指令 (English) | 期望行为 | 路由预期 |
|---|---------------|-------------------|---------|---------|
| A1 | "帮我打开那个 PRD 文档" | "Open the PRD document" | 搜索 FileAliasIndex 匹配 PRD 相关文件 → 打开 | Medium lane → search_and_open |
| A2 | "找一下上次会议的笔记" | "Find the notes from last meeting" | 搜索 shared/ 下最近的 summary 文件 → 打开 | Medium lane → search_and_open |
| A3 | "打开那个 HTML 测试页面" | "Open that HTML test page" | 匹配 stage.html 或 voice-test.html → 打开 | Medium lane → search_and_open |
| A4 | "看一下 presentation 的配置" | "Check the presentation config" | 匹配 presentation-engine.ts 或相关 JSON → 打开 | Medium lane → search_and_open |
| A5 | "帮我找 audio bridge 的代码" | "Find the audio bridge code" | 匹配 audio-bridge.js → 打开编辑器 | Medium lane → search_and_open |

**Gemini 特别注意**: Gemini 有 `open_file` + `computer_action` 可以搜文件，但没有 `search_files` 专用工具（9 tool hardcoded set 不含）。观察是否通过 computer_action 补偿。

---

### Category B: 打开外部网站 (Open External Websites)

测试路径：语音 → Fast lane regex / Haiku → Layer 1 (open URL) 或 Layer 1.5 (OpenCLI)

| # | 语音指令 (中文) | 语音指令 (English) | 期望行为 | 路由预期 |
|---|---------------|-------------------|---------|---------|
| B1 | "打开 GitHub" | "Open GitHub" | 浏览器打开 github.com | Fast lane → open URL |
| B2 | "帮我打开 Hacker News" | "Open Hacker News" | 浏览器打开 news.ycombinator.com | Fast lane / Medium → open URL |
| B3 | "打开我们的 Notion 看一下" | "Open our Notion" | 打开 Notion workspace | Medium lane → open URL |
| B4 | "搜一下 Claude API 的文档" | "Search for Claude API docs" | Google 搜索 or 直接打开 docs.anthropic.com | Medium lane → google_search / open URL |
| B5 | "帮我打开 https://arxiv.org" | "Open https://arxiv.org" | 直接打开 URL（完整 URL 应该走 fast lane） | Fast lane regex → open URL |

**对比重点**: B1-B3 是模糊的（没有完整 URL），看各 provider 是否能正确推断目标网址。B5 是精确 URL，应该三家都走 fast lane。

---

### Category C: Twitter/X 搜索名人 (X Search for Celebrities)

测试路径：语音 → Haiku / Tool call → Layer 1.5 OpenCLI 或 Grok 原生 x_search

| # | 语音指令 (中文) | 语音指令 (English) | 期望行为 | 路由预期 |
|---|---------------|-------------------|---------|---------|
| C1 | "帮我在 Twitter 上搜一下 Elon Musk" | "Search Elon Musk on Twitter" | 打开 x.com 搜索 Elon Musk | OpenCLI / Grok: x_search |
| C2 | "看看 Sam Altman 最近在 X 上说了什么" | "Check what Sam Altman posted on X recently" | 打开 Sam Altman 的 X profile 或搜索 | OpenCLI / Grok: x_search |
| C3 | "搜一下 AI 相关的热门推文" | "Search for trending AI tweets" | X 搜索 "AI" 热门 | OpenCLI / Grok: x_search |
| C4 | "打开 Jensen Huang 的 Twitter 主页" | "Open Jensen Huang's Twitter profile" | 导航到 @jensen_huang 页面 | Medium → open URL |
| C5 | "帮我看看 Anthropic 的 X 账号" | "Check Anthropic's X account" | 导航到 @AnthropicAI | Medium → open URL |

**Grok 优势测试**: Grok 有原生 `x_search` 和 `web_search`，不需要经过 Playwright/OpenCLI。对比 Grok 原生搜索 vs OpenAI/Gemini 经 Layer 1.5 的速度和质量差异。

---

### Category D: 网页滚动 (Web Page Scrolling)

测试路径：语音 → Haiku 分类 → Layer 2 Playwright scroll / Layer 1.5 OpenCLI

**前置条件**: 先通过 B 类测试打开一个网页（如 Hacker News 或 GitHub），确保有页面可滚动。

| # | 语音指令 (中文) | 语音指令 (English) | 期望行为 | 路由预期 |
|---|---------------|-------------------|---------|---------|
| D1 | "往下滚一点" | "Scroll down a bit" | 页面向下滚动约 1 屏 | Fast lane regex / Medium → scroll |
| D2 | "滚到页面最底部" | "Scroll to the bottom" | 页面滚到底 | Medium → scroll(bottom) |
| D3 | "回到顶部" | "Go back to the top" | 页面滚到顶 | Medium → scroll(top) |
| D4 | "往下翻两页" | "Scroll down two pages" | 向下滚动约 2 屏 | Medium → scroll(amount) |
| D5 | "慢慢往下滚，让我看看内容" | "Slowly scroll down, let me see the content" | 缓慢平滑滚动 | Medium → scroll (考验理解"慢"的能力) |

**对比重点**: D5 是语义模糊指令，考验模型是否理解"慢慢"意味着分步小量滚动，而不是一次性到底。

---

### Category E: 网页点击 (Web Page Clicking)

测试路径：语音 → Haiku 分类 → Layer 2 Playwright snapshot + click / Layer 1.5 OpenCLI

**前置条件**: 先打开 Hacker News (news.ycombinator.com) 作为标准测试页面。

| # | 语音指令 (中文) | 语音指令 (English) | 期望行为 | 路由预期 |
|---|---------------|-------------------|---------|---------|
| E1 | "点第一条新闻" | "Click the first news item" | 点击 HN 第一条标题链接 | Medium → click (@ref) |
| E2 | "点击 Comments" | "Click on Comments" | 点击评论链接 | Medium → click (text match) |
| E3 | "帮我点那个登录按钮" | "Click the login button" | 点击 HN 的 login 链接 | Medium → click (text match) |
| E4 | "回到上一页" | "Go back" | 浏览器后退 | Fast lane / Medium → browser back |
| E5 | "点击页面上的 'More'" | "Click on 'More' on the page" | 点击 HN 底部的 More 链接（需要先滚到底） | Medium → scroll + click |

**对比重点**: E1 考验模型理解"第一条"这种序数引用。E5 考验模型是否知道 "More" 可能不在可视区域，需要先滚动。

---

### Category F: 组合指令 (Compound Commands)

测试路径：多步骤链式操作，考验模型的任务分解和上下文保持能力。

| # | 语音指令 (中文) | 语音指令 (English) | 期望行为 | 路由预期 |
|---|---------------|-------------------|---------|---------|
| F1 | "打开 GitHub 然后搜索 CallingClaw" | "Open GitHub and search for CallingClaw" | 打开 github.com → 搜索框输入 → 搜索 | Multi-step: open + type + click |
| F2 | "去 Hacker News 看看最新的头条，然后滚到第三条点进去" | "Go to Hacker News, check the headlines, scroll to the third one and click it" | HN → 定位第三条 → 点击 | Multi-step: open + scroll + click |
| F3 | "帮我截个屏然后告诉我屏幕上有什么" | "Take a screenshot and tell me what's on screen" | 截屏 → 描述内容 | Tool call: take_screenshot → 语音描述 |

---

## 评分记录表

### 单项评分

```
Test Case | Provider | 理解(U) | 路由(R) | 执行(E) | 延迟(L) | 总分 | 备注
----------|----------|---------|---------|---------|---------|------|-----
A1        | OpenAI   |         |         |         |         |      |
A1        | Grok     |         |         |         |         |      |
A1        | Gemini   |         |         |         |         |      |
A2        | OpenAI   |         |         |         |         |      |
A2        | Grok     |         |         |         |         |      |
A2        | Gemini   |         |         |         |         |      |
...
```

### 汇总评分

```
Category          | OpenAI (avg) | Grok (avg) | Gemini (avg) | Winner
------------------|-------------|------------|-------------|-------
A: 模糊文件搜索    |             |            |             |
B: 打开外部网站    |             |            |             |
C: X 搜索名人     |             |            |             |
D: 网页滚动       |             |            |             |
E: 网页点击       |             |            |             |
F: 组合指令       |             |            |             |
------------------|-------------|------------|-------------|-------
TOTAL             |             |            |             |
```

### 语音质量主观评分 (每 provider 测试结束后填写)

```
维度               | OpenAI (0-10) | Grok (0-10) | Gemini (0-10)
-------------------|-------------|------------|-------------
语音自然度          |             |            |
中文发音准确度      |             |            |
英文发音准确度      |             |            |
中英混合处理        |             |            |
语速适中度          |             |            |
打断响应速度        |             |            |
ASR 中文准确度      |             |            |
ASR 英文准确度      |             |            |
工具调用决策质量     |             |            |
```

---

## 执行流程

### Round 1: OpenAI (gpt-realtime-1.5)

1. voice-test.html → Provider: **OpenAI**, Voice: **Marin**
2. 按 A1→A5, B1→B5, C1→C5, D1→D5, E1→E5, F1→F3 顺序执行
3. 每个 case 记录：是否理解、走了哪条路由、执行结果、耗时
4. 语音质量主观评分

### Round 2: Grok (Grok 2 Audio)

1. voice-test.html → Provider: **Grok**, Voice: **Eve**
2. 相同顺序执行
3. **特别关注**: C 类（X 搜索）是否用了原生 x_search（应该更快更准）
4. **特别关注**: 30min session 限制内是否够用

### Round 3: Gemini (3.1 Flash Live)

1. voice-test.html → Provider: **Gemini**, Voice: **Kore**
2. 相同顺序执行
3. **特别关注**: A 类文件搜索（search_files 被禁用，看 FileAliasIndex fallback）
4. **特别关注**: BUG-004 音频重叠是否出现
5. **特别关注**: 15min session 续期是否无缝

---

## 观测指标 (从 voice-test.html transcript 收集)

| 指标 | 如何观测 |
|------|---------|
| **意图识别延迟** | 从 user transcript 出现 → assistant transcript "正在..." 出现的时间 |
| **动作执行延迟** | 从 tool call 发出 → tool result 返回的时间 |
| **端到端延迟** | 从用户说完 → 屏幕上动作可见的时间 |
| **路由准确率** | 是否选对了 fast/medium lane 和 Layer 1/1.5/2 |
| **二次确认率** | 模型需要反问确认的比例（越低越好） |
| **误触发率** | 模型将非指令对话误判为操作指令的比例 |
| **Audio overlap** | Gemini 专项：是否出现声音重叠 |
| **Session 断连** | 测试期间 WS 断连次数 |

---

## 已知预期差异

| 场景 | 预期 Winner | 原因 |
|------|------------|------|
| C 类 (X 搜索) | **Grok** | 原生 x_search + web_search，不需要经 Playwright |
| A 类 (文件搜索) | **OpenAI/Grok** | 有 search_files 专用工具，Gemini 靠 open_file + computer_action |
| 延迟整体 | **Gemini** | 最快的推理速度 + 最低成本 |
| 语音自然度 | **OpenAI** | GPT-4o 语音历史最久，质量最稳定 |
| 中文 ASR | **OpenAI > Gemini > Grok** | Grok 已知中文 hallucination 问题 |
| 长对话稳定性 | **OpenAI** | 120min session，无需续期 |
| 性价比 | **Gemini** | $0.02/min，15x cheaper than OpenAI |
