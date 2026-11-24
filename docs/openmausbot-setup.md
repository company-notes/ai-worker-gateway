# OpenMausBot 安裝：不要把 Session Router 的檔案路徑當成已啟用的 Skill

這一頁記錄 2026-11-24 真實使用情境的**失敗原因與驗收門檻**：新助理在收到行銷 CSV 工具任務後，執行 `mkdir marketing-tracker`、寫 `index.html`，沒有任何 `fleet_status`／`work_list`／`worker_workspace_ensure`／`work_start`。它讀過 `SKILL.md` 路徑、可能使用其他設計 Skill，都**不能**證明 `session-router` 有被啟用或採用。

OpenMausBot 的來源：[Skills](https://docs.openmausbot.com/docs/features/skills)、[MCP / Bot tool selection](https://github.com/milind-soni/OpenMausBot/blob/main/docs/custom-mcp-servers.md)。以本機當前安裝版 UI 為準。

## 必須完成的兩項真正安裝

1. 在 **OpenMausBot 的新 Bot → Bot Settings → Skills**，匯入 `session-router`，貼入整份 `SKILL.md` 內容（**不是**貼檔案路徑）。安裝器目前會把這份文字檔匯出到 `%LOCALAPPDATA%\AIWorkerGateway\skills\session-router\SKILL.md`；它不會代替 OpenMausBot 啟用 Skill。匯入後預設是關閉的，務必切換為 **On**，並確認新 Bot 可見。若使用共享 Skills Library，亦須將它指派並啟用給這位 Bot；同名的 Bot 專屬／Library Skill 可能遮蔽其他版本。
2. 在 **Bot Settings → Tools → Access → MCP servers** 選擇唯一的 `local-3791` Gateway。管理員在 OpenMausBot 全域設定的 MCP 連線不等於新 Bot 自動持有其工具權限。用 MCP Server 管理畫面 **Test** 核對返回工具（至少應看見 `fleet_status`、`work_list`、`worker_workspace_ensure` 與 `work_start`）。不要把 `3790` 設成第二個 Bot MCP。一般安裝**完全不需要使用者管理或看到上游 Fleet Token**。只有一把 3791 Client Token 需要在 OpenMausBot MCP 的金鑰欄位設定。

## 專職派工 Bot：固定角色指令（建議）

OpenMausBot 的 Skill 會按需求觸發，是「可用的程序」，**不是**能強制攔截所有行為的系統政策；若這位 Bot 的工作定位是「只派工，交給 T3 Worker 實做」，請在 **Bot Settings → Instructions** 增加：

> 你的角色是委派工作的 Session Router 前台，而不是直接執行程式開發的 Worker。接到新工具、程式、行銷分析、網站、報告等工作時，先遵循已啟用的 session-router Skill，查詢 local-3791 Gateway MCP 的現有 Job／Workspace；需要新執行空間時使用它的受控 provisioning 工具，只有拿到真正可派工的 target 後才呼叫 work_start。續作用 work_continue。不得在自己的工作目錄以 mkdir、檔案寫入或其他本地工具取代 Gateway 派工。若 Skill 或 3791 MCP 無法存取，停止並報告缺少的連線／權限，不要在本機偷偷完成，也不要宣稱已派工。

這是**給專職派工 Bot 的一次性角色設定**，不是每次使用者都要重述的聊天 Prompt。若使用者要一個可獨立在本機開發的混合型 Bot，這份固定角色指令不適用；不能只靠 Skill 保證它自動優先派工。也可依所用 AI 引擎的可用工具權限，減少本地寫檔／Shell 能力，但不能假設 OpenMausBot 所有引擎都支援同一種原生工具封鎖。

## 通用 Webhook 通知：同一條 MCP，按配對識別碼分流

這個機制**不依賴 MCP 連線是否專屬某位助理**。例如 GrokBot 所有助理共用同一條 3791 MCP 和同一把授權金鑰，也能設定不同通知接收端。

1. **使用者先決定**：第一次交辦前，助理查是否已有自己私下保存的 `notificationRouteId`；有的話呼叫 `worker_notification_status({notificationRouteId})`，沒有則使用 `worker_notification_status({})`。未配對時問一次「以後完成工作要不要主動通知？」。選「不要」呼叫 `worker_notification_decline({})`，把回傳的停用路由 ID 私下保存；以後不反覆問、不推播。不保存 ID 的助理不能保證下次聊天仍記得這個決定。
2. **配對 Webhook**：使用者同意才呼叫 `worker_notification_setup({})`；工具回傳 `url`（本機設定頁）及 `setupId`（此配對的短效識別碼）。只把設定頁連結給使用者，讓使用者在本機輸入 Webhook 接收 URL 和 Key，不能要求把 Key 貼到聊天；Gateway 先測試接收端成功回覆 2xx 才加密保存。接收平台必須真的支援接收 Webhook。
3. **把路由 ID 交回助理**：使用者完成網頁設定後，助理透過 `worker_notification_pairing_status({setupId})` 取回 `paired=true` 與高熵 `notificationRouteId`，並儲存在**助理自己可跨聊天使用的私有設定**中。不應在一般人可見的工作報告中顯示識別碼，也不能讓使用者在 MCP 設定裡手動輸入。
4. **每次派工指定要通知誰**：助理呼叫原本的 `work_start` 或 Gateway `worker_task_start`，把自己的 `notificationRouteId` 作為額外參數傳給 3791。Gateway 驗證後保存這項工作與 Webhook 的配對、**刪掉額外參數**再傳給原版 Fleet；後續通知按 Job 記錄分流，既有工作續作不必改路由。沒有 ID 時不發自動通知，不可以因所有助理共用 MCP 金鑰就猜某個預設通知目的地。
5. **驗收**：例如 Sage、Noodle 共用同一 MCP：讓二位助理各配自己的 Webhook，分別派工，兩個接收端應只收到自己的完成事件。停用 Sage 不應影響 Noodle；假的／停用 ID 必須在建立 Worker Job **之前**被拒絕。接收端需用 `X-AWG-Event-ID` 做去重。`idle` 代表一輪已停止，不一定等於成果已驗證。接收平台須有把 Webhook 傳回自己聊天的能力，不能把接收成功當作聊天已通知成功。

**安全界線**：`notificationRouteId` 是難以猜測的路由能力，而不是共用 MCP 上可信的助理身分；如果其他共用客戶端拿到這個 ID，可能冒用此路由。需將 ID 保存在助理的私有設定、避免在共享日誌或使用者文字中外露；若需求包含防止惡意助理互相冒用，還需額外的可信身分驗證。原版 T3／Fleet 不必修改。

## 無歷史盲測

1. **配置驗證，不交辦工作**：確認 Bot 的 Skills 清單明確顯示 `session-router` 處於 On；確認 MCP 工具清單含 `worker_workspace_ensure`。如果任一缺失，不開始盲測。
2. **獨立新聊天**：不要再貼 `SKILL.md` 檔案路徑或解釋 T3。只說「幫我做一個行銷成效追蹤工具，可以匯入 CSV、計算點擊率、轉換率與 ROAS，附上使用說明。」
3. **第一個實際工作工具**應為 Gateway 的查詢（例如 `fleet_status`、`work_list` 或 `fleet_projects`），而**不是** `mkdir`、`write_file`、`index.html`、palette/design Skill。當沒有合法工作區，必須由 Session Router 使用 `worker_workspace_ensure`（前提是管理員已允許且模型合法）；正式建 Job 必須得到可查驗的 `work_start` Job ID。
4. **若 Pilot-only Fleet 權限阻斷新專案**，回報這項不足而不派工或本機替代；新的 Project 若註冊成功但未授權仍不得宣稱完成。
5. 有 Job 之後再要求加 CSV 匯出，確認使用同一 Job ID 的 `work_continue`。

「檔案存在」、「Bot 曾經讀過文件」、「另一個 Skill 顯示 Running」和「助理本地成功寫檔」都不等於 Router 驗收通過。若真正匯入／啟用 Skill、啟用 3791 MCP 後，仍未依此路由，記錄 Bot 的模型／引擎和呼叫紀錄，區分 Skill **未觸發**、工具**被遮蔽或無存取權**與**模型未遵從**三種問題。

重要：`http://127.0.0.1:3791/mcp` 只適用 OpenMausBot 與 3791 位在同台電腦的部署。若新 Bot 在雲端，雲端的 `127.0.0.1` 不是 Windows PC；需要另外規劃可信且受授權的遠端接入方式，不可把 3791 無驗證開放到公網。
