// Claude brain server for OpenComputer runtimes.
//
// This mirrors how the built-in `claude` runtime is actually built: an OC-UNAWARE
// HTTP server wrapping the Claude Agent SDK. It knows its SDK, an MCP endpoint (tools),
// and a state dir — and NOTHING about OpenComputer. The platform-provided ADAPTER
// (a separate process) drives turns over localhost and owns all OC-awareness: the
// events API, taxonomy, idempotency, fencing, and durability.
//
// Contract (one turn at a time):
//   GET  /healthz → 200 { status:"ready", contract_version, busy }
//   POST /turn    → NDJSON stream of the SDK's NATIVE messages, one JSON per line:
//                   { seq, kind:<msg.type>, msg }… then a terminal
//                   { kind:"done", reason:"quiescent"|"awaiting_input"|"error", error? }
// The brain streams its SDK's native output verbatim; the platform adapter maps each
// message to a durable session event. The brain does not invent an event schema.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// The internal runtime↔adapter contract version. (The public custom-runtime contract
// is still being finalized; the built-ins use this value today.)
const CONTRACT_VERSION = "1";
const PORT = Number(process.env.OC_BRAIN_PORT ?? "8080");

// Force the agent onto the remote MCP tools and off its built-in local tools — files and
// shell must run in the hands sandbox, not in this brain box.
const ALLOWED_TOOLS = ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask"];
const DISALLOWED_TOOLS = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"];

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE. Use ONLY the mcp__oc__ tools: " +
  "mcp__oc__bash (shell), mcp__oc__read / mcp__oc__write (files), mcp__oc__ls. " +
  "The built-in Bash/Read/Write/Edit are unavailable; there is no local filesystem. " +
  "Anything the human should see — progress, findings, and especially your final ANSWER — MUST go through mcp__oc__say. " +
  "Use mcp__oc__ask (it pauses your turn until they reply) when you need a decision or missing info.";

interface TurnConfig {
  model?: string;
  system_prompt?: string;
  mcp_endpoint?: string;   // external MCP server (adapter-hosted): the hands + say/ask
  resume?: boolean;        // --continue the on-box journal
  state_dir?: string;      // checkpointed dir; the journal lives under it
  max_turns?: number;
  deadline_s?: number;
}
interface TurnRequest {
  contract_version?: string;
  turn_id?: string;
  input?: Array<{ role?: string; content?: string }>;
  config?: TurnConfig;
}

let busy = false;

async function readBody(req: IncomingMessage): Promise<TurnRequest> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function writeLine(res: ServerResponse, obj: unknown): void {
  res.write(JSON.stringify(obj) + "\n");
}

async function runTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (busy) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "busy", message: "a turn is in flight" } })); return; }

  let body: TurnRequest;
  try { body = await readBody(req); }
  catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "invalid", message: "bad JSON" } })); return; }

  if (body.contract_version && body.contract_version !== CONTRACT_VERSION) {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "version", message: `brain speaks contract ${CONTRACT_VERSION}` } }));
    return;
  }

  const cfg = body.config ?? {};
  const model = (cfg.model ?? "anthropic/claude-opus-4-8").replace(/^anthropic\//, "");
  const stateDir = cfg.state_dir ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state");
  const cwd = join(stateDir, "journal");      // the Claude SDK journal — resumed with `continue`
  mkdirSync(cwd, { recursive: true });
  const prompt = (body.input ?? []).map((m) => m.content ?? "").filter(Boolean).join("\n\n") || "(no new input)";

  // The model key is sealed by the platform and swapped in by a host egress proxy on the
  // outbound HTTPS call — the brain just calls the SDK normally (no base-URL, no plaintext key).
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.ANTHROPIC_AUTH_TOKEN;   // force the api-key path
  delete childEnv.ANTHROPIC_BASE_URL;     // SDK → api.anthropic.com (proxied)

  // Tools come from the EXTERNAL MCP server the adapter hosts (HTTP transport). alwaysLoad
  // keeps the tools present from turn 1 (no "let me fetch the tool schema" round-trip).
  const mcpServers: Record<string, { type: "http"; url: string; alwaysLoad: boolean }> = {};
  if (cfg.mcp_endpoint) mcpServers.oc = { type: "http", url: cfg.mcp_endpoint, alwaysLoad: true };

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  busy = true;
  let seq = 0;
  let awaiting = false;
  const ac = new AbortController();
  req.on("close", () => { if (!res.writableEnded) ac.abort(); });   // adapter aborts → cancel the SDK

  try {
    const q = query({
      prompt,
      options: {
        model,
        cwd,
        continue: Boolean(cfg.resume),
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code", append: `${cfg.system_prompt ?? "You are a helpful background agent."}\n\n${TOOL_STEERING}` },
        permissionMode: "bypassPermissions",
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        mcpServers,
        maxTurns: cfg.max_turns ?? 24,
        env: childEnv,
        abortController: ac,
      },
    });
    // `ask` pauses the turn. Let the SDK actually RUN the ask tool (it appends the question
    // and pauses) before ending — so we break only after the ask tool's RESULT appears.
    const askIds = new Set<string>();
    for await (const msg of q) {
      // Stream the NATIVE SDK message verbatim; the adapter translates + appends durably.
      writeLine(res, { seq: seq++, kind: (msg as { type?: string }).type, msg });
      const m = msg as { type?: string; message?: { content?: Array<{ type?: string; name?: string; id?: string; tool_use_id?: string }> } };
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) if (b.type === "tool_use" && b.name === "mcp__oc__ask" && b.id) askIds.add(b.id);
      } else if (m.type === "user") {
        for (const b of m.message?.content ?? []) if (b.type === "tool_result" && b.tool_use_id && askIds.has(b.tool_use_id)) awaiting = true;
      }
      if (awaiting) break;
    }
    writeLine(res, { kind: "done", reason: awaiting ? "awaiting_input" : "quiescent" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeLine(res, { kind: "done", reason: "error", error: { type: ac.signal.aborted ? "aborted" : "turn_failed", message } });
  } finally {
    busy = false;
    if (!res.writableEnded) res.end();
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", contract_version: CONTRACT_VERSION, busy }));
    return;
  }
  if (req.method === "POST" && req.url === "/turn") { void runTurn(req, res); return; }
  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () => console.error(`[claude brain] listening on 127.0.0.1:${PORT} (contract ${CONTRACT_VERSION})`));
