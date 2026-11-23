#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$UpstreamTokenFile,
    [string]$GeneralProject,
    [string]$SkillInstallDirectory,
    [string]$WorkspaceRoot,
    [switch]$EnableProvisioning,
    [string]$ProvisionHost,
    [string]$ProvisionModelInstance,
    [string]$ProvisionModel,
    [switch]$ForceSkillOverwrite,
    [switch]$RotateClientToken,
    [switch]$NoAutoStart,
    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $env:LOCALAPPDATA 'AIWorkerGateway'
$taskName = 'AIWorkerGateway'
$runner = Join-Path $repoRoot 'scripts\windows\Start-WorkerGateway.ps1'
$sourceSkill = Join-Path $repoRoot '.agents\skills\session-router\SKILL.md'
$settingsFile = Join-Path $stateRoot 'settings.json'
$upstreamSecretFile = Join-Path $stateRoot 'upstream-token.dpapi'
$clientSecretFile = Join-Path $stateRoot 'client-token.dpapi'

function Test-LoopbackPort([int]$port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(750)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Assert-PrivateFolder([string]$folder) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $args = @(
        $folder, '/inheritance:r', '/grant:r',
        ('*' + $sid + ':(OI)(CI)F'),
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F'
    )
    & icacls.exe @args | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot apply private Windows ACL to AIWorkerGateway state directory.' }
}

function Save-Secret([Security.SecureString]$secret, [string]$file) {
    if ($secret.Length -lt 24) { throw 'A bearer token must contain at least 24 characters.' }
    $cipher = ConvertFrom-SecureString -SecureString $secret
    [IO.File]::WriteAllText($file, $cipher, [Text.Encoding]::ASCII)
}

function Read-Secret([string]$file) {
    $cipher = [IO.File]::ReadAllText($file, [Text.Encoding]::ASCII)
    return ConvertTo-SecureString -String $cipher
}

function Get-ClearText([Security.SecureString]$secret) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'src\main.js') -PathType Leaf)) {
    throw 'AI Worker Gateway source is missing. Run the installer from a complete repository checkout.'
}
if (-not (Test-Path -LiteralPath $sourceSkill -PathType Leaf)) {
    throw 'Session Router Skill is missing from the repository checkout.'
}

