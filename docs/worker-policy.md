# Worker execution and workspace policy

The upstream Fleet Gateway owns host enrollment, job IDs, database, runtime modes and project authorization. AI Worker Gateway is an external MCP facade and **does not** replace or bypass those policies.

## Important distinctions

- `hosts[].access` is the T3 credential's **authorization ceiling**, not an inherited default for every project.
- Configured aliases have their own `projects[].runtimeMode`; when absent, upstream defaults to `approval-required`.
- Unconfigured discovered projects are controlled by `hosts[].discovery.enabled`, `allowWorkStart`, and `runtimeMode`, within the host ceiling.
- A new configured alias **does not inherit discovery policy**; configure it explicitly.
- Upstream per-client project allowlists are relevant for Discovery. Never assume that enabling Discovery is equivalent to least-privilege authorization.
- `auto` can still leave operations requiring manual approval. `full-access` has broader OS effects and should not be turned on globally.
- Git worktrees isolate Git checkout state; they are **not** OS security sandboxes. Use a dedicated least-privilege host/account.

## Wrapper-specific behavior

`worker_workspace_plan` and `worker_workspace_prepare` accept only a direct, lowercase slug under the administrator-supplied existing `AWG_WORKSPACE_ROOT`. They reject traversal and symlink destinations. Neither command changes upstream configuration, registers a T3 project, selects a model, grants permissions, creates a job or makes a prepared folder dispatch-ready.

Start work only after the operator has independently confirmed a valid project target, model, workspace mode and client access in the original Gateway. For quick temporary work, evaluate the upstream scratch/default project feature, subject to its own authorization rules.

## Acceptance gate

Real Windows tests must prove a fresh T3 Project and new Job can start, report status, and continue without unwanted approvals or cross-project access. The local HTTP-substitute tests in this repository are useful regression coverage, but **do not** establish that end-to-end guarantee. Track it in [Issue #2](https://github.com/company-notes/ai-worker-gateway/issues/2).
