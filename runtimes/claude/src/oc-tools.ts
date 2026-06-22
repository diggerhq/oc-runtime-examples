// The agent's tools, registered with the Claude Agent SDK as an in-process MCP server.
// Every side effect goes through the REMOTE hands sandbox (oc.sandboxCall); the model
// has no local filesystem, shell, or network. say/ask are how the agent talks to the
// human — ordinary model text is not shown to them.
//
// The codex runtime's oc-tools.ts does the same job against the Codex SDK — same six
// tools, same events, different SDK.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { appendEvent, sandboxCall } from "./oc.js";

export function makeOcServer(onAsk: () => void) {
  const bash = tool(
    "bash",
    "Run a shell command in the remote sandbox — the ONLY place commands run. Returns exit code + stdout/stderr.",
    { command: z.string(), timeout: z.number().optional() },
    async (a) => {
      await appendEvent({
        type: "tool.call",
        level: "progress",
        body: { tool: "bash", args_summary: a.command.slice(0, 200) },
      });
      const r = await sandboxCall("exec", { command: a.command, timeout: a.timeout });
      if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
      await appendEvent({
        type: "exec.completed",
        level: "progress",
        body: { command: a.command.slice(0, 200), exit_code: r.exitCode, summary: String(r.stdout ?? "").slice(0, 400) },
      });
      return {
        content: [{ type: "text", text: `exit ${r.exitCode}\n${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}` }],
      };
    },
  );

  const read = tool("read", "Read a file from the remote sandbox.", { path: z.string() }, async (a) => {
    const r = await sandboxCall("read", { path: a.path });
    return { content: [{ type: "text", text: r.content ?? r.error ?? "" }], isError: Boolean(r.error) };
  });

  const write = tool(
    "write",
    "Create or overwrite a file in the remote sandbox (parent dirs created).",
    { path: z.string(), content: z.string() },
    async (a) => {
      const r = await sandboxCall("write", { path: a.path, content: a.content });
      return { content: [{ type: "text", text: r.error ?? `wrote ${a.path}` }], isError: Boolean(r.error) };
    },
  );

  const ls = tool("ls", "List a directory in the remote sandbox.", { path: z.string().optional() }, async (a) => {
    const r = await sandboxCall("ls", { path: a.path });
    return { content: [{ type: "text", text: r.error ?? JSON.stringify(r.entries) }], isError: Boolean(r.error) };
  });

  const say = tool(
    "say",
    "Say something to the human you're working with — a deliberate, user-facing message (a finding, a summary, your final ANSWER). Your ordinary reasoning is NOT shown to them. Markdown ok.",
    { text: z.string() },
    async (a) => {
      await appendEvent({ type: "agent.message", level: "user", body: { text: a.text } });
      return { content: [{ type: "text", text: "said" }] };
    },
  );

  const ask = tool(
    "ask",
    "Ask the human a question and PAUSE. Use only when you need a decision or missing info you cannot safely assume. After calling ask, STOP — your turn ends now and resumes when they reply.",
    { text: z.string() },
    async (a) => {
      await appendEvent({ type: "agent.message", level: "user", body: { text: a.text, awaiting_input: true } });
      onAsk();
      return { content: [{ type: "text", text: "asked — turn paused for the human's reply" }] };
    },
  );

  return createSdkMcpServer({ name: "oc", version: "1.0.0", tools: [bash, read, write, ls, say, ask] });
}
