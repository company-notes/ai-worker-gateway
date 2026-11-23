# AI Worker Gateway

An independent, **local-only experimental MCP facade** that extends the original [T3 Fleet Gateway](https://github.com/boundsj/t3-fleet-gateway) without modifying its code. Its upstream is pinned in `upstream/t3-fleet-gateway/` as a Git submodule; the extension's code lives only under `src/`.

**What works now:** an authenticated single MCP endpoint forwards existing upstream jobs and tools, and advertises a self-describing natural-language workflow (`worker_task_plan` → `worker_task_start`). A new assistant can discover those tools directly from MCP without reading this repository or earlier chat messages. Local `worker_workspace_plan`/`worker_workspace_prepare` still only inspect/create folders. The underlying job engine, data, access control and T3 service remain untouched.

**Not yet supported:** automatic creation/registration of a previously unknown T3 Project, dynamic semantic classification across multiple worker projects, remote OAuth, multi-user tenant isolation, and live Windows/T3 acceptance **of the new high-level task tools**. `worker_workspace_prepare` deliberately reports `dispatchReady: false` and requires operator registration. Do not confuse a prepared directory with a new company project or a registered T3 Project.

## Quick start (dedicated test account, loopback only)

1. Install Node.js 22.16+ and run the *original* upstream Fleet Gateway separately, following its official setup. This facade does not replace its OAuth/host enrollment.
2. Run `git submodule update --init --recursive` to obtain the exact upstream code revision. **Do not edit submodule files.**
3. Create a separate, long random client token and an upstream Fleet bearer token with least privilege. Pass the values as environment variables, never commit secrets.
4. Optionally configure `AWG_WORKSPACE_ROOT` to an **existing dedicated directory** owned by the test account. It is unset by default, so both local workspace tools fail closed.
5. Run `npm start` and connect your local MCP client to `http://127.0.0.1:3791/mcp`, presenting `Authorization: Bearer <AWG_CLIENT_TOKEN>`.

See [`.env.example`](.env.example) for names and [docs/architecture.md](docs/architecture.md) for the security contract and upstream update procedure.

**Already have T3/Fleet installed on Windows? Do not uninstall it.** Follow the [side-by-side Windows retest guide](docs/windows-retest.md) to connect this facade on port 3791 to the existing service on port 3790. The submodule is a source pin, not a second service installation.

Operator configuration must also follow the [worker execution and workspace policy](docs/worker-policy.md).

## Brand-new assistant: natural-language task delegation

**One-time operator prerequisite:** configure a dedicated authorized general-work Fleet alias (for example `general-work`) and set `AWG_GENERAL_PROJECT=general-work` before starting this wrapper; **or** configure exactly one host's verified upstream scratch `hosts[].defaultProject`. This gateway does not invent a T3 project, and will refuse unrelated work if only `pilot` is available. The upstream bearer client must have Operate access to the selected destination.

After that, give a **new, empty-context assistant only the MCP connection to port 3791**, then simply say something like "幫我製作一個行銷成效追蹤工具，包含可讀的成果". It should discover `worker_task_plan` and `worker_task_start` from MCP, create a fresh upstream job, return its ID, read progress through `work_status` and `work_messages`, and continue the same ID if you ask for improvements. No separate direct 3790/3773 MCP connections or repo Skill installation are required for this v0.2 experiment.

See the [zero-context assistant acceptance guide](docs/agent-zero-context-test.md) for exact pass/fail criteria, missing-config behavior, and a separate unrelated follow-up task. A generic destination is a **worker execution workspace**, not a company-level Project or Card.

## Agent routing skill

An optional [Gateway-neutral Session Router Skill](.agents/skills/session-router/SKILL.md) documents when to find, start, or continue jobs and explains why preparing a folder is not yet T3 Project registration. Each AI client still needs its own explicit MCP access.

Open implementation milestones are tracked in [GitHub Issues](https://github.com/company-notes/ai-worker-gateway/issues).

## Checks

`npm run check` runs JavaScript syntax checks and the focused real-HTTP MCP user scenario, with a local substitute for the external upstream when a live test instance has not been configured. GitHub Actions runs the same command. A real T3 end-to-end test is still required before production use.

## Repository boundaries

- `src/`, `tests/`, `.github/workflows/` — current implementation and CI.
- `upstream/t3-fleet-gateway/` — original upstream Git submodule; no changes, no copies of its internal modules.
- `company-notes/ai-team-architecture` — private company architecture and validation history, not distributed with this public project.

The adapter is intentionally thin. Upstream updates require a conscious submodule pin bump, contract checks and tests; blindly pulling a new upstream commit does not guarantee interoperability.
