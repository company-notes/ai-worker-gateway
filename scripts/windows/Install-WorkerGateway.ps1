#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$UpstreamTokenFile,
    [string]$GeneralProject,
    [string]$SkillInstallDirectory,
    [string]$WorkspaceRoot,
    [switch]$EnableProvisioning,
    [switch]$NoProvisioning,
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
$fleetRoot = Join-Path $env:LOCALAPPDATA 'T3FleetGateway'
$fleetCliPath = Join-Path $fleetRoot 'app\bin\t3-fleet-gateway.js'
$fleetConfigPath = Join-Path $fleetRoot 'config.json'
$fleetDataPath = Join-Path $fleetRoot 'data'
$grantInstaller = Join-Path $PSScriptRoot 'New-ManagedFleetGrant.ps1'

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
        enablesProvisioning = [bool]($EnableProvisioning -or $ProvisionHost)
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
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($NoAutoStart -and $null -ne $existingTask) {
    throw 'An autostart task already exists. Remove it with Uninstall-WorkerGateway.ps1 before switching to manual-only mode.'
}
if ($null -ne $existingTask) {
    $owned = @($existingTask.Actions | Where-Object { $_.Arguments -like '*Start-WorkerGateway.ps1*' }).Count -eq 1
    if (-not $owned) { throw 'A different Windows scheduled task already uses AIWorkerGateway; refusing to overwrite it.' }
}

# A single local host is selected automatically when it is already enrolled in
# the operator-owned Fleet installation. Multiple hosts are never guessed.
if (-not $ProvisionHost -and $null -ne $existing -and
    $null -ne $existing.PSObject.Properties['provision_host'] -and $existing.provision_host) {
    $ProvisionHost = [string]$existing.provision_host
}
if (-not $ProvisionHost -and (Test-Path -LiteralPath $fleetConfigPath -PathType Leaf)) {
    $localFleetConfig = Get-Content -LiteralPath $fleetConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $localHosts = @($localFleetConfig.hosts | Where-Object {
        $_.t3Url -eq 'http://127.0.0.1:3773' -or $_.t3Url -eq 'http://localhost:3773'
    })
    if ($localHosts.Count -eq 1) {
        $ProvisionHost = [string]$localHosts[0].id
    }
}
if ($EnableProvisioning -and $NoProvisioning) {
    throw 'Choose either EnableProvisioning or NoProvisioning, not both.'
}
$grantHost = $ProvisionHost


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

# Gateway-to-Fleet credentials are internal deployment details. Users only
# receive ONE client token for OpenMausBot at port 3791. The installer manages
# a separate host-scoped operate grant without printing it.
$managedFleetGrant = $false
$managedFleetClientId = $null
$previousManaged = $null -ne $existing -and
    $null -ne $existing.PSObject.Properties['managedFleetGrant'] -and
    $existing.managedFleetGrant -eq $true
