# Retest on an existing Windows T3/Fleet installation (non-destructive)

**You do not need to uninstall T3 Code, T3 Desktop, or your existing T3 Fleet Gateway.** This facade is a separate Node.js process on loopback port **3791**, which sends authorized MCP calls to your existing Fleet Gateway on **3790**, still connected to T3 on **3773**.

These commands are for **PowerShell on the same Windows test machine**, not GitHub Actions. Use a dedicated Windows test account or sandbox; do not run high-risk autonomous coding against live customer data. Do not modify your existing T3/Fleet installations, service registrations, job ledger or configuration during this smoke test.

## A. Inspect the existing system (read-only)

Open a new PowerShell window:

```powershell
node --version
git --version
t3 service status
Test-NetConnection 127.0.0.1 -Port 3773
Test-NetConnection 127.0.0.1 -Port 3790
```

Both port checks should show `TcpTestSucceeded: True`. If either is false, diagnose the **existing** service first; do not uninstall/reinstall it. Keep your current OpenMausBot connection to `http://127.0.0.1:3790/mcp` unchanged.

Optional check using only your **already installed gateway code**, not the upstream submodule:

```powershell
$env:T3FG_CONFIG = Join-Path $env:LOCALAPPDATA 'T3FleetGateway\config.json'
$env:T3FG_DATA_DIR = Join-Path $env:LOCALAPPDATA 'T3FleetGateway\data'
Push-Location (Join-Path $env:LOCALAPPDATA 'T3FleetGateway\app')
try {
    node .\bin\t3-fleet-gateway.js doctor
} finally {
    Pop-Location
}
```

If your earlier installation uses different paths, use its actual paths instead. The CLI must be from the existing installed version; don't run a newer upstream CLI against the old database, because database migrations may be irreversible. `doctor` may perform standard internal maintenance; take a backup before a major upgrade or if the local installation is in doubt. **Do not** delete `~\.t3`, `config.json`, the Gateway data directory or any SQLite database.

## B. Download the new facade into a separate directory

```powershell
Set-Location $HOME
git clone --recurse-submodules https://github.com/company-notes/ai-worker-gateway.git
Set-Location .\ai-worker-gateway
npm run check
```

If you have cloned the repo already, use `git pull --ff-only` and `git submodule update --init --recursive` instead of cloning again. You need Node.js **22.16+** for the facade; a locally installed Fleet Gateway may have stricter Node requirements of its own. `npm run check` runs **local automated tests using a substitute upstream** and does not touch your running T3 jobs.

The pinned submodule is a read-only source checkout and is **not** automatically installed or started when this facade runs. Do not run its CLI on your old live data directory or replace your current service as part of this initial smoke test.

## C. Configure separate credentials (keep them private)

You need **two different tokens**:

- `AWG_CLIENT_TOKEN`: a new secret accepted only by the wrapper on port 3791;
- `AWG_UPSTREAM_TOKEN`: a separately issued *Fleet Gateway client bearer token*, authorized by the original service on port 3790. **This is not the T3 host pairing credential.**

Use your already installed Fleet Gateway CLI and operator-controlled config/data locations from step A. Its documented command, **if your installed version supports it**, is:

```powershell
Push-Location (Join-Path $env:LOCALAPPDATA 'T3FleetGateway\app')
try {
    node .\bin\t3-fleet-gateway.js clients token --name awg-local-test --access read --hosts my-pc --ttl 1d
} finally {
    Pop-Location
}
```

The CLI displays the upstream token **once**. Store it privately; do not paste it in issues, chat, Git or logs. Replace `my-pc` with your installed Gateway's actual test Host ID if it differs. If your installed build does not support `clients token`, **stop this step** and inspect its own CLI help; do not copy host credentials or manually modify the database. You may later issue a separate short-lived `operate` token and restrict the client to the exact pilot/test project (when supported), after read-only testing is complete.

