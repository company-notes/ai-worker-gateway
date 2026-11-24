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

### Scenario A2 — 使用者自主選擇是否接收完成通知

在**未設定通知**的全新助理：派工開始後，Session Router 調用 `worker_notification_status` 看到 `unset`，問一次「完成時要不要主動通知？」。回答「不要」→ `worker_notification_decline` 保存偏好；完成工作時**不應收到任何自動推播**，下次派工也不再問。回答「要」→ `worker_notification_setup`，將一個短效設定頁交給使用者填 URL、Key，不把 Key 貼進聊天；Gateway 必須先向接收端發測試事件，只有收到成功回覆才保存啟用。重新派第二份工作，應自動重用原來的 Webhook，不需要重新問或重填。

多位助理測試：在設定頁為第二位助理建立一組新的 3791 MCP 金鑰（不是第二條 MCP），同一位助理的工作只通知它自己的 Webhook。若兩個助理共用同一組金鑰，**不得聲稱能分辨它們**。停用其中一位助理的通知不能停止另一位。回呼必須由接收助理實際呈現在自己的聊天／通知中；沒有接收端能力時不得假裝可以跨平台送訊息。

助理交付文字只應有工作名稱、功能摘要、品質檢查和 **查看成果資料夾** 連結，不能在主回覆要求使用者理解或操作 Job ID／worktree／branch／Commit。透過 `worker_delivery_link` 的 `versionSaved` 檢查 Worker 是否真的 Commit；若不是，繼續**同一 Job**請 Worker 保存版本，而不是詢問使用者。點擊 3791 本機 capability 連結，必須打開 Explorer 中驗證過的真實工作資料夾，而不是 Git 根目錄或其他無關目錄。

這些都需要真實接收平台的 Webhook、Windows T3 和 Explorer 實機驗收；CI 只能驗證隔離的 HTTPS/localhost 測試服務、加密儲存及假 T3 狀態，不能證明 OpenMausBot 或任意其他助理平台已替使用者收到聊天通知。

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
