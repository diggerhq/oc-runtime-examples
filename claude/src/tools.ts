// The agent's tools, registered with the Claude Agent SDK as an in-process MCP server.
//
// Two kinds of tool:
//   - bash / read / write / ls  proxy to the REMOTE hands sandbox (sandbox.ts) and emit
//     tool.call / exec.completed events for the activity feed.
//   - say / ask                 talk to the human as user-level events; ask pauses the turn.
//
// The handlers are identical in spirit to the codex runtime's; only the registration
// (an in-process MCP server here) is Claude-SDK-specific.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session } from "./session.js";
import type { Sandbox } from "./sandbox.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function ocToolServer(session: Session, sandbox: Sandbox, onAsk: () => void) {
  const bash = tool(
    "bash",
    "Run a shell command in the remote sandbox — the ONLY place commands run. Returns exit code + stdout/stderr.",
    { command: z.string(), timeout: z.number().optional() },
    async ({ command, timeout }) => {
      await session.append({ type: "tool.call", level: "progress", body: { tool: "bash", args_summary: command.slice(0, 200) } });
      try {
        const r = await sandbox.exec(command, timeout);
        await session.append({
          type: "exec.completed",
          level: "progress",
          body: { command: command.slice(0, 200), exit_code: r.exitCode, summary: (r.stdout ?? "").slice(0, 400) },
        });
        return ok(`exit ${r.exitCode}\n${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
      } catch (err) {
        return fail(String(err));
      }
    },
  );

  const read = tool("read", "Read a file from the remote sandbox.", { path: z.string() }, async ({ path }) => {
    try {
      return ok((await sandbox.read(path)).content ?? "");
    } catch (err) {
      return fail(String(err));
    }
  });

  const write = tool(
    "write",
    "Create or overwrite a file in the remote sandbox (parent dirs created).",
    { path: z.string(), content: z.string() },
    async ({ path, content }) => {
      try {
        await sandbox.write(path, content);
        return ok(`wrote ${path}`);
      } catch (err) {
        return fail(String(err));
      }
    },
  );

  const ls = tool("ls", "List a directory in the remote sandbox.", { path: z.string().optional() }, async ({ path }) => {
    try {
      return ok(JSON.stringify((await sandbox.ls(path)).entries));
    } catch (err) {
      return fail(String(err));
    }
  });

  const say = tool(
    "say",
    "Say something to the human — a deliberate, user-facing message (a finding, a summary, your final ANSWER). Your ordinary reasoning is NOT shown to them. Markdown ok.",
    { text: z.string() },
    async ({ text }) => {
      await session.append({ type: "agent.message", level: "user", body: { text } });
      return ok("said");
    },
  );

  const ask = tool(
    "ask",
    "Ask the human a question and PAUSE. Use only when you need a decision or missing info you cannot safely assume. After calling ask, STOP — your turn ends now and resumes when they reply.",
    { text: z.string() },
    async ({ text }) => {
      await session.append({ type: "agent.message", level: "user", body: { text, awaiting_input: true } });
      onAsk();
      return ok("asked — turn paused for the human's reply");
    },
  );

  return createSdkMcpServer({ name: "oc", version: "1.0.0", tools: [bash, read, write, ls, say, ask] });
}