In the PowerShell session in which you will run the new wrapper:

```powershell
$env:AWG_CLIENT_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$tokenSecure = Read-Host 'Paste the new Fleet client bearer token' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
try {
    $env:AWG_UPSTREAM_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
$env:AWG_UPSTREAM_MCP_URL = 'http://127.0.0.1:3790/mcp'
$env:AWG_LISTEN_HOST = '127.0.0.1'
$env:AWG_LISTEN_PORT = '3791'
Remove-Item Env:AWG_WORKSPACE_ROOT -ErrorAction SilentlyContinue
```

The prompt uses a non-echoing SecureString input and copies the value only into this process's environment for the test; environment variables are still accessible to processes with the same privilege boundary. Do not persist these values in your repo or paste them in reports. Do not screenshot token output. If other users can access the same Windows account, keep a separate low-privilege test profile.

## D. Run the wrapper side by side

In the **same** PowerShell window holding the `AWG_*` environment variables:

```powershell
Set-Location (Join-Path $HOME 'ai-worker-gateway')
npm start
```

Expected output includes `AI Worker Gateway listening on 127.0.0.1:3791`. Keep this window open for the smoke test. The original Gateway remains on port 3790 and T3 on 3773. `npm start` does **not** install a Windows service; Ctrl+C stops only this wrapper process.

In another PowerShell window, check the new listener (the second shell does not automatically inherit the secrets set in the first window):

```powershell
Test-NetConnection 127.0.0.1 -Port 3791
```

Then, with your client token supplied only to your local MCP client's bearer-header setting, connect to `http://127.0.0.1:3791/mcp`. If your client cannot supply a static bearer header, use an MCP client that can; do not disable authentication or expose port 3791 publicly.

## E. Test in safe user order

1. **Read-only tool catalog:** call `tools/list`. Verify upstream `fleet_status` and existing `work_*` tools appear **alongside** `worker_workspace_plan` and `worker_workspace_prepare`. If authentication fails, check the dedicated client/upstream tokens; do not reset the original gateway.
2. **Read the old jobs:** call `fleet_status`, `work_list`, `work_status` on an existing known test job. Confirm the same job ID and history show through the wrapper. Do not continue an old failed job.
3. **Optional folder test:** set an isolated existing `AWG_WORKSPACE_ROOT` **before starting** the wrapper and restart only the wrapper; call `worker_workspace_plan` and `worker_workspace_prepare` with a disposable lowercase name such as `awg-smoke`. The result must report `dispatchReady: false`: this creates a folder, **not** a T3 project or dispatch target.
4. **New job acceptance (separate, opt-in):** only after read-only calls succeed, obtain a **separate** `operate` upstream client grant limited to a disposable test project/host; configure it as `AWG_UPSTREAM_TOKEN` and restart only the wrapper. Ask your MCP client to create a fresh job with a new `requestId` in an already configured **test** project, read status/messages, and continue the **same** job. Observe T3 Desktop to learn whether any action still asks for approval. Do not rely on an old approved session. `auto` policy does not guarantee unattended completion.

## E2. Upgrade the existing 3791 connection from read-only to the Pilot Operate grant

If an upstream operator grant has **already been created**, do not mint another token unnecessarily and do not send that Fleet token to the 3791 MCP client. The two credentials are deliberately separate:

| Credential | Configured at | Purpose |
| --- | --- | --- |
| `AWG_CLIENT_TOKEN` | The bot's authorization header to **3791** and the wrapper's environment | Authenticate the bot to the local wrapper |
| `AWG_UPSTREAM_TOKEN` | The wrapper's environment only | Authenticate the wrapper to original Fleet Gateway **3790** |

To change the upstream grant **without changing the bot's 3791 connection**, return to the exact PowerShell window where `npm start` is running:

