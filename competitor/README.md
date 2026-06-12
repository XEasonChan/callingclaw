# CallingClaw 竞品情报库

> **最后更新**: 2026-06-11 · AI 辅助调研（每个竞品由独立 agent 联网核实，来源附在各文件末尾）
> **参照产品 (CallingClaw)**: 实时语音 AI，作为参会者加入 Google Meet / Zoom，**会听、会说、会记笔记、能看共享屏幕、能控制 macOS 电脑**，本地运行，中英文双语。

每个竞品一个独立 `.md` 文件，含：团队/创始人、融资/财务、产品功能+最新动态时间线、Marketing 账号、Marketing 内容/策略、评论区反馈、对 CallingClaw 的威胁评估、信息来源。

---

## 竞品列表

| 文件 | 竞品 | 类别 | 与 CallingClaw 的关系 |
|------|------|------|------------------------|
| [otter-ai.md](otter-ai.md) | Otter.ai | 笔记 + **会说话的 Meeting Agent** | **最直接** — 唯一已落地"实时说话参会"的成熟玩家 |
| [fireflies-ai.md](fireflies-ai.md) | Fireflies.ai | 笔记 + AI 助手 Fred | 市场领导者（$1B 估值），但不实时说话/不控制电脑 |
| [fathom.md](fathom.md) | Fathom | 免费笔记（满意度 #1） | 被动录制，靠免费碾压"笔记"层 |
| [read-ai.md](read-ai.md) | Read.ai | 笔记 + 互动分析 + 跨工具搜索 | 被动；隐私争议严重 |
| [granola.md](granola.md) | Granola | **本地优先、不派 bot** 的笔记本 | 哲学最接近（$1.5B 独角兽），但不说话/不行动 |
| [circleback.md](circleback.md) | Circleback | 高精度笔记 + 会后自动化 | 小团队（YC W24），会后自动化非实时 |
| [tldv.md](tldv.md) | tl;dv | 多语言笔记 + 销售教练 | **中文/多语言**正面重叠；营销内容很猛 |
| [cluely.md](cluely.md) | Cluely | **隐形单人 AI 提词器** | 不同品类，但抢"会议 AI"声量与融资氧气 |
| [pika-pikastream.md](pika-pikastream.md) | Pika PikaStream | **云端 AI 虚拟形象参会** | 品类共创者；核心 bug 仍未修，是机会窗口 |
| [platform-native-ai-zoom-teams-meet.md](platform-native-ai-zoom-teams-meet.md) | Zoom / Teams / Meet 自带 AI | **免费、内置**的平台原生 AI | 最大的"足够好且免费"商品化威胁 |

> 还可补充的候选（暂未建档，告诉我即可加）：Recall.ai（会议 bot 基础设施 / API）、Avoma、Supernormal、Spinach、Screenpipe、ScreenApp、Gong/Chorus（收入智能，邻近赛道）。

---

## 品类定位图

```text
                  被动（只听只记）                 主动（会说 / 会行动）
                        │                              │
   云端          Otter · Fireflies · Read.ai      Pika PikaStream（说话，看不见屏幕/不操作）
                 Fathom · tl;dv · Circleback       Otter Meeting Agent（会说话）
   平台内置       Zoom/Teams/Meet 自带 AI（免费）        ——
                        │                              │
   本地           Granola（不派 bot，只增强你的笔记）   ★ CallingClaw（说话+视觉+电脑控制）
   单人隐形                                          Cluely（提词器，不参会/不发声）
```

**结论**：右下角"本地 + 主动参会 + 会说话 + 能操作电脑 + 能看屏幕"这一格，目前只有 CallingClaw。最逼近的是 Otter Meeting Agent（会说话但云端、不操作电脑）和 Pika（会说话但云端、看不见屏幕、bug 未修）。

---

## 能力对比矩阵

