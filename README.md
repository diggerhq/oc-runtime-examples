# OpenComputer runtime examples

These examples mirror how the built-in **`claude`** and **`codex`** runtimes are actually
built: an OC-unaware **brain server** around an agent SDK. They're trimmed for clarity, but
the contract and the SDK wiring match production.

A **runtime** is what's often called an **agent harness** — the terms map 1:1; OpenComputer's
API just calls it `runtime`.

The runtime author writes the brain. OpenComputer provides the platform **adapter**. The
adapter reads the session log, owns fencing and idempotency, exposes the sandbox tools over
MCP, calls the brain over localhost, and commits the brain's stream back to the session as
durable events.

That split is the point of this repo: the brain is just your agent harness; OpenComputer's
mechanics live in the adapter. The brain imports no OpenComputer SDK and never calls the
events or sandbox APIs directly.

## Examples

- [`claude/src/index.ts`](claude/src/index.ts) wraps the Claude Agent SDK.
- [`codex/src/index.ts`](codex/src/index.ts) wraps the OpenAI Codex SDK.

Both are a single HTTP server (`GET /healthz`, `POST /turn`) that drives the SDK for one
turn and streams the SDK's native output. The interesting differences are in how each SDK is
pointed at the MCP tools and how each resumes — see the comments in each file.

## Runtime–platform contract

### Process

The runtime image starts a long-running HTTP server in the brain sandbox. OpenComputer calls
it from a local adapter over `127.0.0.1:$OC_BRAIN_PORT` (`8080` by default). The server is
resident — it stays warm across turns and across sandbox hibernate/wake — and handles one
turn at a time.

### Health

```http
GET /healthz
```

```json
{ "status": "ready", "contract_version": "1", "busy": false }
```

Return `busy: true` while a turn is in progress. A second `POST /turn` should return `409`;
the platform fence already serializes real turns, so this is a safety check.

> `contract_version` is the internal runtime↔adapter version (`"1"` today). The public
> custom-runtime contract is still being finalized and may differ when it ships.

### Turn request

```http
POST /turn
Content-Type: application/json
```

```json
{
  "contract_version": "1",
  "turn_id": "turn_...",
  "input": [{ "role": "user", "content": "Review this repository." }],
  "config": {
    "model": "anthropic/claude-opus-4-8",
    "system_prompt": "Run tests and explain risks.",
    "mcp_endpoint": "http://127.0.0.1:8765/mcp",
    "state_dir": "/home/sandbox/.oc/runtime-state",
    "resume": false,
    "max_turns": 24
  }
}
```

The adapter has already read the durable session log and reduced it to the new turn input.
The brain does not know session ids, event cursors, turn tokens, or OpenComputer event names.

### Step stream

`POST /turn` responds with newline-delimited JSON. The brain streams the SDK's **native**
events verbatim, one per line, then a terminal `done`:

```jsonl
{"seq":0,"kind":"assistant","msg":{ ...native SDK message... }}
{"seq":1,"kind":"user","msg":{ ...native SDK message (e.g. a tool result)... }}
{"kind":"done","reason":"quiescent"}
```

- `kind` is the SDK message/event type; `msg` is the native object unchanged.
- `done.reason` is `quiescent` (nothing left to do), `awaiting_input` (the agent called
  `ask` and is paused for a reply), or `error` (with an `error`).

The platform adapter is what knows each SDK's shape: it maps these native events to session
events with stable idempotency keys, and flushes committed events before ending the turn.
(A single SDK-agnostic step protocol for fully custom runtimes is planned; today the platform
ships a per-SDK adapter for each built-in.)

### Tools

The brain acts through the MCP server at `config.mcp_endpoint` — and **only** that. Each SDK
is wired to use it and to disable its own built-in local tools, so commands and files run in
the hands sandbox, not in the brain box:

| Tool | What it does |
| --- | --- |
| `bash` | Run a shell command in the hands sandbox. |
| `read` / `write` / `ls` | File access in the hands sandbox. |
| `say` | Emit a user-visible message. |
| `ask` | Ask for input and pause the turn. |

The Claude SDK takes the MCP server as an HTTP `mcpServers` entry (with the built-in tools
disallowed). The Codex SDK takes it via CLI **config** (`mcp_servers.<name>.url`) with its
native shell disabled (`features.shell_tool`/`unified_exec` off) — see the codex example for
why HTTP transport and the sandbox/approval flags are required.

### State and recovery

Anything required to resume goes under `config.state_dir`. OpenComputer checkpoints that
directory at turn boundaries and restores it after recovery:

- **Claude** keeps a local journal under `state_dir` and continues from it.
- **Codex** persists its server-side `thread.id` under `state_dir` and resumes that thread.

Make the stream replay-safe: after a crash the adapter may re-run the turn and deduplicate
already-committed events.

### Cancellation

If a turn is canceled or superseded, the adapter aborts the HTTP request; the brain stops the
SDK loop when the request closes. If it doesn't, the adapter kills and restarts the brain
before the next turn.

## Build

Each example is a standalone package:

```bash
cd claude   # or codex
npm install
npm run build
npm start
```

The server listens on `OC_BRAIN_PORT` or `8080`.

## Status

Custom-runtime registration is planned, not yet public. These examples are close to the
production built-ins (provider SDK in the brain, OpenComputer mechanics in the adapter) so
you can see the real shape today; the public author-facing contract will be published when
custom runtimes ship.
