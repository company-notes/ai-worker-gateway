# Developer and coding-agent guidance

Follow the supplied CODE_PRINCIPLES and TESTING guides in development environments where they are available. They are not redistributed here because they may be proprietary.

- OO / DRY / separation of concerns; use descriptive camelCase and uppercase acronyms in non-leading identifier positions.
- Keep service, transport, configuration and workspace responsibilities in separate classes; prefer early returns and fail fast rather than silent fallbacks.
- Maintain the official upstream gateway as a pinned, untouched Git submodule. Never import from `upstream/t3-fleet-gateway/src/` or write to its private SQLite database.
- A totally new assistant learns the workflow from MCP initialize instructions and tool descriptions, not by reading this repository's Skill file. Use `worker_task_plan` / `worker_task_start` for a fresh task; never silently select an unrelated Pilot alias.
- Only an existing operator-approved `AWG_GENERAL_PROJECT` or official upstream scratch target can be used as a generic destination; folder preparation is not Project registration.
- The extension facade must not escalate access: inbound requests need an independent client credential; upstream has its own token.
- Never expose this pilot facade on a non-loopback interface; production remote OAuth and per-client ACL are future work.
- When a real bug is found: create an observable failing regression test, fix it, rerun tests, then review spacing and rerun again.
- `npm run check` is the core scenario and static syntax check, and is the CI command.
- Final style pass: logical groups separated by one blank line; no blank-line decoration between contiguous `if/else` or `try/catch` units (Rule 20).
