# Windows 安裝：Session Router Skill + 單一 Worker Gateway MCP

適用：Windows PowerShell 5.1+；T3 Code、Node.js 22.16+、Git，以及原版 T3 Fleet Gateway 已安裝且運行。

## 目標流程

1. clone ai-worker-gateway，執行 Install-WorkerGateway.ps1。
2. 安裝器檢查 T3（3773）與既有 Fleet Gateway（3790），驗證既有 Fleet Client Token，產生獨立的 3791 Client Token，以 Windows DPAPI 按使用者加密儲存。
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

安裝器會安全提示輸入你已產生的 Fleet Client Bearer Token（不是 T3 Pairing Credential）。若已有本機受保護的明文 Token 暫存檔，可選擇以 -UpstreamTokenFile 參數傳入其路徑，但安裝器不會自動刪掉原檔；驗證新服務正常後請自行清理。

原版 Fleet Token 必須授權實際執行目的地。只允許 Pilot 的 Token，不能當作一般行銷專案的通用權限。

已經在原版 Fleet 設定過正式、可派工的 general-work alias，才可以額外使用：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Install-WorkerGateway.ps1 -GeneralProject general-work

這個參數不會建立 T3 Project。沒有現有通用 Workspace 或原版已設定的 Scratch 預設時，新行銷任務應被 Skill／Gateway 安全阻擋，不能偷偷改派到無關 Pilot。Worker Workspace Provisioning 仍是後續核心工作。

## 匯入 Skill（只需一次）

匯入檔位置：

    %LOCALAPPDATA%\AIWorkerGateway\skills\session-router\SKILL.md

請在目標助理的 Skills 管理頁匯入／更新並啟用。未知第三方助理的 UI 無法由本腳本自動操作。若官方已知支援本機 Skills 父目錄，可在安裝時指定 -SkillInstallDirectory "完整路徑"；遇到已有不同內容的 Skill 預設拒絕覆寫。經確認才使用 -ForceSkillOverwrite 備份更新。

Skill 是路由決策程序，不是授權或執行器。

## MCP 設定

取得 3791 的 Client Token，只在本機觀看或用 -Clipboard 複製：

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Show-WorkerGatewayClientToken.ps1

助理只需要：

    MCP URL: http://127.0.0.1:3791/mcp
    Authorization: Bearer <3791 Client Token>

注意原版 Fleet 的 3790 Token 不能填進 3791 的 Client 欄位。127.0.0.1 只能由同台電腦的助理使用，雲端 Bot 需要另外規劃安全入口。

## 狀態、回退

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Get-WorkerGatewayStatus.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Uninstall-WorkerGateway.ps1

解除安裝預設只移除我們的登入自動啟動工作，保留本地加密設定與 Token。明確加 -DeleteLocalSecrets 才刪除自己的加密檔與設定；它不會撤銷原版 Fleet Client Token，也不會修改既有 T3/Fleet。Token 綁定目前 Windows 使用者，不能直接複製給別的使用者／電腦。必要時可用 -RotateClientToken 主動更換 3791 Token；之後須更新助理 MCP 設定。

## 目前仍未做到

這個初版腳本以「**已經有可用的原版 3790**」為前提；尚未做從全新電腦自動部署、配對及設定原版 Fleet 的完整流程，也未實作 Worker-local T3 Project 自動建立、第三方助理 Skills UI 自動啟用，或 Windows 登入前真正的 OS Service。Windows CI 目前只做腳本解析、無副作用 PlanOnly、DPAPI 測試；實機註冊排程、重開機登入驗證仍需在使用者測試機完成。

自然語言驗收詳見 agent-zero-context-test.md。
