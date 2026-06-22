// codex runtime — one turn of an OpenComputer agent session, wrapping the OpenAI Codex SDK.
//
// A runtime is a replaceable "brain". It knows its agent SDK (here, Codex) and the
// OpenComputer *operational contract* — a handful of HTTP calls + env vars + exit codes,
// and nothing else. It imports NO OpenComputer library. The contract section below is
// byte-identical to the claude runtime's: the contract doesn't depend on the model.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";

// ---- the OpenComputer operational contract (the entire platform dependency) ----

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
// Handing this array to the SDK (startThread/resumeThread, below) is the one provider-specific
// seam — it converges with the production codex runtime.

let asked = false;
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

const tools = [
  {
    name: "oc_bash",
    description: "Run a shell command in the remote sandbox — the only place commands run.",
    parameters: schema({ command: { type: "string" } }, ["command"]),
    run: async ({ command }: any) => {
      await emit("tool.call", "progress", { tool: "bash", args_summary: String(command).slice(0, 200) });
      const { exitCode, stdout, stderr } = await sandbox("exec", { command });
      await emit("exec.completed", "progress", { command: String(command).slice(0, 200), exit_code: exitCode, summary: (stdout ?? "").slice(0, 400) });
      return `exit ${exitCode}\n${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
    },
  },
  { name: "oc_read", description: "Read a file from the remote sandbox.", parameters: schema({ path: { type: "string" } }, ["path"]), run: async ({ path }: any) => (await sandbox("read", { path })).content ?? "" },
  { name: "oc_write", description: "Write a file in the remote sandbox.", parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]), run: async ({ path, content }: any) => { await sandbox("write", { path, content }); return `wrote ${path}`; } },
  { name: "oc_ls", description: "List a directory in the remote sandbox.", parameters: schema({ path: { type: "string" } }), run: async ({ path }: any) => JSON.stringify((await sandbox("ls", { path })).entries) },
  { name: "oc_say", description: "Say something to the human — your findings or final answer. Ordinary text is not shown to them.", parameters: schema({ text: { type: "string" } }, ["text"]), run: async ({ text }: any) => { await emit("agent.message", "user", { text }); return "said"; } },
  { name: "oc_ask", description: "Ask the human a question and PAUSE the turn until they reply.", parameters: schema({ text: { type: "string" } }, ["text"]), run: async ({ text }: any) => { await emit("agent.message", "user", { text, awaiting_input: true }); asked = true; return "asked"; } },
];

const STEERING =
  "Your filesystem and shell are REMOTE — use only the oc_bash / oc_read / oc_write / oc_ls tools. " +
  "Anything the human should see, especially your final ANSWER, must go through oc_say. " +
  "Use oc_ask only when you need a decision you cannot safely assume, then stop.";

// ---- the turn: assemble the Codex thread from those pieces and run it ----

async function main() {
  // Codex resumes by THREAD ID (the conversation lives server-side), not a local journal.
  const stateDir = process.env.OC_RUNTIME_STATE_DIR ?? `${process.env.HOME}/.oc/state/${SESSION}`;
  mkdirSync(stateDir, { recursive: true });
  const threadFile = join(stateDir, "codex-thread-id");
  const saved = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

  const codex = new Codex({ env: { ...process.env } });
  const model = (process.env.OC_MODEL || "openai/gpt-5-codex").replace(/^openai\//, "");
  const thread = saved ? codex.resumeThread(saved, { tools }) : codex.startThread({ model, skipGitRepoCheck: true, tools });

  const { events } = await thread.runStreamed(`${process.env.OC_AGENT_PROMPT ?? ""}\n\n${STEERING}\n\n${await readInput()}`);
  for await (const ev of events) {
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text?.trim()) await emit("agent.message", "progress", { text: ev.item.text });
    if (asked) break;
  }

  if (thread.id) writeFileSync(threadFile, thread.id);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err?.message === "fenced") process.exit(0); // canceled/superseded — the platform decides
    console.error("[codex runtime] turn failed:", err);
    process.exit(1); // crash — the platform restarts the turn
  });
