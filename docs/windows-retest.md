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

The CLI displays the upstream token **once**. Store it privately; do not paste it in issues, chat, Git or logs. If your installed build does not support `clients token`, **stop this step** and inspect its own CLI help; do not copy host credentials or manually modify the database. You may later issue a separate short-lived `operate` token and restrict the client to the exact pilot/test project (when supported), after read-only testing is complete.

In the PowerShell session in which you will run the new wrapper:

```powershell
$env:AWG_CLIENT_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
$env:AWG_UPSTREAM_TOKEN = Read-Host 'Paste the new Fleet client bearer token (input stays local)'
$env:AWG_UPSTREAM_MCP_URL = 'http://127.0.0.1:3790/mcp'
$env:AWG_LISTEN_HOST = '127.0.0.1'
$env:AWG_LISTEN_PORT = '3791'
Remove-Item Env:AWG_WORKSPACE_ROOT -ErrorAction SilentlyContinue
```

`Read-Host` does not write the secret to PowerShell command history, but it **does display the pasted input**. For a non-echoing prompt, use a secure secret-entry method compatible with your local PowerShell environment. Do not persist these values in your repo. If other users can access the same Windows account, keep a separate low-privilege test profile.

## D. Run the wrapper side by side

In the **same** PowerShell window holding the `AWG_*` environment variables:

```powershell
Set-Location (Join-Path $HOME 'ai-worker-gateway')
npm start
```

Expected output includes `AI Worker Gateway listening on 127.0.0.1:3791`. Keep this window open for the smoke test. The original Gateway remains on port 3790 and T3 on 3773. `npm start` does **not** install a Windows service; Ctrl+C stops only this wrapper process.

In another PowerShell window, check the new listener:

```powershell
Test-NetConnection 127.0.0.1 -Port 3791
```

Then, with your client token supplied only to your local MCP client's bearer-header setting, connect to `http://127.0.0.1:3791/mcp`. If your client cannot supply a static bearer header, use an MCP client that can; do not disable authentication or expose port 3791 publicly.

## E. Test in safe user order

1. **Read-only tool catalog:** call `tools/list`. Verify upstream `fleet_status` and existing `work_*` tools appear **alongside** `worker_workspace_plan` and `worker_workspace_prepare`. If authentication fails, check the dedicated client/upstream tokens; do not reset the original gateway.
2. **Read the old jobs:** call `fleet_status`, `work_list`, `work_status` on an existing known test job. Confirm the same job ID and history show through the wrapper. Do not continue an old failed job.
3. **Optional folder test:** set an isolated existing `AWG_WORKSPACE_ROOT` **before starting** the wrapper and restart only the wrapper; call `worker_workspace_plan` and `worker_workspace_prepare` with a disposable lowercase name such as `awg-smoke`. The result must report `dispatchReady: false`: this creates a folder, **not** a T3 project or dispatch target.
4. **New job acceptance (separate, opt-in):** only after read-only calls succeed, obtain a **separate** `operate` upstream client grant limited to a disposable test project/host; configure it as `AWG_UPSTREAM_TOKEN` and restart only the wrapper. Ask your MCP client to create a fresh job with a new `requestId` in an already configured **test** project, read status/messages, and continue the **same** job. Observe T3 Desktop to learn whether any action still asks for approval. Do not rely on an old approved session. `auto` policy does not guarantee unattended completion.

## F. Stop / roll back

Press Ctrl+C in the wrapper's window and remove its temporary `AWG_*` environment variables from that shell if needed. Nothing in your old T3/Gateway processes has been replaced. If you minted a temporary Fleet client token, revoke that **specific test client** using the installed CLI's documented `clients revoke <id>`; leave all other clients and hosts alone.

Do **not** run historical `Install-T3FleetGateway.ps1` or a patching `Fix-T3FleetGateway.ps1` as part of this retest. The old installers are preserved in Git history, not in the current tree.

Known limits: the current facade is a loopback pilot with a single static inbound client identity and JSON-only MCP forwarding. Actual compatibility with your installed Fleet Gateway/T3/Windows and OpenMausBot authorization has **not yet been demonstrated**. Record the first failing tool/status without leaking token values, then fix the adapter or configuration rather than deleting working software.
