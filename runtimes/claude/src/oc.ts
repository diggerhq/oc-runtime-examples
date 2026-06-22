// The platform substrate every runtime is handed. This file is PROVIDER-AGNOSTIC —
// it is identical in the claude and codex runtimes, because the contract between
// OpenComputer and a runtime does not depend on the model.
//
// What the platform gives a runtime, per turn, through the environment:
//   OC_API_URL          base URL of the session events API
//   OC_SESSION_ID       the session this turn belongs to
//   OC_TURN_ID          this turn's id (used to build idempotent append keys)
//   OC_TURN_TOKEN       fenced, single-use auth for THIS turn — the only plaintext
//                       credential the runtime holds. A superseded turn's token is
//                       rejected, so the event log never gets two writers.
//   OC_EVENTS_CURSOR    read watermark: events at or before this seq are consumed
//   OC_EVENT_KEY_BASE   durable high-water for append idempotency keys (see below)
//
// The runtime reads new input from the events API, appends its own events back, drives
// side effects through the remote hands sandbox, and exits. It never touches a database
// or a plaintext model key.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const config = {
  apiUrl: req("OC_API_URL").replace(/\/$/, ""),
  sessionId: req("OC_SESSION_ID"),
  turnId: process.env.OC_TURN_ID ?? "",
  turnToken: req("OC_TURN_TOKEN"),
};

export type EventLevel = "user" | "progress" | "internal";

export interface InEvent {
  seq: number;
  id: string;
  type: string; // single public discriminator, e.g. "user.message"
  level: EventLevel;
  body: unknown;
  ts: string;
}

export interface OutEvent {
  type: string; // agent.message | tool.call | exec.completed | agent.result | error.* …
  level?: EventLevel; // default "internal"
  body?: unknown;
  refs?: Record<string, unknown>;
  idempotencyKey?: string;
}

const authHeaders = { "X-Turn-Token": config.turnToken };

// Stable append idempotency keys: `rt:<turn>:<base + n>`. Before a crash-restart the
// platform seeds OC_EVENT_KEY_BASE above every already-committed event, so a re-run's
// appends never collide with committed ones and nothing is written twice.
const keyBase = Number(process.env.OC_EVENT_KEY_BASE ?? "0") || 0;
let appendSeq = 0;

export async function getEventsSince(afterSeq: number): Promise<InEvent[]> {
  // level=internal returns ALL levels — the runtime needs every input event.
  const r = await fetch(
    `${config.apiUrl}/v3/sessions/${config.sessionId}/events?after=${afterSeq}&level=internal`,
    { headers: authHeaders },
  );
  if (!r.ok) throw new Error(`getEvents ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data?: InEvent[] };
  return j.data ?? [];
}

export async function appendEvent(ev: OutEvent): Promise<void> {
  const idempotencyKey = ev.idempotencyKey ?? `rt:${config.turnId}:${keyBase + appendSeq++}`;
  const r = await fetch(`${config.apiUrl}/v3/sessions/${config.sessionId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      type: ev.type,
      level: ev.level ?? "internal",
      body: ev.body ?? {},
      refs: ev.refs,
      idempotency_key: idempotencyKey,
    }),
  });
  // 401 = this turn was fenced (canceled or superseded). Stop quietly; the platform
  // owns what happens next.
  if (r.status === 401) throw new Error("fenced");
  if (!r.ok) throw new Error(`appendEvent ${r.status}: ${await r.text()}`);
}

// Side effects run in the session's REMOTE hands sandbox, reached through the same
// turn-token-authed API. The runtime has no local disk, shell, or network of its own.
export async function sandboxCall(
  op: "exec" | "read" | "write" | "ls",
  body: unknown,
): Promise<any> {
  const r = await fetch(`${config.apiUrl}/v3/sessions/${config.sessionId}/sandbox/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: `sandbox ${op}: HTTP ${r.status}` };
  return r.json();
}
