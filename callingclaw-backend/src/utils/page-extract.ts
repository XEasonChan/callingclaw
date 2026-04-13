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
 * JavaScript to inject a virtual cursor overlay into the presenting page.
 * Creates a red pointer cursor that animates to click targets with a ripple effect.
 * Idempotent: safe to call multiple times (checks for existing cursor).
 *
 * Exposes window.__ccCursor = { flyTo(x,y), ripple(x,y,opts?), hide() }
 * - flyTo: returns Promise that resolves after cursor flight animation (~400ms)
 * - ripple: creates an expanding/fading circle at click point
 * - hide: hides the cursor element
 */
export const CURSOR_INJECT_JS = `(() => {
  if (window.__ccCursor) return;

  // Create cursor element — red pointer SVG
  var cursor = document.createElement('div');
  cursor.id = 'cc-cursor';
  cursor.innerHTML = '<svg width="20" height="24" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M1 1L1 19.5L5.5 15L10.5 23L14 21L9 13L15 12L1 1Z" fill="#E63946" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
    '</svg>';
  cursor.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;' +
    'transform:translate(-4px,-2px);opacity:0;transition:left 0.4s cubic-bezier(0.34,1.56,0.64,1),' +
    'top 0.4s cubic-bezier(0.34,1.56,0.64,1),opacity 0.15s ease;will-change:left,top,opacity;';
  document.body.appendChild(cursor);

  // Add ripple keyframe animation
  var style = document.createElement('style');
  style.textContent = '@keyframes cc-ripple{0%{transform:scale(0);opacity:0.6}100%{transform:scale(1);opacity:0}}' +
    '.cc-ripple{position:fixed;width:40px;height:40px;border-radius:50%;border:2px solid #E63946;' +
    'pointer-events:none;z-index:2147483646;animation:cc-ripple 0.5s ease-out forwards;}';
  document.head.appendChild(style);

  var lastX = 0, lastY = 0;

  window.__ccCursor = {
    flyTo: function(x, y) {
      return new Promise(function(resolve) {
        cursor.style.left = x + 'px';
        cursor.style.top = y + 'px';
        cursor.style.opacity = '1';
        lastX = x; lastY = y;
        // Wait for CSS transition to complete
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        cursor.addEventListener('transitionend', finish, { once: true });
        // Fallback timeout in case transitionend doesn't fire
        setTimeout(finish, 450);
      });
    },
    ripple: function(x, y, opts) {
      if (opts && opts.skip) return;
      var el = document.createElement('div');
      el.className = 'cc-ripple';
      el.style.left = (x - 20) + 'px';
      el.style.top = (y - 20) + 'px';
      document.body.appendChild(el);
      setTimeout(function() { el.remove(); }, 600);
    },
    hide: function() {
      cursor.style.opacity = '0';
    }
  };
})()`;

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
 * Shared W3C click dispatch logic, used by both PAGE_CLICK_JS and PAGE_TEXT_CLICK_JS.
 * Inlined into the generated JS string to avoid duplication.
 * Includes cursor animation (flyTo + ripple) before dispatching events.
 */
const W3C_CLICK_DISPATCH_JS = `
    // Scroll into view
    target.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Get click coordinates
    var rect = target.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;

    // Cursor animation: fly to target, then ripple
    if (window.__ccCursor) {
      await window.__ccCursor.flyTo(x, y);
    }

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
`;

/**
 * DOM walk that matches PAGE_EXTRACT_JS indexing exactly.
 * Used by both PAGE_CLICK_JS and PAGE_TEXT_CLICK_JS to find elements
 * using the same index assignment strategy as extraction.
 */
