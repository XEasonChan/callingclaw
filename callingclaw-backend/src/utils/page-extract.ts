// CallingClaw 2.0 — Page Agent DOM Extraction
// ═══════════════════════════════════════════════════════════════════
// Extracts a compact, LLM-friendly text representation of a web page.
// Runs in-browser via Playwright's evaluateOnPresentingPage().
//
// Inspired by alibaba/page-agent's flatTreeToString():
//   - Hierarchical: semantic tags (nav, section, form) as context
//   - Indexed: interactive elements get [0], [1], [2] for precise clicking
//   - Viewport-aware: distinguishes visible vs below-fold
//   - Scroll hints: position + remaining content below
//
// Output format (voice AI Layer 3 context):
//   [PAGE] Title (url)
//   Scroll: 600/2400px (25%) — 1800px more below
//   <nav>
//     [0] a: Home
//     [1] a: Features
//     [2] a: Pricing
//   <section>
//     h1: AI That Joins Your Meetings
//     p: Download CallingClaw and let AI join...
//     [3] a: Download for Mac
//     [4] a: How it Works
//
// Usage:
//   import { PAGE_EXTRACT_JS, PAGE_CLICK_JS, formatPageContext, PAGE_CONTEXT_ID } from "./page-extract";
//   const raw = await cl.evaluateOnPresentingPage(PAGE_EXTRACT_JS);
//   voice.replaceContext(formatPageContext(raw), PAGE_CONTEXT_ID);
//   // Click by index:
//   await cl.evaluateOnPresentingPage(PAGE_CLICK_JS(3));
// ═══════════════════════════════════════════════════════════════════

/**
 * Fixed context item ID for DOM injection.
 * Using a stable ID means each injection REPLACES the previous one
 * instead of accumulating in the FIFO queue (max 15 items).
 */
export const PAGE_CONTEXT_ID = "ctx_page_dom";

/**
 * JavaScript to evaluate inside the browser page.
 * Returns hierarchical DOM with semantic context + indexed interactive elements.
 */
export const PAGE_EXTRACT_JS = `(() => {
  var vh = window.innerHeight;
  var scrollY = Math.round(window.scrollY);
  var scrollMax = Math.round(document.documentElement.scrollHeight - vh);

  // Semantic landmark tags that provide context to LLM
  var SEMANTIC = new Set(['nav','header','footer','main','section','aside','form','dialog','article']);

  // Walk the DOM tree depth-first, building a hierarchical text representation.
  // Interactive elements get numeric indices; semantic tags provide grouping context.
  var idx = 0;
  var tree = [];
  var seen = new Set();

  function walk(node, depth) {
    if (!node || node.nodeType === 8) return; // skip comments
    if (node.nodeType === 3) {
      // Text node: only include if parent is a content element
      var txt = (node.textContent || '').trim();
      if (txt.length > 3 && depth > 0) {
        var parent = node.parentElement;
        if (parent && /^(H[1-6]|P|LI|TD|TH|FIGCAPTION|BLOCKQUOTE|SPAN|LABEL)$/i.test(parent.tagName)) {
          // Text captured at parent level, skip here
        }
      }
      return;
    }
    if (node.nodeType !== 1) return;

    var el = node;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
    if (el.closest('[aria-hidden="true"]')) return;

    var tag = el.tagName.toLowerCase();
    var rect = el.getBoundingClientRect();
    var inView = rect.top < vh + 200 && rect.bottom > -100;

    // Check if interactive
    var isInteractive = false;
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) isInteractive = true;
    else if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem') isInteractive = true;
    else if (el.hasAttribute('onclick')) isInteractive = true;
    // Check computed cursor
    if (!isInteractive) {
      try { if (getComputedStyle(el).cursor === 'pointer') isInteractive = true; } catch {}
    }

    // Semantic landmark: emit tag for context
    if (SEMANTIC.has(tag)) {
      var label = el.getAttribute('aria-label') || el.getAttribute('id') || '';
      tree.push({ depth, type: 'semantic', tag, label: label ? label.slice(0, 40) : '' });
    }

    // Interactive element: assign index
    if (isInteractive && el.offsetWidth > 0) {
      var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
      if (!text) text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
      text = text.trim();
      if (text && text.length >= 2) {
        var key = tag + ':' + text.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          var attrs = '';
          if (tag === 'input') attrs = ' type=' + (el.getAttribute('type') || 'text');
          if (el.getAttribute('aria-expanded')) attrs += ' expanded=' + el.getAttribute('aria-expanded');
          if (el.checked) attrs += ' checked';
          tree.push({
            depth: SEMANTIC.has(tag) ? depth : depth,
            type: 'interactive',
            tag, text, attrs,
            i: idx,
            inView,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          });
          idx++;
        }
      }
    }

    // Content element: capture visible text
    if (/^(H[1-6]|P|LI|TD|TH|FIGCAPTION|BLOCKQUOTE|LABEL)$/i.test(tag) && inView && !isInteractive) {
      var ctext = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      if (ctext.length > 3) {
        tree.push({ depth, type: 'content', tag, text: ctext });
      }
    }

    // Recurse into children (skip script, style, svg internals)
    if (!/^(SCRIPT|STYLE|NOSCRIPT|SVG|IFRAME)$/i.test(tag)) {
      for (var child of el.children) {
        walk(child, depth + (SEMANTIC.has(tag) ? 1 : 0));
      }
    }
  }

  walk(document.body, 0);

  // Scroll hints
  var scrollHint;
  if (scrollMax <= 0) {
    scrollHint = 'no scroll (all content visible)';
  } else {
    var pct = Math.round((scrollY / scrollMax) * 100);
    var below = scrollMax - scrollY;
    scrollHint = scrollY + '/' + scrollMax + 'px (' + pct + '%)';
    if (below > 100) scrollHint += ' — ' + below + 'px more below';
    else if (below < 50) scrollHint += ' — at bottom';
  }

  return JSON.stringify({
    title: document.title,
    url: location.href,
    scrollHint,
    tree: tree.slice(0, 60),
    interactiveCount: idx,
  });
})()`;

