// The platform contract, as it arrives.
//
// Everything the platform hands a runtime for a single turn comes through the
// environment. `loadContext()` reads and validates it once, into a typed object the rest
// of the runtime depends on. This file is provider-agnostic — it is identical in every
// runtime.

export interface RuntimeContext {
  /** Base URL of the session events API. */
  apiUrl: string;
  /** The session this turn belongs to. */
  sessionId: string;
  /** This turn's id — used to build idempotent event-append keys. */
  turnId: string;
  /** Fenced, single-use auth for THIS turn. The only plaintext credential a runtime holds. */
  turnToken: string;
  /** Read watermark: events at or before this seq are already consumed. */
  cursor: number;
  /** Durable high-water seed for append idempotency keys (see session.ts). */
  eventKeyBase: number;
  /** The agent's system prompt. */
  agentPrompt: string;
  /** The `provider/model` to run (e.g. "anthropic/claude-opus-4-8"); empty ⇒ runtime default. */
  model: string;
  /** A checkpointed directory for resumable state that survives crash/restore. */
  stateDir: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadContext(): RuntimeContext {
  const sessionId = required("OC_SESSION_ID");
  return {
    apiUrl: required("OC_API_URL").replace(/\/$/, ""),
    sessionId,
    turnId: process.env.OC_TURN_ID ?? "",
    turnToken: required("OC_TURN_TOKEN"),
    cursor: Number(process.env.OC_EVENTS_CURSOR ?? "0") || 0,
    eventKeyBase: Number(process.env.OC_EVENT_KEY_BASE ?? "0") || 0,
    agentPrompt: process.env.OC_AGENT_PROMPT ?? "You are a helpful background agent.",
    model: process.env.OC_MODEL ?? "",
    stateDir:
      process.env.OC_RUNTIME_STATE_DIR ?? `${process.env.HOME ?? "/home/sandbox"}/.oc/state/${sessionId}`,
  };
}
