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

## 通用 Webhook 完成通知（任何支援 Webhook 的助理）

1. **第一次交辦時詢問一次**：Bot 在成功派工後呼叫 `worker_notification_status`。若 `preference=unset`，問使用者「完成時要不要自動通知？」；若使用者說不要，呼叫 `worker_notification_decline` 保存偏好，以後不反覆詢問，沒有通知就由使用者自己查進度。
2. **使用者說要才設定**：Bot 若有正式能力建立自己平台的 Webhook 接收端，可代使用者建立一條持續可用的回呼網址；若平台沒有此能力，不能捏造網址。呼叫 `worker_notification_setup`，把回傳的本機設定連結交給使用者；在本機瀏覽器輸入 Webhook URL、金鑰（可選擇 Authorization Bearer 或 X-Webhook-Key 等標頭）。**這些機密資訊不經過 Bot 聊天**，Gateway 先送 `work.webhook_test`，接收端回覆 2xx 後才啟用並加密保存。只要已啟用，相同助理以後的工作沿用同一條 Webhook。
3. **多個助理要分流**：不同助理不得共用同一組 3791 MCP 金鑰，否則 Gateway 無法辨識來源。設定頁可替其他助理建立專用連線，會在瀏覽器**只顯示一次**新的 MCP 金鑰；把那一組填進該助理**既有同一個** `http://127.0.0.1:3791/mcp` 連線即可。沒有第二個 Gateway，也不需要告訴使用者 Job ID。
4. **Webhook 事件**：Gateway 在背景監控自己派出的工作，只把事件送到該助理的固定接收端。JSON 包含 `schema`、`deliveryId`、`event`（例如 `work.turn_finished`／`work.needs_input`／`work.failed`）、`assistant`、`task`、`jobId`、`state`、`occurredAt`、`message`。`jobId` 讓接收助理內部查詢詳細內容，不應呈現給一般使用者。接收端須自行處理重試去重（`X-AWG-Event-ID`）以及回到使用者聊天室／App 的通知；Gateway 不會繞過不同平台的 Webhook API。
5. **驗收**：結束聊天後讓 Worker 再完成一輪；接收端應收到一則 webhook。使用者在該助理上看到的應是「行銷工具這一輪已結束，請查看成果」，不是 Windows 桌面提示，也不能把 `idle` 當作已驗收成功。拒絕設定通知的助理不得收到事件。關閉 Windows 或 Gateway 時不能宣稱即時推播，恢復後會從持久事件位置繼續檢查。

通知可獨立於 OpenMausBot 使用；這份檔案僅以 OpenMausBot 作為示範助理。若某平台不支援 Webhook 接收，這個功能就必須坦白回報不可用，**不要轉而預設使用該平台 Routine 或 Windows 桌面提示**。

## 無歷史盲測

1. **配置驗證，不交辦工作**：確認 Bot 的 Skills 清單明確顯示 `session-router` 處於 On；確認 MCP 工具清單含 `worker_workspace_ensure`。如果任一缺失，不開始盲測。
2. **獨立新聊天**：不要再貼 `SKILL.md` 檔案路徑或解釋 T3。只說「幫我做一個行銷成效追蹤工具，可以匯入 CSV、計算點擊率、轉換率與 ROAS，附上使用說明。」
3. **第一個實際工作工具**應為 Gateway 的查詢（例如 `fleet_status`、`work_list` 或 `fleet_projects`），而**不是** `mkdir`、`write_file`、`index.html`、palette/design Skill。當沒有合法工作區，必須由 Session Router 使用 `worker_workspace_ensure`（前提是管理員已允許且模型合法）；正式建 Job 必須得到可查驗的 `work_start` Job ID。
4. **若 Pilot-only Fleet 權限阻斷新專案**，回報這項不足而不派工或本機替代；新的 Project 若註冊成功但未授權仍不得宣稱完成。
5. 有 Job 之後再要求加 CSV 匯出，確認使用同一 Job ID 的 `work_continue`。

「檔案存在」、「Bot 曾經讀過文件」、「另一個 Skill 顯示 Running」和「助理本地成功寫檔」都不等於 Router 驗收通過。若真正匯入／啟用 Skill、啟用 3791 MCP 後，仍未依此路由，記錄 Bot 的模型／引擎和呼叫紀錄，區分 Skill **未觸發**、工具**被遮蔽或無存取權**與**模型未遵從**三種問題。

重要：`http://127.0.0.1:3791/mcp` 只適用 OpenMausBot 與 3791 位在同台電腦的部署。若新 Bot 在雲端，雲端的 `127.0.0.1` 不是 Windows PC；需要另外規劃可信且受授權的遠端接入方式，不可把 3791 無驗證開放到公網。