if ($PlanOnly) {
    [pscustomobject]@{
        repository = $repoRoot
        settingsDirectory = $stateRoot
        startup = if ($NoAutoStart) { 'manual' } else { 'at-user-logon' }
        assistantMCP = 'http://127.0.0.1:3791/mcp'
        upstreamMCP = 'http://127.0.0.1:3790/mcp'
        skillSource = $sourceSkill
        changesUpstream = $false
        createsWorkspaceProject = $false
        enablesProvisioning = [bool]$EnableProvisioning
    }
    return
}

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    throw 'This installation script only supports Windows.'
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $node --version).Trim().TrimStart('v')
if ([version]$nodeVersion -lt [version]'22.16.0') {
    throw 'Node.js 22.16.0+ is required by the Worker Gateway.'
}
if (-not (Get-Command t3 -ErrorAction SilentlyContinue)) {
    throw 'T3 CLI was not found. Install/configure T3 Code before running this script.'
}
if (-not (Test-LoopbackPort 3773)) {
    throw 'T3 Background Service is not listening on 127.0.0.1:3773; start and diagnose T3 first.'
}
if (-not (Test-LoopbackPort 3790)) {
    throw 'Original T3 Fleet Gateway is not listening on 127.0.0.1:3790. This installer attaches to an existing upstream; it does not install or patch T3 Fleet Gateway.'
}
if (Test-LoopbackPort 3791) {
    throw 'Port 3791 is already in use. Stop the manual Worker Gateway process before registering its automatic startup; do not kill an unknown process.'
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($NoAutoStart -and $null -ne $existingTask) {
    throw 'An autostart task already exists. Remove it with Uninstall-WorkerGateway.ps1 before switching to manual-only mode.'
}
if ($null -ne $existingTask) {
    $owned = @($existingTask.Actions | Where-Object { $_.Arguments -like '*Start-WorkerGateway.ps1*' }).Count -eq 1
    if (-not $owned) { throw 'A different Windows scheduled task already uses AIWorkerGateway; refusing to overwrite it.' }
}

$existing = $null
if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
    $existing = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

if ($PSBoundParameters.ContainsKey('GeneralProject')) {
    if ($GeneralProject -and $GeneralProject -notmatch '^[a-zA-Z0-9._-]{1,64}$') {
        throw 'GeneralProject must be an exact, existing Fleet alias, not an arbitrary directory.'
    }
} elseif ($null -ne $existing -and $null -ne $existing.generalProject) {
    $GeneralProject = [string]$existing.generalProject
}

if ($PSBoundParameters.ContainsKey('WorkspaceRoot')) {
    if ($WorkspaceRoot -and -not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) {
        throw 'WorkspaceRoot must be an existing directory. This installer does not create or register T3 projects.'
    }
} elseif ($null -ne $existing -and $null -ne $existing.workspaceRoot) {
    $WorkspaceRoot = [string]$existing.workspaceRoot
}

if ($SkillInstallDirectory) {
    if (-not (Test-Path -LiteralPath $SkillInstallDirectory -PathType Container)) {
        throw 'SkillInstallDirectory must be the existing, confirmed Skills parent directory for the target assistant.'
    }
    $skillTargetFolder = Join-Path $SkillInstallDirectory 'session-router'
    $skillTargetFile = Join-Path $skillTargetFolder 'SKILL.md'
    if ((Test-Path -LiteralPath $skillTargetFile) -and -not $ForceSkillOverwrite) {
        $oldHash = (Get-FileHash -LiteralPath $skillTargetFile -Algorithm SHA256).Hash
        $newHash = (Get-FileHash -LiteralPath $sourceSkill -Algorithm SHA256).Hash
        if ($oldHash -ne $newHash) {
            throw 'Target skill already differs. Use ForceSkillOverwrite only after reviewing the target copy.'
        }
    }
}

if (-not $UpstreamTokenFile -and -not (Test-Path -LiteralPath $upstreamSecretFile -PathType Leaf)) {
    $upstreamSecret = Read-Host 'Paste an existing Fleet Gateway client bearer token for the wrapper (not the T3 pairing credential)' -AsSecureString
} elseif ($UpstreamTokenFile) {
    if (-not (Test-Path -LiteralPath $UpstreamTokenFile -PathType Leaf)) {
        throw 'UpstreamTokenFile does not exist.'
    }
    $rawToken = (Get-Content -LiteralPath $UpstreamTokenFile -Raw -Encoding UTF8).Trim()
    $upstreamSecret = ConvertTo-SecureString -String $rawToken -AsPlainText -Force
    $rawToken = $null
} else {
    $upstreamSecret = Read-Secret $upstreamSecretFile
}

if ($upstreamSecret.Length -lt 24) {
    throw 'Fleet Gateway client token must contain at least 24 characters.'
}

$upstreamClear = Get-ClearText $upstreamSecret
try {
    $request = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fleet_status","arguments":{}}}'
    $headers = @{ Authorization = 'Bearer ' + $upstreamClear; Accept = 'application/json' }
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3790/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body $request -TimeoutSec 15
    if ($null -ne $response.PSObject.Properties['error'] -or $null -eq $response.PSObject.Properties['result']) {
        throw 'Fleet bearer token is not authorized to call fleet_status.'
    }
    $result = $response.result
    if ($null -ne $result.PSObject.Properties['isError'] -and $result.isError -eq $true) {
        throw 'Fleet bearer token is not authorized to call fleet_status.'
    }
    if ($null -eq $result.PSObject.Properties['structuredContent'] -or -not $result.structuredContent) {
        throw 'Fleet status did not include structuredContent; verify installed upstream compatibility before installation.'
    }
    if ($GeneralProject) {
        $matching = @($response.result.structuredContent.projects | Where-Object { $_.alias -eq $GeneralProject -and $_.allowWorkStart -eq $true })
        if ($matching.Count -ne 1) {
            throw 'GeneralProject is not an exactly matching, visible, start-enabled Fleet alias.'
        }
    }
    $fleetStatus = $result.structuredContent
} finally {
    $upstreamClear = $null
}

$clientSecret = $null
if ((Test-Path -LiteralPath $clientSecretFile -PathType Leaf) -and -not $RotateClientToken) {
    $clientSecret = Read-Secret $clientSecretFile
} else {
    $freshToken = & $node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
    $clientSecret = ConvertTo-SecureString -String $freshToken -AsPlainText -Force
    $freshToken = $null
}
if ((Get-ClearText $clientSecret) -eq (Get-ClearText $upstreamSecret)) {
    throw 'The wrapper inbound token must differ from its upstream Fleet token.'
}

Assert-PrivateFolder $stateRoot

$provisionEnabled = $EnableProvisioning -or $PSBoundParameters.ContainsKey('ProvisionHost')
if (-not $provisionEnabled -and $null -ne $existing -and $null -ne $existing.PSObject.Properties['provision_host']) {
    $ProvisionHost = [string]$existing.provision_host
    $provisionEnabled = -not [string]::IsNullOrWhiteSpace($ProvisionHost)
}
if ($provisionEnabled) {
    if (-not $ProvisionHost) {
        $candidates = @($fleetStatus.hosts | Where-Object {
            $_.reachable -eq $true -and $_.discovery.enabled -eq $true -and $_.discovery.allowWorkStart -eq $true
        })
        if ($candidates.Count -ne 1) {
            throw 'EnableProvisioning requires exactly one authorized, reachable host with Fleet discovery and work_start enabled, or an explicit -ProvisionHost.'
        }
        $ProvisionHost = [string]$candidates[0].id
    }
    $hostMatch = @($fleetStatus.hosts | Where-Object {
        $_.id -eq $ProvisionHost -and $_.reachable -eq $true -and
        $_.discovery.enabled -eq $true -and $_.discovery.allowWorkStart -eq $true
    })
    if ($hostMatch.Count -ne 1) {
        throw 'ProvisionHost is not an authorized reachable Fleet host with discovery and work_start enabled.'
    }

    if (-not $WorkspaceRoot) {
        $WorkspaceRoot = Join-Path $stateRoot 'workspaces'
        Assert-PrivateFolder $WorkspaceRoot
    }
    if (-not (Test-Path -LiteralPath $WorkspaceRoot -PathType Container)) {
        throw 'Provisioning WorkspaceRoot must be an existing directory.'
    }
}

if ([bool]$ProvisionModelInstance -ne [bool]$ProvisionModel) {
    throw 'ProvisionModelInstance and ProvisionModel must both be given, or neither.'
}
$provisionModelSelection = $null
if ($ProvisionModelInstance -and $ProvisionModel) {
    $provisionModelSelection = @{
        instance_id = $ProvisionModelInstance
        model = $ProvisionModel
    }
} elseif ($null -ne $existing -and $null -ne $existing.PSObject.Properties['provision_model_selection']) {
    $provisionModelSelection = $existing.provision_model_selection
}

Save-Secret $upstreamSecret $upstreamSecretFile
Save-Secret $clientSecret $clientSecretFile

$settings = @{
    repoRoot = $repoRoot
    nodePath = $node
    listenPort = 3791
    listenHost = '127.0.0.1'
    upstreamURL = 'http://127.0.0.1:3790/mcp'
    generalProject = if ($GeneralProject) { $GeneralProject } else { $null }
    workspaceRoot = if ($WorkspaceRoot) { [IO.Path]::GetFullPath($WorkspaceRoot) } else { $null }
    provision_host = if ($provisionEnabled) { $ProvisionHost } else { $null }
    provision_model_selection = $provisionModelSelection
}
$encoded = $settings | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($settingsFile, $encoded, (New-Object Text.UTF8Encoding($false)))

$exportFolder = Join-Path $stateRoot 'skills\session-router'
New-Item -ItemType Directory -Force -Path $exportFolder | Out-Null
Copy-Item -LiteralPath $sourceSkill -Destination (Join-Path $exportFolder 'SKILL.md') -Force
if ($SkillInstallDirectory) {
    New-Item -ItemType Directory -Force -Path $skillTargetFolder | Out-Null
    if ((Test-Path -LiteralPath $skillTargetFile) -and $ForceSkillOverwrite) {
        Copy-Item -LiteralPath $skillTargetFile -Destination ($skillTargetFile + '.backup-' + (Get-Date -Format 'yyyyMMddHHmmss'))
    }
    Copy-Item -LiteralPath $sourceSkill -Destination $skillTargetFile -Force
}

if (-not $NoAutoStart) {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $powershellExe)) {
        $powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
    }
    $action = New-ScheduledTaskAction -Execute $powershellExe -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    $clientClear = Get-ClearText $clientSecret
    try {
        $healthy = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            try {
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3791/healthz' -Method Get -Headers @{ Authorization = 'Bearer ' + $clientClear } -TimeoutSec 2
                if ($health.healthy -eq $true) {
                    $healthy = $true
                    break
                }
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if (-not $healthy) {
            throw ('The Windows startup task registered, but authenticated health on 3791 did not succeed. Inspect ' + (Join-Path $stateRoot 'gateway.log'))
        }
    } finally {
        $clientClear = $null
    }
}

