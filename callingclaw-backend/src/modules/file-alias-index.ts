// CallingClaw 2.0 — File Alias Index (Instant Voice-to-File Lookup)
//
// Pre-builds a keyword index of local files at meeting start. When voice says
// "open the action cart PRD", we match keywords instantly (~5ms) instead of
// scanning directories + calling Haiku (~3-5s).
//
// Built from two sources:
//   1. MeetingPrepBrief.filePaths (agent-generated descriptions)
//   2. Directory scan of topic-relevant folders (filename-based keywords)
//
// Keyword matching: split file names by separators (-, _, ., space, camelCase),
// normalize to lowercase, match against voice input keywords. Score by overlap.

import { homedir } from "os";
import { resolve, basename, dirname } from "path";

export interface FileAlias {
  path: string;
  keywords: string[];       // lowercase tokens for matching
  description: string;      // human-friendly label (from prep or generated)
  source: "prep" | "scan";  // where this alias came from
}

export class FileAliasIndex {
  private _entries: FileAlias[] = [];
  private _ready = false;

  get ready() { return this._ready; }
  get size() { return this._entries.length; }

  /**
   * Build the index from meeting prep brief + directory scan.
   * Call once at meeting start. Runs in ~50-100ms (pure filesystem).
   */
  async build(opts: {
    prepFilePaths?: Array<{ path: string; description: string }>;
    topicKeywords?: string[];
    extraDirs?: string[];
  } = {}): Promise<void> {
    this._entries = [];
    const seen = new Set<string>();

    // Source 1: Meeting prep brief file paths (highest quality — has descriptions)
    if (opts.prepFilePaths) {
      for (const fp of opts.prepFilePaths) {
        if (!fp.path || seen.has(fp.path)) continue;
        seen.add(fp.path);
        this._entries.push({
          path: fp.path,
          keywords: this.extractKeywords(fp.path, fp.description),
          description: fp.description,
          source: "prep",
        });
      }
    }

    // Source 2: Scan relevant directories for files matching topic
    const home = homedir();
    const defaultDirs = [
      resolve(home, ".callingclaw", "shared"),
      resolve(home, "Library/Mobile Documents/com~apple~CloudDocs/CallingClaw 2.0"),
      resolve(home, "Library/Mobile Documents/com~apple~CloudDocs/Tanka"),
      resolve(home, "Library/Mobile Documents/com~apple~CloudDocs/Documents"),
      resolve(home, "Desktop"),
    ];
    const scanDirs = [...(opts.extraDirs || []), ...defaultDirs];

    for (const dir of scanDirs) {
      try {
        const output = await Bun.$`find ${dir} -maxdepth 4 -type f \( -name "*.html" -o -name "*.md" -o -name "*.pdf" -o -name "*.txt" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.pneuma/*" 2>/dev/null`.text();
        for (const line of output.split("\n")) {
          const p = line.trim();
          if (!p || seen.has(p)) continue;
          seen.add(p);

          const name = basename(p);
          const dirName = basename(dirname(p));
          const description = name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
          this._entries.push({
            path: p,
            keywords: this.extractKeywords(p, dirName),
            description,
            source: "scan",
          });
        }
      } catch { /* dir doesn't exist */ }
    }

    this._ready = true;
    console.log(`[FileAliasIndex] Built: ${this._entries.length} files indexed (${opts.prepFilePaths?.length || 0} from prep)`);
  }

  /**
   * Search the index for the best matching file.
   * Returns the best match, or null if no match above threshold.
   *
   * This is the fast path: ~5ms, no LLM, pure keyword matching.
   */
  search(query: string, minScore = 0.6): FileAlias | null {
    if (!this._ready || this._entries.length === 0) return null;

    const queryKeywords = this.tokenize(query);
    if (queryKeywords.length === 0) return null;

    let bestMatch: FileAlias | null = null;
    let bestScore = 0;

    for (const entry of this._entries) {
      // Score: what fraction of query keywords appear in entry keywords
      let hits = 0;
      for (const qk of queryKeywords) {
        // Substring match (handles partial: "prd" matches "prd", "action" matches "action")
        if (entry.keywords.some(ek => ek.includes(qk) || qk.includes(ek))) {
          hits++;
        }
      }
      const score = hits / queryKeywords.length;

      // Bidirectional score: also check what fraction of entry keywords match query
      // This penalizes entries that match a few query words but are about something else
      let reverseHits = 0;
      for (const ek of entry.keywords) {
        if (queryKeywords.some(qk => ek.includes(qk) || qk.includes(ek))) {
          reverseHits++;
        }
      }
      const reverseScore = entry.keywords.length > 0 ? reverseHits / entry.keywords.length : 0;

      // Combined score: harmonic mean of forward and reverse (penalizes one-sided matches)
      const combined = score > 0 && reverseScore > 0
        ? 2 * (score * reverseScore) / (score + reverseScore)
        : score * 0.5; // If no reverse match, heavily discount

      // Boost prep-sourced entries (they have better descriptions)
      const boosted = entry.source === "prep" ? combined * 1.2 : combined;

      if (boosted > bestScore && boosted >= minScore) {
        bestScore = boosted;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      console.log(`[FileAliasIndex] Match: "${query}" → ${basename(bestMatch.path)} (score: ${bestScore.toFixed(2)}, source: ${bestMatch.source})`);
    } else {
      console.log(`[FileAliasIndex] No match for "${query}" (best score: ${bestScore.toFixed(2)} < threshold ${minScore})`);
    }
    return bestMatch;
  }

  /**
   * Get all entries (for Haiku fallback — send full list to LLM when keyword match fails).
   * Returns compact format to minimize tokens.
   */
  getCompactList(limit = 50): string {
    return this._entries
      .slice(0, limit)
      .map((e, i) => `${i + 1}. ${e.description} → ${e.path.replace(homedir(), "~")}`)
      .join("\n");
  }

  /** Clear the index (meeting ended). */
  clear(): void {
    this._entries = [];
    this._ready = false;
  }

  // ── Internal ──

  /** Extract keywords from a file path and optional description. */
  private extractKeywords(filePath: string, description?: string): string[] {
    const parts = [
      basename(filePath).replace(/\.[^.]+$/, ""),  // filename without extension
      basename(dirname(filePath)),                   // parent directory name
      description || "",
    ].join(" ");

    return this.tokenize(parts);
  }

  /** Tokenize a string into lowercase keywords. */
  private tokenize(text: string): string[] {
    const STOP_WORDS = new Set([
      "the", "a", "an", "this", "that", "my", "our", "for", "and", "or",
      "of", "in", "to", "is", "it", "on", "at", "by", "with", "from",
      "please", "open", "show", "find", "get", "check", "look",
      "帮我", "打开", "看看", "查看", "找", "那个", "这个", "最近",
    ]);

    return text
      .toLowerCase()
      // Split camelCase: "ActionPermission" → "action permission"
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // Split by separators
      .replace(/[-_./\\,;:()[\]{}'"]+/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w))
      // Deduplicate
      .filter((w, i, arr) => arr.indexOf(w) === i);
  }
}
