// claude runtime — entrypoint for ONE turn (invoke-style: exit 0 = nothing left to do).
//
// It wraps the Claude Agent SDK: read new input from the session, drive query(),
// translate the SDK's message stream into OpenComputer session events, and yield.
// Everything platform-side is in ./oc.ts (shared, provider-agnostic); the only
// Claude-specific code is here and in ./oc-tools.ts.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, getEventsSince, appendEvent } from "./oc.js";
import { makeOcServer } from "./oc-tools.js";

const cursor = Number(process.env.OC_EVENTS_CURSOR ?? "0");
const agentPrompt = process.env.OC_AGENT_PROMPT ?? "You are a helpful background agent.";
const model = (process.env.OC_MODEL ?? "anthropic/claude-opus-4-8").replace(/^anthropic\//, "");

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE. Use ONLY the mcp__oc__ tools: mcp__oc__bash (shell), " +
  "mcp__oc__read / mcp__oc__write (files), mcp__oc__ls. The built-in Bash/Read/Write are unavailable; " +
  "there is no local filesystem. Anything the human should see — progress and especially your final " +
  "ANSWER — MUST go through mcp__oc__say; text written outside say/ask is invisible to them. Use " +
  "mcp__oc__ask (it pauses your turn until they reply) only when you need a decision you cannot safely assume.";

// The Agent SDK's journal lives under OC_RUNTIME_STATE_DIR so the platform can checkpoint
// it at a turn boundary and a restored box can --continue from it.
const stateDir =
  process.env.OC_RUNTIME_STATE_DIR ?? join(process.env.HOME ?? "/home/sandbox", ".oc/state", config.sessionId);
const cwd = join(stateDir, "journal");
const resuming = existsSync(cwd);
mkdirSync(cwd, { recursive: true });

let sawUserFacing = false; // did this turn say/ask anything user-facing?
let lastText = ""; // the agent's final plain text (the safety-net answer)

async function translate(msg: any): Promise<void> {
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        lastText = block.text;
        // agent narration at PROGRESS level (the user-facing answer goes via `say`).
        await appendEvent({ type: "agent.message", level: "progress", body: { text: block.text } });
      } else if (block.type === "tool_use" && ["mcp__oc__say", "mcp__oc__ask"].includes(block.name)) {
        sawUserFacing = true;
      }
    }
  } else if (msg.type === "result") {
    const u = msg.usage ?? {};
    await appendEvent({
      type: "agent.result",
      level: "internal",
      body: {
        model,
        num_turns: msg.num_turns,
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
      },
    });
  }
}

async function main(): Promise<void> {
  const inputs = await getEventsSince(cursor);
  // Prompt from new USER input messages — conversational continuity comes from the
  // SDK's --continue of the journal, not from re-feeding old turns.
  const prompt =
    inputs
      .filter((e) => e.level === "user" && typeof e.type === "string" && e.type.endsWith(".message"))
      .map((e) => (e.body as any)?.text ?? "")
      .filter(Boolean)
      .join("\n\n") || "(no new input)";

  let asked = false; // ask yields the turn (needs_input)
  const ocServer = makeOcServer(() => {
    asked = true;
  });

  // The sealed model key is already in process.env as an opaque token; the host egress
  // proxy swaps in the real value on the outbound call to api.anthropic.com. We pass env
  // through unchanged — no plaintext key, no base-url override.
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN; // force the api-key path
  delete env.ANTHROPIC_BASE_URL; // SDK → api.anthropic.com (proxied)

  const q = query({
    prompt,
    options: {
      model,
      cwd,
      continue: resuming,
      settingSources: [], // isolation: ignore any host ~/.claude
      systemPrompt: { type: "preset", preset: "claude_code", append: `${agentPrompt}\n\n${TOOL_STEERING}` },
      permissionMode: "bypassPermissions", // autonomous; the remote sandbox is the boundary
      allowedTools: ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask"],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
      mcpServers: { oc: { type: "sdk", name: "oc", instance: ocServer.instance } },
      maxTurns: 24,
      env,
    },
  });

  for await (const msg of q) {
    await translate(msg);
    if (asked) break; // ask yielded — end the turn
  }
  // Safety net: surface the agent's final plain-text answer as a user-level message so
  // a user channel isn't left silent.
  if (!sawUserFacing && lastText.trim()) {
    await appendEvent({ type: "agent.message", level: "user", body: { text: lastText.trim() } });
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    // "fenced" = a cancel/supersede landed — exit cleanly (the platform owns disposition).
    // Anything else: emit an error event and exit non-zero so the platform restarts the
    // turn in place from the journal.
    if (err instanceof Error && err.message === "fenced") process.exit(0);
    await appendEvent({
      type: "error.runtime",
      level: "internal",
      body: { code: "turn_failed", message: String(err?.message ?? err), retriable: true },
    }).catch(() => {});
    console.error("[oc-runtime-claude] turn failed:", err);
    process.exit(1);
  });
