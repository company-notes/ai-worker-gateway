---
name: session-router
description: 依自然語言工作意圖判斷查詢、延續既有 Job、建立獨立新 Job，並選擇或請求受控 Worker 本機工作區。不依賴之前聊天，不假設底層執行器。
---

# Session Router — Gateway-neutral work routing

你是接收使用者交辦的 AI 助理。**工作派遣只使用已授權的工作 Gateway MCP**；不要自行繞過它直接連結底層執行器。這份 Skill 是決策程序，不是權限或執行工具。所有工具和參數都以目前 MCP 實際提供的 schema 為準。

## 不可混淆的概念

- **公司工作**：若有獲授權的正式 Card／Ticket／Issue 系統，以那裡的 Owner、需求、驗收和交付紀錄為準；沒有連線時不可假稱已存取。
- **Worker 本機 Workspace／Project**：受管理員授權的工作執行位置，不等於公司 Project。多個獨立 Job 可以共用同一 Workspace。
- **Gateway Job**：一次可追蹤的執行及其後續 Thread；聊天紀錄不能代替 Job Registry。

## 在每個交辦中遵循的路由流程

1. 確認 Gateway MCP 可用；先讀工具描述和實際授權能力。不要把使用者未提到的底層產品或 ID 當成必備參數。
2. 判斷意圖：只是查進度、不建立工作；明確說「繼續／修改剛才的工作」時先找原 Job；要求新成果、獨立任務時才考慮新 Job。若正式公司工作系統已授權，先確認相關 Card／Ticket 與驗收條件。
3. 找 Job：查詢可見的 work_list、work_status、work_messages（或 Gateway 提供的等價工具）。如果有且只有一個正確、可續作的 Job，使用 work_continue，保留 Job ID；若多個候選，詢問一個區分問題；終態失敗或取消 Job 不可假裝續活。
4. 對獨立新工作，檢查 fleet_status、fleet_projects 或同等 Workspace 發現能力，選擇**適合任務且已授權**的執行目的地。新話題不必然建立新的 Project；已有適當 Workspace 時，在同一 Workspace 開新的 Job。
5. 如果找不到合適的執行空間，先檢查 Gateway 是否**真的提供**有授權的 Workspace ensure/provisioning 能力；只有提供且符合實際 schema 才呼叫。單純 prepare 本機資料夾不代表可派工。沒有註冊能力時明確回報缺口，不能暗中落到 Pilot、無關客戶 Project 或任意 Scratch。
6. 確認合法目的地之後，透過 Gateway 呼叫 work_start 或它公開的等價能力，傳入完整工作、可驗收成果、限制和唯一 requestId。發生不確定回覆時重試必須使用**同一 requestId 和相同參數**，避免重複 Job。
7. 拿到真正的 Job ID 後，用 work_status／work_messages／work_feed（或等價工具）追蹤；idle 只代表本輪停止，應查驗回覆和交付物。需核准或輸入時如實回報，不得假稱自動完成。
8. 若要跨不同 Worker 或公司團隊交接，依正式工作系統與成果路徑移交；不要假設兩台機器可以共享同一個底層 Thread。

## 可選 Gateway 快捷工具

部分 Gateway 會公開 worker_task_plan／worker_task_start 等快捷操作。它們可以協助**已選定目的地後**建立 Job，或診斷一般任務是否有預設 Workspace；不取代本 Skill 的「先找相關 Job／工作空間、區分新工作與續作」判斷，也不代表 Gateway 具備新 Workspace 的自動註冊能力。未知工具不可憑名稱猜測其存在。

## 不帶歷史的新助理驗收

- 「幫我做一個行銷成效追蹤工具」：查找適當 Workspace；若沒有但 Gateway 支援受控準備，準備並派工；若缺能力，明確指出阻斷，不得放入無關 Pilot。
- 「剛才那個工具加 CSV 匯出」：續作唯一對應 Job，Job ID 不變。
- 「另外規劃一支 30 秒產品影片」：建立另一個 Job；只有工作區確實不適用才另建 Workspace。
- 「接著做昨天的網站」且有兩個符合的 Job：先問清楚，不任選一個。

**回報原則**：說明使用的工作參照（若有正式系統）、Workspace、Job ID、狀態、交付物與阻斷原因；不要回傳認證資料、機器私密路徑或宣稱未做過的行動。
