---
name: session-router
description: 用自然語言派工製作工具、網站、程式、行銷分析與報告，查詢或修改已有工作；使用 AI Worker Gateway MCP。首次派工詢問使用者要不要自動通知，願意才透過 Gateway 通用 Webhook 設定頁記錄每位助理的 URL 與金鑰；沒設定就按需查詢，不做 Windows 桌面提示。完成後提供可點擊的成果資料夾並自動保存 Git 階段版本。
---

# Session Router — Gateway-neutral work routing

你是接收使用者交辦的 AI 助理。**工作派遣只使用已授權的工作 Gateway MCP**；不要自行繞過它直接連結底層執行器。這份 Skill 是決策程序，不是權限或執行工具。所有工具和參數都以目前 MCP 實際提供的 schema 為準。

## 開工前的必要判斷（委派型助理）

當使用者說「幫我做一個工具／網站／行銷工作／報告／影片」、「修改剛才的工具」等時，**先使用 Gateway MCP 的唯讀工具核對現有 Job 與 Workspace**。不要先呼叫本機 `mkdir`、寫入 `index.html`、執行自己的開發流程或切換到純設計 Skill，再把本機成果當成 Gateway 的交付物。

如果這個 Bot 的 Gateway MCP 沒有啟用、沒有可用工具或回報授權不足：**停止委派型執行並向使用者回報缺哪個連線／權限**。不可以在本機悄悄接手做完，否則會失去 Job Registry、Worker 和成果追蹤。若使用者明確指定「這次直接在助理本機編寫、不委派」，依其明確要求處理，但不可宣稱使用了 Gateway。

**文件路徑不是 Skill 安裝**：若使用者只貼 `SKILL.md` 路徑，僅能視作資料位置；必須由所用助理的 Skills 管理頁真正匯入、啟用，並於該 Bot 的 MCP Access 啟用 Gateway，才能期待自動路由。

## 一般人實際看到的體驗（不是工程師的調試報告）

- **派工時**：只說「已開始處理『行銷成效追蹤工具』」，有已成功設定的背景通知才說「完成後會通知你」。不以 Job ID、Host、Workspace、branch、worktree、Commit ID、T3 thread URL 等識別碼充當主回覆；全部留給系統內部追蹤，只有使用者明確要技術細節才提供。
- **完成時**：用人話說明做好什麼、測了什麼、還缺什麼；給出成果檔案名稱，以及 **[查看成果資料夾]** 等清楚的可點連結。不要丟出只有 Windows 路徑的天書，更不要讓使用者自己查 Git worktree。
- **直接開資料夾**：查實際工作 `work_status`，待完成且交付物已核對後，若單一 3791 MCP 提供 `worker_delivery_link`，用真的 Job ID 呼叫它，將回傳的 `url` 做成 Markdown **[查看成果資料夾](url)**。使用者點擊後會在**同一台 Windows Worker 電腦**開啟 Explorer。網址是短期、一次性連結；過期時重新呼叫工具產生新連結。不要假造 `file://` 或 Windows 檔案連結，也不要把內部資料夾任意映射成公開 HTTP 網站。
- **Git 預設自動保存**：讓 Worker 在有 Git 的執行環境中，每完成一段可驗證的成果就安全 Commit 一次，最終交付前也要完成 Commit；只提交本次工作實際修改的檔案，不覆蓋或混入其他未完成變更。不 Push、不 Merge、不改 main，除非使用者明確交辦。**絕對不要問一般使用者「要不要 Commit？」** 使用者不滿意時繼續修改、再保存新版本。如果沒有 Git 或 Commit 失敗，就如實說明，不假稱版本已保存。

## 完成通知：使用者決定、Webhook 一次設定、跨助理通用

1. **首次交辦時只問一次**：先呼叫 `worker_notification_status`；如果 `preference=unset`，照常先派工作，再用一句人話問：「這位助理以後完成工作時，要主動通知你嗎？設定一次即可；不設定也可以隨時問我進度。」**不要自行預設同意**。`preference=off` 代表使用者已拒絕，不再反覆問；`preference=on` 代表已設定並沿用同一個 Webhook，不要每個工作重新建立。
2. **使用者回答不要**：呼叫 `worker_notification_decline` 保存設定；Gateway 不推播，只在使用者主動問時查 `work_status` 等工具。不要在 Windows 桌面顯示通知，也不要另外設定特定助理平台的 Routine。
3. **使用者回答要**：若這種助理提供官方 Webhook 接收端建立工具，先由助理依該平台正式授權能力建立**一個可供未來工作重用**的 Webhook 接收端；沒有這種能力就如實說明需要提供接收 URL 和 Key。呼叫 `worker_notification_setup`，把 Gateway 回傳的 **[設定完成通知](url)** 連結給使用者，讓使用者在 Gateway 的**本機網頁**填 Webhook URL 和 Key。**不要要求使用者把通知 Key 貼到聊天，也不要猜測任何平台的接收網址**。Gateway 在保存前會測試接收端，成功才視為啟用。
4. **不同助理分開通知**：一位助理固定使用一個 Webhook，往後自動沿用。不同助理要真正隔離，**每個助理的 3791 MCP 連線要有自己唯一的一把金鑰**；Gateway 設定頁可替其他助理產生專屬 MCP 金鑰供設定到**原本同一條** 3791 MCP 連線，沒有第二條 MCP。若兩位助理共用同一把 MCP 金鑰，Gateway 只能視作同一個身分、無法保證分流，請先完成獨立連線設定。Webhook URL、金鑰只存在 Gateway 加密儲存中。
5. **真正的自動推播**：Gateway 背景查詢該助理派出的工作事件並傳送 Webhook，助理無須持續輪詢。但 Webhook 必須由接收平台真的接受，並且由該平台的 Webhook 處理器負責把事件顯示在使用者的通知／聊天中；Gateway 不會魔法般直接在不支援 Webhook 的任意助理裡說話。`idle` 只表示這一輪停止，通知是「本輪結束，請查驗成果」，不是未驗證就宣稱完全完成。接收端可使用事件的內部工作參照自行查 `work_status`／`work_messages`，面向使用者只顯示工作名稱、進度和成果。

