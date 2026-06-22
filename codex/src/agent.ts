// Drive the OpenAI Codex SDK for one turn and translate its streamed items into session
// events. This mirrors claude/agent.ts: the platform layer it wires in (session, sandbox,
// tools) is the same shape; the Codex-specific part is the thread + its event stream.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { RuntimeContext } from "./context.js";
import { Session, FencedError } from "./session.js";
import { Sandbox } from "./sandbox.js";
import { ocTools } from "./tools.js";
import { TOOL_STEERING } from "./prompt.js";

export async function runTurn(ctx: RuntimeContext, session: Session): Promise<void> {
  const model = (ctx.model || "openai/gpt-5-codex").replace(/^openai\//, "");

  // Codex resumes by THREAD ID — the conversation lives server-side, not in a local
  // journal. We persist the id under the checkpointed state dir so a restored box resumes
  // the same thread. This is the codex analogue of the claude runtime's `--continue`.
  mkdirSync(ctx.stateDir, { recursive: true });
  const threadFile = join(ctx.stateDir, "codex-thread-id");
  const savedThreadId = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

  const sandbox = new Sandbox(ctx);
  let asked = false; // set when the agent calls oc_ask, which yields the turn
  let sawUserFacing = false; // did the agent say/ask anything this turn?
  let lastText = ""; // the agent's last message — a safety net if it never said anything
  const tools = ocTools(
    session,
    sandbox,
    () => {
      asked = true;
    },
    () => {
      sawUserFacing = true;
    },
  );

  // The sealed OPENAI_API_KEY is already in the environment as an opaque token; the host
  // egress proxy swaps in the real value on the outbound call to api.openai.com.
  const codex = new Codex({ env: { ...process.env } });

  // Resume the server-side thread on a restart; otherwise start a fresh one. The sandbox
  // is REMOTE, so skip Codex's local git-repo check. Handing the tools to the SDK is the
  // one provider-specific seam (see tools.ts).
  const thread = savedThreadId
    ? codex.resumeThread(savedThreadId, { tools })
    : codex.startThread({ model, skipGitRepoCheck: true, tools });

  try {
    const { events } = await thread.runStreamed(`${ctx.agentPrompt}\n\n${TOOL_STEERING}\n\n${await session.newUserText()}`);

    // Codex streams structured items; map the ones a session cares about. Exact item field
    // names track @openai/codex-sdk and converge with the production runtime.
    for await (const event of events) {
      if (event.type === "item.completed") {
        const item = event.item ?? {};
        if (item.type === "agent_message" && item.text?.trim()) {
          lastText = item.text;
          await session.append({ type: "agent.message", level: "progress", body: { text: item.text } });
        } else if (item.type === "command_execution") {
          const command = String(item.command ?? "").slice(0, 200);
          await session.append({ type: "tool.call", level: "progress", body: { tool: "bash", args_summary: command } });
          await session.append({
            type: "exec.completed",
            level: "progress",
            body: { command, exit_code: item.exit_code, summary: String(item.aggregated_output ?? "").slice(0, 400) },
          });
        }
      } else if (event.type === "turn.completed") {
        const u = event.usage ?? {};
        await session.append({ type: "agent.result", level: "internal", body: { model, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } } });
      }
      if (asked) break; // oc_ask yielded — end the turn here
    }

    // Safety net: if the agent never used say/ask, surface its last message as user-level.
    if (!sawUserFacing && lastText.trim()) {
      await session.append({ type: "agent.message", level: "user", body: { text: lastText.trim() } });
    }

    // Persist the thread id so the next turn (or a restart) resumes this conversation.
    if (thread.id) writeFileSync(threadFile, thread.id);
  } catch (err) {
    if (err instanceof FencedError) throw err; // canceled/superseded — handled in index.ts
    await session
      .append({ type: "error.runtime", level: "internal", body: { code: "turn_failed", message: String((err as Error)?.message ?? err), retriable: true } })
      .catch(() => {});
    throw err;
  }
}