1. Press **Ctrl+C** to stop **only** the wrapper. Leave the original 3790/3773 services running.
2. Keep `AWG_CLIENT_TOKEN` unchanged; do not rerun the random token generator, or the existing bot connection will receive 401 until updated.
3. Set `AWG_UPSTREAM_TOKEN` to the new **Fleet client** Operate token, privately. If a temporary operator-controlled plaintext token file was created during the test, one local-only option is:

```powershell
$tokenFile = Join-Path $env:LOCALAPPDATA 'T3FleetGateway\omb-pilot-test-token.txt'
$env:AWG_UPSTREAM_TOKEN = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
npm start
```

Do not commit, paste, echo or upload the token. Check access to the temporary file and remove it once you have an appropriate secure way to restart/restore the secret. The current wrapper is an experimental process: secrets in environment variables and local files require care.

4. **Do not change the bot's MCP URL or inbound token.** It stays `http://127.0.0.1:3791/mcp` with the same `AWG_CLIENT_TOKEN`.
5. From the existing **3791** client, test `fleet_status`, a **new** `work_start` with a unique `requestId` in the authorized test project, then `work_status`, `work_messages` and `work_continue` on that exact new job ID. Confirm forbidden projects stay hidden and record whether T3 Desktop requests approval. Tests executed **directly on 3790** validate the upstream and its permissions but **do not** validate the wrapper's operate forwarding.

**Security:** All assistants sharing the same `AWG_CLIENT_TOKEN` use the same upstream grant. Replacing a read-only upstream token with an Operate token means the common 3791 entry point now has the scope of that Operate grant (currently only the allowed test project/host). This is a local pilot; multi-user identity/scoped grants must be implemented before public deployment.

## F. Stop / roll back

Press Ctrl+C in the wrapper's window and remove its temporary `AWG_*` environment variables from that shell if needed. Nothing in your old T3/Gateway processes has been replaced. If you minted a temporary Fleet client token, revoke that **specific test client** using the installed CLI's documented `clients revoke <id>`; leave all other clients and hosts alone.

Do **not** run historical `Install-T3FleetGateway.ps1` or a patching `Fix-T3FleetGateway.ps1` as part of this retest. The old installers are preserved in Git history, not in the current tree.

Known limits: the current facade is a loopback pilot with a single static inbound client identity and JSON-only MCP forwarding. Actual compatibility with your installed Fleet Gateway/T3/Windows and OpenMausBot authorization has **not yet been demonstrated**. Record the first failing tool/status without leaking token values, then fix the adapter or configuration rather than deleting working software.

## G. Zero-context new-assistant task routing (the main acceptance scenario)

Read the [full zero-context scenario](agent-zero-context-test.md). The key difference from the old token/proxy smoke test: the new assistant should be asked to do **real new work**, without earlier conversation history or knowing that T3 exists.

Before launching the wrapper, the operator must configure a suitable general execution destination once (e.g. `AWG_GENERAL_PROJECT=general-work`, where `general-work` is an authorized alias already registered with the Fleet Gateway; or the original gateway's verified scratch default). Do not point unrelated marketing tasks at `pilot` by convenience. Ensure that 3791's existing upstream client has Operate permission for that destination. The bot only receives the 3791 MCP URL and inbound token; no separate 3790 MCP is required.

In an empty assistant conversation, send **only**:

> 幫我做一個行銷成效追蹤工具，能匯入每週活動數據、算轉換率，最後給我一份可查看的成果。

Observe: `worker_task_plan` and `worker_task_start` visible/used, one fresh Fleet Job ID, authorized general host/workspace, `work_status` / `work_messages` progress, deliverable verified rather than just an idle status. Then say "幫我在剛才那個工具加上 CSV 匯出" and verify `work_continue` uses the same ID. Then order a separate product-video script and verify another Job ID. An unknown workspace must **not** silently use Pilot.

If the plan reports no general destination, **the acceptance has not passed**. It identifies the one-time operator configuration still missing; setting environment variables alone does not create or register a T3 project.
