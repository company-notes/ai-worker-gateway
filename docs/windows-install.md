# Windows 安裝：Session Router Skill + 單一 Worker Gateway MCP

適用：Windows PowerShell 5.1+；T3 Code、Node.js、Git，以及原版 T3 Fleet Gateway **已在這台 Windows 電腦安裝並運行**。目前此版本的安裝器會自動配置 3791 與其內部 Fleet Operate 授權，**尚不負責在完全乾淨的電腦安裝原版 3790**；此限制不能說成完整一鍵全新部署。

## 目標流程

1. clone ai-worker-gateway，執行 Install-WorkerGateway.ps1。
2. 安裝器檢查 T3（3773）與已存在的 Fleet Gateway（3790），透過本機已安裝的 Fleet CLI **自動建立僅限本機 Host 的內部 Operate Grant**，同時生成唯一需交給 OpenMausBot 的 **3791 Client Token**。兩層內部安全憑證使用 Windows DPAPI 保存；使用者不須看到或複製內部金鑰。
3. 安裝器在 Windows Task Scheduler 註冊低權限「使用者登入後自動啟動」3791，並匯出 Session Router Skill。
4. 在新助理 Skills UI 匯入、啟用 Skill；在 MCP 列表只設定 http://127.0.0.1:3791/mcp 與 3791 專用 Bearer Token。
5. 全新助理不用舊聊天紀錄，以一般自然語言交辦；Skill 負責判斷 Job 續作／新工作、檢查相關 Workspace、呼叫 Gateway。

這不是「Windows 尚未登入時」就執行的系統服務。T3 是使用者 Background Service，所以本地試行採用同使用者的登入觸發。3790 也必須有原本自己的自動啟動設定；本安裝器不改寫它。

## 一次安裝

先在原本執行 npm start 的視窗按 Ctrl+C，停止手動 3791。保留 3773 和 3790 運行，不用解除安裝。

在 clone 好的 Repository 根目錄：

    git pull --ff-only
    npm run check
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-WorkerGateway.ps1

**一般安裝不需再輸入另一把 Fleet Token。** 安裝器會使用本機受管理的 Fleet CLI，針對單一已授權 Host 建立 `operate` 存取（不選擇所有 Host），把內部憑證保存在目前 Windows 使用者的加密檔中。若曾經使用手動 Read/Pilot 專用內部憑證，第一次執行新版安裝器會自動取代它；之後重跑會重用自己管理的憑證。進階操作者仍可明確指定 `-UpstreamTokenFile`，但這不屬於標準流程。

新的內部授權只涵蓋選定 Host，但在該 Host 中允許派工到已核准的新 Project。它不會修改 Fleet Host 的 Discovery、Runtime Mode 或 Project 規則；那些仍是原版 Fleet 的獨立安全政策。

已經在原版 Fleet 設定過正式、可派工的 general-work alias，才可以額外使用：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-WorkerGateway.ps1 -GeneralProject general-work

這個參數不會建立 T3 Project。**新版安裝器會自動識別當前 T3 服務唯一的本機 Fleet Host 並啟用受控 Worker-local Provisioning**。只有主機不唯一時才需要明確指定 `-ProvisionHost`；也可以選擇指定其他專用根目錄。想明確鎖定 Host 或模型時可使用：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-WorkerGateway.ps1 -EnableProvisioning -ProvisionHost my-pc -ProvisionModelInstance "<fleet_models 的 providerInstanceId>" -ProvisionModel "<fleet_models 的 modelId>"

這會在目前 Windows 帳號的 `%LOCALAPPDATA%\AIWorkerGateway\workspaces` 下啟用專屬 Git 工作區根目錄、預設使用官方 `t3 project add` 註冊，然後再用 Fleet 的 `fleet_projects` 確認可派工；**不修改原版 Fleet Gateway 的原始碼或資料庫**。如已自行準備其他專用根目錄，可另加 `-WorkspaceRoot "已存在目錄"`。`-ProvisionModelInstance` 和 `-ProvisionModel` 是**可選**的管理員模型鎖定政策，兩者必須引用實際 `fleet_models` 所列的值。如果沒鎖定模型，Session Router 可以先查詢 `fleet_models`，把選定且驗證過的 `modelSelection` 隨 `worker_workspace_ensure` 傳入；這不需要每次修改安裝設定。若連一個合法模型都找不到，Gateway 必須拒絕執行。

