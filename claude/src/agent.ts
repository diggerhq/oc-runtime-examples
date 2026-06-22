// Drive the Claude Agent SDK for one turn and translate its message stream into session
// events. This is the only provider-specific logic of any size. Everything it touches —
// the session log, the remote sandbox, the tools — is the same platform layer any runtime
// uses; the Claude-specific part is `query()` and how its messages map onto events.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeContext } from "./context.js";
import { Session, FencedError } from "./session.js";
import { Sandbox } from "./sandbox.js";
import { ocToolServer } from "./tools.js";
import { TOOL_STEERING } from "./prompt.js";

export async function runTurn(ctx: RuntimeContext, session: Session): Promise<void> {
  const model = (ctx.model || "anthropic/claude-opus-4-8").replace(/^anthropic\//, "");

  // The Agent SDK's journal lives under the checkpointed state dir, so the platform can
  // archive it at a turn boundary and a restored box can `--continue` from it. Its
  // presence is also how we know this turn is a resume.
  const journal = join(ctx.stateDir, "journal");
  const resuming = existsSync(journal);
  mkdirSync(journal, { recursive: true });

  const sandbox = new Sandbox(ctx);
  let asked = false; // set when the agent calls `ask`, which yields the turn
  const tools = ocToolServer(session, sandbox, () => {
    asked = true;
  });

  let sawUserFacing = false; // did the agent say/ask anything this turn?
  let lastText = ""; // the agent's final plain text — a safety net if it never said anything

  try {
    const stream = query({
      prompt: await session.newUserText(),
      options: {
        model,
        cwd: journal,
        continue: resuming,
        settingSources: [], // isolation: ignore any host ~/.claude config
        systemPrompt: { type: "preset", preset: "claude_code", append: `${ctx.agentPrompt}\n\n${TOOL_STEERING}` },
        permissionMode: "bypassPermissions", // autonomous; the remote sandbox is the boundary
        allowedTools: ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask"],
        disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
        mcpServers: { oc: { type: "sdk", name: "oc", instance: tools.instance } },
        maxTurns: 24,
        env: sealedEnv(),
      },
    });

    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            lastText = block.text;
            await session.append({ type: "agent.message", level: "progress", body: { text: block.text } });
          } else if (block.type === "tool_use" && (block.name === "mcp__oc__say" || block.name === "mcp__oc__ask")) {
            sawUserFacing = true;
          }
        }
      } else if (message.type === "result") {
        const u = message.usage ?? {};
        await session.append({
          type: "agent.result",
          level: "internal",
          body: { model, num_turns: message.num_turns, is_error: message.is_error, usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } },
        });
      }
      if (asked) break; // `ask` yielded — end the turn here
    }

    // Safety net: if the agent never used say/ask, surface its final text as a user-level
    // message so a user channel isn't left silent.
    if (!sawUserFacing && lastText.trim()) {
      await session.append({ type: "agent.message", level: "user", body: { text: lastText.trim() } });
    }
  } catch (err) {
    if (err instanceof FencedError) throw err; // canceled/superseded — handled in index.ts
    await session
      .append({ type: "error.runtime", level: "internal", body: { code: "turn_failed", message: String((err as Error)?.message ?? err), retriable: true } })
      .catch(() => {});
    throw err;
  }
}

// The sealed ANTHROPIC_API_KEY is already in the environment as an opaque token; the host
// egress proxy swaps in the real value on the outbound call to api.anthropic.com. Pass env
// through unchanged — no plaintext key, no base-url override.
function sealedEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN; // force the api-key path
  delete env.ANTHROPIC_BASE_URL; // SDK → api.anthropic.com (proxied)
  return env;
}
