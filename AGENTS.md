# Developer and coding-agent guidance

Follow the supplied CODE_PRINCIPLES and TESTING guides in development environments where they are available. They are not redistributed here because they may be proprietary.

- OO / DRY / separation of concerns; use descriptive camelCase and uppercase acronyms in non-leading identifier positions.
- Keep service, transport, configuration and workspace responsibilities in separate classes; prefer early returns and fail fast rather than silent fallbacks.
- Maintain the official upstream gateway as a pinned, untouched Git submodule. Never import from `upstream/t3-fleet-gateway/src/` or write to its private SQLite database.
- An assistant's routing policy is the Session Router Skill: inspect existing Job/workspace, determine follow-up vs new task, then use authorized MCP tools. MCP instructions and optional task helpers supplement rather than replace the Skill. Never silently select an unrelated Pilot alias.
- An explicitly authorized existing project, upstream scratch target, or `worker_workspace_ensure` verified local T3 project may be used. The new provisioning path needs AWG_WORKSPACE_ROOT, AWG_PROVISION_HOST, Git and an authorized Fleet discovery target; folder preparation is not Project registration.
- The extension facade must not escalate access: inbound requests need an independent client credential; upstream has its own token.
- Never expose this pilot facade on a non-loopback interface; production remote OAuth and per-client ACL are future work.
- When a real bug is found: create an observable failing regression test, fix it, rerun tests, then review spacing and rerun again.
- `npm run check` is the core scenario and static syntax check, and is the CI command.
- Final style pass: logical groups separated by one blank line; no blank-line decoration between contiguous `if/else` or `try/catch` units (Rule 20).
