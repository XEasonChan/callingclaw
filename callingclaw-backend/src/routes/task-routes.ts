// CallingClaw 2.0 — Task Store API Routes
// /api/tasks (GET+POST), /api/tasks/:id (GET+PATCH+DELETE)

import type { Services, RouteHandler } from "./types";

export function taskRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/tasks"),

    handle: async (req, url, headers) => {
      // GET /api/tasks — List tasks with optional filters
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        const filters: Record<string, string> = {};
        const status = url.searchParams.get("status");
        const meetingId = url.searchParams.get("meeting_id");
        const assignee = url.searchParams.get("assignee");
        const priority = url.searchParams.get("priority");

        if (status) filters.status = status;
        if (meetingId) filters.meetingId = meetingId;
        if (assignee) filters.assignee = assignee;
        if (priority) filters.priority = priority;

        const tasks = services.taskStore.list(filters as any);
        return Response.json({ tasks, stats: services.taskStore.stats() }, { headers });
      }

      // POST /api/tasks — Create a new task
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const body = (await req.json()) as {
          task: string;
          priority?: "high" | "medium" | "low";
          assignee?: string;
          deadline?: string;
          context?: string;
        };

        if (!body.task) {
          return Response.json({ error: "task field is required" }, { status: 400, headers });
        }

        const task = services.taskStore.create(body);
        return Response.json({ task }, { status: 201, headers });
      }

      // Task by ID routes
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const taskId = taskMatch[1];

        // GET /api/tasks/:id
        if (req.method === "GET") {
          const task = services.taskStore.get(taskId);
          if (!task) return Response.json({ error: "Task not found" }, { status: 404, headers });
          return Response.json({ task }, { headers });
        }

        // PATCH /api/tasks/:id — Update task status/result
        if (req.method === "PATCH") {
          const body = (await req.json()) as {
            status?: "pending" | "in_progress" | "done" | "cancelled";
            result?: string;
            assignee?: string;
            priority?: "high" | "medium" | "low";
            deadline?: string;
          };
          const task = services.taskStore.update(taskId, body);
          if (!task) return Response.json({ error: "Task not found" }, { status: 404, headers });
          return Response.json({ task }, { headers });
        }

        // DELETE /api/tasks/:id
        if (req.method === "DELETE") {
          const deleted = services.taskStore.delete(taskId);
          if (!deleted) return Response.json({ error: "Task not found" }, { status: 404, headers });
          return Response.json({ ok: true }, { headers });
        }
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