const DOM_WALK_FIND_JS = `
    var idx = 0;
    var target = null;
    var seen = new Set();
    var SEMANTIC = new Set(['nav','header','footer','main','section','aside','form','dialog','article']);

    function walkFind(node) {
      if (!node || node.nodeType !== 1 || target) return;
      var el = node;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
      if (el.closest('[aria-hidden="true"]')) return;
      var tag = el.tagName.toLowerCase();

      // Check if interactive (same logic as PAGE_EXTRACT_JS)
      var isInteractive = false;
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) isInteractive = true;
      else if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem') isInteractive = true;
      else if (el.hasAttribute('onclick')) isInteractive = true;
      if (!isInteractive) {
        try { if (getComputedStyle(el).cursor === 'pointer') isInteractive = true; } catch {}
      }

      // Interactive element: assign index (same as PAGE_EXTRACT_JS)
      if (isInteractive && el.offsetWidth > 0) {
        var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        if (!text) text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
        text = text.trim();
        if (text && text.length >= 2) {
          var key = tag + ':' + text.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            if (idx === FIND_INDEX) target = el;
            idx++;
          }
        }
      }

      // Recurse (skip script, style, svg, iframe — same as PAGE_EXTRACT_JS)
      if (!/^(SCRIPT|STYLE|NOSCRIPT|SVG|IFRAME)$/i.test(tag)) {
        for (var child of el.children) { walkFind(child); }
      }
    }
    walkFind(document.body);
`;

/**
 * W3C-compliant click by index.
 * Uses the same DOM walk as PAGE_EXTRACT_JS to ensure index N maps to
 * the same element the voice AI sees as [N] in the extracted DOM.
 * Includes cursor animation (flyTo + ripple) before dispatching events.
 */
export function PAGE_CLICK_JS(index: number): string {
  const findJS = DOM_WALK_FIND_JS.replace(/FIND_INDEX/g, String(index));
  return `(async () => {
    ${findJS}

    if (!target) return JSON.stringify({ ok: false, error: 'Element index ${index} not found' });

    ${W3C_CLICK_DISPATCH_JS}

    // 5. Ripple + Click activation
    if (window.__ccCursor) window.__ccCursor.ripple(x, y);
    clickTarget.click();

    var text = (target.textContent || '').trim().slice(0, 60);
    return JSON.stringify({ ok: true, text: text, tag: target.tagName.toLowerCase() });
  })()`;
}

/**
 * W3C-compliant click by text content (fuzzy match).
 * Extracted from automation-tools.ts inline JS for DRY.
 * Includes cursor animation. For external/download links, flies to target
 * but skips ripple since the link is not actually clicked.
 */
export function PAGE_TEXT_CLICK_JS(targetText: string): string {
  return `(async () => {
    var els = document.querySelectorAll('a,button,input,textarea,[role="button"],[role="textbox"],[contenteditable="true"],[onclick]');
    var target = null;
    var searchText = ${JSON.stringify(targetText.toLowerCase())};

    // Text content match
    for (var el of els) {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      var text = (el.textContent || '').toLowerCase().trim();
      if (text.includes(searchText)) { target = el; break; }
    }

    // Aria-label fallback
    if (!target) {
      for (var el of els) {
        var label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes(searchText)) { target = el; break; }
      }
    }

    if (!target) return JSON.stringify({ ok: false });

    ${W3C_CLICK_DISPATCH_JS}

    // Check if external/download link (should NOT navigate away)
    var href = target.tagName === 'A' ? target.getAttribute('href') : null;
    var isExternal = href && (href.startsWith('http') && !href.includes(location.hostname));
    var isDownload = href && (href.includes('.dmg') || href.includes('.zip') || href.includes('.exe') || target.hasAttribute('download'));

    if (isExternal || isDownload) {
      // Fly to target but skip ripple — we didn't actually click
      if (window.__ccCursor) window.__ccCursor.ripple(x, y, { skip: true });
      return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 60), link: href, external: true });
    }

    // 5. Ripple + Click activation
    if (window.__ccCursor) window.__ccCursor.ripple(x, y);
    clickTarget.click();

    return JSON.stringify({ ok: true, text: (target.textContent || '').trim().slice(0, 60) });
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
