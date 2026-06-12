// In-memory ring buffer of recent CallingClaw events, with a monotonic cursor.
// Lets any MCP client poll `callingclaw_recent_events` for a notification feed
// (used by agents — e.g. Hermes — that can't receive Claude's channel push).

export interface BufferedEvent {
  seq: number;
  type: string;
  data: Record<string, any>;
  timestamp: number;
}

export class EventBuffer {
  private events: BufferedEvent[] = [];
  private seq = 0;
  private readonly max: number;

  constructor(max = 100) {
    this.max = max;
  }

  push(type: string, data: Record<string, any>): BufferedEvent {
    const evt: BufferedEvent = {
      seq: ++this.seq,
      type,
      data: data || {},
      timestamp: Date.now(),
    };
    this.events.push(evt);
    if (this.events.length > this.max) {
      this.events.splice(0, this.events.length - this.max);
    }
    return evt;
  }

  /** Events with seq > since. Pass 0 (default) for everything buffered. */
  since(since = 0): BufferedEvent[] {
    return this.events.filter((e) => e.seq > since);
  }

  /** Highest seq issued so far (the cursor to pass next time). */
  get cursor(): number {
    return this.seq;
  }
}
