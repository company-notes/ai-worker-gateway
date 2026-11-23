# AI Worker Gateway

An independent, **local-only experimental MCP facade** that extends the original [T3 Fleet Gateway](https://github.com/boundsj/t3-fleet-gateway) without modifying its code. Its upstream is pinned in `upstream/t3-fleet-gateway/` as a Git submodule; the extension's code lives only under `src/`.

**What works now:** an authenticated single MCP endpoint forwards upstream `initialize`, `tools/list`, `work_start`, `work_status`, `work_continue` and other JSON-RPC methods; tool discovery adds two new local tools for planning and preparing a workspace folder under an administrator-approved root. The underlying job engine, data, access control and T3 service remain untouched.

**Not yet supported:** end-to-end T3 Project registration, automatic dispatch from a newly prepared workspace, remote OAuth, multi-user tenant isolation, and live Windows/T3 acceptance. `worker_workspace_prepare` deliberately reports `dispatchReady: false` and requires operator registration. Do not confuse a prepared directory with a new company project or a registered T3 Project.

## Quick start (dedicated test account, loopback only)

1. Install Node.js 22.16+ and run the *original* upstream Fleet Gateway separately, following its official setup. This facade does not replace its OAuth/host enrollment.
2. Run `git submodule update --init --recursive` to obtain the exact upstream code revision. **Do not edit submodule files.**
3. Create a separate, long random client token and an upstream Fleet bearer token with least privilege. Pass the values as environment variables, never commit secrets.
4. Optionally configure `AWG_WORKSPACE_ROOT` to an **existing dedicated directory** owned by the test account. It is unset by default, so both local workspace tools fail closed.
5. Run `npm start` and connect your local MCP client to `http://127.0.0.1:3791/mcp`, presenting `Authorization: Bearer <AWG_CLIENT_TOKEN>`.

See [`.env.example`](.env.example) for names and [docs/architecture.md](docs/architecture.md) for the security contract and upstream update procedure.

## Agent routing skill

An optional [Gateway-neutral Session Router Skill](.agents/skills/session-router/SKILL.md) documents when to find, start, or continue jobs and explains why preparing a folder is not yet T3 Project registration. Each AI client still needs its own explicit MCP access.

Open implementation milestones are tracked in [GitHub Issues](https://github.com/company-notes/ai-worker-gateway/issues).

## Checks

`npm run check` runs JavaScript syntax checks and the focused real-HTTP MCP user scenario, with a local substitute for the external upstream when a live test instance has not been configured. GitHub Actions runs the same command. A real T3 end-to-end test is still required before production use.

## Repository boundaries

- `src/`, `tests/`, `.github/workflows/` — current implementation and CI.
- `upstream/t3-fleet-gateway/` — original upstream Git submodule; no changes, no copies of its internal modules.
- `legacy/windows/` — retained historical Windows migration scripts, **not supported installers for this facade**.
- `company-notes/ai-team-architecture` — private company architecture and validation history, not distributed with this public project.

The adapter is intentionally thin. Upstream updates require a conscious submodule pin bump, contract checks and tests; blindly pulling a new upstream commit does not guarantee interoperability.
