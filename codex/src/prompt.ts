// System-prompt steering appended to the agent's own prompt. Two things the model must
// know that aren't obvious from the tools alone: the tools are REMOTE (there is no local
// machine), and the human only ever sees what goes through say/ask.

export const TOOL_STEERING =
  "Your filesystem and shell are REMOTE — act ONLY through the oc_bash / oc_read / oc_write / oc_ls " +
  "tools; there is no local filesystem. Anything the human should see — progress and especially your " +
  "final ANSWER — must go through oc_say. Use oc_ask only when you need a decision you cannot safely " +
  "assume; after calling it, stop — the turn ends and resumes when they reply.";
