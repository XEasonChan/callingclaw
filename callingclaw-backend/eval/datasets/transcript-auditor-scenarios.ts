// CallingClaw Eval — TranscriptAuditor Intent Classification Scenarios
// Tests the Haiku LLM medium lane: multi-turn transcript → action intent.
// These simulate real meeting conversations with labeled expected actions.

import type { EvalCase, TranscriptAuditorInput, TranscriptAuditorExpected } from "../types";

const MEETING_BRIEF = {
  topic: "CallingClaw v2.9 Product Roadmap",
  goal: "Review features and assign priorities",
  filePaths: [
    { path: "~/.callingclaw/shared/prep/roadmap-v29.md", description: "v2.9 roadmap draft" },
    { path: "~/.callingclaw/shared/prep/competitor-analysis.pdf", description: "Voice AI competitor analysis" },
  ],
  browserUrls: [
    { url: "https://github.com/XEasonChan/callingclaw/issues", description: "GitHub issues board" },
    { url: "https://docs.google.com/presentation/d/abc123", description: "Product deck" },
  ],
};

export const transcriptAuditorCases: EvalCase<TranscriptAuditorInput, TranscriptAuditorExpected>[] = [
  // ═══════════════════════════════════════════════════
  // Action: search_and_open (user asks to see a file)
  // ═══════════════════════════════════════════════════
  {
    id: "ta-open-01",
    name: "User asks to see the roadmap",
    tags: ["zh", "open", "llm"],
    input: {
      transcript: [
        { role: "user", text: "我们先看看v2.9的roadmap吧" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "search_and_open",
      params: { query: "roadmap" },
      minConfidence: 0.8,
    },
  },
  {
    id: "ta-open-02",
    name: "User asks to pull up competitor analysis",
    tags: ["en", "open", "llm"],
    input: {
      transcript: [
        { role: "assistant", text: "What would you like to review first?" },
        { role: "user", text: "Can you pull up the competitor analysis?" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "search_and_open",
      params: { query: "competitor" },
      minConfidence: 0.8,
    },
  },
  {
    id: "ta-open-03",
    name: "User says show me the issues",
    tags: ["en", "open", "llm"],
    input: {
      transcript: [
        { role: "user", text: "show me the GitHub issues" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "open_url",
      params: { url: "https://github.com/XEasonChan/callingclaw/issues" },
      minConfidence: 0.8,
    },
  },

  // ═══════════════════════════════════════════════════
  // Action: share_url / share_file (present in meeting)
  // ═══════════════════════════════════════════════════
  {
    id: "ta-share-01",
    name: "User asks to present the deck",
    tags: ["en", "share", "llm"],
    input: {
      transcript: [
        { role: "user", text: "Let's present the product deck to everyone" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "share_url",
      params: { url: "https://docs.google.com/presentation/d/abc123" },
      minConfidence: 0.7,
    },
  },
  {
    id: "ta-share-02",
    name: "投屏那个roadmap",
    tags: ["zh", "share", "llm"],
    input: {
      transcript: [
        { role: "user", text: "帮我投屏那个roadmap文件" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "share_file",
      params: { query: "roadmap" },
      minConfidence: 0.7,
    },
  },

  // ═══════════════════════════════════════════════════
  // Action: click / scroll (on presenting tab)
  // ═══════════════════════════════════════════════════
  {
    id: "ta-click-01",
    name: "Click the next button on slide",
    tags: ["en", "click", "llm"],
    input: {
      transcript: [
        { role: "user", text: "click next on the presentation" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "click",
      minConfidence: 0.7,
    },
  },
  {
    id: "ta-scroll-01",
    name: "Scroll down to see more",
    tags: ["en", "scroll", "llm"],
    input: {
      transcript: [
        { role: "user", text: "scroll down a bit, I want to see the rest" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "scroll",
      params: { direction: "down" },
      minConfidence: 0.7,
    },
  },

  // ═══════════════════════════════════════════════════
  // Action: stop_sharing
  // ═══════════════════════════════════════════════════
  {
    id: "ta-stop-01",
    name: "Stop sharing",
    tags: ["en", "share", "llm"],
    input: {
      transcript: [
        { role: "user", text: "ok that's enough, stop sharing" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "stop_sharing",
      minConfidence: 0.8,
    },
  },

  // ═══════════════════════════════════════════════════
  // Action: meet_mute / meet_camera
  // ═══════════════════════════════════════════════════
  {
    id: "ta-mute-01",
    name: "Mute me",
    tags: ["en", "meeting-control", "llm"],
    input: {
      transcript: [
        { role: "user", text: "mute me please" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "meet_mute",
      minConfidence: 0.8,
    },
  },

  // ═══════════════════════════════════════════════════
  // Negative: Discussion (should NOT act)
  // ═══════════════════════════════════════════════════
  {
    id: "ta-neg-01",
    name: "Opinion about architecture (no action)",
    tags: ["en", "negative", "llm"],
    input: {
      transcript: [
        { role: "user", text: "I think we should reconsider the voice provider architecture" },
        { role: "assistant", text: "That's a great point. What specifically concerns you?" },
        { role: "user", text: "The latency is still too high for real-time use" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: null,
      maxConfidence: 0.3,
    },
  },
  {
    id: "ta-neg-02",
    name: "Planning discussion (no action)",
    tags: ["zh", "negative", "llm"],
    input: {
      transcript: [
        { role: "user", text: "我们下周需要把评测框架搭好" },
        { role: "assistant", text: "好的,需要我帮你做什么准备吗?" },
        { role: "user", text: "先不用,我们今天只讨论一下思路" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: null,
      maxConfidence: 0.3,
    },
  },
  {
    id: "ta-neg-03",
    name: "Response to AI question (no action)",
    tags: ["zh", "negative", "llm"],
    input: {
      transcript: [
        { role: "assistant", text: "要不要我帮你打开那个文档?" },
        { role: "user", text: "不用了,我们继续聊" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: null,
      maxConfidence: 0.3,
    },
  },
  {
    id: "ta-neg-04",
    name: "Multi-person discussion (no action)",
    tags: ["en", "negative", "llm"],
    input: {
      transcript: [
        { role: "participant", speaker: "Alice", text: "What about using WebSockets instead of polling?" },
        { role: "participant", speaker: "Bob", text: "I agree, that would reduce latency significantly" },
        { role: "user", text: "Yeah let's go with that approach" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: null,
      maxConfidence: 0.3,
    },
  },

  // ═══════════════════════════════════════════════════
  // Edge: Ambiguous utterances the auditor must handle correctly
  // ═══════════════════════════════════════════════════
  {
    id: "ta-edge-01",
    name: "CallingClaw AI cues action (let me pull that up)",
    tags: ["en", "edge", "llm"],
    input: {
      transcript: [
        { role: "user", text: "Do we have the latest benchmark numbers?" },
        { role: "assistant", text: "Let me pull that up for you" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      // When assistant says "let me pull that up", auditor should act
      action: "search_and_open",
      minConfidence: 0.6,
    },
  },
  {
    id: "ta-edge-02",
    name: "Mixed language open command",
    tags: ["zh", "en", "edge", "llm"],
    input: {
      transcript: [
        { role: "user", text: "帮我open一下那个competitor analysis" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "search_and_open",
      params: { query: "competitor" },
      minConfidence: 0.7,
    },
  },
  {
    id: "ta-edge-03",
    name: "Indirect request via context",
    tags: ["en", "edge", "llm"],
    input: {
      transcript: [
        { role: "participant", speaker: "PM", text: "We need to look at the roadmap before making a decision" },
        { role: "user", text: "Right, let me get that up" },
      ],
      meetingBrief: MEETING_BRIEF,
    },
    expected: {
      action: "search_and_open",
      params: { query: "roadmap" },
      minConfidence: 0.6,
    },
  },
];
