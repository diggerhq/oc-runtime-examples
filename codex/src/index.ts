// codex runtime — one turn of an OpenComputer agent session, wrapping the OpenAI Codex SDK.
//
// Same shape as the claude runtime, and the platform-contract helpers below (newInput /
// append / sandbox) are the same — only the SDK loop in main() differs. The model key is
// sealed: an opaque token the host egress proxy swaps for the real key on the way out, so
// it never enters this VM.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";

const API = process.env.OC_API_URL!.replace(/\/$/, "");
const SESSION = process.env.OC_SESSION_ID!;
const headers = { "Content-Type": "application/json", "X-Turn-Token": process.env.OC_TURN_TOKEN! };
let asked = false; // set by the oc_ask tool — it ends the turn awaiting a human reply
let spokeToHuman = false; // did the agent say/ask anything this turn?

// ---- the turn ----

async function main() {
  // Codex resumes by THREAD ID (the conversation lives server-side), not a local journal.
  // We persist the id in the checkpointed state dir so a restart resumes the same thread.
  const stateDir = process.env.OC_RUNTIME_STATE_DIR ?? `${process.env.HOME}/.oc/state/${SESSION}`;
  mkdirSync(stateDir, { recursive: true });
  const threadFile = join(stateDir, "codex-thread-id");
  const saved = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

  const codex = new Codex({ env: { ...process.env } });
  const model = (process.env.OC_MODEL || "openai/gpt-5-codex").replace(/^openai\//, "");

  // Handing the tools to the SDK is the one provider-specific seam (see `tools`, below).
  const thread = saved ? codex.resumeThread(saved, { tools }) : codex.startThread({ model, skipGitRepoCheck: true, tools });

  let lastText = "";
  const { events } = await thread.runStreamed(`${process.env.OC_AGENT_PROMPT ?? ""}\n\n${STEERING}\n\n${await newInput()}`);
  for await (const ev of events) {
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text?.trim()) {
      lastText = ev.item.text;
      await append("agent.message", "progress", { text: ev.item.text });
    } else if (ev.type === "item.completed" && ev.item?.type === "command_execution") {
      const command = String(ev.item.command ?? "").slice(0, 200);
      await append("tool.call", "progress", { tool: "bash", args_summary: command });
      await append("exec.completed", "progress", { command, exit_code: ev.item.exit_code, summary: String(ev.item.aggregated_output ?? "").slice(0, 400) });
    }
    if (asked) break;
  }

  // If the agent never used say/ask, surface its final text so the session isn't left silent.
  if (!spokeToHuman && lastText.trim()) await append("agent.message", "user", { text: lastText.trim() });
  if (thread.id) writeFileSync(threadFile, thread.id);
}

// ---- the platform contract: read input, append events, act in the remote sandbox ----
// (identical to the claude runtime — the contract doesn't depend on the model)

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
// The handler logic is the same as the claude runtime; only the registration shape (and the
// exact item field names above) is Codex-specific and converges with the production runtime.

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

const tools = [
  {
    name: "oc_bash",
    description: "Run a shell command in the remote sandbox — the only place commands run.",
    parameters: schema({ command: { type: "string" } }, ["command"]),
    run: async ({ command }: any) => {
      await append("tool.call", "progress", { tool: "bash", args_summary: String(command).slice(0, 200) });
      const out = await sandbox("exec", { command });
      await append("exec.completed", "progress", { command: String(command).slice(0, 200), exit_code: out.exitCode, summary: String(out.stdout ?? "").slice(0, 400) });
      return `exit ${out.exitCode}\n${out.stdout ?? ""}${out.stderr ? `\n[stderr]\n${out.stderr}` : ""}`;
    },
  },
  { name: "oc_read", description: "Read a file from the remote sandbox.", parameters: schema({ path: { type: "string" } }, ["path"]), run: async ({ path }: any) => (await sandbox("read", { path })).content ?? "" },
  { name: "oc_write", description: "Write a file in the remote sandbox.", parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]), run: async ({ path, content }: any) => { await sandbox("write", { path, content }); return `wrote ${path}`; } },
  { name: "oc_ls", description: "List a directory in the remote sandbox.", parameters: schema({ path: { type: "string" } }), run: async ({ path }: any) => JSON.stringify((await sandbox("ls", { path })).entries) },
  { name: "oc_say", description: "Say something to the human — your findings or final answer. Ordinary text is not shown to them.", parameters: schema({ text: { type: "string" } }, ["text"]), run: async ({ text }: any) => { await append("agent.message", "user", { text }); spokeToHuman = true; return "said"; } },
  { name: "oc_ask", description: "Ask the human a question and PAUSE the turn until they reply.", parameters: schema({ text: { type: "string" } }, ["text"]), run: async ({ text }: any) => { await append("agent.message", "user", { text, awaiting_input: true }); spokeToHuman = true; asked = true; return "asked"; } },
];

const STEERING =
  "Your filesystem and shell are REMOTE — use only the oc_bash / oc_read / oc_write / oc_ls tools. " +
  "Anything the human should see, especially your final ANSWER, must go through oc_say. " +
  "Use oc_ask only when you need a decision you cannot safely assume, then stop.";

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err?.message === "fenced") process.exit(0); // canceled/superseded — the platform decides
    console.error("[codex runtime] turn failed:", err);
    process.exit(1); // crash — the platform restarts the turn
  });
