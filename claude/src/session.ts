// The durable session: an append-only event log reached over HTTP, authenticated by the
// fenced turn token. The runtime reads new input from it and appends its own events back.
// This is the runtime's whole relationship with the platform — there is no database and
// no plaintext model key. Provider-agnostic — identical in every runtime.

import type { RuntimeContext } from "./context.js";

export type EventLevel = "user" | "progress" | "internal";

export interface InEvent {
  seq: number;
  id: string;
  type: string; // single public discriminator, e.g. "user.message"
  level: EventLevel;
  body: { text?: string } & Record<string, unknown>;
  ts: string;
}

export interface OutEvent {
  type: string; // agent.message | tool.call | exec.completed | agent.result | error.*
  level?: EventLevel; // default "internal"
  body?: unknown;
  refs?: Record<string, unknown>;
}

/** Thrown when an append is rejected with 401 — this turn was canceled or superseded. */
export class FencedError extends Error {
  constructor() {
    super("fenced");
    this.name = "FencedError";
  }
}

export class Session {
  private appendSeq = 0;

  constructor(private readonly ctx: RuntimeContext) {}

  private get authHeaders(): Record<string, string> {
    return { "X-Turn-Token": this.ctx.turnToken };
  }

  /** Events appended after the read cursor — the new input for this turn. */
  async newInput(): Promise<InEvent[]> {
    // level=internal returns ALL levels — the runtime needs every input event.
    const url = `${this.ctx.apiUrl}/v3/sessions/${this.ctx.sessionId}/events?after=${this.ctx.cursor}&level=internal`;
    const r = await fetch(url, { headers: this.authHeaders });
    if (!r.ok) throw new Error(`read events ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { data?: InEvent[] };
    return j.data ?? [];
  }

  /** The concatenated text of new user-level messages — what to prompt the agent with. */
  async newUserText(): Promise<string> {
    const events = await this.newInput();
    return (
      events
        .filter((e) => e.level === "user" && e.type.endsWith(".message"))
        .map((e) => e.body?.text ?? "")
        .filter(Boolean)
        .join("\n\n") || "(no new input)"
    );
  }

  /**
   * Append an event to the durable log. Idempotency keys are stable per turn
   * (`rt:<turn>:<base + n>`): before a crash-restart the platform seeds the base above
   * every committed event, so a re-run appends fresh keys and never double-writes.
   */
  async append(event: OutEvent): Promise<void> {
    const idempotencyKey = `rt:${this.ctx.turnId}:${this.ctx.eventKeyBase + this.appendSeq++}`;
    const r = await fetch(`${this.ctx.apiUrl}/v3/sessions/${this.ctx.sessionId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders },
      body: JSON.stringify({
        type: event.type,
        level: event.level ?? "internal",
        body: event.body ?? {},
        refs: event.refs,
        idempotency_key: idempotencyKey,
      }),
    });
    if (r.status === 401) throw new FencedError();
    if (!r.ok) throw new Error(`append event ${r.status}: ${await r.text()}`);
  }
}
