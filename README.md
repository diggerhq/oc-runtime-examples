# OpenComputer runtime examples

A **runtime** is the engine that runs an OpenComputer [Durable Agent Session](https://docs.opencomputer.dev/agent-sessions/runtimes): a replaceable "brain" that drives a model's agent loop for one turn. A runtime knows two things and nothing else — **a provider's agent SDK** (the model loop) and the **OpenComputer operational contract** (a handful of HTTP calls + env vars + an exit code). It does **not** import any OpenComputer library; a brain in any language implements the same contract.

Two worked examples, each a single file:

- [**`claude/src/index.ts`**](claude/src/index.ts) — wraps the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
- [**`codex/src/index.ts`**](codex/src/index.ts) — wraps the OpenAI Codex SDK (`@openai/codex-sdk`).

Each file reads the same way: the operational contract (the only platform dependency), the agent's tools, then the turn. The contract section is byte-identical across both — it doesn't depend on the model. The only real difference is the provider SDK.

## The operational contract

This is the whole interface between a runtime and the platform.

### Invocation — once per turn

The platform runs the runtime **once per turn** (`node dist/index.js`): the process drives a single turn and exits. It is not a long-running server.

### Inputs — the environment

Everything the runtime needs arrives in the environment:

| Variable | Meaning |
| --- | --- |
| `OC_API_URL` | Base URL of the session API. |
| `OC_SESSION_ID` | The session this turn belongs to. |
| `OC_TURN_ID` | This turn's id (used to build idempotent append keys). |
| `OC_TURN_TOKEN` | Fenced, single-use auth for this turn (sent as `X-Turn-Token`) — the only plaintext credential the runtime holds. |
| `OC_EVENTS_CURSOR` | Read watermark: events at or before this seq are already consumed. |
| `OC_EVENT_KEY_BASE` | Durable high-water seed for append idempotency keys. |
| `OC_AGENT_PROMPT` | The agent's system prompt. |
| `OC_MODEL` | The `provider/model` to run. |
| `OC_RUNTIME_STATE_DIR` | A checkpointed directory for resumable state. |
| `<PROVIDER>_API_KEY` | The model key, **sealed**: an opaque token the host egress proxy swaps for the real key on the outbound call to the provider. It never enters the VM in plaintext. |

### The turn — three HTTP calls

1. **Read new input** — `GET /v3/sessions/:id/events?after=<cursor>&level=internal`.
2. **Append events** — `POST /v3/sessions/:id/events` with `{ type, level, body, idempotency_key }`. Types: `agent.message`, `tool.call`, `exec.completed`, `error.*`. The stable idempotency key (`rt:<turn>:<base+n>`) makes a restart safe to replay.
3. **Act in the remote sandbox** — `POST /v3/sessions/:id/sandbox/{exec,read,write,ls}`. The runtime has no local disk, shell, or network of its own.

All authenticated by `X-Turn-Token`. Talking to the human is just an append at `level: "user"` (`say`), or one with `awaiting_input: true` (`ask`, which pauses the turn).

### Event levels

Every event has a `level`: `user` (shown to the human), `progress` (activity feed), or `internal` (operator/debug).

### Output — the exit code is the lifecycle

- **Exit 0** — quiescent: nothing left to do. The session goes idle until the next message.
- **Non-zero** — crash: the platform restarts the turn in place from the checkpointed state.
- A **`401`** on append means the turn was **fenced** (canceled, or superseded by a newer one). Stop quietly and exit 0; the platform owns what's next. Fencing guarantees a single writer, so the log never forks.

### Resumable state

Anything needed to resume goes under `OC_RUNTIME_STATE_DIR`, which the platform checkpoints at each turn boundary and restores on recovery. Its shape is up to the SDK: `claude` keeps a journal it `--continue`s; `codex` persists a server-side thread id it `resumeThread()`s.

### What the platform owns

The durable event log, single-writer fencing, hibernation, crash/restart, recovery, and delivery. The runtime stays stateless between turns except for `OC_RUNTIME_STATE_DIR`.

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
