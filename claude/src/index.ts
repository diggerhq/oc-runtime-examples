// claude runtime — one turn of an OpenComputer agent session.
//
// A runtime is two SDKs wired together: the OpenComputer runtime SDK (connectRuntime —
// the turn: input, events, sandbox) and a provider's agent SDK (here, the Claude Agent
// SDK). This file just assembles the Claude agent from those pieces and runs one turn.
// There is no raw HTTP and no platform plumbing here — connectRuntime() is all of it.

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connectRuntime, FencedError } from "@opencomputer/sdk";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const oc = connectRuntime();
let asked = false; // the `ask` tool sets this — it ends the turn awaiting a human reply

// ---- piece 1: the agent's hands — tools backed by the OC sandbox; say/ask reach the human ----

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

const tools = createSdkMcpServer({
  name: "oc",
  version: "1.0.0",
  tools: [
    tool("bash", "Run a shell command in the remote sandbox — the only place commands run.", { command: z.string() }, async ({ command }) => {
      await oc.emit("tool.call", "progress", { tool: "bash", args_summary: command.slice(0, 200) });
      const { exitCode, stdout, stderr } = await oc.sandbox.exec(command);
      await oc.emit("exec.completed", "progress", { command: command.slice(0, 200), exit_code: exitCode, summary: (stdout ?? "").slice(0, 400) });
      return reply(`exit ${exitCode}\n${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
    }),
    tool("read", "Read a file from the remote sandbox.", { path: z.string() }, async ({ path }) => reply(await oc.sandbox.read(path))),
    tool("write", "Write a file in the remote sandbox.", { path: z.string(), content: z.string() }, async ({ path, content }) => {
      await oc.sandbox.write(path, content);
      return reply(`wrote ${path}`);
    }),
    tool("ls", "List a directory in the remote sandbox.", { path: z.string().optional() }, async ({ path }) => reply(JSON.stringify(await oc.sandbox.ls(path)))),
    tool("say", "Say something to the human — your findings or final answer. Ordinary text is not shown to them.", { text: z.string() }, async ({ text }) => {
      await oc.say(text);
      return reply("said");
    }),
    tool("ask", "Ask the human a question and PAUSE the turn until they reply.", { text: z.string() }, async ({ text }) => {
      await oc.ask(text);
      asked = true;
      return reply("asked");
    }),
  ],
});

const STEERING =
  "Your filesystem and shell are REMOTE — use only the mcp__oc__ tools (bash/read/write/ls). " +
  "Anything the human should see, especially your final ANSWER, must go through mcp__oc__say. " +
  "Use mcp__oc__ask only when you need a decision you cannot safely assume, then stop.";

// ---- piece 2: assemble the Claude Agent SDK for one turn, then run it ----

async function main() {
  // The journal (resumable SDK state) lives in the checkpointed dir; its presence = resume.
  const journal = join(oc.stateDir, "journal");
  const resuming = existsSync(journal);
  mkdirSync(journal, { recursive: true });

  const agent = query({
    prompt: (await oc.input()) || "(no new input)",
    options: {
      model: (oc.model || "anthropic/claude-opus-4-8").replace(/^anthropic\//, ""),
      cwd: journal,
      continue: resuming,
      settingSources: [], // ignore any host ~/.claude config
      maxTurns: 24,
      permissionMode: "bypassPermissions", // autonomous; the remote sandbox is the boundary
      systemPrompt: { type: "preset", preset: "claude_code", append: `${oc.agentPrompt}\n\n${STEERING}` },
      allowedTools: ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask"],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
      mcpServers: { oc: { type: "sdk", name: "oc", instance: tools.instance } },
    },
  });

  // Run the turn. The tools record their own steps; the agent speaks to the human via `say`.
  for await (const msg of agent) {
    if (msg.type === "assistant")
      for (const block of msg.message?.content ?? [])
        if (block.type === "text" && block.text?.trim()) await oc.emit("agent.message", "progress", { text: block.text });
    if (asked) break;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof FencedError) process.exit(0); // canceled/superseded — the platform decides
    console.error("[claude runtime] turn failed:", err);
    process.exit(1); // crash — the platform restarts the turn from the journal
  });
