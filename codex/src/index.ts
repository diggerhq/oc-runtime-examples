// codex runtime — one turn of an OpenComputer agent session.
//
// Same shape as the claude runtime: the OpenComputer runtime SDK (connectRuntime) wired to
// a provider's agent SDK — here the OpenAI Codex SDK. This file assembles the Codex thread
// from those pieces and runs one turn. connectRuntime() is the entire platform side; there
// is no raw HTTP here.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectRuntime, FencedError } from "@opencomputer/sdk";
import { Codex } from "@openai/codex-sdk";

const oc = connectRuntime();
let asked = false; // the oc_ask tool sets this — it ends the turn awaiting a human reply

// ---- piece 1: the agent's hands — tools backed by the OC sandbox; say/ask reach the human ----
// Handing this array to the SDK (startThread/resumeThread, below) is the one provider-specific
// seam — it converges with the production codex runtime.

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

const tools = [
  {
    name: "oc_bash",
    description: "Run a shell command in the remote sandbox — the only place commands run.",
    parameters: schema({ command: { type: "string" } }, ["command"]),
    run: async ({ command }: any) => {
      await oc.emit("tool.call", "progress", { tool: "bash", args_summary: String(command).slice(0, 200) });
      const { exitCode, stdout, stderr } = await oc.sandbox.exec(command);
      await oc.emit("exec.completed", "progress", { command: String(command).slice(0, 200), exit_code: exitCode, summary: (stdout ?? "").slice(0, 400) });
      return `exit ${exitCode}\n${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
    },
  },
  { name: "oc_read", description: "Read a file from the remote sandbox.", parameters: schema({ path: { type: "string" } }, ["path"]), run: async ({ path }: any) => oc.sandbox.read(path) },
  { name: "oc_write", description: "Write a file in the remote sandbox.", parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]), run: async ({ path, content }: any) => { await oc.sandbox.write(path, content); return `wrote ${path}`; } },
  { name: "oc_ls", description: "List a directory in the remote sandbox.", parameters: schema({ path: { type: "string" } }), run: async ({ path }: any) => JSON.stringify(await oc.sandbox.ls(path)) },
  { name: "oc_say", description: "Say something to the human — your findings or final answer. Ordinary text is not shown to them.", parameters: schema({ text: { type: "string" } }, ["text"]), run: async ({ text }: any) => { await oc.say(text); return "said"; } },
  { name: "oc_ask", description: "Ask the human a question and PAUSE the turn until they reply.", parameters: schema({ text: { type: "string" } }, ["text"]), run: async ({ text }: any) => { await oc.ask(text); asked = true; return "asked"; } },
];

const STEERING =
  "Your filesystem and shell are REMOTE — use only the oc_bash / oc_read / oc_write / oc_ls tools. " +
  "Anything the human should see, especially your final ANSWER, must go through oc_say. " +
  "Use oc_ask only when you need a decision you cannot safely assume, then stop.";

// ---- piece 2: assemble the Codex thread for one turn, then run it ----

async function main() {
  // Codex resumes by THREAD ID (the conversation lives server-side), not a local journal.
  // We persist the id in the checkpointed state dir so a restart resumes the same thread.
  mkdirSync(oc.stateDir, { recursive: true });
  const threadFile = join(oc.stateDir, "codex-thread-id");
  const saved = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

  const codex = new Codex({ env: { ...process.env } });
  const model = (oc.model || "openai/gpt-5-codex").replace(/^openai\//, "");
  const thread = saved ? codex.resumeThread(saved, { tools }) : codex.startThread({ model, skipGitRepoCheck: true, tools });

  // Run the turn. The tools record their own steps; the agent speaks to the human via oc_say.
  const { events } = await thread.runStreamed(`${oc.agentPrompt}\n\n${STEERING}\n\n${(await oc.input()) || "(no new input)"}`);
  for await (const ev of events) {
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text?.trim()) await oc.emit("agent.message", "progress", { text: ev.item.text });
    if (asked) break;
  }

  if (thread.id) writeFileSync(threadFile, thread.id);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof FencedError) process.exit(0); // canceled/superseded — the platform decides
    console.error("[codex runtime] turn failed:", err);
    process.exit(1); // crash — the platform restarts the turn
  });
