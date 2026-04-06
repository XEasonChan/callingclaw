// CallingClaw 2.0 — Page Agent DOM Extraction
// ═══════════════════════════════════════════════════════════════════
// Extracts a compact, LLM-friendly text representation of a web page.
// Runs in-browser via Playwright's evaluateOnPresentingPage().
//
// Inspired by alibaba/page-agent's flatTreeToString() approach:
//   - Text-based, no screenshots needed
//   - Interactive elements indexed for precise click/scroll references
//   - Viewport-aware: distinguishes visible vs below-fold content
//   - Scroll position hints for navigation context
//
// Output format consumed by Voice AI (Layer 2 live context injection):
//   [PAGE] Title (url)
//   scroll: 0/2400px (more content below)
//   Visible content: h1: AI That Joins Your Meetings ...
//   Interactive: [0] button: Download for Mac [1] a: How it Works ...
//
// Usage:
//   import { PAGE_EXTRACT_JS, formatPageContext, PAGE_CONTEXT_ID } from "./page-extract";
//   const raw = await chromeLauncher.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
//   const context = formatPageContext(raw);
//   voice.client.removeContext(PAGE_CONTEXT_ID);  // delete previous
//   voice.client.injectContext(context, PAGE_CONTEXT_ID);  // replace with fresh
// ═══════════════════════════════════════════════════════════════════

/**
 * Fixed context item ID for DOM injection.
 * Using a stable ID means each new injection REPLACES the previous one
 * instead of accumulating in the FIFO queue (max 15 items).
 * Voice AI always sees only the LATEST page state.
 */
export const PAGE_CONTEXT_ID = "ctx_page_dom";

/**
 * JavaScript to evaluate inside the browser page.
 * Returns a JSON string with page structure, visible content, and interactive elements.
 */
export const PAGE_EXTRACT_JS = `(() => {
  const vh = window.innerHeight;
  const scrollY = Math.round(window.scrollY);
  const scrollMax = Math.round(document.documentElement.scrollHeight - vh);

  // ── Interactive elements with index ──
  const interactive = [];
  const seen = new Set();
  document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[onclick]')
    .forEach(el => {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
      if (el.closest('[aria-hidden="true"]')) return;
      const rect = el.getBoundingClientRect();
      const inView = rect.top < vh && rect.bottom > 0;
      const tag = el.tagName.toLowerCase();
      let text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
      if (!text) text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
      text = text.trim();
      if (!text || text.length < 2) return;
      // Dedup by text (common in navs)
      const key = tag + ':' + text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const i = interactive.length;
      interactive.push({ i, tag, text, inView });
    });

  // ── Visible content (headings + text in viewport) ──
  const content = [];
  document.querySelectorAll('h1,h2,h3,h4,p,li,td,th,figcaption,blockquote,[role="heading"]')
    .forEach(el => {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
      const rect = el.getBoundingClientRect();
      // Include viewport + 200px below (upcoming content)
      if (rect.top > vh + 200 || rect.bottom < -100) return;
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      if (text.length < 5) return;
      const tag = el.tagName.toLowerCase();
      content.push(tag + ': ' + text);
    });

  // ── Scroll hints ──
  let scrollHint;
  if (scrollMax <= 0) {
    scrollHint = 'no scroll (all content visible)';
  } else {
    const pct = Math.round((scrollY / scrollMax) * 100);
    const below = scrollMax - scrollY;
    scrollHint = scrollY + '/' + scrollMax + 'px (' + pct + '%)';
    if (below > 100) scrollHint += ' — ' + below + 'px more below';
    else if (below < 50) scrollHint += ' — at bottom';
  }

  return JSON.stringify({
    title: document.title,
    url: location.href,
    scrollHint,
    content: content.slice(0, 25),
    interactive: interactive.slice(0, 20),
  });
})()`;

/**
 * Format the raw JSON from PAGE_EXTRACT_JS into voice AI context text.
 * Returns null if extraction failed.
 */
export function formatPageContext(raw: any): string | null {
  if (!raw) return null;
  try {
    const page = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!page.title && !page.url) return null;

    const parts: string[] = [];
    parts.push(`[PAGE] ${page.title || "Untitled"} (${page.url || "unknown"})`);
    parts.push(`Scroll: ${page.scrollHint || "unknown"}`);

    if (page.content?.length > 0) {
      parts.push("");
      parts.push("Visible content:");
      for (const line of page.content) {
        parts.push("  " + line);
      }
    }

    if (page.interactive?.length > 0) {
      parts.push("");
      parts.push("Interactive elements:");
      for (const el of page.interactive) {
        const viewHint = el.inView ? "" : " (below fold)";
        parts.push(`  [${el.i}] ${el.tag}: ${el.text}${viewHint}`);
      }
    }

    parts.push("");
    parts.push('Use interact(action="scroll") to scroll, interact(action="click", target="<text>") to click.');

    return parts.join("\n");
  } catch {
    return null;
  }
}