if ($UpstreamTokenFile) {
    if (-not (Test-Path -LiteralPath $UpstreamTokenFile -PathType Leaf)) {
        throw 'UpstreamTokenFile does not exist.'
    }
    $rawToken = (Get-Content -LiteralPath $UpstreamTokenFile -Raw -Encoding UTF8).Trim()
    $upstreamSecret = ConvertTo-SecureString -String $rawToken -AsPlainText -Force
    $rawToken = $null
} elseif ($previousManaged -and (Test-Path -LiteralPath $upstreamSecretFile -PathType Leaf)) {
    $upstreamSecret = Read-Secret $upstreamSecretFile
    $managedFleetGrant = $true
    if ($null -ne $existing.PSObject.Properties['managedFleetHost'] -and
        $existing.managedFleetHost -ne $grantHost) {
        throw 'Managed Fleet grant belongs to a different host. Re-run with an explicitly reviewed Fleet configuration.'
    }
    if ($null -ne $existing.PSObject.Properties['managedFleetClientId']) {
        $managedFleetClientId = [string]$existing.managedFleetClientId
    }
} else {
    if (-not $grantHost) {
        throw 'Cannot determine one local Fleet host. The operator must first configure one authorized local host.'
    }
    if (-not (Test-Path -LiteralPath $fleetCliPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $fleetConfigPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $fleetDataPath -PathType Container)) {
        throw 'Existing local Fleet installation not found. Full clean-machine Fleet bootstrap is not yet supported by this installer.'
    }
    Write-Host ('Preparing one internal, host-scoped worker authorization for ' + $grantHost + ' (no extra token to copy).')
    $newGrant = & $grantInstaller -NodePath $node -FleetCliPath $fleetCliPath -HostId $grantHost -FleetConfigPath $fleetConfigPath -FleetDataDir $fleetDataPath
    $upstreamSecret = $newGrant.secret
    $managedFleetClientId = [string]$newGrant.clientId
    $managedFleetGrant = $true
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
# Existing installations are upgraded to a newly generated external token once
# because the old token may have been copied into diagnostic transcripts.
$rotateOnUpgrade = $null -ne $existing -and
    $null -eq $existing.PSObject.Properties['clientTokenVersion']
if ((Test-Path -LiteralPath $clientSecretFile -PathType Leaf) -and
    -not $RotateClientToken -and -not $rotateOnUpgrade) {
    $clientSecret = Read-Secret $clientSecretFile
} else {
    $freshToken = & $node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
    $clientSecret = ConvertTo-SecureString -String $freshToken -AsPlainText -Force
    $freshToken = $null
}
if ((Get-ClearText $clientSecret) -eq (Get-ClearText $upstreamSecret)) {
    throw 'The wrapper inbound token must differ from its upstream Fleet token.'
}

# Reinstallation safely stops ONLY this installer's owned scheduled task.
# Existing 3790/T3 services and other processes are left untouched.
if (Test-LoopbackPort 3791) {
    if ($null -eq $existingTask) {
        throw 'Port 3791 belongs to an unknown/manual process. Stop that process before the installer can safely restart its own task.'
    }
    Stop-ScheduledTask -TaskName $taskName
    for ($attempt = 0; $attempt -lt 30 -and (Test-LoopbackPort 3791); $attempt++) {
        Start-Sleep -Milliseconds 500
    }
    if (Test-LoopbackPort 3791) {
        throw 'The owned scheduled task was stopped but port 3791 remains occupied. Diagnose the unknown process before retrying.'
    }
}

Assert-PrivateFolder $stateRoot

$provisionEnabled = -not $NoProvisioning -and -not [string]::IsNullOrWhiteSpace($ProvisionHost)
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
    managedFleetHost = if ($managedFleetGrant) { $grantHost } else { $null }
    provision_model_selection = $provisionModelSelection
    managedFleetGrant = $managedFleetGrant
    managedFleetClientId = $managedFleetClientId
    clientTokenVersion = 2
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
if ($RotateClientToken -or $rotateOnUpgrade) {
    Write-Warning 'The one OpenMausBot MCP client key was rotated. Update local-3791 in OpenMausBot using Show-WorkerGatewayClientToken.ps1 -Clipboard.'
}
Write-Host 'Assistant MCP URL: http://127.0.0.1:3791/mcp'
Write-Host ('Session Router Skill package: ' + (Join-Path $exportFolder 'SKILL.md'))
if ($SkillInstallDirectory) {
    Write-Host ('Session Router Skill copied to: ' + $skillTargetFile)
} else {
    Write-Host 'Import/enable this Skill in the assistant UI; a file copy alone does not activate it in an unknown client.'
}
Write-Host 'Copy your ONE OpenMausBot MCP client token securely with:'
Write-Host ('  powershell -NoProfile -File "' + (Join-Path $PSScriptRoot 'Show-WorkerGatewayClientToken.ps1') + '" -Clipboard')
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
