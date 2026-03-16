// CallingClaw 2.0 — Context API Routes
// /api/context (GET), /api/context/workspace (POST+DELETE),
// /api/context/sync, /api/context/brief, /api/context/pin (POST+DELETE),
// /api/context/note, /api/context/reload

import type { Services, RouteHandler } from "./types";

export function contextRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/context"),

    handle: async (req, url, headers) => {
      // GET /api/context — Get SharedContext summary
      if (url.pathname === "/api/context" && req.method === "GET") {
        return Response.json(services.context.exportSummary(), { headers });
      }

      // POST /api/context/workspace — Inject workspace context (from OpenClaw)
      if (url.pathname === "/api/context/workspace" && req.method === "POST") {
        const body = (await req.json()) as {
          topic?: string;
          files?: Array<{ path: string; summary?: string; diffLines?: number }>;
          git_summary?: string;
          discussion_points?: string[];
        };

        services.context.setWorkspace({
          topic: body.topic,
          files: body.files || [],
          gitSummary: body.git_summary,
          discussionPoints: body.discussion_points,
        });

        services.eventBus.emit("workspace.updated", {
          topic: body.topic,
          fileCount: body.files?.length || 0,
        });

        return Response.json({ ok: true, workspace: services.context.workspace }, { headers });
      }

      // DELETE /api/context/workspace — Clear workspace context
      if (url.pathname === "/api/context/workspace" && req.method === "DELETE") {
        services.context.clearWorkspace();
        return Response.json({ ok: true }, { headers });
      }

      // GET /api/context/sync — Get ContextSync status (memory, pinned files, brief lengths)
      if (url.pathname === "/api/context/sync" && req.method === "GET") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        return Response.json(services.contextSync.getStatus(), { headers });
      }

      // GET /api/context/brief — Get generated briefs (voice + computer)
      if (url.pathname === "/api/context/brief" && req.method === "GET") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const brief = services.contextSync.getBrief();
        return Response.json({
          voice: brief.voice,
          computer: brief.computer,
          voiceChars: brief.voice.length,
          computerChars: brief.computer.length,
        }, { headers });
      }

      // POST /api/context/pin — Pin a file to shared context
      if (url.pathname === "/api/context/pin" && req.method === "POST") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const body = await req.json() as { path: string; summary?: string };
        if (!body.path) {
          return Response.json({ error: "path is required" }, { status: 400, headers });
        }
        const pinned = await services.contextSync.pinFile(body.path, body.summary);
        if (!pinned) {
          return Response.json({ error: "File not found or could not be read" }, { status: 404, headers });
        }
        return Response.json({ ok: true, pinned: { path: pinned.path, summary: pinned.summary, contentLength: pinned.content.length } }, { headers });
      }

      // DELETE /api/context/pin — Unpin a file
      if (url.pathname === "/api/context/pin" && req.method === "DELETE") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const body = await req.json() as { path: string };
        const removed = services.contextSync.unpinFile(body.path);
        return Response.json({ ok: removed }, { headers });
      }

      // POST /api/context/note — Add a session note
      if (url.pathname === "/api/context/note" && req.method === "POST") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const body = await req.json() as { note: string };
        if (!body.note) {
          return Response.json({ error: "note is required" }, { status: 400, headers });
        }
        services.contextSync.addNote(body.note);
        return Response.json({ ok: true }, { headers });
      }

      // POST /api/context/reload — Reload OpenClaw memory from disk
      if (url.pathname === "/api/context/reload" && req.method === "POST") {
        if (!services.contextSync) {
          return Response.json({ error: "ContextSync not initialized" }, { status: 503, headers });
        }
        const loaded = await services.contextSync.loadOpenClawMemory();
        return Response.json({ ok: loaded, status: services.contextSync.getStatus() }, { headers });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
