# CallingClaw v2.3.1 — 验收测试指南

> 给产品经理和用户的体验验收文档
> 测试前确保: CallingClaw 后端 + Desktop 客户端 + OpenClaw 都在运行

---

## 启动检查

### 启动 CallingClaw Desktop
```bash
cd "/Users/admin/Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0/callingclaw-desktop" && npm run start
```
> ⚠️ 必须用主仓库的完整路径（不是 worktree 里的）。worktree 版本可能是旧的。
> Desktop 会自动拉起 Bun daemon（后端引擎）。如果 daemon 已在运行，Desktop 会直接连接。

**验收标准:**
- [ ] Desktop 窗口弹出，标题显示 `CallingClaw v2.3.1`
- [ ] Dock 图标是圆角龙虾爪（824x824 squircle）
- [ ] 状态栏显示：🟢运行中 🟢语音 🟢OpenClaw 🟢音频
- [ ] 首页显示 "🦞 Hey Andrew, What's our next meeting topic?"
- [ ] 无 Chrome 窗口弹出（Playwright lazy start）
- [ ] Coming Up 列表显示 Google Calendar 中的会议

---

## 测试 1: 会议准备流程

### 1a. 输入话题
在首页输入框输入: `明天下午两点讨论一下CallingClaw的hackathon demo方案`

**验收标准:**
- [ ] 输入框支持中文输入法（Enter 确认输入法不会提交话题）
- [ ] 点击"准备会议"后卡片立刻出现（<1s）
- [ ] 卡片左侧显示 `--`（等待日期），标题显示原始话题
- [ ] 侧面板自动打开，显示 Agent Activity log
- [ ] 侧面板实时更新 OpenClaw 的处理步骤

### 1b. OpenClaw 处理完成
等待 OpenClaw 完成（30s-5min）

**验收标准:**
- [ ] 侧面板 log 显示: "正在委托 OpenClaw 处理..." → "OpenClaw 已接管..."
- [ ] 卡片日期更新为实际日期（如 18）
- [ ] 卡片时间更新为 14:00
- [ ] "Join Meeting" 按钮出现（绿色，带 Meet 链接）
- [ ] "Talk Locally" 按钮出现（红色）
- [ ] prep 附件变为 "✅ Meeting Prep — 调研完成"
- [ ] 侧面板自动切换到完整的 Meeting Prep markdown

### 1c. 会前调研内容
点击卡片或 prep 附件查看调研内容

**验收标准:**
- [ ] Markdown 渲染正确（标题、列表、引用块）
- [ ] 包含: 要点 / 架构决策 / 预期问题 / 相关文件 / 链接
- [ ] 内容来自 OpenClaw 深度调研（不是空框架）
- [ ] 文件已存到 `~/.callingclaw/shared/{meetingId}_prep.md`

### 1d. 日历邀请
打开 Google Calendar 检查

**验收标准:**
- [ ] 日历事件已创建，标题正确
- [ ] 时间为 "明天下午两点"（AI 解析的）
- [ ] Meet 链接已生成
- [ ] 参会人包含你的邮箱（settings 里配置的）

---

## 测试 2: Talk Locally（本地对话）

### 2a. 开始对话
点击卡片上的 "Talk Locally" 按钮

**验收标准:**
- [ ] 侧面板打开，显示 "本地对话" 模式
- [ ] 状态栏语音变绿
- [ ] 能通过麦克风和 AI 对话（OpenAI Realtime）
- [ ] AI 回复通过扬声器播放

### 2b. 会中功能
对话过程中测试

**验收标准:**
- [ ] 截图分析在运行（log 显示 `[MeetingVision]`）
- [ ] TranscriptAuditor 在运行
- [ ] 浏览器打开一个网页，AI 能描述你在看什么（DOM 捕获）

### 2c. 结束对话
点击侧面板的 "停止" 按钮

**验收标准:**
- [ ] 语音停止
- [ ] 截图分析停止（不再有 vision log）
- [ ] 会后总结生成到 `~/.callingclaw/shared/{meetingId}_summary.md`
- [ ] 状态栏语音恢复灰色

---

## 测试 3: Google Meet 会议

### 3a. 加入会议
点击 "Join Meeting" 按钮（或用已有的 Meet 链接）

**验收标准:**
- [ ] Chrome 自动打开并导航到 Meet
- [ ] 摄像头关闭，麦克风开启（BlackHole 16ch）
- [ ] 扬声器设为 BlackHole 2ch
- [ ] 自动点击 "Join now"
- [ ] 状态显示 "进行中"

### 3b. 会中通话
在 Meet 里说话

**验收标准:**
- [ ] AI 能听到你说话（通过 BlackHole 音频桥）
- [ ] AI 回复能在 Meet 里播放
- [ ] transcript 有记录（检查 `/api/meeting/transcript`）
- [ ] 截图分析在运行

