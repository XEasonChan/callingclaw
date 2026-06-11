// CallingClaw Eval — YouTube Transcript Fetcher
// Fetches YouTube auto-generated or manual subtitles via the innertube API.
// Converts to CallingClaw TranscriptEntry format for eval comparison.
//
// Usage:
//   import { fetchYouTubeTranscript } from "./youtube-transcript";
//   const entries = await fetchYouTubeTranscript("VIDEO_ID", "en");

import type { YouTubeTranscriptEntry, YouTubeTranscriptDataset } from "./types";
import type { TranscriptEntry } from "../src/modules/shared-context";

// ── Fetch transcript from YouTube (innertube API, no auth needed) ──

export async function fetchYouTubeTranscript(
  videoId: string,
  lang = "en",
): Promise<YouTubeTranscriptDataset> {
  // Step 1: Get the video page to extract caption track info
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageResp = await fetch(watchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      "Accept-Language": `${lang},en;q=0.9`,
    },
  });
  const pageHtml = await pageResp.text();

  // Extract title
  const titleMatch = pageHtml.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? titleMatch[1]!.replace(" - YouTube", "").trim() : videoId;

  // Extract captions player response
  const captionMatch = pageHtml.match(/"captions":\s*(\{.*?"captionTracks":\s*\[.*?\].*?\})/s);
  if (!captionMatch) {
    // Try alternative: timedtext API directly
    return await fetchViaTimedText(videoId, lang, title);
  }

  let captionData: any;
  try {
    // Extract just the captionTracks array
    const tracksMatch = captionMatch[1]!.match(/"captionTracks":\s*(\[.*?\])/s);
    if (!tracksMatch) throw new Error("No caption tracks found");
    captionData = JSON.parse(tracksMatch[1]!);
  } catch {
    return await fetchViaTimedText(videoId, lang, title);
  }

  // Find the matching language track
  const track = captionData.find(
    (t: any) => t.languageCode === lang || t.vssId?.includes(`.${lang}`)
  ) || captionData[0]; // fallback to first track

  if (!track?.baseUrl) {
    return await fetchViaTimedText(videoId, lang, title);
  }

  // Step 2: Fetch the transcript XML
  const transcriptResp = await fetch(track.baseUrl);
  const transcriptXml = await transcriptResp.text();

  // Step 3: Parse XML into entries
  const entries = parseTranscriptXml(transcriptXml);

  return { videoId, title, language: track.languageCode || lang, entries };
}

