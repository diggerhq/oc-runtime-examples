# claude runtime

An OpenComputer runtime that wraps the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). It adheres to the [operational contract](../README.md) — so only the SDK-specific files differ from any other runtime.

## Layout

| File | Role | SDK-specific? |
| --- | --- | --- |
| `src/index.ts` | Entry point — the per-turn lifecycle scaffold (load → run → exit). | no |
| `src/context.ts` | Reads and validates the `OC_*` environment into a typed `RuntimeContext`. | no |
| `src/session.ts` | The durable event log: read new input, append events, fencing. | no |
| `src/sandbox.ts` | The remote hands sandbox client (`exec` / `read` / `write` / `ls`). | no |
| `src/agent.ts` | Drives `query()` for one turn and translates its messages into events. | **yes** |
| `src/tools.ts` | The six OC tools, registered as an in-process MCP server. | **yes** |
| `src/prompt.ts` | System-prompt steering (tools are remote; the human sees only say/ask). | **yes** |

The four "no" files are byte-identical to the codex runtime's. Dependencies flow one way: `index → agent → { tools → { session, sandbox }, prompt }`, with `session`/`sandbox` built on `context`.

## How a turn maps to the SDK

- **Input** → the `prompt` passed to `query()`. Continuity across turns comes from the journal, not from re-feeding history.
- **Tools** → an in-process MCP server (`mcpServers.oc`). The built-in `Bash`/`Read`/`Write` are disabled, so the agent's only surface is the remote sandbox.
- **Resume** → the Agent SDK journal under `OC_RUNTIME_STATE_DIR`, replayed with `continue: true`.
- **Key** → the sealed `ANTHROPIC_API_KEY` is passed through untouched; the host egress proxy swaps in the real key on the call to `api.anthropic.com`.

## Build

```bash
npm install
npm run build      # tsc → dist/
npm start          # runs one turn from the OC_* environment
```
