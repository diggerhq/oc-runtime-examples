// The session's REMOTE hands sandbox — the only place the agent's file and shell actions
// run. Reached over the same turn-token-authed API; the runtime itself has no local disk,
// shell, or network, so this client is the agent's entire surface for acting on the world.
// Provider-agnostic — identical in every runtime.

import type { RuntimeContext } from "./context.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class Sandbox {
  constructor(private readonly ctx: RuntimeContext) {}

  private async call(op: "exec" | "read" | "write" | "ls", body: unknown): Promise<any> {
    const r = await fetch(`${this.ctx.apiUrl}/v3/sessions/${this.ctx.sessionId}/sandbox/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Turn-Token": this.ctx.turnToken },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`sandbox ${op}: HTTP ${r.status}`);
    return r.json();
  }

  exec(command: string, timeout?: number): Promise<ExecResult> {
    return this.call("exec", { command, timeout });
  }

  read(path: string): Promise<{ content: string }> {
    return this.call("read", { path });
  }

  async write(path: string, content: string): Promise<void> {
    await this.call("write", { path, content });
  }

  ls(path?: string): Promise<{ entries: string[] }> {
    return this.call("ls", { path });
  }
}
