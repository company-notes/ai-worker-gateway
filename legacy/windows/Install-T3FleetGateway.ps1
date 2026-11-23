# T3 Fleet Gateway local-only bootstrap for Windows (PowerShell 5.1+)
# Fix: Windows ACL changes use icacls (not Set-Acl / SeSecurityPrivilege).
# Fix: T3 .cmd pairing runs through a PowerShell launcher for Node execFile().
# Wait for T3 server-runtime.json before t3 project add; no lock deletion or service restarts.
# Installs into %LOCALAPPDATA%\T3FleetGateway, sets a private NTFS ACL,
# pairs with the existing local T3 server, and starts at each user login.
# Does NOT publish an Internet endpoint or install cloudflared.
# Source: https://github.com/boundsj/t3-fleet-gateway

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Say([string]$Text) { Write-Host "[T3 Fleet] $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { throw $Text }
function Quote-PS([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Is-Listening([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch { return $false }
    finally { $client.Close() }
}
function Make-Private([string]$Path) {
    # Set-Acl may try to write the SACL on some Windows installations and fail with
    # SeSecurityPrivilege. icacls changes only the DACL and needs no administrator
    # privilege for directories owned by this Windows user.
    if (-not (Test-Path -LiteralPath $Path)) { Fail "Path does not exist: $Path" }
    $item = Get-Item -LiteralPath $Path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    if (-not (Test-Path -LiteralPath $icacls)) { Fail 'Windows icacls.exe not found.' }
    $suffix = if ($item.PSIsContainer) { ':(OI)(CI)F' } else { ':F' }
    $grants = @("*${sid}${suffix}", "*S-1-5-18${suffix}", "*S-1-5-32-544${suffix}")

    # Grant our user (and Windows SYSTEM / local Administrators) explicitly first,
    # then disable inheritance while REMOVING inherited entries. This doesn't
    # revoke the user's own permissions midway through the operation.
    $grantArgs = @($Path, '/grant:r') + $grants
    $output = @(& $icacls @grantArgs 2>&1)
    if ($LASTEXITCODE -ne 0) { Fail "icacls /grant:r failed for ${Path}: $($output -join ' ')" }
    $output = @(& $icacls $Path '/inheritance:r' 2>&1)
    if ($LASTEXITCODE -ne 0) { Fail "icacls /inheritance:r failed for ${Path}: $($output -join ' ')" }

    # A pre-existing explicit grant to another user/group must fail closed.
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { Fail "ACL inheritance is still enabled for $Path" }
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    foreach ($entry in $acl.Access) {
        if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        try { $actual = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { Fail "Unknown ACL trustee on ${Path}: $($entry.IdentityReference.Value)" }
        if ($actual -notin $allowed) {
            Fail "Refusing to use ${Path}: explicit ACL grant for $actual. Check the directory permissions."
        }
    }
}

try {
    Say 'Checking prerequisites...'
    $nodeCmd = Get-Command node.exe -ErrorAction Stop
    $npmCmd = Get-Command npm.cmd -ErrorAction Stop
    $t3Cmd = Get-Command t3 -ErrorAction Stop
    $nodeExe = $nodeCmd.Source
    $npmExe = $npmCmd.Source
    $t3Exe = $t3Cmd.Source
    $version = (& $nodeExe --version).Trim()
    if ($version -notmatch '^v(\d+)\.(\d+)\.(\d+)') { Fail "Unexpected Node version: $version" }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]
    $supported = ($major -eq 24 -and ($minor -gt 22 -or ($minor -eq 22 -and $patch -ge 3))) -or
                 ($major -eq 26 -and ($minor -gt 13 -or ($minor -eq 13 -and $patch -ge 1))) -or ($major -gt 26)
    if (-not $supported) { Fail "Node $version is unsupported. Need 24.22.3+ (24.x) or 26.13.1+." }
    Say "Node: $version; T3 command: $t3Exe"

    $base = Join-Path $env:LOCALAPPDATA 'T3FleetGateway'
    $app = Join-Path $base 'app'
    $data = Join-Path $base 'data'
    $config = Join-Path $base 'config.json'
    $pilot = Join-Path $base 'pilot'
    $probe = Join-Path $base 'root-probe.mjs'
    $mintScript = Join-Path $base 'Mint-T3PairingCode.ps1'
    $launcher = Join-Path $base 'Start-T3FleetGateway.ps1'
    $log = Join-Path $base 'gateway.log'
    $repoUrl = 'https://github.com/boundsj/t3-fleet-gateway/archive/refs/heads/main.zip'

    New-Item -ItemType Directory -Force -Path $base, $data, $pilot | Out-Null
    Make-Private $base
    Make-Private $data
    $pilotReadme = Join-Path $pilot 'README.md'
    if (-not (Test-Path -LiteralPath $pilotReadme)) {
        Set-Content -LiteralPath $pilotReadme -Encoding UTF8 -Value @('# Fleet Pilot', '', 'Local test workspace for T3 Fleet Gateway.')
    }

    if (-not (Test-Path -LiteralPath (Join-Path $app 'package.json'))) {
        Say 'Downloading Fleet Gateway source...'
        $temp = Join-Path $env:TEMP ('t3fg-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $temp | Out-Null
        try {
            $zip = Join-Path $temp 'source.zip'
            Invoke-WebRequest -Uri $repoUrl -OutFile $zip -UseBasicParsing
            Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
            $extracted = Join-Path $temp 't3-fleet-gateway-main'
            if (-not (Test-Path -LiteralPath (Join-Path $extracted 'package-lock.json'))) { Fail 'Unexpected GitHub archive contents.' }
            Move-Item -LiteralPath $extracted -Destination $app
        } finally {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        }
    } else {
        Say 'Fleet Gateway already downloaded; reusing existing installation.'
    }

    # The upstream secure-files check uses POSIX mode bits (0600/0700).
    # Native Windows stat.mode does not describe the real NTFS ACL. Supply
    # an NTFS ACL check instead; NEVER skip permission verification.
    $dataSource = Join-Path $app 'src\dataDir.ts'
    $source = [IO.File]::ReadAllText($dataSource)
    if (-not $source.Contains('T3FG_WINDOWS_NTFS_ACL_CHECK')) {
        Say 'Adapting upstream POSIX-only data-directory check to NTFS ACLs...'
        $oldImport = "import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';"
        if (-not $source.Contains($oldImport)) { Fail 'Gateway security source changed; refusing to patch an unknown version.' }
        $source = $source.Replace($oldImport, $oldImport + "`nimport { execFileSync } from 'node:child_process';")
        $needle = '  if ((stats.mode & 0o077) !== 0) {'
        if (-not $source.Contains($needle)) { Fail 'Gateway permission function changed; refusing to patch an unknown version.' }
        $compat = @'
  // T3FG_WINDOWS_NTFS_ACL_CHECK: require actual Windows NTFS ACL privacy.
  // POSIX mode bits do not represent Windows user/group permissions.
  if (process.platform === 'win32') {
    const path64 = Buffer.from(path, 'utf8').toString('base64');
    const check = [
      '$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + path64 + '"))',
      '$ErrorActionPreference = "Stop"',
      'if (-not (Test-Path -LiteralPath $target)) { exit 4 }',
      '$acl = Get-Acl -LiteralPath $target',
      '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      'foreach ($entry in $acl.Access) {',
      'if ($entry.AccessControlType -eq "Allow") {',
      'try { $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { exit 2 }',
      'if ($sid -ne $me -and $sid -ne "S-1-5-18" -and $sid -ne "S-1-5-32-544") { exit 3 }',
      '}',
      '}',
      'exit 0',
    ].join(';');
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(check, 'utf16le').toString('base64'),
      ], { stdio: 'pipe', windowsHide: true, timeout: 15000 });
    } catch {
      throw new GatewayError('data_dir_insecure', `${path} has unsafe Windows NTFS ACLs; re-run the installer.`);
    }
    return;
  }
'@
        $source = $source.Replace($needle, $compat + "`n" + $needle)
        [IO.File]::WriteAllText($dataSource, $source, (New-Object System.Text.UTF8Encoding($false)))
    }

    Say 'Installing npm dependencies...'
    Push-Location $app
    try {
        & $npmExe ci --omit=dev
        if ($LASTEXITCODE -ne 0) { Fail "npm ci failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }

    # The T3 CLI requires the active server-runtime.json record to call the
    # existing server. A TCP listener alone is NOT sufficient: during the
    # Windows service startup race, project add can fall back to direct SQLite
    # writes and hit ServerAlreadyRunningError. Never delete server-owner.sqlite.
    $t3Home = if ([string]::IsNullOrWhiteSpace($env:T3CODE_HOME)) {
        Join-Path $HOME '.t3'
    } else { $env:T3CODE_HOME }
    $t3RuntimeFile = Join-Path $t3Home 'userdata\server-runtime.json'

    # Fleet Gateway uses Node execFile(), which does NOT execute .cmd files on
    # Windows. Use an ordinary PowerShell wrapper to invoke T3's t3.cmd.
    $qT3 = Quote-PS $t3Exe
    $qT3Home = Quote-PS $t3Home
    $mintCode = @"
`$ErrorActionPreference = 'Stop'
& $qT3 auth pairing create --ttl 5m --label t3-fleet-gateway --json --base-dir $qT3Home
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
"@
    [IO.File]::WriteAllText($mintScript, $mintCode, (New-Object System.Text.UTF8Encoding($true)))
    Make-Private $mintScript
    $mintCommand = @('powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $mintScript)

    if (-not (Is-Listening 3773)) {
        Say 'T3 not listening on port 3773; installing/starting its background service...'
        & $t3Exe service install
        if ($LASTEXITCODE -ne 0) { Fail 'Could not install/start T3 background service.' }
    }

    Say 'Waiting for T3 HTTP server AND its runtime ownership record...'
    $readyState = $null
    for ($i = 0; $i -lt 45; $i++) {
        if (Test-Path -LiteralPath $t3RuntimeFile) {
            try {
                $candidate = Get-Content -LiteralPath $t3RuntimeFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
                if ($candidate -and $candidate.pid -and $candidate.port -and (Is-Listening ([int]$candidate.port))) {
                    $owner = Get-Process -Id ([int]$candidate.pid) -ErrorAction SilentlyContinue
                    if ($owner -and [int]$candidate.port -eq 3773) {
                        $readyState = $candidate
                        break
                    }
                }
            } catch { } # The file may be midway through an atomic replacement.
        }
        Start-Sleep -Seconds 1
    }
    if ($null -eq $readyState) {
        Say 'T3 service diagnostics:'
        & $t3Exe service status
        Fail "T3 is not fully ready: server-runtime.json was not valid at $t3RuntimeFile. The existing server and lock were NOT touched. Verify T3 status/logs and re-run this PS1."
    }
    Say "T3 ready (PID $($readyState.pid); port $($readyState.port))."

    Say 'Registering an isolated test project in T3 (without taking its database lock)...'
    $projectRegistered = $false
    $projectResult = @()
    # Pass the exact T3 home so the CLI looks at the same userdata as the
    # background service. Retry only the known startup/race condition.
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        $previousActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $projectResult = @(& $t3Exe project add $pilot --title 'Fleet Pilot' --base-dir $t3Home 2>&1 | ForEach-Object { "$_" })
            $projectExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousActionPreference }
        if ($projectExit -eq 0 -or (($projectResult -join ' ') -match 'already exists|active project already exists')) {
            $projectRegistered = $true
            break
        }
        if (($projectResult -join ' ') -notmatch 'ServerAlreadyRunningError|server already owns') { break }
        if ($attempt -lt 12) {
            Say "T3 is still finishing initialization; retrying ($attempt/12)..."
            Start-Sleep -Seconds 2
        }
    }
    if (-not $projectRegistered) {
        $lastErrorText = [string](($projectResult -join ' ') -replace '\s+', ' ')
        if ($lastErrorText.Length -gt 1500) { $lastErrorText = $lastErrorText.Substring(0, 1500) }
        Fail ('t3 project add could not connect to the running server. No locks or projects were deleted. Last error: ' + $lastErrorText)
    }

    # Non-Git test projects use T3 root workspace, not Git worktrees.
    # Gateway uses the canonical path and serializes jobs sharing that root.
    if (-not (Test-Path -LiteralPath $probe)) {
        $probeCode = @'
import { realpathSync, statSync } from 'node:fs';
let input = '';
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
const root = realpathSync(request.root);
if (!statSync(root).isDirectory()) process.exit(2);
process.stdout.write(JSON.stringify({ kind: 'root', root }) + '\n');
'@
        [IO.File]::WriteAllText($probe, $probeCode, (New-Object Text.UTF8Encoding($false)))
    }

    if (-not (Test-Path -LiteralPath $config)) {
        Say 'Creating local-only Gateway configuration...'
        $settings = [ordered]@{
            publicUrl = 'http://127.0.0.1:3790'
            listen = [ordered]@{ host='127.0.0.1'; port=3790 }
            hosts = @([ordered]@{
                id='my-pc'
                label='This Windows computer'
                t3Url='http://127.0.0.1:3773'
                mintPairingCode=$mintCommand
                access='approval-required'
                maxConcurrentJobs=2
                workspaceProbeCommand=@($nodeExe,$probe)
            })
            projects = @([ordered]@{
                alias='pilot'
                description='Local test project (no Git needed)'
                host='my-pc'
                t3ProjectTitle='Fleet Pilot'
                runtimeMode='approval-required'
            })
            watcher = @{ pollSeconds = 10; reconcileWindowMinutes = 10 }
            webhooks = @{ subscriptions = @() }
            dashboard = @{ enabled = $false }
        }
        $configJson = $settings | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($config, $configJson, (New-Object System.Text.UTF8Encoding($false)))
        Make-Private $config
    } else {
        Say 'Preserving existing Gateway config; fixing the T3 pairing launcher when needed.'
        $configState = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
        $hostEntry = @($configState.hosts | Where-Object { $_.id -eq 'my-pc' }) | Select-Object -First 1
        if ($null -eq $hostEntry) { Fail "Existing Gateway config has no host 'my-pc': $config" }
        $hostEntry.mintPairingCode = $mintCommand
        [IO.File]::WriteAllText($config, ($configState | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
    }
    Make-Private $config

    $env:T3FG_CONFIG = $config
    $env:T3FG_DATA_DIR = $data
    Say 'Enrolling local T3 server (no T3 Connect account required)...'
    Push-Location $app
    try {
        & $nodeExe bin/t3-fleet-gateway.js hosts enroll my-pc
        if ($LASTEXITCODE -ne 0) { Fail 'T3 pairing failed; check that your T3 CLI matches the running T3 server.' }
    } finally { Pop-Location }

    $qConfig = Quote-PS $config; $qData = Quote-PS $data
    $qApp = Quote-PS $app; $qNode = Quote-PS $nodeExe; $qLog = Quote-PS $log
    $startupScript = @"
`$ErrorActionPreference = 'Stop'
`$env:T3FG_CONFIG = $qConfig
`$env:T3FG_DATA_DIR = $qData
Set-Location -LiteralPath $qApp
& $qNode 'bin/t3-fleet-gateway.js' serve *> $qLog
"@
    [IO.File]::WriteAllText($launcher, $startupScript, (New-Object Text.UTF8Encoding($true)))

    # Create a per-user Startup shortcut. No administrator privileges needed.
    $startupFolder = [Environment]::GetFolderPath('Startup')
    $shortcutFile = Join-Path $startupFolder 'T3 Fleet Gateway.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcutFile)
    $link.TargetPath = (Join-Path $PSHOME 'powershell.exe')
    $link.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
    $link.WorkingDirectory = $app
    $link.WindowStyle = 7
    $link.Description = 'Start local-only T3 Fleet Gateway'
    $link.Save()

    if (-not (Is-Listening 3790)) {
        Say 'Starting Fleet Gateway in the background...'
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
            -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $launcher + '"')) `
            -WorkingDirectory $app -WindowStyle Hidden | Out-Null
        for ($i=0; $i -lt 22 -and -not (Is-Listening 3790); $i++) { Start-Sleep -Milliseconds 650 }
    }
    if (-not (Is-Listening 3790)) {
        $tail = if (Test-Path $log) { (Get-Content $log -Tail 25) -join "`n" } else { 'No gateway.log yet.' }
        Fail "Gateway did not start. Log: $log`n$tail"
    }

    Say 'Running Gateway diagnostics...'
    Push-Location $app
    try { & $nodeExe bin/t3-fleet-gateway.js doctor; $doctorExit = $LASTEXITCODE }
    finally { Pop-Location }

    Write-Host ''
    Write-Host '====================================================' -ForegroundColor Green
    Write-Host 'T3 Fleet Gateway local installation complete' -ForegroundColor Green
    Write-Host '====================================================' -ForegroundColor Green
    Write-Host "Gateway MCP : http://127.0.0.1:3790/mcp"
    Write-Host "T3 Server   : http://127.0.0.1:3773"
    Write-Host "Test project: $pilot"
    Write-Host "Config      : $config"
    Write-Host "Logs        : $log"
    Write-Host "Startup     : $shortcutFile"
    if ($doctorExit -ne 0) {
        Write-Warning 'doctor found one or more issues. Check the output above; most often the Fleet Pilot T3 project needs a default model selected.'
    }
    Write-Host ''
    Write-Host 'Local-only: Rakazo on VPS and hosted Grok Bot cannot reach localhost.' -ForegroundColor Yellow
    Write-Host 'Later, add a private/reachable HTTPS tunnel to port 3790 and update publicUrl.' -ForegroundColor Yellow
    Write-Host 'Do NOT expose T3 port 3773 or the private Gateway dashboard.' -ForegroundColor Yellow
} catch {
    Write-Host ''
    Write-Host ('INSTALL FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Your existing T3 installation was not removed or modified.' -ForegroundColor Yellow
    exit 1
}