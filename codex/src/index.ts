// Codex brain server for OpenComputer runtimes.
//
// This mirrors how the built-in `codex` runtime is actually built: an OC-UNAWARE HTTP
// server wrapping the OpenAI Codex SDK. Same contract as the claude brain (GET /healthz +
// POST /turn streaming the SDK's NATIVE events as NDJSON); only the SDK wiring differs.
// The platform ADAPTER (a separate process) owns all OC-awareness.
//
// Codex specifics (the parts that make brain/hands separation + resume actually work):
//   - Tools come from the MCP endpoint, registered via the codex CLI **config**
//     (`mcp_servers.<name>.url`) — NOT a per-thread `tools` option (the SDK ignores that).
//   - Codex's BUILT-IN shell is disabled (`features.shell_tool` / `unified_exec` = false) so
//     it runs everything through the `oc` MCP tools (the hands box), not local exec.
//   - HTTP/SSE transport is forced (a custom provider with `supports_websockets:false`) so the
//     host egress proxy can swap the sealed key — the default responses-websocket can't be proxied.
//   - Resume is a SERVER-SIDE THREAD: persist `thread.id` under state_dir and resume it next turn.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";

const CONTRACT_VERSION = "1";
const PORT = Number(process.env.OC_BRAIN_PORT ?? "8080");

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE — use ONLY the OpenComputer MCP tools (oc): " +
  "bash (shell), read / write / ls (files). There is no local filesystem. " +
  "Anything the human should see — progress, findings, and especially your final ANSWER — MUST go through the say tool. " +
  "Use the ask tool when you need a decision or missing info; after asking, STOP.";

interface TurnConfig {
  model?: string;
  system_prompt?: string;
  mcp_endpoint?: string;   // external MCP server (adapter-hosted): the hands + say/ask
  state_dir?: string;      // checkpointed dir; the codex thread id lives under it
  resume?: boolean;        // ignored — codex resumes via the persisted thread id, not a flag
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
  busy = true;   // claim NOW — no await between the guard and the claim, so two POSTs can't both pass.

  let body: TurnRequest;
  try { body = await readBody(req); }
  catch { busy = false; res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "invalid", message: "bad JSON" } })); return; }

  if (body.contract_version && body.contract_version !== CONTRACT_VERSION) {
    busy = false;
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "version", message: `brain speaks contract ${CONTRACT_VERSION}` } }));
    return;
  }

  const cfg = body.config ?? {};
  const model = (cfg.model ?? "openai/gpt-5-codex").replace(/^openai\//, "");
  const stateDir = cfg.state_dir ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state");
  mkdirSync(stateDir, { recursive: true });
  const threadFile = join(stateDir, "codex-thread-id");
  const savedThreadId = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

  const prompt = [
    cfg.system_prompt ?? "You are a helpful background agent.",
    TOOL_STEERING,
    (body.input ?? []).map((m) => `${m.role ?? "user"}: ${m.content ?? ""}`).filter(Boolean).join("\n\n") || "(no new input)",
  ].filter(Boolean).join("\n\n");

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  let seq = 0;
  let awaiting = false;
  const ac = new AbortController();
  req.on("close", () => { if (!res.writableEnded) ac.abort(); });

  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

    const codex = new Codex({
      env,
      config: {
        // Force HTTP/SSE transport (not the experimental responses-websocket): the sealed-key
        // egress proxy swaps the key on HTTPS, not on a wss handshake.
        model_provider: "openai-http",
        model_providers: {
          "openai-http": { name: "OpenAI HTTP/SSE", base_url: "https://api.openai.com/v1", env_key: "OPENAI_API_KEY", wire_api: "responses", requires_openai_auth: true, supports_websockets: false },
        },
        // Disable codex's native local exec so it MUST use the `oc` hands tools. image_generation
        // is also off — the fallback model metadata injects it and gpt-5-codex rejects it turn-fatally.
        features: { shell_tool: false, unified_exec: false, image_generation: false },
        // Register the adapter-hosted MCP server (auto-approve — there's no human per-tool approval).
        mcp_servers: cfg.mcp_endpoint ? { oc: { url: cfg.mcp_endpoint, default_tools_approval_mode: "auto" } } : {},
      },
    } as never);

    // danger-full-access + approval never: with the native shell gone nothing runs locally, so
    // codex's local sandbox is moot — but if left restrictive it cancels the remote MCP calls.
    const threadOpts = { skipGitRepoCheck: true, sandboxMode: "danger-full-access", approvalPolicy: "never" } as never;
    const thread = savedThreadId
      ? codex.resumeThread(savedThreadId, threadOpts)
      : codex.startThread({ model, ...(threadOpts as object) } as never);

    const { events } = await thread.runStreamed(prompt);
    for await (const event of events) {
      if (ac.signal.aborted) throw new Error("aborted");
      // Stream the NATIVE codex event verbatim; the adapter translates + appends durably.
      writeLine(res, { seq: seq++, kind: (event as { type?: string }).type, msg: event });
      const e = event as { type?: string; item?: { type?: string; tool?: string; name?: string } };
      if (e.type === "item.completed" && /(^|[._])ask$/.test(e.item?.tool ?? e.item?.name ?? "")) awaiting = true;
    }
    if (thread.id) writeFileSync(threadFile, thread.id);   // persist for resume
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

server.listen(PORT, "127.0.0.1", () => console.error(`[codex brain] listening on 127.0.0.1:${PORT} (contract ${CONTRACT_VERSION})`));
