// The agent's tools for the codex runtime — the SAME six tools, the SAME events, the SAME
// remote sandbox as the claude runtime. The handler bodies are line-for-line equivalent;
// only how the tools are described to the SDK differs.
//
// NOTE — the one provider-specific seam: the Claude Agent SDK takes in-process tools
// directly; Codex exposes tools through its own configuration. The handlers below are the
// portable part; handing this array to the SDK (in agent.ts) is what converges with the
// production codex runtime.

import type { Session } from "./session.js";
import type { Sandbox } from "./sandbox.js";

export interface OcTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  run: (args: any) => Promise<{ output: string; isError?: boolean }>;
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

export function ocTools(session: Session, sandbox: Sandbox, onAsk: () => void, onSay: () => void): OcTool[] {
  return [
    {
      name: "oc_bash",
      description: "Run a shell command in the remote sandbox — the ONLY place commands run. Returns exit code + stdout/stderr.",
      parameters: schema({ command: { type: "string" }, timeout: { type: "number" } }, ["command"]),
      run: async ({ command, timeout }) => {
        await session.append({ type: "tool.call", level: "progress", body: { tool: "bash", args_summary: String(command).slice(0, 200) } });
        try {
          const r = await sandbox.exec(command, timeout);
          await session.append({
            type: "exec.completed",
            level: "progress",
            body: { command: String(command).slice(0, 200), exit_code: r.exitCode, summary: (r.stdout ?? "").slice(0, 400) },
          });
          return { output: `exit ${r.exitCode}\n${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}` };
        } catch (err) {
          return { output: String(err), isError: true };
        }
      },
    },
    {
      name: "oc_read",
      description: "Read a file from the remote sandbox.",
      parameters: schema({ path: { type: "string" } }, ["path"]),
      run: async ({ path }) => {
        try {
          return { output: (await sandbox.read(path)).content ?? "" };
        } catch (err) {
          return { output: String(err), isError: true };
        }
      },
    },
    {
      name: "oc_write",
      description: "Create or overwrite a file in the remote sandbox (parent dirs created).",
      parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      run: async ({ path, content }) => {
        try {
          await sandbox.write(path, content);
          return { output: `wrote ${path}` };
        } catch (err) {
          return { output: String(err), isError: true };
        }
      },
    },
    {
      name: "oc_ls",
      description: "List a directory in the remote sandbox.",
      parameters: schema({ path: { type: "string" } }),
      run: async ({ path }) => {
        try {
          return { output: JSON.stringify((await sandbox.ls(path)).entries) };
        } catch (err) {
          return { output: String(err), isError: true };
        }
      },
    },
    {
      name: "oc_say",
      description: "Say something to the human — a deliberate, user-facing message (a finding, a summary, your final ANSWER). Your ordinary reasoning is NOT shown to them.",
      parameters: schema({ text: { type: "string" } }, ["text"]),
      run: async ({ text }) => {
        await session.append({ type: "agent.message", level: "user", body: { text } });
        onSay();
        return { output: "said" };
      },
    },
    {
      name: "oc_ask",
      description: "Ask the human a question and PAUSE the turn. Use only when you need a decision you cannot safely assume. After calling ask, STOP.",
      parameters: schema({ text: { type: "string" } }, ["text"]),
      run: async ({ text }) => {
        await session.append({ type: "agent.message", level: "user", body: { text, awaiting_input: true } });
        onSay();
        onAsk();
        return { output: "asked — turn paused for the human's reply" };
      },
    },
  ];
}
