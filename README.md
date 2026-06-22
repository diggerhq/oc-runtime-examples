# OpenComputer runtime examples

A **runtime** is the engine that runs an OpenComputer [Durable Agent Session](https://docs.opencomputer.dev/agent-sessions/runtimes): it drives a model's agent loop for one turn and records every step in the session's durable log. A runtime is two SDKs wired together — the **OpenComputer runtime SDK** (the turn: input, events, sandbox) and a **provider's agent SDK** (the model loop).

Two worked examples, each a single file:

- [**`claude/src/index.ts`**](claude/src/index.ts) — wraps the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
- [**`codex/src/index.ts`**](codex/src/index.ts) — wraps the OpenAI Codex SDK (`@openai/codex-sdk`).

Each file reads the same way: connect the runtime, define the tools (the agent's hands, backed by the OC sandbox), assemble the provider SDK, run one turn. The only thing that changes between the two is the provider SDK — that's the point.

## The runtime SDK

`connectRuntime()` from `@opencomputer/sdk` is the whole platform side — there is no raw HTTP in either example. It reads the per-turn environment and returns a `RuntimeSession`:

| Member | What it does |
| --- | --- |
| `oc.input()` | The new user text for this turn. |
| `oc.emit(type, level, body)` | Append an event to the durable log (`tool.call`, `exec.completed`, …). |
| `oc.say(text)` / `oc.ask(text)` | A user-level message / a message that pauses the turn for a reply. |
| `oc.sandbox.exec / read / write / ls` | Act in the remote **hands** sandbox — the only place file/shell work runs. |
| `oc.model` / `oc.agentPrompt` / `oc.stateDir` | The pinned model + prompt, and a checkpointed dir for resumable state. |

It is the runtime-side companion to `connectSession()` (the client API). Under the hood it authenticates with the fenced turn token, generates idempotent event keys, and raises `FencedError` when a turn is canceled or superseded.

## The operational contract

`connectRuntime()` implements the contract below — the same contract a runtime written in another language would speak directly.

### Invocation — once per turn

The platform runs the runtime **once per turn** (`node dist/index.js`): the process drives a single turn and exits. It is not a long-running server.

### Inputs — the environment

Everything the runtime needs for a turn arrives in the environment (`connectRuntime()` reads these):

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

1. **Read new input** at `OC_EVENTS_CURSOR` — `oc.input()`.
2. **Drive the agent SDK** for one turn.
3. **Append each step** with `oc.emit(...)` — typed events (`agent.message`, `tool.call`, `exec.completed`, `error.*`). Idempotency keys are stable per turn, so a restart never double-writes.
4. **Run side effects only in the remote sandbox** — `oc.sandbox.*`. The runtime has no local disk, shell, or network.
5. **Talk to the human** with `oc.say(...)` / `oc.ask(...)`; `ask` ends the turn awaiting a reply.

### Event levels

Every event has a `level`: `user` (shown to the human), `progress` (activity feed), or `internal` (operator/debug).

### Output — the exit code is the lifecycle

- **Exit 0** — quiescent: nothing left to do. The session goes idle until the next message.
- **Non-zero** — crash: the platform restarts the turn in place from the checkpointed state.
- A superseded turn surfaces as a **`FencedError`** (a `401` underneath). Stop quietly and exit 0; the platform owns what's next. Fencing guarantees a single writer, so the log never forks.

### Resumable state

Anything needed to resume goes under `OC_RUNTIME_STATE_DIR` (`oc.stateDir`), which the platform checkpoints at each turn boundary and restores on recovery. Its shape is up to the SDK: `claude` keeps a journal it `--continue`s; `codex` persists a server-side thread id it `resumeThread()`s.

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

These are reference implementations. Registering your own custom runtime image is on the OpenComputer roadmap — see [Custom runtimes](https://docs.opencomputer.dev/agent-sessions/custom-runtimes). The `claude` example tracks the production `claude` runtime closely; in `codex`, the tool-registration call and the streamed-item field names are the two spots that converge with the production `codex` runtime (marked in the file).
