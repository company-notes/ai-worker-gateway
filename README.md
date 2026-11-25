# AI Worker Gateway

An independent, **local-only experimental MCP facade** that extends the original [T3 Fleet Gateway](https://github.com/boundsj/t3-fleet-gateway) without modifying its code. Its upstream is pinned in `upstream/t3-fleet-gateway/` as a Git submodule; the extension's code lives only under `src/`.

**What works now:** an authenticated single MCP endpoint forwards existing upstream jobs and tools, and advertises a self-describing natural-language workflow (`worker_task_plan` → `worker_task_start`). A new assistant can discover those tools directly from MCP without reading this repository or earlier chat messages. Local `worker_workspace_plan`/`worker_workspace_prepare` only inspect/create folders, while the opt-in `worker_workspace_ensure` can register an isolated Git workspace in the installed local T3 via its official CLI and verify a Fleet dispatch target. The underlying job engine, data, access control and T3 service remain untouched.

**Not yet supported:** unattended deployment of the original Fleet Gateway on fresh machines, backend-independent project provisioning beyond the local T3 CLI adapter, dynamic semantic project selection across workers, remote OAuth, multi-user tenant isolation, and live Windows/T3 acceptance **of this new provisioning path**. `worker_workspace_prepare` deliberately reports `dispatchReady: false` and requires operator registration. Do not confuse a prepared directory with a new company project or a registered T3 Project.

## Worker model defaults: inherit T3 Desktop on first installation

T3 Desktop keeps its **New threads** default in its local `~/.t3/userdata/settings.json` (`T3CODE_HOME` can relocate it). When the Windows installer runs for the **first** time, it reads only `defaultModelSelection`, including selected reasoning/effort options, and verifies the provider/model/options against the authorized Fleet `fleet_models` catalog. It saves the result as the **Gateway default** without modifying T3 or Fleet. On managed local T3 targets, the Gateway supplies this model only when the user/assistant has not explicitly selected another; an explicit per-job choice wins. Fleet configured project aliases continue to use their own defaults. The original Fleet records the Gateway-supplied selection as `source=explicit` because it receives a concrete model, even though the assistant did not choose one arbitrarily.

If T3 has no explicit default or the catalog cannot verify it, the first interactive installer offers a choice: allow an agent to reuse **its own exact Fleet-compatible model** (or ask when no such match exists), or manually pick a verified model from Fleet. Noninteractive installation never blocks on a prompt. Reinstalling does not silently reset the chosen model. To synchronize a changed T3 Desktop preference on an existing installation, rerun the installer with `-UseT3DefaultModel`; this explicitly replaces the old provisioning model pin. Normal `-ProvisionModelInstance`/`-ProvisionModel` flags still let an operator choose an exact model intentionally.

## Windows user-logon bootstrap (existing T3 and Fleet installed)

From the cloned Repository, **stop any manually running 3791 process first**, then run in Windows PowerShell 5.1+:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-WorkerGateway.ps1
```

The installer checks 3773 and 3790, automatically mints a local-host-scoped internal Fleet **Operate** grant using the locally installed Fleet CLI (no second token to copy), saves internal and external secrets with per-user DPAPI encryption and sets up a limited-privilege Task Scheduler task at **user logon**. It exports the Skill to `%LOCALAPPDATA%\AIWorkerGateway\skills\session-router\SKILL.md`; import and enable it in your AI client's Skills UI (or pass `-SkillInstallDirectory` when you know its officially supported local Skills directory). Then add **only** `http://127.0.0.1:3791/mcp` to that client's MCP list, using its wrapper client token. [Full installer guide](docs/windows-install.md).

**Not yet unattended before Windows sign-in**: the user-logon task is not an OS-level Windows service. It deliberately runs as the same user who owns the encrypted secrets and T3 session. The script does **not** yet install/configure a missing Fleet Gateway on a fresh Windows machine or automatically activate Skills inside an arbitrary third-party client. This is the remaining gap to the desired T3 + Node + clone + one-command fresh-machine experience. Local T3 Project registration is available only when provisioning is explicitly enabled with an authorized root, host and model policy.

## 成果交付：使用者只看得到要看的東西

完成的成果對一般使用者應呈現為：「行銷成效追蹤工具已經可以查看。已測試匯入 CSV、CTR／CVR／ROAS 計算與匯出。**查看成果資料夾**。需要修改直接告訴助理。」

- **版本自動保存**：Gateway 透過 `WorkRequestPolicy` 為 `work_start`、`work_continue` 的 Worker 工作文字附加預設的「每個有意義、測過的完成階段安全 Git Commit」要求；助理不問使用者是否 Commit，也不自動 Merge 或 Push。它是對 Worker 的工作政策，仍需驗證 Git 實際提交。交付工具 `worker_delivery_link` 提供 `versionSaved`，只有工作分支相對 main 有新提交且工作目錄乾淨時才為 `true`。
- **本機資料夾直接交付（不用網址）**：助理交付工作時優先呼叫 `worker_delivery_open({jobId})`。Gateway 會按原版 Fleet 的 `work_status` **直接回傳物件**解析工作資訊，驗證這個工作真的屬於受控本機 Git Project／worktree，然後直接開啟 Windows Explorer，並回傳真實的絕對資料夾位置 `folderPath`、檔名、工作狀態與 Git 版本檢查結果。即使工作尚在執行，也可以查看已存在的檔案，但不能稱為驗收完成。只有需要從聊天**點擊**開 Explorer 時，才使用 `worker_delivery_link` 的 127.0.0.1 一次性備用入口；它不是雲端檔案連結，而且同樣回傳真實 `folderPath`。開啟 Explorer 不等於上傳檔案，也不要求使用者去找 Git 分支。原版 Fleet/T3 無須修改。
- **所有助理共用 MCP、通知依 Webhook 配對分流**：第一次派工前，Session Router 問一次是否需要完成通知。使用者同意時，助理使用 `worker_notification_setup` 取得 Gateway 的本機設定頁，使用者在網頁輸入 Webhook URL 與 Key（不經聊天），Gateway 發出測試通知，接收端成功才加密保存。助理再呼叫 `worker_notification_pairing_status({setupId})`，取得隨機高熵的私有 `notificationRouteId` 並存入該助理的私有設定。**以後每次呼叫 `work_start`／`worker_task_start` 都帶該 `notificationRouteId`**；Gateway 記下 Job→Webhook 的對應後移除這個欄位，再呼叫未修改的原版 Fleet。不同助理可完全共用**同一個 3791 MCP 網址、同一把 MCP 金鑰**，靠不同配對 ID 分流通知，**無須各助理分別申請 MCP Token**。沒有配對 ID 就不自動通知。識別碼屬於私有路由能力，須由助理持久保存，若平台無法保存就不能保證跨聊天自動沿用。接收平台本身須支援將 Webhook 呈現在對應聊天，不是所有平台都自動有此功能。

一般使用者不需要看到 Job ID、分支、Workspace、Commit ID 或上游 Token。技術識別碼只用於內部追蹤，必要時才展開。

## Quick start (dedicated test account, loopback only)

1. Install Node.js 22.16+ and run the *original* upstream Fleet Gateway separately, following its official setup. This facade does not replace its OAuth/host enrollment.
2. Run `git submodule update --init --recursive` to obtain the exact upstream code revision. **Do not edit submodule files.**
3. Create a separate, long random client token and an upstream Fleet bearer token with least privilege. Pass the values as environment variables, never commit secrets.
4. Optionally configure `AWG_WORKSPACE_ROOT` to an **existing dedicated directory** owned by the test account. It is unset by default, so both local workspace tools fail closed.
5. Run `npm start` and connect your local MCP client to `http://127.0.0.1:3791/mcp`, presenting `Authorization: Bearer <AWG_CLIENT_TOKEN>`.

See [`.env.example`](.env.example) for names and [docs/architecture.md](docs/architecture.md) for the security contract and upstream update procedure.

**Already have T3/Fleet installed on Windows? Do not uninstall it.** Use the [Windows bootstrap installer](docs/windows-install.md) to install 3791, export the Session Router Skill, store the two tokens using Windows DPAPI and register user-logon autostart. Follow the [side-by-side Windows retest guide](docs/windows-retest.md) to connect this facade on port 3791 to the existing service on port 3790. The submodule is a source pin, not a second service installation.

Operator configuration must also follow the [worker execution and workspace policy](docs/worker-policy.md).

## Brand-new assistant: natural-language task delegation

**One-time operator prerequisite:** opt into managed local provisioning (`AWG_WORKSPACE_ROOT` + `AWG_PROVISION_HOST`, optional `AWG_PROVISION_MODEL_SELECTION`), **or** choose an existing authorized Fleet alias/scratch target. The Session Router Skill decides whether to reuse an existing workspace or call `worker_workspace_ensure` for a different one. A newly registered T3 Project is dispatched only after it appears in the authorized Fleet catalog and has a launch model (operator-pinned or chosen by the assistant from `fleet_models`); a client limited to Pilot cannot dispatch it.

After that, install/enable the **Session Router Skill** in the new assistant and give it **only the MCP connection to port 3791**. Then simply say something like "幫我製作一個行銷成效追蹤工具，包含可讀的成果". It should discover existing Fleet tools and `worker_workspace_ensure` from MCP when a workspace is missing, create a fresh upstream job, return its ID, read progress through `work_status` and `work_messages`, and continue the same ID if you ask for improvements. No separate direct 3790/3773 MCP connections or access to earlier chat transcripts are required.

See the [zero-context assistant acceptance guide](docs/agent-zero-context-test.md) for exact pass/fail criteria, missing-config behavior, and a separate unrelated follow-up task. A generic destination is a **worker execution workspace**, not a company-level Project or Card.

## Agent routing skill

The [Session Router Skill](.agents/skills/session-router/SKILL.md) is the **intended routing policy** for every fresh assistant: discover existing jobs and workspaces, decide whether to continue or start, then call the Gateway. The MCP `worker_task_plan` / `worker_task_start` endpoints are experimental backend helpers, **not** a replacement for the Skill's intent judgment. Installing the Skill does not itself create a Gateway grant or an unregistered T3 Project.

Open implementation milestones are tracked in [GitHub Issues](https://github.com/company-notes/ai-worker-gateway/issues).

## Checks

`npm run check` runs JavaScript syntax checks and the focused real-HTTP MCP user scenario, with a local substitute for the external upstream when a live test instance has not been configured. GitHub Actions runs the same command. A real T3 end-to-end test is still required before production use.

## Repository boundaries

- `src/`, `tests/`, `.github/workflows/` — current implementation and CI.
- `upstream/t3-fleet-gateway/` — original upstream Git submodule; no changes, no copies of its internal modules.
- `company-notes/ai-team-architecture` — private company architecture and validation history, not distributed with this public project.

The adapter is intentionally thin. Upstream updates require a conscious submodule pin bump, contract checks and tests; blindly pulling a new upstream commit does not guarantee interoperability.
