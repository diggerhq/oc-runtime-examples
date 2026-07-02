# AGENTS.md — oc-runtime-examples

Example agent **runtimes** built on the current runtime contract: OC-aware over
HTTP, mirroring the prod `v3-claude` runtime.

## What's here
- Single-file examples (claude + codex).
- **No `@opencomputer/sdk` import.** A runtime imports nothing of OC beyond the
  HTTP contract.

## Rule
Do NOT add an OC client-library dependency here. Runtimes talk to OC only over
the HTTP contract.

## Where to look
- Runtime reshape: `../oc-bg-agents/.agents/work/runtime.md` (§3)
- Runtime contract: `../oc-bg-agents/.agents/design/003-runtime-contract.md`

## Safety
Do NOT `npm install`, build, or execute code in sibling repos without verifying
them clean first (see archived-repo warnings).