**不再需要手動替 `omb-pilot-test` 升權。** 本機安裝器會建立自己的 Host 限定 Operate Grant，不更改原有 Pilot 測試 Client，也不改變其他 Bot 的授權。管理員應了解：持有 **3791 Client Token** 的本機助理，現在可執行此 Host 許可的工作；若不想讓某位 Bot 使用，請在那位 Bot 的 OpenMausBot MCP Access 關閉 `local-3791`。

若 3791 是由本安裝器的排程啟動，重跑安裝器會在完成安全檢查後**自行停止並重啟其擁有的排程**，不動原版 3790／3773。若有另一個未知程序佔用 3791，安裝器會拒絕接管，請先確認程序來源。

## OpenMausBot 的 Skill 啟用不可省略

**注意：曾經發生過「助理只看到 Skill 檔案路徑，便轉去自己執行 mkdir 和寫 HTML」的真實失敗案例。** 單純發送 `SKILL.md` 路徑或讓 Bot 讀過文字，不等於 Skills 已啟用。OpenMausBot 必須在個別 Bot 的 Skills 明確匯入全文／打開開關，並在 Bot Tools → Access → MCP servers 啟用 `local-3791`。專職派工 Bot 也建議在固定角色 Instructions 設為「先 Gateway 後執行、不可本機代做」；Skill 本身不是強制政策。

詳見 [OpenMausBot 安裝與不帶歷史的第一工具驗收](openmausbot-setup.md)。

## 匯入 Skill（只需一次）

匯入檔位置：

    %LOCALAPPDATA%\AIWorkerGateway\skills\session-router\SKILL.md

請在目標助理的 Skills 管理頁匯入／更新並啟用。未知第三方助理的 UI 無法由本腳本自動操作。若官方已知支援本機 Skills 父目錄，可在安裝時指定 -SkillInstallDirectory "完整路徑"；遇到已有不同內容的 Skill 預設拒絕覆寫。經確認才使用 -ForceSkillOverwrite 備份更新。

Skill 是路由決策程序，不是授權或執行器。

## MCP 設定

**OpenMausBot 唯一需要填的金鑰**就是 3791 Client Token。首次更新新版安裝器會主動輪替舊版 3791 Token（既有 Token 曾可能被貼到聊天），因此請在本機複製新 Token 到 MCP 設定的秘密欄位：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Show-WorkerGatewayClientToken.ps1 -Clipboard

助理只需要：

    MCP URL: http://127.0.0.1:3791/mcp
    Authorization: Bearer <3791 Client Token>

使用者不必看到或填寫 3790 的任何 Token。`127.0.0.1` 只供同台電腦上的助理連線；雲端 Bot 需要另外規劃安全入口。**絕不要把 MCP Token 貼進對話、Issue 或截圖。**

## 狀態、回退

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Get-WorkerGatewayStatus.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Uninstall-WorkerGateway.ps1

解除安裝預設只移除我們的登入自動啟動工作，保留本地加密設定與 Token。明確加 -DeleteLocalSecrets 才刪除自己的加密檔與設定；它不會撤銷原版 Fleet Client Token，也不會修改既有 T3/Fleet。Token 綁定目前 Windows 使用者，不能直接複製給別的使用者／電腦。必要時可用 -RotateClientToken 主動更換 3791 Token；之後須更新助理 MCP 設定。

## 目前仍未做到

這個初版腳本以「**已經有可用的原版 3790**」為前提；尚未做從全新電腦自動部署、配對及設定原版 Fleet 的完整流程、非 Git 執行工作區、第三方助理 Skills UI 自動啟用，或 Windows 登入前真正的 OS Service。**受控本機 T3 Git Project Provisioning 與本機 Fleet 內部 Operate Grant 自動配置已加入程式碼，仍須在真實 Windows + T3 + Fleet 實際驗收。完全乾淨的 Windows 電腦自動安裝原版 Fleet 尚未完成，不可宣稱一條指令可從只有 T3/Node 自動部署完整的 3790/3791。**Windows CI 目前只做腳本解析、無副作用 PlanOnly、DPAPI 測試；實機註冊排程、重開機登入驗證仍需在使用者測試機完成。

自然語言驗收詳見 agent-zero-context-test.md。
