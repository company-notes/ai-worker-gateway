# Architecture and upstream contract

AI assistant → **AI Worker Gateway (loopback pilot, MCP entry)** → **unmodified T3 Fleet Gateway (MCP)** → T3 Code.

## Code ownership

`upstream/t3-fleet-gateway/` is a pinned Git submodule from `boundsj/t3-fleet-gateway`. It is read-only to this project. Never patch its working tree or edit its database. `src/` is the project's own transport, upstream adapter, configuration and local workspace service. A clean submodule enables reproducible upstream checkout without merging source code.

## Behavior of the local pilot

- The facade forwards JSON-RPC MCP messages to the upstream MCP HTTP server using a dedicated upstream bearer token. For `tools/list` it appends local task-routing and workspace tools. `initialize` includes a short delegation guide for clients that expose MCP server instructions. Other MCP methods, tool calls and upstream result IDs stay untouched.
- The facade is **loopback-only** and uses a distinct inbound bearer token. It does not implement upstream OAuth for agents; remote deployment, user/tenant identity and per-client policies are not ready. It must never be placed behind an unauthenticated tunnel.
- `worker_workspace_plan` inspects a child of an operator-owned root; `worker_workspace_prepare` creates/reuses only the folder, and does not register a project. Opt-in `worker_workspace_ensure` uses `WorkspaceProvisionService` (authorization and durable marker), `GitWorkspaceBootstrapper` (new Git repository with a first commit), and `T3ProjectAdapter` (official installed T3 CLI, not a database patch) to register a local Worker workspace. It verifies the exact returned project ID via authorized `fleet_projects` and validates a configured model via `fleet_models`. It returns a target for the existing official `work_start` call, not a company Card/Ticket.
- `worker_task_plan` queries authorized `fleet_status` data and chooses only an explicitly named project, operator configured `AWG_GENERAL_PROJECT`, or one upstream pinned scratch default. `worker_task_start` then uses original `work_start` with its `requestId`; it never invents a Project or resumes an unrelated job. If there is no safe default, it blocks before creating a job.
- When a suitable workspace already exists, use its authorized Fleet target directly. Otherwise `worker_workspace_ensure` may create an isolated Git project only when the operator opted into a local root and host. Project creation is not a job launch; the Fleet client must separately have access to NEW projects, plus Operate on that host and Discovery launch policy. A Pilot-only grant will not be silently elevated. Any failed/uncertain CLI registration or missing marker fails closed; re-run only after inspecting partial state. Non-Git workspace provisioning is not supported by this adapter.
- For tested runtime, the upstream endpoint is expected to respond to `tools/list` in JSON mode (as documented by upstream). No streaming / resumable MCP proxying is implemented. An SSE-mode tools/list is an explicit error.

## Update policy

The gitlink is a **version pin**, not a fork. Updating it is a deliberate, tested operation:

```bash
git submodule update --init --recursive
git -C upstream/t3-fleet-gateway fetch origin main
git -C upstream/t3-fleet-gateway checkout origin/main
npm run check
git add upstream/t3-fleet-gateway
git commit -m "chore: update upstream t3-fleet-gateway pin"
```

CI must pass against the new pin before deployment. An upstream pull is **not** a guaranteed compatibility upgrade; changed tool schemas, OAuth or transports may require changes in our adapter. Git submodule checkout does not install or start the upstream service.
