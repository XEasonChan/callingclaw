// CallingClaw 2.0 — Module: Event Bus
// Push-based event system for agent integration.
// Agents subscribe via WebSocket (/ws/events) or register webhook URLs.
// Events: meeting.started, meeting.ended, meeting.action_item,
//         voice.tool_request, computer.task_done, task.created, task.updated

import type { ServerWebSocket } from "bun";

export interface CallingClawEvent {
  type: string;
  timestamp: number;
  correlationId?: string;  // tracks a meeting lifecycle end-to-end
  data: Record<string, any>;
}

interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];   // ["meeting.*", "task.*"] — supports glob
  secret?: string;     // HMAC signing secret
  createdAt: number;
}

export class EventBus {
  private _subscribers = new Set<ServerWebSocket<any>>();
  private _webhooks = new Map<string, WebhookRegistration>();
  private _listeners = new Map<string, Set<(data: Record<string, any>) => void>>();
  private _history: CallingClawEvent[] = [];
  private _correlationId: string | null = null;

  /** Start a new correlation (e.g. a meeting lifecycle) */
  startCorrelation(prefix = "mtg"): string {
    if (this._correlationId) {
      console.warn(`[EventBus] Overwriting active correlation ${this._correlationId}`);
    }
    this._correlationId = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return this._correlationId;
  }

  get correlationId() {
    return this._correlationId;
  }

  endCorrelation() {
    if (!this._correlationId) {
      console.warn("[EventBus] endCorrelation called but no active correlation");
      return;
    }
    this._correlationId = null;
  }

  // ── WebSocket Subscribers ──

  addSubscriber(ws: ServerWebSocket<any>) {
    this._subscribers.add(ws);
    console.log(`[EventBus] Subscriber connected (total: ${this._subscribers.size})`);
  }

  removeSubscriber(ws: ServerWebSocket<any>) {
    this._subscribers.delete(ws);
    console.log(`[EventBus] Subscriber disconnected (total: ${this._subscribers.size})`);
  }

  // ── Webhook Registration ──

  registerWebhook(url: string, events: string[], secret?: string): string {
    const id = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._webhooks.set(id, { id, url, events, secret, createdAt: Date.now() });
    console.log(`[EventBus] Webhook registered: ${id} → ${url} (${events.join(", ")})`);
    return id;
  }

  removeWebhook(id: string): boolean {
    const removed = this._webhooks.delete(id);
    if (removed) console.log(`[EventBus] Webhook removed: ${id}`);
    return removed;
  }

  listWebhooks(): WebhookRegistration[] {
    return [...this._webhooks.values()];
  }

  // ── Local Listeners ──

  /** Register a local in-process listener for an event type */
  on(type: string, callback: (data: Record<string, any>) => void) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(callback);
  }

  /** Remove a local listener */
  off(type: string, callback: (data: Record<string, any>) => void) {
    this._listeners.get(type)?.delete(callback);
  }

  // ── Emit Events ──

  emit(type: string, data: Record<string, any> = {}) {
    const event: CallingClawEvent = {
      type,
      timestamp: Date.now(),
      correlationId: this._correlationId || undefined,
      data,
    };

    // Store in history (keep last 200)
    this._history.push(event);
    if (this._history.length > 200) {
      this._history = this._history.slice(-200);
    }

    console.log(`[EventBus] ${type}${this._correlationId ? ` [${this._correlationId}]` : ""}`);

    // Notify local in-process listeners
    for (const [pattern, cbs] of this._listeners) {
      if (this._matchesFilter(type, [pattern])) {
        for (const cb of cbs) {
          try { cb(data); } catch (e: any) {
            console.warn(`[EventBus] Listener error (${pattern}):`, e.message);
          }
        }
      }
    }

    // Push to WebSocket subscribers
    const json = JSON.stringify(event);
    for (const ws of this._subscribers) {
      try {
        ws.send(json);
      } catch {
        this._subscribers.delete(ws);
      }
    }

    // Push to webhooks (fire-and-forget)
    for (const wh of this._webhooks.values()) {
      if (this._matchesFilter(type, wh.events)) {
        this._deliverWebhook(wh, event);
      }
    }
  }

  /** Get recent event history */
  getHistory(count = 50, typeFilter?: string): CallingClawEvent[] {
    let events = this._history;
    if (typeFilter) {
      events = events.filter((e) => this._matchesFilter(e.type, [typeFilter]));
    }
    return events.slice(-count);
  }

  /** Check if an event type matches a filter pattern */
  private _matchesFilter(type: string, filters: string[]): boolean {
    return filters.some((filter) => {
      if (filter === "*") return true;
      if (filter.endsWith(".*")) {
        return type.startsWith(filter.slice(0, -1));
      }
      return type === filter;
    });
  }

  /** Deliver event to a webhook URL */
  private async _deliverWebhook(wh: WebhookRegistration, event: CallingClawEvent) {
    try {
      const body = JSON.stringify(event);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-CallingClaw-Event": event.type,
        "X-CallingClaw-Webhook-Id": wh.id,
      };

      // HMAC signature if secret is set
      if (wh.secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(wh.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
        headers["X-CallingClaw-Signature"] = `sha256=${Buffer.from(sig).toString("hex")}`;
      }

      await fetch(wh.url, { method: "POST", headers, body });
    } catch (e: any) {
      console.warn(`[EventBus] Webhook delivery failed (${wh.id}):`, e.message);
    }
  }
}
