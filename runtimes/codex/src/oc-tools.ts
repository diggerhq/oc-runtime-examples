// The agent's tools for the codex runtime. The SAME six tools as the claude runtime,
// the SAME events, the SAME remote hands sandbox (oc.sandboxCall) — only the SDK they
// are registered with differs.
//
// NOTE — the one provider-specific seam: the Claude Agent SDK takes in-process tools
// directly; Codex exposes tools through its own configuration. The handlers below are
// the portable part (identical logic to claude/oc-tools.ts); how the array is handed to
// the SDK is the piece that converges with the production codex runtime — see README.

import { appendEvent, sandboxCall } from "./oc.js";

export interface OcTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any) => Promise<{ output: string; isError?: boolean }>;
}

export function ocTools(onAsk: () => void, onUserFacing: () => void): OcTool[] {
  return [
    {
      name: "oc_bash",
      description: "Run a shell command in the remote sandbox — the ONLY place commands run. Returns exit code + stdout/stderr.",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
      run: async (a) => {
        await appendEvent({ type: "tool.call", level: "progress", body: { tool: "bash", args_summary: String(a.command).slice(0, 200) } });
        const r = await sandboxCall("exec", { command: a.command, timeout: a.timeout });
        if (r.error) return { output: r.error, isError: true };
        await appendEvent({
          type: "exec.completed",
          level: "progress",
          body: { command: String(a.command).slice(0, 200), exit_code: r.exitCode, summary: String(r.stdout ?? "").slice(0, 400) },
        });
        return { output: `exit ${r.exitCode}\n${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}` };
      },
    },
    {
      name: "oc_read",
      description: "Read a file from the remote sandbox.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      run: async (a) => {
        const r = await sandboxCall("read", { path: a.path });
        return { output: r.content ?? r.error ?? "", isError: Boolean(r.error) };
      },
    },
    {
      name: "oc_write",
      description: "Create or overwrite a file in the remote sandbox (parent dirs created).",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      run: async (a) => {
        const r = await sandboxCall("write", { path: a.path, content: a.content });
        return { output: r.error ?? `wrote ${a.path}`, isError: Boolean(r.error) };
      },
    },
    {
      name: "oc_ls",
      description: "List a directory in the remote sandbox.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      run: async (a) => {
        const r = await sandboxCall("ls", { path: a.path });
        return { output: r.error ?? JSON.stringify(r.entries), isError: Boolean(r.error) };
      },
    },
    {
      name: "oc_say",
      description: "Say something to the human — a deliberate, user-facing message (a finding, a summary, your final ANSWER). Ordinary reasoning is NOT shown to them.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (a) => {
        await appendEvent({ type: "agent.message", level: "user", body: { text: a.text } });
        onUserFacing();
        return { output: "said" };
      },
    },
    {
      name: "oc_ask",
      description: "Ask the human a question and PAUSE the turn. Use only when you need a decision you cannot safely assume. After calling ask, STOP.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (a) => {
        await appendEvent({ type: "agent.message", level: "user", body: { text: a.text, awaiting_input: true } });
        onUserFacing();
        onAsk();
        return { output: "asked — turn paused for the human's reply" };
      },
    },
  ];
}
