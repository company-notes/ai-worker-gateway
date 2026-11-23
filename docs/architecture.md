# Architecture and upstream contract

AI assistant → **AI Worker Gateway (loopback pilot, MCP entry)** → **unmodified T3 Fleet Gateway (MCP)** → T3 Code.

## Code ownership

`upstream/t3-fleet-gateway/` is a pinned Git submodule from `boundsj/t3-fleet-gateway`. It is read-only to this project. Never patch its working tree or edit its database. `src/` is the project's own transport, upstream adapter, configuration and local workspace service. A clean submodule enables reproducible upstream checkout without merging source code.

## Behavior in v0.1

- The facade forwards JSON-RPC MCP messages to the upstream MCP HTTP server using a dedicated upstream bearer token. For `tools/list` it appends local tools, and for two local `tools/call` names it handles requests itself. Other MCP methods, tool calls and upstream result IDs stay untouched.
- The facade is **loopback-only** and uses a distinct inbound bearer token. It does not implement upstream OAuth for agents; remote deployment, user/tenant identity and per-client policies are not ready. It must never be placed behind an unauthenticated tunnel.
- `worker_workspace_plan` inspects one direct child of an approved operator-supplied root without changing it; `worker_workspace_prepare` creates/reuses only that child folder. These tools do **not** create a T3 Project, configure a Fleet alias or launch a job. Both report `dispatchReady: false`.
- Projects must first be explicitly registered/configured in the upstream stack; only then should assistants use upstream `work_start` with an authorized target. For non-project work, consider upstream's existing scratch-project target rather than inventing Project Create.
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
