# OpenComputer runtime examples

A **runtime** is the engine that runs an OpenComputer [Durable Agent Session](https://docs.opencomputer.dev/agent-sessions/runtimes). This repo shows what a runtime actually is: **a thin wrapper around a provider's agent SDK** that speaks a small contract with the platform.

Two runtimes, built the same way:

| Directory | Wraps | Models |
| --- | --- | --- |
| [`runtimes/claude`](runtimes/claude) | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | `anthropic/…` |
| [`runtimes/codex`](runtimes/codex) | OpenAI Codex SDK (`@openai/codex-sdk`) | `openai/…` |

They mirror how the built-in `claude` and `codex` runtimes are implemented.

## The point: a runtime is an SDK wrapper

Each runtime is three small files:

- **`src/oc.ts`** — the platform substrate: read events, append events, call the remote sandbox. **This file is identical in both runtimes** — the contract between OpenComputer and a runtime doesn't depend on the model. (`diff runtimes/claude/src/oc.ts runtimes/codex/src/oc.ts` is empty.)
- **`src/index.ts`** — drives the provider's agent SDK for one turn and translates its output into session events. This is the only file that meaningfully differs between the two.
- **`src/oc-tools.ts`** — the agent's tools (`bash` / `read` / `write` / `ls` / `say` / `ask`), each calling the remote sandbox.

Swap the SDK in `index.ts` + `oc-tools.ts`, keep `oc.ts`, and you have a new runtime.

## The contract

The platform invokes a runtime **once per turn** and hands it everything through the environment:

| Env | Meaning |
| --- | --- |
| `OC_API_URL` | base URL of the session events API |
| `OC_SESSION_ID` | the session this turn belongs to |
| `OC_TURN_ID` | this turn's id (used to build idempotent append keys) |
| `OC_TURN_TOKEN` | fenced, single-use auth for this turn — the only plaintext credential the runtime holds |
| `OC_EVENTS_CURSOR` | read watermark: events at or before this seq are already consumed |
| `OC_EVENT_KEY_BASE` | durable high-water for append idempotency keys |
| `OC_AGENT_PROMPT` | the agent's system prompt |
| `OC_MODEL` | the `provider/model` to run |
| `OC_RUNTIME_STATE_DIR` | a checkpointed directory for resumable state |
| `<PROVIDER>_API_KEY` | the model key — **sealed**: an opaque token the host egress proxy swaps for the real key on the call to the provider. It never enters the VM in plaintext. |

For one turn, the runtime:

1. reads new input from the events API at `OC_EVENTS_CURSOR`;
2. drives its SDK's agent loop;
3. appends each step back as typed events (`agent.message`, `tool.call`, `exec.completed`, `agent.result`, `error.*`, …);
4. performs side effects only through the remote **hands sandbox** (`POST /v3/sessions/:id/sandbox/{exec,read,write,ls}`);
5. **exits `0`** when there's nothing left to do. A non-zero exit is treated as a crash and the platform restarts the turn in place.

The platform owns everything else: the durable event log, fencing a single writer, hibernation, crash/restart, and recovery. The runtime stays stateless between turns except for what it leaves under `OC_RUNTIME_STATE_DIR`.

### Resumable state — the model-specific part

Both runtimes keep resumable state under `OC_RUNTIME_STATE_DIR`, but in the shape their SDK wants:

- **claude** keeps the Agent SDK's journal there and `--continue`s it on the next turn.
- **codex** persists the **Codex thread id** there and `resumeThread()`s it — the conversation lives server-side, keyed by that id.

## Build

Each runtime is a standalone package:

```bash
cd runtimes/claude   # or runtimes/codex
npm install
npm run build        # tsc → dist/
npm start            # runs one turn from the OC_* environment
```

## Status

These are **reference implementations** to show the shape — registering your own custom runtime image is on the OpenComputer roadmap (see [Custom runtimes](https://docs.opencomputer.dev/agent-sessions/custom-runtimes)). The `claude` example tracks the production `claude` runtime closely. The `codex` example tracks the public `@openai/codex-sdk`; the exact streamed-item shapes and the tool-registration call are marked in the code where they converge with the production `codex` runtime.
