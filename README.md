# OpenComputer runtime examples

A **runtime** is the engine that runs an OpenComputer [Durable Agent Session](https://docs.opencomputer.dev/agent-sessions/runtimes): it drives a model's agent loop for one turn and records every step in the session's durable log. A runtime is a thin **wrapper around a provider's agent SDK** that adheres to the operational contract below.

Two worked examples, each a single file:

- [**`claude/src/index.ts`**](claude/src/index.ts) — wraps the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
- [**`codex/src/index.ts`**](codex/src/index.ts) — wraps the OpenAI Codex SDK (`@openai/codex-sdk`).

Each file reads top to bottom: the **turn** (`main`), then the **platform contract** (`newInput` / `append` / `sandbox`), then the **tools**. The contract helpers are the same in both runtimes — only `main` and the tool registration are SDK-specific. That contrast is the point: writing a runtime is wrapping an SDK, not re-implementing the platform.

---

## The operational contract

Every runtime adheres to this contract, whatever SDK it wraps.

### Invocation — once per turn

The platform runs the runtime **once per turn** (`node dist/index.js`): the process drives a single turn and exits. It is not a long-running server.

### Inputs — the environment

Everything the runtime needs for a turn arrives in the environment:

| Variable | Meaning |
| --- | --- |
| `OC_API_URL` | Base URL of the session events API. |
| `OC_SESSION_ID` | The session this turn belongs to. |
| `OC_TURN_ID` | This turn's id (used to build idempotent append keys). |
| `OC_TURN_TOKEN` | Fenced, single-use auth for this turn — the only plaintext credential the runtime holds. |
| `OC_EVENTS_CURSOR` | Read watermark: events at or before this seq are already consumed. |
| `OC_EVENT_KEY_BASE` | Durable high-water seed for append idempotency keys. |
| `OC_AGENT_PROMPT` | The agent's system prompt. |
| `OC_MODEL` | The `provider/model` to run. |
| `OC_RUNTIME_STATE_DIR` | A checkpointed directory for resumable state. |
| `<PROVIDER>_API_KEY` | The model key, **sealed**: an opaque token the host egress proxy swaps for the real key on the outbound call to the provider. It never enters the VM in plaintext. |

### The turn

1. **Read new input** from the events API at `OC_EVENTS_CURSOR` — `GET /v3/sessions/:id/events?after=<cursor>`.
2. **Drive the agent SDK** for one turn.
3. **Append each step** back — `POST /v3/sessions/:id/events` — as a typed event: `agent.message`, `tool.call`, `exec.completed`, `error.*`. Each append carries a stable idempotency key (`rt:<turn>:<base+n>`), so a restart never double-writes.
4. **Run side effects only in the remote sandbox** — `POST /v3/sessions/:id/sandbox/{exec,read,write,ls}`. The runtime has no local disk, shell, or network.
5. **Talk to the human** through the `say` and `ask` tools (user-level events); `ask` ends the turn awaiting a reply.

### Event levels

Every appended event carries a `level`: `user` (shown to the human), `progress` (activity feed), or `internal` (operator/debug).

### Output — the exit code is the lifecycle

- **Exit 0** — quiescent: nothing left to do. The session goes idle until the next message.
- **Non-zero** — crash: the platform restarts the turn in place from the checkpointed state.
- A **`401`** from the events API means the turn was **fenced** (canceled, or superseded by a newer one). Stop quietly and exit 0; the platform owns what happens next. Fencing guarantees a single writer, so the log never forks.

### Resumable state

Anything needed to resume goes under `OC_RUNTIME_STATE_DIR`, which the platform checkpoints at each turn boundary and restores on recovery. Its shape is up to the SDK: `claude` keeps a journal it `--continue`s; `codex` persists a server-side thread id it `resumeThread()`s.

### What the platform owns

The durable event log, single-writer fencing, hibernation, crash/restart, recovery, and delivery. The runtime stays stateless between turns except for `OC_RUNTIME_STATE_DIR`.

---

## Build

Each runtime is a standalone package:

```bash
cd claude   # or codex
npm install
npm run build
npm start
```

## Status

These are reference implementations of the contract. Registering your own custom runtime image is on the OpenComputer roadmap — see [Custom runtimes](https://docs.opencomputer.dev/agent-sessions/custom-runtimes). The `claude` example tracks the production `claude` runtime closely; in `codex`, the tool-registration call and the streamed-item field names are the two spots that converge with the production `codex` runtime (marked in the file).
