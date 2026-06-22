// codex runtime — entrypoint for ONE turn (invoke-style: exit 0 = nothing left to do).
//
// Same shape as the claude runtime, wrapping the OpenAI Codex SDK instead of the Claude
// Agent SDK: read new input, drive a Codex thread, translate its streamed items into
// OpenComputer session events, and yield. ./oc.ts is the SAME file as in the claude
// runtime — the platform contract doesn't depend on the model. The only codex-specific
// code is here and in ./oc-tools.ts.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { config, getEventsSince, appendEvent } from "./oc.js";
import { ocTools } from "./oc-tools.js";

const cursor = Number(process.env.OC_EVENTS_CURSOR ?? "0");
const agentPrompt = process.env.OC_AGENT_PROMPT ?? "You are a helpful background agent.";
const model = (process.env.OC_MODEL ?? "openai/gpt-5-codex").replace(/^openai\//, "");

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE — act ONLY through the provided oc_bash / oc_read / oc_write / " +
  "oc_ls tools; there is no local filesystem. Anything the human should see, especially your final " +
  "ANSWER, must go through oc_say. Use oc_ask only when you need a decision you cannot safely assume, then stop.";

// Codex resumes a turn by THREAD ID, not by replaying a local journal: the thread lives
// server-side. We persist the thread id under OC_RUNTIME_STATE_DIR (a checkpointed dir),
// so a restored box resumes the SAME thread instead of starting a new one. This is the
// codex analogue of the claude runtime's --continue journal.
const stateDir =
  process.env.OC_RUNTIME_STATE_DIR ?? join(process.env.HOME ?? "/home/sandbox", ".oc/state", config.sessionId);
mkdirSync(stateDir, { recursive: true });
const threadFile = join(stateDir, "codex-thread-id");
const savedThreadId = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

let sawUserFacing = false;

async function translate(event: any): Promise<void> {
  // Codex streams structured items; we map the ones a session cares about to OC events.
  // (Exact item field names track @openai/codex-sdk and converge with the production
  // runtime — see README.)
  if (event.type === "item.completed") {
    const item = event.item ?? {};
    if (item.type === "agent_message" && item.text?.trim()) {
      await appendEvent({ type: "agent.message", level: "progress", body: { text: item.text } });
    } else if (item.type === "command_execution") {
      const command = String(item.command ?? "").slice(0, 200);
      await appendEvent({ type: "tool.call", level: "progress", body: { tool: "bash", args_summary: command } });
      await appendEvent({
        type: "exec.completed",
        level: "progress",
        body: { command, exit_code: item.exit_code, summary: String(item.aggregated_output ?? "").slice(0, 400) },
      });
    }
    // oc_say / oc_ask surface their own user-level events from the tool handlers.
  } else if (event.type === "turn.completed") {
    const u = event.usage ?? {};
    await appendEvent({
      type: "agent.result",
      level: "internal",
      body: { model, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } },
    });
  }
}

async function main(): Promise<void> {
  const inputs = await getEventsSince(cursor);
  const prompt =
    inputs
      .filter((e) => e.level === "user" && typeof e.type === "string" && e.type.endsWith(".message"))
      .map((e) => (e.body as any)?.text ?? "")
      .filter(Boolean)
      .join("\n\n") || "(no new input)";

  let asked = false;
  const tools = ocTools(
    () => {
      asked = true;
    },
    () => {
      sawUserFacing = true;
    },
  );

  // The sealed OPENAI_API_KEY is already in process.env as an opaque token; the host
  // egress proxy swaps in the real value on the outbound call to api.openai.com. We pass
  // env through unchanged — no plaintext key.
  const codex = new Codex({ env: { ...process.env } });

  // Resume the server-side thread on a restart; otherwise start a fresh one. The sandbox
  // is REMOTE, so skip Codex's local git-repo check. Tool registration is the one
  // provider-specific seam (see oc-tools.ts / README).
  const thread = savedThreadId
    ? codex.resumeThread(savedThreadId, { tools })
    : codex.startThread({ model, skipGitRepoCheck: true, tools });

  const { events } = await thread.runStreamed(`${agentPrompt}\n\n${prompt}`);
  for await (const event of events) {
    await translate(event);
    if (asked) break; // oc_ask yielded — end the turn
  }

  // Persist the thread id so the next turn (or a restart) resumes this conversation.
  if (thread.id) writeFileSync(threadFile, thread.id);
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    if (err instanceof Error && err.message === "fenced") process.exit(0); // canceled/superseded
    await appendEvent({
      type: "error.runtime",
      level: "internal",
      body: { code: "turn_failed", message: String(err?.message ?? err), retriable: true },
    }).catch(() => {});
    console.error("[oc-runtime-codex] turn failed:", err);
    process.exit(1);
  });
