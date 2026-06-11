// CallingClaw Eval — Tool Calling Test Scenarios
// Tests AutomationRouter regex classification (fast lane) accuracy.
// Each case: user utterance → expected tool name + params.

import type { EvalCase, ToolCallInput, ToolCallExpected } from "../types";

export const toolCallingCases: EvalCase<ToolCallInput, ToolCallExpected>[] = [
  // ═══════════════════════════════════════════════════
  // Screen Sharing (Layer 1: Shortcuts)
  // ═══════════════════════════════════════════════════
  {
    id: "share-01",
    name: "投屏 (Chinese)",
    tags: ["zh", "screen-share"],
    input: { utterance: "帮我投屏" },
    expected: { toolName: "share_screen", minConfidence: 0.9 },
  },
  {
    id: "share-02",
    name: "Share screen (English)",
    tags: ["en", "screen-share"],
    input: { utterance: "share my screen" },
    expected: { toolName: "share_screen", minConfidence: 0.9 },
  },
  {
    id: "share-03",
    name: "Stop sharing (Chinese) — KNOWN BUG: share_screen regex matches 投屏 before stop_sharing",
    tags: ["zh", "screen-share", "known-bug"],
    input: { utterance: "停止投屏" },
    expected: { toolName: "stop_sharing", minConfidence: 0.9 },
  },
  {
    id: "share-04",
    name: "Stop presenting — KNOWN BUG: presentation regex matches before stop_sharing",
    tags: ["en", "screen-share", "known-bug"],
    input: { utterance: "stop presenting" },
    expected: { toolName: "stop_sharing", minConfidence: 0.9 },
  },
  {
    id: "share-05",
    name: "Start presentation",
    tags: ["en", "screen-share"],
    input: { utterance: "start the presentation" },
    expected: { toolName: "share_screen", minConfidence: 0.9 },
  },

  // ═══════════════════════════════════════════════════
  // Meeting Controls (Mute/Camera)
  // ═══════════════════════════════════════════════════
  {
    id: "mute-01",
    name: "Mute (Chinese)",
    tags: ["zh", "meeting-control"],
    input: { utterance: "静音" },
    expected: { toolName: "meet:toggle_mute", minConfidence: 0.8 },
  },
  {
    id: "mute-02",
    name: "Unmute (English)",
    tags: ["en", "meeting-control"],
    input: { utterance: "unmute" },
    expected: { toolName: "meet:toggle_mute", minConfidence: 0.8 },
  },
  {
    id: "mute-03",
    name: "Zoom mute",
    tags: ["en", "meeting-control"],
    input: { utterance: "zoom mute" },
    expected: { toolName: "zoom:toggle_mute", minConfidence: 0.9 },
  },
  {
    id: "camera-01",
    name: "Toggle camera (Chinese)",
    tags: ["zh", "meeting-control"],
    input: { utterance: "开关摄像头" },
    expected: { toolName: "meet:toggle_video", minConfidence: 0.8 },
  },

  // ═══════════════════════════════════════════════════
  // Open URL (Layer 1: Shortcuts)
  // ═══════════════════════════════════════════════════
  {
    id: "url-01",
    name: "Open URL (Chinese)",
    tags: ["zh", "url"],
    input: { utterance: "打开 https://github.com/XEasonChan/callingclaw" },
    expected: { toolName: "open_url", params: { url: "https://github.com/XEasonChan/callingclaw" }, minConfidence: 0.9 },
  },
  {
    id: "url-02",
    name: "Open URL (English) — KNOWN BUG: 'presentation' in URL matches share_screen regex",
    tags: ["en", "url", "known-bug"],
    input: { utterance: "open https://docs.google.com/presentation/d/abc123" },
    expected: { toolName: "open_url", params: { url: "https://docs.google.com/presentation/d/abc123" }, minConfidence: 0.9 },
  },

  // ═══════════════════════════════════════════════════
  // Open File (Layer 1: Shortcuts — fuzzy name)
  // ═══════════════════════════════════════════════════
  {
    id: "file-01",
    name: "Open file by Chinese name",
    tags: ["zh", "file"],
    input: { utterance: "打开那个landing page html文件" },
    expected: { toolName: "open_file", minConfidence: 0.8 },
  },
  {
    id: "file-02",
    name: "Open file by English name",
    tags: ["en", "file"],
    input: { utterance: "open the PRD文档" },
    expected: { toolName: "open_file", minConfidence: 0.8 },
  },

  // ═══════════════════════════════════════════════════
  // Scrolling (Layer 2: Playwright)
  // ═══════════════════════════════════════════════════
  {
    id: "scroll-01",
    name: "Scroll down (Chinese)",
    tags: ["zh", "scroll"],
    input: { utterance: "往下滚动" },
    expected: { toolName: "scroll_down", minConfidence: 0.8 },
  },
  {
    id: "scroll-02",
    name: "Scroll up (English)",
    tags: ["en", "scroll"],
    input: { utterance: "scroll up" },
    expected: { toolName: "scroll_up", minConfidence: 0.8 },
  },
  {
    id: "scroll-03",
    name: "Scroll to top",
    tags: ["en", "scroll"],
    input: { utterance: "scroll to the top" },
    expected: { toolName: "scroll_top", minConfidence: 0.85 },
  },
  {
    id: "scroll-04",
    name: "Scroll to bottom",
    tags: ["en", "scroll"],
    input: { utterance: "scroll to the bottom" },
    expected: { toolName: "scroll_bottom", minConfidence: 0.85 },
  },

  // ═══════════════════════════════════════════════════
  // Tab Management (Layer 2: Playwright)
  // ═══════════════════════════════════════════════════
  {
    id: "tab-01",
    name: "Switch tab (Chinese)",
    tags: ["zh", "tab"],
    input: { utterance: "切到第二个tab" },
    expected: { toolName: "switch_tab", minConfidence: 0.85 },
  },
  {
    id: "tab-02",
    name: "Next tab",
    tags: ["en", "tab"],
    input: { utterance: "next tab" },
    expected: { toolName: "next_tab", minConfidence: 0.85 },
  },
  {
    id: "tab-03",
    name: "Close tab — KNOWN BUG: 'close this tab' has 'this' between close and tab",
    tags: ["en", "tab", "known-bug"],
    input: { utterance: "close this tab" },
    expected: { toolName: "close_tab", minConfidence: 0.85 },
  },

  // ═══════════════════════════════════════════════════
  // Browser Click (Layer 2: Playwright)
  // ═══════════════════════════════════════════════════
  {
    id: "click-01",
    name: "Click button (Chinese)",
    tags: ["zh", "click"],
    input: { utterance: "点击那个登录按钮" },
    expected: { toolName: "browser_click", minConfidence: 0.6 },
  },
  {
    id: "click-02",
    name: "Click link",
    tags: ["en", "click"],
    input: { utterance: "click the submit link" },
    expected: { toolName: "browser_click", minConfidence: 0.6 },
  },

  // ═══════════════════════════════════════════════════
  // Zoom Controls (Layer 1: Shortcuts)
  // ═══════════════════════════════════════════════════
  {
    id: "zoom-01",
    name: "Zoom raise hand",
    tags: ["en", "zoom"],
    input: { utterance: "zoom raise hand" },
    expected: { toolName: "zoom:raise_hand", minConfidence: 0.9 },
  },
  {
    id: "zoom-02",
    name: "Zoom share screen — KNOWN BUG: generic share_screen regex matches before zoom-specific",
    tags: ["en", "zoom", "known-bug"],
    input: { utterance: "zoom share screen" },
    expected: { toolName: "zoom:start_share", minConfidence: 0.85 },
  },
  {
    id: "zoom-03",
    name: "Zoom end meeting",
    tags: ["en", "zoom"],
    input: { utterance: "zoom end the meeting" },
    expected: { toolName: "zoom:end_meeting", minConfidence: 0.85 },
  },
  {
    id: "zoom-04",
    name: "Zoom toggle chat",
    tags: ["zh", "zoom"],
    input: { utterance: "zoom打开聊天" },
    expected: { toolName: "zoom:toggle_chat", minConfidence: 0.85 },
  },
  {
    id: "zoom-05",
    name: "Zoom recording",
    tags: ["en", "zoom"],
    input: { utterance: "zoom start recording" },
    expected: { toolName: "zoom:start_recording", minConfidence: 0.85 },
  },

  // ═══════════════════════════════════════════════════
  // OpenCLI Web Adapters (Layer 1.5)
  // ═══════════════════════════════════════════════════
  {
    id: "opencli-01",
    name: "Check GitHub issues",
    tags: ["en", "opencli"],
    input: { utterance: "check the github issues" },
    expected: { toolName: "github_issues", minConfidence: 0.85 },
  },
  {
    id: "opencli-02",
    name: "HackerNews trending",
    tags: ["en", "opencli"],
    input: { utterance: "check hacker news trending" },
    expected: { toolName: "hackernews_trending", minConfidence: 0.85 },
  },
  {
    id: "opencli-03",
    name: "Google search",
    tags: ["en", "opencli"],
    input: { utterance: 'search google for "voice agent benchmarks"' },
    expected: { toolName: "google_search", params: { query: "voice agent benchmarks" }, minConfidence: 0.8 },
  },
  {
    id: "opencli-04",
    name: "查看 GitHub PR",
    tags: ["zh", "opencli"],
    input: { utterance: "查看一下 github pr" },
    expected: { toolName: "github_prs", minConfidence: 0.85 },
  },

  // ═══════════════════════════════════════════════════
  // Negative Cases (should NOT trigger any action)
  // ═══════════════════════════════════════════════════
  {
    id: "neg-01",
    name: "Opinion statement (no action)",
    tags: ["zh", "negative"],
    input: { utterance: "我觉得这个方案还需要再想想" },
    expected: { toolName: null },
  },
  {
    id: "neg-02",
    name: "Discussion (no action)",
    tags: ["en", "negative"],
    input: { utterance: "I think we should reconsider the architecture" },
    expected: { toolName: null },
  },
  {
    id: "neg-03",
    name: "Agreeing with AI (no action)",
    tags: ["zh", "negative"],
    input: { utterance: "好的没问题" },
    expected: { toolName: null },
  },
  {
    id: "neg-04",
    name: "Question (no action)",
    tags: ["en", "negative"],
    input: { utterance: "what do you think about the timeline?" },
    expected: { toolName: null },
  },
  {
    id: "neg-05",
    name: "Small talk (no action)",
    tags: ["en", "negative"],
    input: { utterance: "hey everyone, how's it going?" },
    expected: { toolName: null },
  },

  // ═══════════════════════════════════════════════════
  // Edge Cases (STT garbled, mixed language, ambiguous)
  // ═══════════════════════════════════════════════════
  {
    id: "edge-01",
    name: "Mixed language scroll",
    tags: ["zh", "en", "edge"],
    input: { utterance: "scroll down一下" },
    expected: { toolName: "scroll_down", minConfidence: 0.8 },
  },
  {
    id: "edge-02",
    name: "Slides navigation — KNOWN BUG: 'slide' matches google slides pattern before next_slide",
    tags: ["en", "edge", "known-bug"],
    input: { utterance: "next slide please" },
    expected: { toolName: "next_slide", minConfidence: 0.8 },
  },
  {
    id: "edge-03",
    name: "Window management",
    tags: ["zh", "edge"],
    input: { utterance: "最小化这个窗口" },
    expected: { toolName: "window_minimize", minConfidence: 0.85 },
  },
];