### 3c. 参会人准入
让另一个账号请求加入会议

**验收标准:**
- [ ] 自动准入（3 秒内）
- [ ] log 显示 `[MeetAdmit] ✅ Admitted: xxx`

### 3d. 会议结束
主持人结束会议（或在另一端结束）

**验收标准:**
- [ ] CallingClaw 检测到会议结束（DOM 检测）
- [ ] 自动生成会后总结
- [ ] 截图分析停止
- [ ] Telegram 收到 Todo 列表

---

## 测试 4: Sidecar 稳定性

### 4a. 长时间运行
启动 Talk Locally 对话 5 分钟

**验收标准:**
- [ ] Sidecar 不断连（无 `Python sidecar disconnected` log）
- [ ] 音频持续流通
- [ ] 截图持续工作

### 4b. 异常恢复
手动 kill Python sidecar: `pkill -f "python.*sidecar"`

**验收标准:**
- [ ] Sidecar 自动重连（3 秒内）
- [ ] 音频自动恢复（meet_bridge 配置自动重放）
- [ ] 不需要手动干预

---

## 测试 5: 设置

### 5a. 用户邮箱
点击 ⚙ 齿轮 → 找到 "Your Email" 输入框

**验收标准:**
- [ ] 显示已保存的邮箱
- [ ] 修改后保存成功
- [ ] 重启 Desktop 后邮箱仍在

### 5b. 引擎状态
检查状态栏 4 个指示灯

**验收标准:**
- [ ] 引擎运行时全绿
- [ ] 手动停止后端 → 状态栏变红
- [ ] 点击 "启动引擎" 能恢复

---

## 测试 6: 共享文档

### 6a. 文件结构
```bash
ls ~/.callingclaw/shared/
```

**验收标准:**
- [ ] 目录存在
- [ ] 有 sessions.json
- [ ] 有 `cc_*_prep.md` 文件（从测试 1 生成的）

### 6b. sessions.json
```bash
cat ~/.callingclaw/shared/sessions.json | python3 -m json.tool
```

**验收标准:**
- [ ] JSON 格式正确
- [ ] 包含测试 1 创建的会议 session
- [ ] meetingId 格式: `cc_{ts}_{rand}`
- [ ] files 字段有 prep 文件名

### 6c. OpenClaw 可访问
在 OpenClaw/Telegram 执行: `/callingclaw manifest`

**验收标准:**
- [ ] 返回 sessions 列表
- [ ] 能看到刚创建的会议

---

## 测试 7: 来自 Telegram 的会议

### 7a. OpenClaw 创建会议
在 Telegram 对 OpenClaw 说: "帮我安排一个明天讨论产品路线图的会议"

**验收标准:**
- [ ] OpenClaw 使用 `/callingclaw prepare` 或直接创建
- [ ] Google Calendar 事件创建
- [ ] prep.md 写入 shared 目录
- [ ] Desktop 上出现新的会议卡片（自动同步）

---

## 测试 8: Coming Up 列表持久化

### 8a. 重启后保留
重启 Desktop 客户端

**验收标准:**
- [ ] Coming Up 列表显示之前创建的会议（从 Google Calendar 拉取）
- [ ] Past Meetings 显示历史会议笔记
- [ ] 点击卡片能打开 prep brief（从 localStorage 缓存或 shared 目录）

---

## 测试 9: 安全网验证

### 9a. Voice 断开安全网
开始 Talk Locally → 直接关掉后端进程

**验收标准:**
- [ ] 重启后端后，vision 不会继续上一次的截图
- [ ] 不会有泄漏的截图推送到 OpenClaw

### 9b. 3 小时超时
（无需实测，代码检查）

**验收标准:**
- [ ] `callingclaw.ts` 中有 `setTimeout(() => { ... }, 3 * 60 * 60 * 1000)` 安全网

---

## Bug 报告模板

如果发现问题，请记录：
1. **步骤**: 你做了什么
2. **期望**: 应该发生什么
3. **实际**: 实际发生了什么
4. **日志**: `tail -50 /tmp/callingclaw.log`
5. **截图**: Desktop UI 状态

---

## 快速命令参考

| 操作 | 命令 |
|------|------|
| 检查状态 | `curl -s localhost:4000/api/status \| python3 -m json.tool` |
| 检查健康 | `curl -s localhost:4000/api/recovery/health \| python3 -m json.tool` |
| 查看日志 | `tail -f /tmp/callingclaw.log` |
| 重启 sidecar | `curl -X POST localhost:4000/api/recovery/sidecar` |
| 重启 voice | `curl -X POST localhost:4000/api/recovery/voice` |
| 查看 transcript | `curl -s localhost:4000/api/meeting/transcript` |
| 查看共享文件 | `ls ~/.callingclaw/shared/` |
| 查看 sessions | `cat ~/.callingclaw/shared/sessions.json \| python3 -m json.tool` |
