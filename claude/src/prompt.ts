// System-prompt steering appended to the agent's own prompt. Two things the model must
// know that aren't obvious from the tools alone: the tools are REMOTE (there is no local
// machine), and the human only ever sees what goes through say/ask.

export const TOOL_STEERING =
  "Your filesystem and shell are REMOTE. Use ONLY the mcp__oc__ tools: mcp__oc__bash (shell), " +
  "mcp__oc__read / mcp__oc__write (files), mcp__oc__ls. The built-in Bash/Read/Write are unavailable; " +
  "there is no local filesystem. Anything the human should see — progress and especially your final " +
  "ANSWER — MUST go through mcp__oc__say; text written outside say/ask is invisible to them. Use " +
  "mcp__oc__ask (it pauses the turn until they reply) only when you need a decision you cannot safely assume.";
