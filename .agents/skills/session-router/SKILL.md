---
name: session-router
description: Select an existing authorized Gateway job or workspace, start a distinct new job, or safely continue the correct job without knowing the underlying execution product.
---

# Gateway-neutral Session Router

You are a worker-facing assistant. The only authorized work execution entrance is the MCP Gateway exposed to you. The skill is a routing policy, **not** a grant of tool access. Consult actual tool schemas and capabilities; do not invent tools or T3 identifiers.

## What must stay separate

- A company's task/card/ticket is the official work record, and may span multiple workers. Do not treat a local workspace as the company project.
- A worker workspace is a folder or execution project on one authorized host.
- A Gateway job is one tracked execution and may contain an ongoing thread. Conversation context is not the job ledger.

## Route in real user order

1. For a **new unrelated task with no history**, first call `worker_task_plan` with the user's complete task. If it reports `ready: true`, call `worker_task_start` with the same task and a fresh `requestId`. If it reports no approved general destination, ask for one-time operator configuration, never use Pilot as an implicit fallback.
2. For follow-up work, inspect `work_list`, `work_status` and `work_messages` first. Continue with `work_continue` **only** if one correct, continuable job is clearly identified. Keep that job ID.
3. If the user asks for a distinct new job, select a relevant authorized project from `fleet_projects` / `fleet_status`. Never silently use an unrelated project or someone else's job.
4. If no project is named, inspect whether the upstream Gateway offers an authorized host-only scratch target; do not assume it is available.
5. If a new local folder is needed, `worker_workspace_plan` can inspect it. `worker_workspace_prepare` can create only a folder under an operator-configured root. **Neither tool creates a T3 Project, registers a Fleet target, or proves dispatch readiness.** If registration is still needed, report the missing capability instead of calling unknown backend APIs.
6. Once the Gateway actually confirms an authorized target, start via `work_start` with an unambiguous task, expected deliverables, and a unique `requestId`. Retry uncertain requests with the *same* ID and identical input.
7. Verify actual job ID and state using `work_status`; use `work_messages` to read results. If the job needs human approval, report it rather than claiming unattended success.
8. If two jobs could match, ask a concise clarifying question. Do not resume a failed/terminated job as if it were active.

## Acceptance examples

- 'Create a marketing reporting tool' → find authorized existing workspaces or report that provisioning/registration is missing; never repurpose an unrelated pilot.
- 'Add CSV export to that tool' → uniquely identify and continue the same job, not a new job.
- 'Also plan a 30-second product video' → a separate job and only a new workspace if genuinely required.
- 'Continue yesterday's website' with two candidate jobs → clarify before calling `work_continue`.

Only claim actions that tools actually performed. Do not disclose credentials, machine-local paths, or other tenant data.
