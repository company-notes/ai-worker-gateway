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
- `JobNotificationService` 使用 `work_feed({mine:true})`、持久 cursor 及 Gateway 自己記錄的工作歸屬，將狀態事件送到該助理綁定的 Webhook，**不顯示 Windows 桌面提示、不要求特定 Bot Routine**。`worker_notification_status/setup/decline` 讓助理依使用者選擇處理一次性 Opt-in；本機設定頁透過 10 分鐘 capability、HTTP Origin/Host/loopback 檢查填入 URL、Key，測試接收端後才啟用。`NotificationStore` 將每位助理的設定及工作對應資料以 AES-GCM 加密保存，Windows 的內部儲存金鑰由使用者帳戶 DPAPI 保護、獨立於可輪替的對外 MCP 金鑰。多位助理須用不同的 3791 MCP Client Token 才能可靠識別並分流通知。`WebhookSender` 限制外部 HTTPS、DNS 對外位址，避免 HTTP 重導向、私有 DNS 位址及無界逾時；loopback HTTP 僅為經本機使用者明確設定的目的地。Webhook 只提供通知事件，接收端負責把事件送回自己的聊天／App。
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
