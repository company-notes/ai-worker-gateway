# Zero-context AI assistant acceptance: automatic task delegation

This is the actual product requirement: a **brand-new assistant with no access to prior chats, documentation, or local T3 details** must accept a natural-language request such as "I need a marketing analytics tool" and dispatch it through the **single** AI Worker Gateway MCP endpoint.

## One-time operator setup (not something every new assistant must know)

1. Start/keep the original T3 Fleet Gateway at port 3790 and the original T3 Background Service at 3773. The wrapper listens at 3791; do not uninstall any of these. The assistant connects **only to 3791**.
2. Provide one authorized route. The preferred new-workspace test is the new **opt-in local provisioning** (`AWG_WORKSPACE_ROOT` + `AWG_PROVISION_HOST` and a verified launch model when needed), where the Session Router can call `worker_workspace_ensure`, then the official `work_start`. Existing alternatives are:
   - **Persistent work:** create/register a dedicated T3 project in the original supported system, configure it as a Fleet alias such as `general-work`, check its model, Git/workspace mode and `allowWorkStart`, then set `AWG_GENERAL_PROJECT=general-work` in the wrapper's launch environment; or
   - **One-off scratch work:** configure an official, verified `hosts[].defaultProject` scratch alias with `workspaceMode: "scratch"` and pinned real T3 scratch project id. The upstream must support this capability. See [the official upstream instructions](https://github.com/boundsj/t3-fleet-gateway/blob/main/docs/configuration.md#no-named-project).
3. For a standard locally installed Windows Fleet Gateway, run the new `Install-WorkerGateway.ps1`, which internally creates and encrypts a host-scoped Fleet Operate grant. The assistant only sees one inbound `AWG_CLIENT_TOKEN` for port 3791; no user-visible second key. Do not copy internal tokens into a chat or the bot's MCP settings.
4. Re-run the Windows installer when internal grant policy changes; it owns the 3791 scheduled-task restart. It preserves existing 3790/3773 services and data.

Without local provisioning or a suitable existing destination the gateway must **refuse** arbitrary work rather than use an unrelated `pilot`, FileShare or ffl-mcp project. `worker_workspace_prepare` alone is **not** sufficient: it never registers a T3 Project.

## Blind test: install Session Router Skill, but no previous conversation

**OpenMausBot 特別前置檢查**：請先依 [OpenMausBot 設定指引](openmausbot-setup.md) 在 Bot Settings → Skills 真正開啟 Skill 並於 Tools → Access 啟用 Gateway。只傳送 `SKILL.md` Windows 檔案路徑給 Bot 不算安裝。第一個實際工作工具若是本機 `mkdir`、寫 `index.html`，即判定路由失敗，即使它做出的網站可以使用，也不算 Gateway 驗收通過。


Create a brand-new agent or fresh conversation. **Install and enable the published `session-router` Skill once**, plus exactly one MCP connection to `http://127.0.0.1:3791/mcp` using its inbound client bearer. Do **not** load the old private conversation, paste this guide as a prompt, configure the original 3790 MCP, or mention T3. The Skill supplies intent routing; tool descriptions and live status supply capabilities. The agent should work without remembering any previous chat.

### Scenario A — new unrelated marketing task

Say only:

> 幫我做一個行銷成效追蹤工具，可以匯入每週的活動數據、計算轉換率，最後給我一份能查看的成果。

Expected:
- Agent follows the Session Router Skill: discovers available Gateway tools, searches relevant Job/Workspace, and chooses new Job only when appropriate. `worker_task_plan` / `worker_task_start` are optional helpers, not a second routing authority.
- Routing chooses an existing related authorized workspace if present; if none exists, it calls `fleet_models` to choose an authorized model if no default is configured, then `worker_workspace_ensure` with a safe slug, unique requestId and optional exact `modelSelection`. Only when it returns `dispatchReady: true` should it use the returned `target` and `modelSelection` for `work_start`; **never** unrelated `pilot` merely because it is the only configured alias. An authorized general-work alias or verified scratch default remains an alternative.
- Agent starts one fresh job through the Gateway using `work_start` (or a safe exposed helper), with a new `requestId`, returns the real new Job ID and follows `work_status` / `work_messages`.
- Check the delivered files or report, not just an `idle` state. Missing upstream model, policy, authorization or workspace is a **failure**, not something the assistant may invent.

### Scenario A2 — 共用 MCP 的多助理 Webhook 分流

用同一個 MCP URL、同一個 3791 連線金鑰建立兩個新助理（模擬 GrokBot）。兩位助理各先問使用者是否要完成通知；同意後各自呼叫 `worker_notification_setup`，讓使用者在本機頁面填寫不同 Webhook 接收 URL／Key；接收端必須先通過測試事件。助理各使用對應的 `setupId` 呼叫 `worker_notification_pairing_status`，取得不同的私有 `notificationRouteId`，存入各自可持久設定。

在每次 `work_start`／`worker_task_start` 派工參數帶上正確 `notificationRouteId`，Gateway 記錄各 Job 的通知路由，移除額外參數再轉交原版 Fleet。兩個任務完成時，Webhook A 只收到 A 任務、Webhook B 只收到 B 任務。使用假 ID 或已停用 ID 派工必須**在呼叫原版 work_start 之前失敗**。沒有 ID 的派工不應自動通知任何助理。原工作 `work_continue` 仍保留已綁定的路由，不重新分配。

使用者說不要時 `worker_notification_decline` 返回一個停用路由識別碼供助理私下記錄，後續不反覆問、也不推播。不支援私有持久設定的助理可能需要重新配對，不可宣稱永遠記得。確認所有助理仍只用同一個 MCP 金鑰，完全不修改 T3/Fleet、也不依賴 Windows 桌面通知或特定 Bot Routine。

上述 GitHub CI 僅覆蓋模擬的 Fleet 和 Webhook；真實 GrokBot 跨聊天儲存識別碼、接收端真的回到其聊天室、Windows T3 路由及 Explorer 等需實機驗收。

### Scenario A3 — 本機成果路徑與 Explorer 優先交付

使用真正的原版 Fleet `work_status` 資料形狀（**直接的 structuredContent JobDetailView**），不能只以假的 `structuredContent.job` 測試。Worker 有 Git worktree 後，`worker_delivery_open` 應直接啟動受控 Windows Explorer，回傳正確的真實 `folderPath`、檔案和進度，不得因 `job.state !== idle` 而錯誤回報「尚未完成執行」。工作仍在運行時只說「可先查看目前檔案」，不能宣稱交付驗收完成。若使用者想自己點，`worker_delivery_link` 可以回傳實際 `folderPath` 及備用 localhost 點擊入口。若 Git Commit 狀態檢查失敗也不得阻止開啟已驗證的目錄。未知／不同專案／偽造 Job、錯誤工作分支仍必須拒絕開啟。

實機須驗收 Windows 排程登入環境的 `explorer.exe` 能否出現在使用者桌面，和舊版一次性 URL 的點擊備援；GitHub CI 的模擬 `openFolder` 不等同真正桌面驗收。

### Scenario B — continuation

Then say:

> 剛才那個工具再加上 CSV 匯出功能。

Expected: same Job ID / T3 thread; `work_continue`, not a second start. If several jobs match, assistant must ask which one.

### Scenario C — separate unrelated job

Then say:

> 另外幫我規劃一支 30 秒的產品介紹短影片，交付拍攝腳本和分鏡建議。

Expected: a **different Job ID**; it can reuse the authorized general execution workspace. Do not create a new T3 Project simply because the category is marketing versus video; a company Task/Card and T3 Project are different entities.

### Scenario D — ambiguous work and no default

Disable provisioning and any authorized default in a separate test instance, leaving only the Pilot alias. A new marketing job should yield a clear **blocked** result requiring operator-controlled workspace provisioning/registration, and must create **no upstream Job**. Repeat with a Pilot-only Token while provisioning is enabled: any T3 project created must not be declared dispatchReady or launched until the new project's Fleet permissions are explicitly granted. An assistant asked "繼續昨天那個工作" when several jobs match must clarify rather than randomly continue one.

## Pass / fail

A pass is *not* merely that the assistant can see `work_start`. The new assistant must autonomously discover the route, safely start a genuinely new unrelated job, preserve ID on follow-up, distinguish a separate new job, and verify work output **through 3791**. A blocked plan is safe but means full hands-off job dispatch **has not yet passed** on that machine.

The current pilot can provision a **new local Git-backed T3 Project** on one explicitly authorized host via the official installed CLI; this is not multi-backend provisioning, not a non-Git document/video workspace, and not company Card/Ticket creation. A Pilot-restricted Fleet token cannot dispatch new projects. An operator-fixed model cannot be overridden by the assistant; an assistant-proposed model is checked against the live Fleet catalog before any T3 Project registration. Windows live T3 CLI registration and actual worker output still need acceptance before claiming hands-off production readiness. We must not claim a full zero-touch company dispatcher until those are built and tested.

### Scenario M1 — First installation inherits T3 New threads model

給測試 Windows 帳戶建立 T3 預設設定 `userdata/settings.json`，包含 Provider、modelId 與 `options:[{id,value}]`，再在原版 Fleet `fleet_models` 模擬相同 Provider／模型及合法 effort 選項。新安裝器應在未修改 T3/Fleet 任何檔案的前提下複製設定；重新安裝不覆蓋，除非指定 `-UseT3DefaultModel`。派工到受管 Target 且未帶 modelSelection 時，自動帶入匯入的預設，明確指定則優先；Fleet Alias 則沿用自己的專案/Host 預設。沒有 T3 預設或可驗證模型時不能擅自挑 Sonnet；互動式首次安裝詢問，無互動環境不能卡住。CI 驗證檔案讀取／轉換／Gateway 派工與 Windows PowerShell Parser，但不能證明特定使用者 T3 Desktop 的設定檔路徑及模型供應商此刻一定存在，需實機驗收。