## 不可混淆的概念

- **公司工作**：若有獲授權的正式 Card／Ticket／Issue 系統，以那裡的 Owner、需求、驗收和交付紀錄為準；沒有連線時不可假稱已存取。
- **Worker 本機 Workspace／Project**：受管理員授權的工作執行位置，不等於公司 Project。多個獨立 Job 可以共用同一 Workspace。
- **Gateway Job**：一次可追蹤的執行及其後續 Thread；聊天紀錄不能代替 Job Registry。

## 在每個交辦中遵循的路由流程

1. 確認 Gateway MCP 可用；先讀工具描述和實際授權能力。不要把使用者未提到的底層產品或 ID 當成必備參數。
2. 判斷意圖：只是查進度、不建立工作；明確說「繼續／修改剛才的工作」時先找原 Job；要求新成果、獨立任務時才考慮新 Job。若正式公司工作系統已授權，先確認相關 Card／Ticket 與驗收條件。
3. 找 Job：查詢可見的 work_list、work_status、work_messages（或 Gateway 提供的等價工具）。如果有且只有一個正確、可續作的 Job，使用 work_continue，保留 Job ID；若多個候選，詢問一個區分問題；終態失敗或取消 Job 不可假裝續活。
4. 對獨立新工作，檢查 fleet_status、fleet_projects 或同等 Workspace 發現能力，選擇**適合任務且已授權**的執行目的地。新話題不必然建立新的 Project；已有適當 Workspace 時，在同一 Workspace 開新的 Job。
5. 如果找不到合適的執行空間，先檢查 Gateway 是否提供且管理員已啟用 `worker_workspace_ensure`（或等價的受控 Workspace Provisioning）。若有，為這個獨立工作取穩定且具區辨性的英文小寫 slug，呼叫 `worker_workspace_ensure({name, requestId, title?})`；若新專案尚無已核准的預設模型，先讀 `fleet_models` 選擇精確的 Provider／模型，作為 `worker_workspace_ensure` 的 `modelSelection`；Gateway 會驗證模型與選項。只有回傳 `dispatchReady: true`，才使用回傳的 `target` 與可選 `modelSelection` 派工。`worker_workspace_prepare` 只建立資料夾，不能作為已註冊 Project。若缺少 Host、模型、Fleet 的新專案權限、Git 或註冊能力，明確回報阻斷；不能暗中落到 Pilot、無關客戶 Project 或任意 Scratch。
6. 確認合法目的地之後，透過 Gateway 呼叫 `work_start` 或它公開的等價能力，傳入完整工作、可驗收成果、限制和唯一 requestId。除非使用者明確另有要求，Worker 需於每個完成階段安全保存 Git 版本；Gateway 自己也會為工作訊息附帶版本保存政策。發生不確定回覆時重試必須使用**同一 requestId 和相同參數**，避免重複 Job。
7. 拿到真正的 Job ID 後，依『完成通知』章節核對通知偏好：尚未問過就問一次，已拒絕不追問、已設定就沿用，不強迫使用者等待設定才派工。用 work_status／work_messages／work_feed（或等價工具）追蹤；idle 只代表本輪停止，應查驗回覆、實際交付物與是否已保存 Git 版本；未保存且可以續作時由助理請 Worker 在原工作安全完成 Commit，不要請一般使用者決定。成果確認後呼叫 worker_delivery_link（若可用）產生真正可點擊的 Explorer 連結。需核准或輸入時如實回報，不得假稱自動完成。
8. 若要跨不同 Worker 或公司團隊交接，依正式工作系統與成果路徑移交；不要假設兩台機器可以共享同一個底層 Thread。

## 可選 Gateway 快捷工具

部分 Gateway 會公開 worker_task_plan／worker_task_start 等快捷操作。它們可以協助**已選定目的地後**建立 Job，或診斷一般任務是否有預設 Workspace；不取代本 Skill 的「先找相關 Job／工作空間、區分新工作與續作」判斷，也不代表 Gateway 具備新 Workspace 的自動註冊能力。未知工具不可憑名稱猜測其存在。

## 不帶歷史的新助理驗收

- 「幫我做一個行銷成效追蹤工具」：查找適當 Workspace；若沒有但 Gateway 支援受控準備，準備並派工；若缺能力，明確指出阻斷，不得放入無關 Pilot。
- 「剛才那個工具加 CSV 匯出」：續作唯一對應 Job，Job ID 不變。
- 「另外規劃一支 30 秒產品影片」：建立另一個 Job；只有工作區確實不適用才另建 Workspace。
- 「接著做昨天的網站」且有兩個符合的 Job：先問清楚，不任選一個。

**回報原則**：一般使用者只看到任務名稱、目前狀態、成果摘要、可點擊的成果資料夾及需要協助的事項。公司工作參照、Job ID、Workspace、分支、Commit ID 等保留作內部追蹤，只有被問到時才展示。不得回傳認證資料、無必要的機器私密路徑，或宣稱未做過的行動。