/** Fallback: fetch via YouTube timedtext API */
async function fetchViaTimedText(
  videoId: string,
  lang: string,
  title: string,
): Promise<YouTubeTranscriptDataset> {
  const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
  const resp = await fetch(url);
  if (!resp.ok) {
    // Try auto-generated
    const autoUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&kind=asr&fmt=srv3`;
    const autoResp = await fetch(autoUrl);
    if (!autoResp.ok) {
      throw new Error(`No captions found for video ${videoId} in language ${lang}`);
    }
    const xml = await autoResp.text();
    return { videoId, title, language: lang, entries: parseTranscriptXml(xml) };
  }
  const xml = await resp.text();
  return { videoId, title, language: lang, entries: parseTranscriptXml(xml) };
}

/** Parse YouTube transcript XML (srv3 or legacy format) */
function parseTranscriptXml(xml: string): YouTubeTranscriptEntry[] {
  const entries: YouTubeTranscriptEntry[] = [];

  // Match <text start="X" dur="Y">content</text> (legacy) or <p t="X" d="Y">content</p> (srv3)
  const legacyPattern = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const srv3Pattern = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;

  let match;

  // Try legacy format first
  while ((match = legacyPattern.exec(xml)) !== null) {
    const start = parseFloat(match[1]!);
    const dur = parseFloat(match[2]!);
    const text = decodeHtmlEntities(match[3]!.trim());
    if (text) {
      entries.push({ startTime: start, endTime: start + dur, text });
    }
  }

  // If no legacy matches, try srv3
  if (entries.length === 0) {
    while ((match = srv3Pattern.exec(xml)) !== null) {
      const startMs = parseInt(match[1]!, 10);
      const durMs = parseInt(match[2]!, 10);
      const text = decodeHtmlEntities(match[3]!.trim());
      if (text) {
        entries.push({
          startTime: startMs / 1000,
          endTime: (startMs + durMs) / 1000,
          text,
        });
      }
    }
  }

  return entries;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, ""); // Strip remaining HTML tags
}

// ── Parse SRT files (local subtitle files) ──

export function parseSRT(srtContent: string): YouTubeTranscriptEntry[] {
  const entries: YouTubeTranscriptEntry[] = [];
  const blocks = srtContent.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    // Line 2: timestamp "00:00:01,234 --> 00:00:04,567"
    const timeMatch = lines[1]!.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!timeMatch) continue;

    const startTime =
      parseInt(timeMatch[1]!) * 3600 +
      parseInt(timeMatch[2]!) * 60 +
      parseInt(timeMatch[3]!) +
      parseInt(timeMatch[4]!) / 1000;
    const endTime =
      parseInt(timeMatch[5]!) * 3600 +
      parseInt(timeMatch[6]!) * 60 +
      parseInt(timeMatch[7]!) +
      parseInt(timeMatch[8]!) / 1000;

    // Lines 3+: text content
    const text = lines.slice(2).join(" ").trim();
    if (text) {
      entries.push({ startTime, endTime, text });
    }
  }

  return entries;
}

// ── Parse VTT files (WebVTT format) ──

export function parseVTT(vttContent: string): YouTubeTranscriptEntry[] {
  // Strip WEBVTT header and optional metadata
  const body = vttContent.replace(/^WEBVTT[\s\S]*?\n\n/, "");
  // VTT uses . instead of , for milliseconds, but the rest is similar to SRT
  return parseSRT(body);
}

// ── Convert YouTube entries to CallingClaw TranscriptEntry format ──

export function toTranscriptEntries(
  ytEntries: YouTubeTranscriptEntry[],
  role: "user" | "participant" = "user",
  speaker?: string,
): TranscriptEntry[] {
  return ytEntries.map((e) => ({
    role,
    speaker,
    text: e.text,
    ts: Math.floor(e.startTime * 1000), // Convert to ms timestamp
  }));
}

// ── Utility: chunk transcript into sliding windows for auditor eval ──

export function chunkTranscript(
  entries: YouTubeTranscriptEntry[],
  windowSize = 15,
  stepSize = 5,
): YouTubeTranscriptEntry[][] {
  const chunks: YouTubeTranscriptEntry[][] = [];
  for (let i = 0; i < entries.length; i += stepSize) {
    chunks.push(entries.slice(i, i + windowSize));
  }
  return chunks;
}

// ── CLI: fetch and save transcript ──

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: bun eval/youtube-transcript.ts <VIDEO_ID> [LANG]");
    console.log("       bun eval/youtube-transcript.ts dQw4w9WgXcQ en");
    console.log("       bun eval/youtube-transcript.ts <path-to-file.srt>");
    process.exit(1);
  }

  const input = args[0]!;
  const lang = args[1] || "en";

  if (input.endsWith(".srt") || input.endsWith(".vtt")) {
    // Parse local file
    const content = await Bun.file(input).text();
    const entries = input.endsWith(".srt") ? parseSRT(content) : parseVTT(content);
    console.log(`Parsed ${entries.length} entries from ${input}`);
    console.log(JSON.stringify(entries.slice(0, 5), null, 2));
    console.log(`... (${entries.length - 5} more)`);
  } else {
    // Fetch from YouTube
    console.log(`Fetching transcript for ${input} (${lang})...`);
    try {
      const dataset = await fetchYouTubeTranscript(input, lang);
      console.log(`Title: ${dataset.title}`);
      console.log(`Language: ${dataset.language}`);
      console.log(`Entries: ${dataset.entries.length}`);
      console.log();

      // Save to datasets/
      const outPath = new URL(`./datasets/yt-${input}-${lang}.json`, import.meta.url).pathname;
      await Bun.write(outPath, JSON.stringify(dataset, null, 2));
      console.log(`Saved to: ${outPath}`);

      // Preview first 5 entries
      for (const e of dataset.entries.slice(0, 5)) {
        const ts = formatTime(e.startTime);
        console.log(`  [${ts}] ${e.text}`);
      }
      if (dataset.entries.length > 5) {
        console.log(`  ... (${dataset.entries.length - 5} more)`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
