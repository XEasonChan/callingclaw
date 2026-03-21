# CallingClaw — 浏览器自动化优化方案

## 当前瓶颈分析

```
每次 Playwright CLI 操作:
  shell spawn (200-500ms) + JSON 解析 (50ms) + 执行 (50-100ms) = ~400-800ms

Meet 入会流程:
  17 次子进程启动 × ~500ms = 8.5s 仅子进程开销
  16.4s 固定 wait() 调用 = 等待 DOM 渲染
  总计: ~13-20 秒
```

## 短期优化：合并 eval（本周可做）

把 7 个 phase 的多次 eval 合并成 **1-2 个大的 JS eval**，在页面内一次性完成：

```javascript
// 一个 eval 完成: 关弹窗 + 设设备 + 点 Join
await playwrightCli.evaluate(`() => {
  // Phase 1: 关弹窗
  const btns = document.querySelectorAll('button');
  btns.forEach(b => { if (['Got it','OK','Dismiss'].includes(b.textContent.trim())) b.click(); });

  // Phase 4: 关摄像头
  const camOff = document.querySelector('[aria-label*="Turn off camera"]');
  if (camOff) camOff.click();

  // Phase 6: 点 Join
  const join = [...btns].find(b => ['Join now','Ask to join','加入'].includes(b.textContent.trim()));
  if (join) join.click();

  return 'joined';
}`);
// 一次 eval，~200ms，替代当前 7 个 phase 的 ~15s
```

预计提升: **13-20s → 2-3s**

## 中期方案：Chrome DevTools Protocol 直连（v3.0）

替换 Playwright CLI 子进程模型，直接用 CDP WebSocket：

```
当前: CallingClaw → spawn playwright-cli → CLI → Chrome
目标: CallingClaw → WebSocket (CDP) → Chrome
```

### 实现方式 1: Chrome DevTools MCP Server
```bash
# Chrome 启动时带 debugging port
chrome --remote-debugging-port=9222 --user-data-dir=~/.callingclaw/browser-profile

# CallingClaw 通过 MCP 或直接 CDP WebSocket 操作
ws://127.0.0.1:9222/devtools/page/{pageId}
```

### 实现方式 2: 直接 CDP (更轻量)
```typescript
// 不需要 MCP server，直接用 Chrome DevTools Protocol
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/xxx');

// 执行 JS: ~50ms
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression: 'document.querySelector("[aria-label*=Join]").click()' }
}));
```

每次操作: **~50-150ms**（WebSocket 往返）
入会流程: **~0.5-1.5s**（10 次 eval × 100ms）

### 对比

| | 当前 CLI | 合并 eval | CDP 直连 |
|---|---|---|---|
| 每次操作 | 400-800ms | 200ms (1次) | 50-150ms |
| 入会时间 | 13-20s | 2-3s | 0.5-1.5s |
| 改动量 | — | 小 (改 joinGoogleMeet) | 大 (新 CDP client) |

## 确定性操作固化为 Skill

Meet 入会的每一步都是确定性的（已知按钮选择器）。把这些固化为快速路径：

```
skill: meet_join
  - navigate to URL
  - dismiss dialogs (Got it, Cookie, Notification)
  - configure camera OFF
  - configure audio (BlackHole 16ch mic, BlackHole 2ch speaker)
  - click Join now / Ask to join
  预计: <1s 完成

skill: meet_admit
  - detect green notification
  - click Admit / Admit all
  - handle confirmation dialog
  预计: <0.5s 完成

skill: meet_leave
  - click Leave call button
  - OR send Cmd+Shift+H
  预计: <0.2s 完成
```

这些 skill 不需要 AI — 纯 JS eval + 已知选择器。

## Page-Agent 评估

不适合 CallingClaw 的 Meet 入会场景：
- 每步需要 LLM 推理（1-2s），但我们的操作是完全确定性的
- 适合场景：ERP/CRM 表单填写（UI 不确定）、网页数据抓取
- CallingClaw 的 Computer Use (L4) 已经覆盖了需要 AI 理解的场景

## Chrome DevTools MCP 评估

技术上最优，但有开销：
- MCP 工具定义消耗 ~18k tokens
- 需要额外启动 MCP server
- 对于 CallingClaw 的确定性操作，直接 CDP WebSocket 更轻量

## 推荐路径

1. **本周**：合并 eval（短期，2-3s 入会）
2. **下周**：CDP 直连替代 Playwright CLI（中期，<1s 入会）
3. **后续**：Chrome DevTools MCP 用于非确定性操作（如网页数据理解）