| 能力 | CallingClaw | Otter | Fireflies | Fathom | Read.ai | Granola | Circleback | tl;dv | Pika | Zoom/Teams/Meet | Cluely |
|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 加入会议 | ✅本地 | ✅云 | ✅云 | ✅云 | ✅云 | ⚠️不派bot | ✅云 | ✅云 | ✅云 | ✅内置 | ❌不参会 |
| **实时说话** | ✅ | ✅* | ❌(聊天框) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅** | ❌ | ❌(只对你) |
| 看共享屏幕 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️只读截屏 | ❌ | ❌ | ❌ | ✅(看你的屏) |
| **控制电脑** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 会后自动化/执行 | ✅ | ⚠️ | ⚠️ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ⚠️ | ❌ |
| 本地运行/隐私 | ✅ | ❌ | ❌ | ⚠️3.0本地捕获 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌(企业云) | ⚠️本地叠加层 |
| 原生中文 | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅多语言 | ❌(Issue#2未修) | ⚠️ | ⚠️ |

\* Otter Meeting Agent（2025-03）可在通话中语音应答。 \*\* Pika 的语音对部分用户失效（GitHub Issue #3 至今未修）。

---

## 团队 / 融资速览

| 竞品 | 创始人 | 融资 / 估值 | 规模 | 备注 |
|------|--------|-------------|------|------|
| Otter.ai | Sam Liang, Yun Fu | ~$63M，~35M 用户、~$100M ARR(2025) | ~85–280? | 面临加州集体诉讼（偷录指控） |
| Fireflies.ai | Krish Ramineni, Sam Udotong | ~$19M 募集、**$1B 估值**(2025 员工 tender) | ~100 人远程 | 2023 起盈利；BIPA 集体诉讼 |
| Fathom | Richard White | $17M A 轮(2024)、单一来源 $73M 估值、~$30M ARR | ~150–170 | G2 满意度 #1（5.0/~6800 评） |
| Read.ai | David Shim 等 | **~$81M**（B 轮 $50M，~$450M 估值） | — | Trustpilot ~1.4★，多校禁用 |
| Granola | Chris Pedregal, Sam Stephenson | **$125M C 轮(2026-03)、$1.5B 估值** | ~50–116 | 本地优先；增长靠创始人/口碑 |
| Circleback | Ali Haghani, Kevin Jacyna | **$2.5M 种子(YC 领投)** | ~8 人 | a16z 背书**未证实**；YC W24 |
| tl;dv | Raphael Allstadt, Carlo Thissen | ~$4.49M 种子、~$4.5M ARR(估) | ~60 | 德国；营销内容机器 |
| Cluely | Roy Lee, Neel Shanmugam | $5.3M 种子 + **$15M(a16z)**、~$120M 估值 | — | ARR 曾撒谎（创始人已承认） |
| Pika Labs | Demi Guo, Chenlin Meng | **~$135M**、~$470M 估值（主业文生视频） | — | PikaStream 仅是其一个 skill |
| Zoom/MS/Google | 上市巨头 | 不适用（巨头） | 不适用 | 免费/捆绑分发是最大威胁 |

---

## 三类威胁与应对

1. **商品化威胁（最严重）— Zoom/Teams/Meet 自带 AI + Fathom 免费层**
   平台把"笔记/总结"做成免费内置，Fathom 又用免费层压垮付费意愿。
   → **CallingClaw 绝不在"笔记/总结"这一层竞争或定价**。锚定它们短期内结构上做不到的：主动发声参会、看屏幕、控电脑、本地隐私、跨平台、中文。

2. **同品类直接威胁 — Otter Meeting Agent / Pika PikaStream**
   两者都已能"在会上说话"，是离我们最近的。
   → 主打它们的缺口：**控制电脑 + 看共享屏幕 + 本地运行 + 中文 + 成本**。Pika 的音频 bug 与中文缺失（Issue #2/#3 未修）是可立刻借势的窗口。

3. **隐私/合规反弹 — 几乎所有云端 bot 的共性软肋**
   Otter（集体诉讼）、Fireflies（BIPA 诉讼）、Read.ai（多校禁用、Trustpilot 1.4★）都因"未经同意偷录 + 云端训练"挨打。
   → CallingClaw 的"**本地运行、不偷录、数据留在你电脑上**"是直接反向定位的强卖点（注意：我们*作为参会者加入*，需自证同意机制，参考 Granola 的合规话术）。

**一句话定位建议**：*"别人的 AI 在会上记笔记；CallingClaw 在会上替你干活——它会说、看得见屏幕、还能动手。"*

---

## 数据置信度说明

- **高置信**：团队/创始人、融资轮次、产品能力差异、隐私诉讼/封禁事件、主流评分站点评分（多为一手或权威来源）。
- **中/低置信（各文件已标"未能核实"）**：社媒粉丝数（时间敏感、多为二手聚合）、部分 ARR/估值（单一来源或第三方估算）、部分公司员工数。
- 建议每 4–6 周刷新一次；Pika 的 GitHub issue 状态、Otter/Fireflies 诉讼进展、Granola/Cluely 的新融资值得持续盯。
