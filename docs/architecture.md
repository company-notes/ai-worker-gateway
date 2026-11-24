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
- `WorkRequestPolicy` **僅修改工作文字**：在上游 `work_start` 的 `task` 及 `work_continue` 的 `message` 中，確定性地追加安全 Git 階段提交及普通人交付指令，不改 requestId、host、project 或 model。是否真的提交以 Git 查證為準，不信任 Worker 自稱。
- `DeliveryService` 的 `worker_delivery_link` 只接受已授權的真實 `work_status`，從 Operator 核准的本機 root 下帶 `.awg-provision.json` 的 Project 登記標記找到專案，使用 Git `worktree list --porcelain` 和共同 Git 目錄比對真實任務分支；檢查 `main..HEAD` 有新提交且無未提交變更才回覆 `versionSaved:true`。產生 24h、單次使用的高熵 loopback capability URL，僅開啟 Windows Explorer，不接受任意目錄路徑。**瀏覽器 GET 只能拿到這個特殊 capability，不是開放不帶 Bearer 的 MCP 工具**。
- 通用通知不採用「MCP Token = Assistant」假設。`NotificationStore` 在本機以 AES-GCM 加密保存每個 Webhook Profile 與工作歸屬，配對成功後產生 256-bit 高熵 `notificationRouteId`，只將 HMAC 摘要記錄在磁碟。`worker_notification_setup` 提供本機安全設定頁，`worker_notification_pairing_status({setupId})` 讓原來的助理透過 MCP 收回自己的路由 ID；助理需將 ID 存入私有持久設定。`WorkerGateway` 在 `work_start` 與 `worker_task_start` 時驗證此 ID、移除私有附加欄位後才呼叫**原版** Fleet，成功時持久綁定 Job→Webhook。後續 `JobNotificationService` 透過 `work_feed({mine:true})` 及 `work_status`、持久游標和重試佇列依 Job 分流。沒有 ID 的派工不會綁定任何通知；每位助理可以共用同一條 MCP 連線及同一把 MCP 授權金鑰。`WebhookSender` 對外使用 HTTPS、擋私有網段 DNS 重綁／重導向；同機測試只允許明確的 127.0.0.1 HTTP，Webhook 金鑰不從 Gateway 送回聊天。持有路由 ID 即可指定通知目的地，若共用客戶端會惡意彼此攻擊，仍需額外可信的助理身分驗證。
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