Write-Host 'AI Worker Gateway configuration installed without altering T3/Fleet source or data.'
Write-Host 'Assistant MCP URL: http://127.0.0.1:3791/mcp'
Write-Host ('Session Router Skill package: ' + (Join-Path $exportFolder 'SKILL.md'))
if ($SkillInstallDirectory) {
    Write-Host ('Session Router Skill copied to: ' + $skillTargetFile)
} else {
    Write-Host 'Import/enable this Skill in the assistant UI; a file copy alone does not activate it in an unknown client.'
}
Write-Host 'Show your wrapper client token locally with:'
Write-Host ('  powershell -NoProfile -File "' + (Join-Path $PSScriptRoot 'Show-WorkerGatewayClientToken.ps1') + '"')
if ($NoAutoStart) {
    Write-Host ('Start manually with: powershell -NoProfile -File "' + $runner + '"')
} else {
    Write-Host 'Automatic startup: Task Scheduler at YOUR Windows user logon (not before sign-in).'
}
if ($provisionEnabled) {
    Write-Host ('Worker-local T3 Project provisioning enabled for host: ' + $ProvisionHost)
    Write-Host ('Approved isolated Workspace root: ' + $WorkspaceRoot)
    if (-not $provisionModelSelection) {
        Write-Warning 'No provisioning model selected. A new T3 project without a default model cannot start a job until a model is configured.'
    }
    Write-Warning 'The Fleet client token must also have Operate and project visibility for NEW projects. A Pilot-only grant will block dispatch; this installer will not elevate it.'
} elseif (-not $GeneralProject) {
    Write-Warning 'No general-purpose Fleet alias or Worker Provisioning enabled. New unrelated work will be blocked until the operator configures a destination.'
}
