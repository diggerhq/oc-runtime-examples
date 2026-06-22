# codex runtime

An OpenComputer runtime that wraps the **OpenAI Codex SDK** (`@openai/codex-sdk`). It adheres to the [operational contract](../README.md) — so only the SDK-specific files differ from any other runtime.

## Layout

| File | Role | SDK-specific? |
| --- | --- | --- |
| `src/index.ts` | Entry point — the per-turn lifecycle scaffold (load → run → exit). | no |
| `src/context.ts` | Reads and validates the `OC_*` environment into a typed `RuntimeContext`. | no |
| `src/session.ts` | The durable event log: read new input, append events, fencing. | no |
| `src/sandbox.ts` | The remote hands sandbox client (`exec` / `read` / `write` / `ls`). | no |
| `src/agent.ts` | Drives a Codex thread for one turn and translates its items into events. | **yes** |
| `src/tools.ts` | The six OC tools (handlers identical to claude; registration differs). | **yes** |
| `src/prompt.ts` | System-prompt steering (tools are remote; the human sees only say/ask). | **yes** |

The four "no" files are byte-identical to the claude runtime's — the platform contract doesn't depend on the model.

## How a turn maps to the SDK

- **Input** → the prompt passed to `thread.runStreamed()`.
- **Resume** → Codex threads live **server-side**, keyed by id. We persist `thread.id` under `OC_RUNTIME_STATE_DIR` and `resumeThread()` it on the next turn or after a restart — the codex analogue of claude's `--continue` journal.
- **Key** → the sealed `OPENAI_API_KEY` is passed through untouched; the host egress proxy swaps in the real key on the call to `api.openai.com`.

## Convergence note

This example tracks the public `@openai/codex-sdk`. Two spots finalize with the production `codex` runtime, both marked in the code:

- the **streamed-item field names** in `agent.ts` (`item.completed` → `agent_message` / `command_execution`), and
- the **tool-registration call** that hands `ocTools(...)` to the SDK (`agent.ts` / `tools.ts`).

The shape of the wrapper — read input, drive the thread, translate to events, persist the thread id, exit — is stable.

## Build

```bash
npm install
npm run build      # tsc → dist/
npm start          # runs one turn from the OC_* environment
```
