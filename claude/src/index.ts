// claude runtime — one turn of an OpenComputer agent session, wrapping the Claude Agent SDK.
//
// A runtime is a replaceable "brain". It knows its agent SDK (here, Claude) and the
// OpenComputer *operational contract* — a handful of HTTP calls + env vars + exit codes,
// and nothing else. It imports NO OpenComputer library; a brain in any language implements
// the same contract. The contract section below is the whole dependency on the platform.
//
// Reads top to bottom: the operational contract, the agent's tools, then the turn.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---- the OpenComputer operational contract (the entire platform dependency) ----
// The platform passes everything in the environment, and the runtime talks back over the
// session API, authenticated by the per-turn turn token. Read input, append events, act in
// the remote sandbox. That's it — no SDK, no shared types.

const API = process.env.OC_API_URL!.replace(/\/$/, "");
const SESSION = process.env.OC_SESSION_ID!;
const headers = { "Content-Type": "application/json", "X-Turn-Token": process.env.OC_TURN_TOKEN! };
let eventKey = Number(process.env.OC_EVENT_KEY_BASE ?? 0);

async function readInput(): Promise<string> {
  const after = process.env.OC_EVENTS_CURSOR ?? "0";
  const res = await fetch(`${API}/v3/sessions/${SESSION}/events?after=${after}&level=internal`, { headers });
  const { data = [] } = (await res.json()) as { data: any[] };
  return data.filter((e) => e.level === "user" && e.type.endsWith(".message")).map((e) => e.body?.text).filter(Boolean).join("\n\n") || "(no new input)";
}

async function emit(type: string, level: "user" | "progress" | "internal", body: unknown) {
  // Stable per-turn idempotency key, so a crash-restart never double-writes.
  const res = await fetch(`${API}/v3/sessions/${SESSION}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type, level, body, idempotency_key: `rt:${process.env.OC_TURN_ID}:${eventKey++}` }),
  });
  if (res.status === 401) throw new Error("fenced"); // turn canceled/superseded — stop quietly
  if (!res.ok) throw new Error(`emit ${type}: ${res.status}`);
}

async function sandbox(op: "exec" | "read" | "write" | "ls", body: unknown): Promise<any> {
  const res = await fetch(`${API}/v3/sessions/${SESSION}/sandbox/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`sandbox ${op}: ${res.status}`);
  return res.json();
}

// ---- the agent's tools: file/shell run in the remote sandbox; say/ask reach the human ----

let asked = false;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

const tools = createSdkMcpServer({
  name: "oc",
  version: "1.0.0",
  tools: [
    tool("bash", "Run a shell command in the remote sandbox — the only place commands run.", { command: z.string() }, async ({ command }) => {
      await emit("tool.call", "progress", { tool: "bash", args_summary: command.slice(0, 200) });
      const { exitCode, stdout, stderr } = await sandbox("exec", { command });
      await emit("exec.completed", "progress", { command: command.slice(0, 200), exit_code: exitCode, summary: (stdout ?? "").slice(0, 400) });
      return reply(`exit ${exitCode}\n${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
    }),
    tool("read", "Read a file from the remote sandbox.", { path: z.string() }, async ({ path }) => reply((await sandbox("read", { path })).content ?? "")),
    tool("write", "Write a file in the remote sandbox.", { path: z.string(), content: z.string() }, async ({ path, content }) => {
      await sandbox("write", { path, content });
      return reply(`wrote ${path}`);
    }),
    tool("ls", "List a directory in the remote sandbox.", { path: z.string().optional() }, async ({ path }) => reply(JSON.stringify((await sandbox("ls", { path })).entries))),
    tool("say", "Say something to the human — your findings or final answer. Ordinary text is not shown to them.", { text: z.string() }, async ({ text }) => {
      await emit("agent.message", "user", { text });
      return reply("said");
    }),
    tool("ask", "Ask the human a question and PAUSE the turn until they reply.", { text: z.string() }, async ({ text }) => {
      await emit("agent.message", "user", { text, awaiting_input: true });
      asked = true;
      return reply("asked");
    }),
  ],
});

const STEERING =
  "Your filesystem and shell are REMOTE — use only the mcp__oc__ tools (bash/read/write/ls). " +
  "Anything the human should see, especially your final ANSWER, must go through mcp__oc__say. " +
  "Use mcp__oc__ask only when you need a decision you cannot safely assume, then stop.";

// ---- the turn: assemble the Claude Agent SDK from those pieces and run it ----

async function main() {
  const journal = join(process.env.OC_RUNTIME_STATE_DIR ?? `${process.env.HOME}/.oc/state/${SESSION}`, "journal");
  const resuming = existsSync(journal);
  mkdirSync(journal, { recursive: true });

  const agent = query({
    prompt: await readInput(),
    options: {
      model: (process.env.OC_MODEL || "anthropic/claude-opus-4-8").replace(/^anthropic\//, ""),
      cwd: journal,
      continue: resuming,
      settingSources: [],
      maxTurns: 24,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code", append: `${process.env.OC_AGENT_PROMPT ?? ""}\n\n${STEERING}` },
      allowedTools: ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask"],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
      mcpServers: { oc: { type: "sdk", name: "oc", instance: tools.instance } },
    },
  });

  for await (const msg of agent) {
    if (msg.type === "assistant")
      for (const block of msg.message?.content ?? [])
        if (block.type === "text" && block.text?.trim()) await emit("agent.message", "progress", { text: block.text });
    if (asked) break;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err?.message === "fenced") process.exit(0); // canceled/superseded — the platform decides
    console.error("[claude runtime] turn failed:", err);
    process.exit(1); // crash — the platform restarts the turn from the journal
  });