/**
 * W3C-compliant click by index.
 * Dispatches full pointer/mouse event sequence (from Page Agent's actions.ts).
 * Uses hit-test to find deepest element at click coordinates.
 */
export function PAGE_CLICK_JS(index: number): string {
  return `(() => {
    // Rebuild the same index map as PAGE_EXTRACT_JS
    var idx = 0;
    var target = null;
    var seen = new Set();
    document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[onclick]')
      .forEach(function(el) {
        if (target) return;
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
        if (el.closest('[aria-hidden="true"]')) return;
        var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        if (!text) text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
        text = text.trim();
        if (!text || text.length < 2) return;
        var key = el.tagName.toLowerCase() + ':' + text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (idx === ${index}) target = el;
        idx++;
      });

    // Also check cursor:pointer elements
    if (!target) {
      idx = 0; seen.clear();
      document.querySelectorAll('*').forEach(function(el) {
        if (target) return;
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
        try { if (getComputedStyle(el).cursor !== 'pointer') return; } catch { return; }
        if (el.closest('[aria-hidden="true"]')) return;
        var text = (el.textContent || '').trim().slice(0, 60);
        if (!text || text.length < 2) return;
        var key = el.tagName.toLowerCase() + ':' + text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (idx === ${index}) target = el;
        idx++;
      });
    }

    if (!target) return JSON.stringify({ ok: false, error: 'Element index ${index} not found' });

    // Scroll into view
    target.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Get click coordinates
    var rect = target.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;

    // Hit-test: find deepest element at coordinates (matches real browser behavior)
    var hitTarget = document.elementFromPoint(x, y);
    var clickTarget = (hitTarget instanceof HTMLElement && target.contains(hitTarget)) ? hitTarget : target;

    var pointerOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse' };
    var mouseOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };

    // W3C Pointer Events + UI Events spec order
    // 1. Hover
    clickTarget.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
    clickTarget.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, pointerOpts, { bubbles: false })));
    clickTarget.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
    clickTarget.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, mouseOpts, { bubbles: false })));

    // 2. Press
    clickTarget.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
    clickTarget.dispatchEvent(new MouseEvent('mousedown', mouseOpts));

    // 3. Focus the interactive ancestor
    target.focus({ preventScroll: true });

    // 4. Release
    clickTarget.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
    clickTarget.dispatchEvent(new MouseEvent('mouseup', mouseOpts));

    // 5. Click activation
    clickTarget.click();

    var text = (target.textContent || '').trim().slice(0, 60);
    return JSON.stringify({ ok: true, text: text, tag: target.tagName.toLowerCase() });
  })()`;
}

/**
 * Format the raw JSON from PAGE_EXTRACT_JS into voice AI context text.
 * Produces hierarchical output with semantic grouping.
 */
export function formatPageContext(raw: any): string | null {
  if (!raw) return null;
  try {
    const page = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!page.title && !page.url) return null;

    const parts: string[] = [];
    parts.push(`[PAGE] ${page.title || "Untitled"} (${page.url || "unknown"})`);
    parts.push(`Scroll: ${page.scrollHint || "unknown"}`);
    parts.push("");

    if (page.tree?.length > 0) {
      for (const node of page.tree) {
        const indent = "  ".repeat(node.depth || 0);
        if (node.type === "semantic") {
          const label = node.label ? ` "${node.label}"` : "";
          parts.push(`${indent}<${node.tag}${label}>`);
        } else if (node.type === "interactive") {
          const viewHint = node.inView === false ? " (below fold)" : "";
          const attrs = node.attrs || "";
          parts.push(`${indent}[${node.i}]<${node.tag}${attrs}>${node.text}${viewHint}`);
        } else if (node.type === "content") {
          parts.push(`${indent}${node.tag}: ${node.text}`);
        }
      }
    }

    parts.push("");
    parts.push(`${page.interactiveCount || 0} interactive elements. Use interact(action="click", target="3") with the [index] number.`);

    return parts.join("\n");
  } catch {
    return null;
  }
}
