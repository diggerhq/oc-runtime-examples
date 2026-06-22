// Entry point — ONE turn of an OpenComputer agent session.
//
// A runtime is invoked once per turn. The lifecycle is always the same; the only thing
// that changes between runtimes is which agent SDK drives the middle step (see agent.ts):
//
//   1. load the platform contract from the environment           → context.ts
//   2. drive the agent SDK for one turn, streaming every step    → agent.ts
//      into the durable session log                                 (session.ts, sandbox.ts, tools.ts)
//   3. exit 0 when idle; non-zero on crash, and the platform restarts the turn
//
// This file is just that scaffold — there is no business logic here.

import { loadContext } from "./context.js";
import { Session, FencedError } from "./session.js";
import { runTurn } from "./agent.js";

async function main(): Promise<void> {
  const ctx = loadContext(); // the contract: OC_* environment, validated
  const session = new Session(ctx); // the durable event log: read input, append events, fenced
  await runTurn(ctx, session); // drive the SDK and translate its steps into events
}

main()
  .then(() => process.exit(0)) // quiescent — nothing left to do this turn
  .catch((err: unknown) => {
    // A fenced turn was canceled or superseded: exit clean and let the platform decide.
    if (err instanceof FencedError) return process.exit(0);
    // Anything else is a crash. The platform restarts the turn in place from the
    // checkpointed state. (The error event itself is emitted in agent.ts, which holds the
    // session.) Logged here only for local debugging.
    console.error("[runtime] turn failed:", err);
    process.exit(1);
  });
