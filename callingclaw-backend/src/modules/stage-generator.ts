// CallingClaw 2.0 — Per-Meeting Stage HTML Generator
// Generates a custom stage.html with iframe src already set,
// eliminating the loadSlideFrame() race condition.

import { resolve } from "path";
import { CONFIG } from "../config";

export interface StageGeneratorOptions {
  meetingId: string;
  title: string;
  documentUrl: string;  // iframe src (e.g., render.html?file=... or launch-video-brief.html)
  documents?: Array<{ name: string; path: string; badge?: string }>;
}

/**
 * Generate a custom Meeting Stage HTML for this specific meeting.
 * The iframe src is baked in — no dynamic loadSlideFrame() needed.
 *
 * @returns file:// URL to the generated HTML (in /tmp)
 */
export async function generateStageHtml(options: StageGeneratorOptions): Promise<string> {
  const { meetingId, title, documentUrl, documents = [] } = options;

  // Read the template
  const templatePath = resolve(import.meta.dir, "../../public/stage.html");
  let html = await Bun.file(templatePath).text();

  // 1. Set meeting title (replace "Connecting..." default)
  html = html.replace(
    'id="meetingName">Connecting...</span>',
    `id="meetingName">${escapeHtml(title)}</span>`
  );

  // 2. Set iframe src (replace "about:blank" with actual document URL)
  html = html.replace(
    'id="slideFrame" src="about:blank"',
    `id="slideFrame" src="${escapeHtml(documentUrl)}"`
  );

  // 3. Hide placeholder (document is loading immediately)
  html = html.replace(
    'id="slidePlaceholder">',
    'id="slidePlaceholder" style="display:none">'
  );

  // 4. Show slide nav
  html = html.replace(
    'id="slideNav" style="display:none;"',
    'id="slideNav"'
  );

  // 5. Inject documents data (replace demo mode with real data)
  if (documents.length > 0) {
    const docsScript = `
    <script>
    // Pre-loaded documents for this meeting (no WebSocket needed)
    (function() {
      var docsEl = document.getElementById('docsList');
      if (!docsEl) return;
      docsEl.innerHTML = '';
      var docs = ${JSON.stringify(documents.map(d => ({
        name: d.name,
        path: d.path,
        badge: d.badge || null,
      })))};
      docs.forEach(function(doc) {
        var div = document.createElement('div');
        div.className = 'doc-item';
        div.innerHTML = '<span class="doc-icon">' + getFileIcon(doc.name) + '</span>' +
          '<span class="doc-name">' + doc.name + '</span>' +
          (doc.badge ? '<span class="doc-badge ' + doc.badge + '">' + doc.badge + '</span>' : '');
        div.onclick = function() { window.open(doc.path, '_blank'); };
        docsEl.appendChild(div);
      });
    })();
    </script>`;

    // Insert before closing </body>
    html = html.replace('</body>', docsScript + '\n</body>');
  }

  // 6. Disable demo mode (set DEMO_MODE = false early)
  html = html.replace(
    'var DEMO_MODE = true;',
    'var DEMO_MODE = false; // Pre-generated stage — no demo needed'
  );

  // Write to /tmp
  const outPath = `/tmp/callingclaw-stage-${meetingId}.html`;
  await Bun.write(outPath, html);
  console.log(`[StageGenerator] Generated: ${outPath} (title: "${title}", doc: ${documentUrl})`);

  return `file://${outPath}`;
}

/**
 * Resolve the best document URL for the Stage iframe from a meeting prep brief.
 * Returns a localhost URL that the iframe can load (same-origin).
 */
export function resolveDocumentUrl(brief: any): string | null {
  if (!brief) return null;

  // 1. Check scenes (presentation.json)
  const sceneUrl = brief.scenes?.find((s: any) => s.url)?.url;
  if (sceneUrl) {
    if (sceneUrl.startsWith("http")) return sceneUrl;
    return `http://localhost:${CONFIG.port}${sceneUrl.startsWith("/") ? "" : "/"}${sceneUrl}`;
  }

  // 2. Check filePaths for HTML files
  const htmlFile = brief.filePaths?.find((f: any) => /\.html?$/i.test(f.path));
  if (htmlFile) {
    return `http://localhost:${CONFIG.port}/${htmlFile.path.split("/").pop()}`;
  }

  // 3. Check filePaths for markdown files → use renderer
  const mdFile = brief.filePaths?.find((f: any) => /\.md$/i.test(f.path));
  if (mdFile) {
    return `http://localhost:${CONFIG.port}/render.html?file=${encodeURIComponent(mdFile.path)}`;
  }

  return null;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
