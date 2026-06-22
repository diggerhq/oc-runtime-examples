// claude runtime — one turn of an OpenComputer agent session, wrapping the Claude Agent SDK.
//
// The platform runs this once per turn. Top to bottom, the whole job is: read new input
// from the session, drive the Claude Agent SDK, stream each step back as a session event,
// act only through the remote sandbox, and exit 0 when there's nothing left to do (a
// non-zero exit is a crash, and the platform restarts the turn).
//
// Everything the platform gives us is in the environment (OC_*). The model key is sealed:
// an opaque token the host egress proxy swaps for the real key on the way out, so it never
// enters this VM.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const API = process.env.OC_API_URL!.replace(/\/$/, "");
const SESSION = process.env.OC_SESSION_ID!;
const headers = { "Content-Type": "application/json", "X-Turn-Token": process.env.OC_TURN_TOKEN! };
let asked = false; // set by the `ask` tool — it ends the turn awaiting a human reply

// ---- the turn ----

async function main() {
  // The Agent SDK's journal lives in the checkpointed state dir; its presence means resume.
  const journal = join(process.env.OC_RUNTIME_STATE_DIR ?? `${process.env.HOME}/.oc/state/${SESSION}`, "journal");
  const resuming = existsSync(journal);
  mkdirSync(journal, { recursive: true });

  let lastText = "";
  let spokeToHuman = false;

  for await (const msg of query({
    prompt: await newInput(),
    options: {
      model: (process.env.OC_MODEL || "anthropic/claude-opus-4-8").replace(/^anthropic\//, ""),
      cwd: journal,
      continue: resuming,
      settingSources: [], // ignore any host ~/.claude config
      maxTurns: 24,
      permissionMode: "bypassPermissions", // autonomous; the remote sandbox is the boundary
      systemPrompt: { type: "preset", preset: "claude_code", append: `${process.env.OC_AGENT_PROMPT ?? ""}\n\n${STEERING}` },
      allowedTools: ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask"],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
      mcpServers: { oc: { type: "sdk", name: "oc", instance: oc.instance } },
    },
  })) {
    if (msg.type !== "assistant") continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        lastText = block.text;
        await append("agent.message", "progress", { text: block.text });
      } else if (block.type === "tool_use" && (block.name === "mcp__oc__say" || block.name === "mcp__oc__ask")) {
        spokeToHuman = true;
      }
    }
    if (asked) break;
  }

  // If the agent never used say/ask, surface its final text so the session isn't left silent.
  if (!spokeToHuman && lastText.trim()) await append("agent.message", "user", { text: lastText.trim() });
}

// ---- the platform contract: read input, append events, act in the remote sandbox ----

let eventKey = Number(process.env.OC_EVENT_KEY_BASE ?? 0);

async function newInput(): Promise<string> {
  const after = process.env.OC_EVENTS_CURSOR ?? "0";
  const res = await fetch(`${API}/v3/sessions/${SESSION}/events?after=${after}&level=internal`, { headers });
  const { data = [] } = (await res.json()) as { data: any[] };
  return data.filter((e) => e.level === "user" && e.type.endsWith(".message")).map((e) => e.body?.text).filter(Boolean).join("\n\n") || "(no new input)";
}

async function append(type: string, level: "user" | "progress" | "internal", body: unknown) {
  // Stable idempotency key per turn — the platform seeds the base above committed events
  // before a restart, so a re-run never double-writes.
  const res = await fetch(`${API}/v3/sessions/${SESSION}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type, level, body, idempotency_key: `rt:${process.env.OC_TURN_ID}:${eventKey++}` }),
  });
  if (res.status === 401) throw new Error("fenced"); // turn canceled/superseded — stop quietly
  if (!res.ok) throw new Error(`append ${type}: ${res.status}`);
}

async function sandbox(op: "exec" | "read" | "write" | "ls", body: unknown): Promise<any> {
  const res = await fetch(`${API}/v3/sessions/${SESSION}/sandbox/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`sandbox ${op}: ${res.status}`);
  return res.json();
}

// ---- the agent's tools: file/shell run in the remote sandbox; say/ask reach the human ----

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

const oc = createSdkMcpServer({
  name: "oc",
  version: "1.0.0",
  tools: [
    tool("bash", "Run a shell command in the remote sandbox — the only place commands run.", { command: z.string() }, async ({ command }) => {
      await append("tool.call", "progress", { tool: "bash", args_summary: command.slice(0, 200) });
      const out = await sandbox("exec", { command });
      await append("exec.completed", "progress", { command: command.slice(0, 200), exit_code: out.exitCode, summary: (out.stdout ?? "").slice(0, 400) });
      return reply(`exit ${out.exitCode}\n${out.stdout ?? ""}${out.stderr ? `\n[stderr]\n${out.stderr}` : ""}`);
    }),
    tool("read", "Read a file from the remote sandbox.", { path: z.string() }, async ({ path }) => reply((await sandbox("read", { path })).content ?? "")),
    tool("write", "Write a file in the remote sandbox.", { path: z.string(), content: z.string() }, async ({ path, content }) => {
      await sandbox("write", { path, content });
      return reply(`wrote ${path}`);
    }),
    tool("ls", "List a directory in the remote sandbox.", { path: z.string().optional() }, async ({ path }) => reply(JSON.stringify((await sandbox("ls", { path })).entries))),
    tool("say", "Say something to the human — your findings or final answer. Ordinary text is not shown to them.", { text: z.string() }, async ({ text }) => {
      await append("agent.message", "user", { text });
      return reply("said");
    }),
    tool("ask", "Ask the human a question and PAUSE the turn until they reply.", { text: z.string() }, async ({ text }) => {
      await append("agent.message", "user", { text, awaiting_input: true });
      asked = true;
      return reply("asked");
    }),
  ],
});

const STEERING =
  "Your filesystem and shell are REMOTE — use only the mcp__oc__ tools (bash/read/write/ls). " +
  "Anything the human should see, especially your final ANSWER, must go through mcp__oc__say. " +
  "Use mcp__oc__ask only when you need a decision you cannot safely assume, then stop.";

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err?.message === "fenced") process.exit(0); // canceled/superseded — the platform decides
    console.error("[claude runtime] turn failed:", err);
    process.exit(1); // crash — the platform restarts the turn from the journal
  });
