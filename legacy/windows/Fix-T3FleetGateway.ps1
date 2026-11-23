#Requires -Version 5.1
<#
.SYNOPSIS
  Repair Fleet Gateway project models and local Pilot Git workspace after T3 pairing.
.DESCRIPTION
  No hardcoded T3 project UUID or host ID. Pilot is recognized by alias only
  to locate the known test folder from the installer; other aliases are supported
  only with an explicit workspace path.
  Uses Gateway's own `doctor` output to resolve each configured project alias
  to its actual T3 project ID, and reads T3's saved settings.json.
  Maintains model sync, safe Pilot Git workspace repair and the optional
  worker-wide runtime policy in one canonical script. The installer-created
  Pilot folder is created by Install-T3FleetGateway.ps1.
  Only the known installer-created Pilot folder is repaired automatically.
  Other aliases need an explicit -ProjectAlias and -ProjectPath; no unknown folder
  is silently initialized as Git. Never edits T3 desktop settings, starts T3,
  runs T3 pairing, removes T3 locks, or installs software.
  Safe to rerun: changes Gateway config only when a setting actually differs,
  backs it up before a write, and restarts ONLY the verified Gateway port owner.
  Optional unattended mode is explicitly opt-in; when the host's permission
  ceiling is too low, updates hosts[].access and re-enrolls its T3 credential.
  Does not redo Desktop pairing or change T3 desktop settings.
  Git repair uses only local Git operations; no network fetch or push.
.PARAMETER ProjectAlias
  Optionally repair one Gateway alias (e.g. pilot); omit to sync all local
  models and repair the installer-created pilot workspace.
.PARAMETER T3Home
  Override the local T3 home. Defaults to $env:T3CODE_HOME or ~/.t3.
.PARAMETER ProjectPath
  Explicit local Git workspace directory for a non-pilot project. Requires
  -ProjectAlias. If omitted, only the known installer Pilot folder is changed.
.PARAMETER RuntimeMode
  Keep (default) preserves the current permission mode. Explicitly choose
  auto for automatic review (some approvals may remain), or full-access for
  broadly unattended work (dangerous: commands run with local user rights).
  Requires -ProjectAlias OR -AllLocalProjects. Existing aliases default to approval-required.
  Other supported modes: approval-required, auto-accept-edits.
.PARAMETER AllLocalProjects
  Batch-apply RuntimeMode to all CONFIGURED project aliases on loopback T3 hosts.
  Explicit opt-in; full-access is intentionally rejected for bulk changes.
.PARAMETER EnableDiscoveredProjects
  Also enable hosts[].discovery for loopback hosts and set discovery.runtimeMode.
  Allows authorized Gateway clients to launch into T3 projects WITHOUT aliases.
  This broadens the launch surface; restrict client project grants and use
  dedicated low-privilege Workers. Does not change future configured aliases;
  alias-creation tooling must explicitly set runtimeMode.
  Requires -AllLocalProjects.
#>
param(
    [string]$ProjectAlias = '',
    [string]$T3Home = '',
    [string]$ProjectPath = '',
    [ValidateSet('keep','approval-required','auto-accept-edits','auto','full-access')]
    [string]$RuntimeMode = 'keep',
    [switch]$AllLocalProjects,
    [switch]$EnableDiscoveredProjects
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Info([string]$message) { Write-Host "[Fleet Repair] $message" -ForegroundColor Cyan }
function Fail([string]$message) { throw $message }

function Set-JsonProperty($Object, [string]$Name, $Value) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { $property.Value = $Value }
    else { $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value }
}

function Read-GitResult([string]$GitExe, [string]$Workspace, [string[]]$Arguments) {
    # PS 5.1 can promote expected native stderr into a terminating error under Stop.
    # A failed "git rev-parse" is data for these probes, not a script exception.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $GitExe -C $Workspace @Arguments 2>$null | ForEach-Object { [string]$_ })
        $status = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    return [PSCustomObject]@{ Lines = $lines; ExitCode = [int]$status }
}

function Repair-Workspace {
    param(
        $Project,
        $HostEntry,
        $GatewayConfig,
        [string]$Base,
        [string]$ExplicitPath
    )
    $alias = [string]$Project.alias
    $isInstallerPilot = ($alias -ceq 'pilot' -and [string]::IsNullOrWhiteSpace($ExplicitPath))
    if (-not $isInstallerPilot -and [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        Info "$alias : model sync only; workspace unchanged (no verified local folder)."
        return [PSCustomObject]@{ Checked = $false; Changed = $false; Ready = $false }
    }
    $workspace = if ($isInstallerPilot) { Join-Path $Base 'pilot' } else { $ExplicitPath }
    $root = [IO.Path]::GetFullPath($workspace).TrimEnd([char[]]@('\','/'))
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        Fail "Workspace directory missing: $root. No new project folder was created."
    }
    $readme = Join-Path $root 'README.md'
    if ($isInstallerPilot -and -not (Test-Path -LiteralPath $readme -PathType Leaf)) {
        Fail "The expected installer Pilot README is missing: $readme. Refusing to touch an unexpected folder."
    }

    # The probe is a HOST-wide setting. Do not remove it when another alias shares the host.
    $probeProperty = $HostEntry.PSObject.Properties['workspaceProbeCommand']
    if ($null -ne $probeProperty) {
        $siblings = @($GatewayConfig.projects | Where-Object {
            $_.host -ceq $Project.host -and $_.alias -cne $Project.alias
        })
        if ($siblings.Count -gt 0) {
            Fail "Host $($Project.host) has $($siblings.Count) other project alias(es). Its workspaceProbeCommand is host-wide; no changes made to this setting. Use a dedicated T3 host or migrate all its workspace policies together."
        }
    }

    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -eq $gitCommand) {
        Fail 'Git for Windows is required to repair a Pilot worktree. Install Git first; no Git changes were attempted.'
    }
    $git = $gitCommand.Source
    Info "Verifying $alias Git workspace: $root"
    $gitMarker = Join-Path $root '.git'
    if (-not (Test-Path -LiteralPath $gitMarker)) {
        # A folder inside ANOTHER repository must never get a new nested repository accidentally.
        $parentRepo = Read-GitResult $git $root @('rev-parse','--show-toplevel')
        if ($parentRepo.ExitCode -eq 0 -and $parentRepo.Lines.Count -gt 0) {
            Fail "Folder belongs to an existing parent Git repository: $($parentRepo.Lines[0]). Refusing nested git init at $root."
        }
        if (-not (Test-Path -LiteralPath $readme -PathType Leaf)) {
            Fail "Workspace has no Git history and no README.md: $root. Refusing to create an empty/unexpected repository."
        }
        Info "$alias : initializing a local Git repository on main (no remote or global Git config)."
        & $git -C $root init --initial-branch=main | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "git init failed in $root" }
    }

    $top = Read-GitResult $git $root @('rev-parse','--show-toplevel')
    if ($top.ExitCode -ne 0 -or $top.Lines.Count -ne 1) { Fail "Cannot identify Git repository at $root" }
    $topPath = [IO.Path]::GetFullPath(([string]$top.Lines[0]).Trim()).TrimEnd([char[]]@('\','/'))
    if ($topPath -ine $root) { Fail "Git root is $topPath, not $root. Refusing to change other folders." }

    $head = Read-GitResult $git $root @('rev-parse','--verify','--quiet','HEAD')
    if ($head.ExitCode -ne 0 -or $head.Lines.Count -eq 0) {
        if (-not (Test-Path -LiteralPath $readme -PathType Leaf)) {
            Fail "$alias has no Git commit and no README.md. Refusing to invent a commit or add unrelated files."
        }
        Info "$alias : creating one local initial README commit."
        & $git -C $root add -- README.md | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'git add README.md failed.' }
        # Override the author ONLY for this invocation, never the user's global Git identity.
        & $git -C $root -c 'user.name=Fleet Pilot' -c 'user.email=fleet-pilot@localhost.invalid' commit -m 'Initialize Fleet Pilot workspace' -- README.md | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'git commit README.md failed.' }
    }
    $branches = Read-GitResult $git $root @('symbolic-ref','--quiet','--short','HEAD')
    if ($branches.ExitCode -ne 0 -or $branches.Lines.Count -ne 1) {
        Fail "$alias repository is in detached HEAD; select a branch before running this fix."
    }
    $branch = ([string]$branches.Lines[0]).Trim()
    if ([string]::IsNullOrWhiteSpace($branch)) { Fail "Git branch is empty for $alias" }

    $changed = $false
    if ($null -ne $probeProperty) {
        $HostEntry.PSObject.Properties.Remove('workspaceProbeCommand')
        $changed = $true
        Info "$alias : disabled the Windows-incompatible root probe on this dedicated host."
    }
    $modeProperty = $Project.PSObject.Properties['workspaceMode']
    if ($null -eq $modeProperty -or [string]$modeProperty.Value -cne 'worktree') {
        Set-JsonProperty $Project 'workspaceMode' 'worktree'
        $changed = $true
    }
    $branchProperty = $Project.PSObject.Properties['baseRef']
    if ($null -eq $branchProperty -or [string]$branchProperty.Value -cne $branch) {
        Set-JsonProperty $Project 'baseRef' $branch
        $changed = $true
    }
    Info "$alias : Git checkout ready, branch $branch; worktree policy $($(if ($changed) { 'updated' } else { 'unchanged' }))."
    return [PSCustomObject]@{ Checked = $true; Changed = $changed; Ready = $true }
}

function Get-ListenerPid([int]$port) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($pids.Count -eq 0) { return $null }
    if ($pids.Count -gt 1) { Fail "Multiple processes own listener port $port; not stopping anything." }
    return [int]$pids[0]
}

function Test-GatewayProcess([int]$processId) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $false }
    return ($p.Name -ieq 'node.exe' -and $p.CommandLine -match 't3-fleet-gateway\.js' -and $p.CommandLine -match '(?:^|\s)serve(?:\s|$)')
}

function Wait-Gateway([int]$port, [int]$seconds = 16) {
    $count = [Math]::Max(1, [int]($seconds * 2))
    for ($i = 0; $i -lt $count; $i++) {
        if ($null -ne (Get-ListenerPid $port)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

try {
    if ($ProjectPath -and -not $ProjectAlias) { Fail '-ProjectPath requires -ProjectAlias so a folder cannot be assigned to the wrong project.' }
    if ($AllLocalProjects -and $ProjectAlias) {
        Fail '-AllLocalProjects and -ProjectAlias are mutually exclusive.'
    }
    if ($EnableDiscoveredProjects -and -not $AllLocalProjects) {
        Fail '-EnableDiscoveredProjects requires -AllLocalProjects.'
    }
    if ($AllLocalProjects -and $RuntimeMode -eq 'keep') {
        Fail '-AllLocalProjects requires an explicit -RuntimeMode.'
    }
    if ($AllLocalProjects -and $RuntimeMode -eq 'full-access') {
        Fail 'Bulk full-access is intentionally disabled. Use a dedicated sandbox and explicitly configure only the necessary projects.'
    }
    if ($RuntimeMode -ne 'keep' -and -not $ProjectAlias -and -not $AllLocalProjects) {
        Fail '-RuntimeMode requires -ProjectAlias or explicit -AllLocalProjects.'
    }
    if ($EnableDiscoveredProjects) {
        Write-Warning 'DISCOVERY: authorized Gateway clients may launch work in unaliased T3 projects on every loopback host. Review client project allowlists and OS isolation before using.'
    }
    $base = Join-Path $env:LOCALAPPDATA 'T3FleetGateway'
    $gwPath = if ([string]::IsNullOrWhiteSpace($env:T3FG_CONFIG)) {
        Join-Path $base 'config.json'
    } else { $env:T3FG_CONFIG }
    $gwData = if ([string]::IsNullOrWhiteSpace($env:T3FG_DATA_DIR)) {
        Join-Path $base 'data'
    } else { $env:T3FG_DATA_DIR }
    $app = Join-Path $base 'app'
    $gatewayJs = Join-Path $app 'bin\t3-fleet-gateway.js'
    $launcher = Join-Path $base 'Start-T3FleetGateway.ps1'

    if ([string]::IsNullOrWhiteSpace($T3Home)) {
        $T3Home = if ([string]::IsNullOrWhiteSpace($env:T3CODE_HOME)) {
            Join-Path $HOME '.t3'
        } else { $env:T3CODE_HOME }
    }
    $t3Path = Join-Path $T3Home 'userdata\settings.json'
    if (-not (Test-Path -LiteralPath $t3Path)) { Fail "T3 settings not found: $t3Path" }
    if (-not (Test-Path -LiteralPath $gwPath)) { Fail "Gateway config not found: $gwPath" }
    if (-not (Test-Path -LiteralPath $gatewayJs)) { Fail "Gateway program not found: $gatewayJs" }
    $node = (Get-Command node.exe -ErrorAction Stop).Source

    $t3 = Get-Content -LiteralPath $t3Path -Encoding UTF8 -Raw | ConvertFrom-Json
    $gw = Get-Content -LiteralPath $gwPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $env:T3FG_CONFIG = $gwPath
    $env:T3FG_DATA_DIR = $gwData

    # The Gateway is authoritative about which T3 project ID corresponds to
    # each configured alias, including entries identified by project title.
    Info 'Discovering actual T3 project IDs from Fleet Gateway...'
    $lines = @(& $node $gatewayJs doctor 2>&1 | ForEach-Object { [string]$_ })
    $projectIds = @{}
    foreach ($line in $lines) {
        if ($line -match '^\s*OK\s+project\s+(?<alias>[a-z0-9._-]+):\s+T3 project\s+(?<id>\S+)\s+on\s+(?<host>\S+)\s*$') {
            $projectIds["$($Matches['host'])/$($Matches['alias'])"] = $Matches['id']
        }
    }

    $changes = 0
    # Host access is an enrollment ceiling, not the project runtime mode. A
    # ceiling increase requires the gateway's own `hosts enroll` (NOT Desktop Pair).
    $permissionOrder = @('read-only','approval-required','auto-accept-edits','auto','full-access')
    $hostsToReenroll = @{}
    $checked = 0
    $workspacesReady = 0
    foreach ($project in @($gw.projects)) {
        if ($null -eq $project) { continue }
        if ($ProjectAlias -and $project.alias -ne $ProjectAlias) { continue }
        $targetHost = @($gw.hosts | Where-Object { $_.id -eq $project.host } | Select-Object -First 1)
        if ($targetHost.Count -eq 0) {
            Write-Warning "Skipping $($project.alias): no matching Gateway host."
            continue
        }
        # A local settings.json must never be used for a remote T3 host.
        $url = [Uri]([string]$targetHost[0].t3Url)
        if ($url.Host -notin @('127.0.0.1','localhost','::1')) {
            Info "Skipping $($project.alias): T3 host is remote ($($url.Host))."
            continue
        }
        $checked++
        # Operator opt-in: update one alias or ALL configured aliases on loopback hosts.
        # Host access is an enrollment ceiling, not an inherited default.
        if ($RuntimeMode -ne 'keep' -and ($ProjectAlias -or $AllLocalProjects)) {
            $oldModeProperty = $project.PSObject.Properties['runtimeMode']
            $oldMode = if ($null -ne $oldModeProperty -and $oldModeProperty.Value) {
                [string]$oldModeProperty.Value
            } else { 'approval-required' }
            if ($oldMode -cne $RuntimeMode) {
                Set-JsonProperty $project 'runtimeMode' $RuntimeMode
                $changes++
                Info "$($project.alias): runtime mode $oldMode -> $RuntimeMode."
            } else {
                Info "$($project.alias): runtime mode already $RuntimeMode."
            }
            $hostEntry = $targetHost[0]
            $accessProperty = $hostEntry.PSObject.Properties['access']
            $oldAccess = if ($null -ne $accessProperty -and $accessProperty.Value) {
                [string]$accessProperty.Value
            } else { 'auto' }
            $oldIndex = [Array]::IndexOf($permissionOrder, $oldAccess)
            $newIndex = [Array]::IndexOf($permissionOrder, $RuntimeMode)
            if ($oldIndex -lt 0 -or $newIndex -lt 0) {
                Fail "Unknown permission level: host=$oldAccess, project=$RuntimeMode"
            }
            if ($oldIndex -lt $newIndex) {
                Set-JsonProperty $hostEntry 'access' $RuntimeMode
                $hostsToReenroll[[string]$hostEntry.id] = $true
                $changes++
                Info "Host $($hostEntry.id): authorization ceiling $oldAccess -> $RuntimeMode; Gateway host re-enrollment required."
            } else {
                Info "Host $($hostEntry.id): authorization ceiling $oldAccess already permits $RuntimeMode."
            }
        }

        $key = "$($project.host)/$($project.alias)"
        $projectId = $projectIds[$key]
        if (-not $projectId) {
            $pinnedId = $project.PSObject.Properties['t3ProjectId']
            if ($null -ne $pinnedId -and $pinnedId.Value) { $projectId = [string]$pinnedId.Value }
        }
        if (-not $projectId) {
            Write-Warning "Skipping $($project.alias): could not resolve its T3 project ID. Check the Gateway doctor output."
            continue
        }

        # In batch mode do not change any model selection, Git working tree or
        # host workspace probe as a side effect of a permission-policy update.
        # Other projects may have non-Git workspaces; repairing them is a separate task.
        if ($AllLocalProjects) { continue }

        # Workspace repair follows the installer-created Pilot path only (or an
        # explicitly supplied -ProjectPath). The project ID above was discovered,
        # never hardcoded. Do this even if T3 has not saved a model yet.
        $repair = Repair-Workspace -Project $project -HostEntry $targetHost[0] `
            -GatewayConfig $gw -Base $base -ExplicitPath $ProjectPath
        if ($repair.Ready) { $workspacesReady++ }
        if ($repair.Changed) { $changes++ }

        # First the explicit project override; then the saved environment default.
        # Do NOT guess the automatically displayed T3 UI model when both are null.
        $model = $null
        $overrides = $t3.PSObject.Properties['projectSettingsOverrides']
        if ($null -ne $overrides -and $null -ne $overrides.Value) {
            $entry = $overrides.Value.PSObject.Properties[[string]$projectId]
            if ($null -ne $entry -and $null -ne $entry.Value) {
                $saved = $entry.Value.PSObject.Properties['defaultModelSelection']
                if ($null -ne $saved) { $model = $saved.Value }
            }
        }
        if ($null -eq $model) {
            $globalModel = $t3.PSObject.Properties['defaultModelSelection']
            if ($null -ne $globalModel) { $model = $globalModel.Value }
        }
        if ($null -eq $model -or
            [string]::IsNullOrWhiteSpace([string]$model.instanceId) -or
            [string]::IsNullOrWhiteSpace([string]$model.model)) {
            $existing = $project.PSObject.Properties['modelSelection']
            if ($null -ne $existing -and $null -ne $existing.Value) {
                Info "$($project.alias): no explicitly saved T3 model; preserving existing Gateway model."
            } else {
                Write-Warning "$($project.alias): no saved model. In T3 Settings > Threads, explicitly select a Model for this project."
            }
            continue
        }

        $existing = $project.PSObject.Properties['modelSelection']
        $oldJson = if ($null -ne $existing -and $null -ne $existing.Value) {
            $existing.Value | ConvertTo-Json -Depth 50 -Compress
        } else { '' }
        $newJson = $model | ConvertTo-Json -Depth 50 -Compress
        if ($oldJson -ceq $newJson) {
            Info "$($project.alias): already correct ($($model.instanceId) / $($model.model))."
        } else {
            $project | Add-Member -NotePropertyName modelSelection -NotePropertyValue $model -Force
            $changes++
            Info "$($project.alias): syncing $($model.instanceId) / $($model.model) (T3 project $projectId)."
        }
    }

    # Host discovery provides the one-time default for UNALIASED projects.
    # A newly configured alias continues to use projects[].runtimeMode and must
    # be assigned auto by the alias-creation flow (Gateway does not inherit it).
    $discoveryHosts = 0
    if ($AllLocalProjects -and $EnableDiscoveredProjects) {
        foreach ($hostEntry in @($gw.hosts)) {
            $hostUrl = [Uri]([string]$hostEntry.t3Url)
            if ($hostUrl.Host -notin @('127.0.0.1','localhost','::1')) { continue }
            $discoveryHosts++
            $accessProp = $hostEntry.PSObject.Properties['access']
            $oldAccess = if ($null -ne $accessProp -and $accessProp.Value) { [string]$accessProp.Value } else { 'auto' }
            $oldIndex = [Array]::IndexOf($permissionOrder, $oldAccess)
            $requestedIndex = [Array]::IndexOf($permissionOrder, $RuntimeMode)
            if ($oldIndex -lt 0 -or $requestedIndex -lt 0) { Fail "Unsupported host $($hostEntry.id) access level: $oldAccess" }
            if ($oldIndex -lt $requestedIndex) {
                Set-JsonProperty $hostEntry 'access' $RuntimeMode
                $hostsToReenroll[[string]$hostEntry.id] = $true
                $changes++
                Info "Host $($hostEntry.id): increased ceiling $oldAccess -> $RuntimeMode for discovered projects."
            }
            $discoveryProp = $hostEntry.PSObject.Properties['discovery']
            if ($null -eq $discoveryProp -or $null -eq $discoveryProp.Value) {
                $d = [PSCustomObject]@{}
                Set-JsonProperty $hostEntry 'discovery' $d
                $changes++
            } else { $d = $discoveryProp.Value }
            foreach ($setting in @(
                [PSCustomObject]@{ Name = 'enabled'; Value = $true },
                [PSCustomObject]@{ Name = 'allowWorkStart'; Value = $true },
                [PSCustomObject]@{ Name = 'runtimeMode'; Value = $RuntimeMode }
            )) {
                $prop = $d.PSObject.Properties[$setting.Name]
                if ($null -eq $prop -or $prop.Value -cne $setting.Value) {
                    Set-JsonProperty $d $setting.Name $setting.Value
                    $changes++
                    Info "Host $($hostEntry.id): discovery.$($setting.Name) -> $($setting.Value)"
                }
            }
        }
    }

    if ($ProjectAlias -and $checked -eq 0) { Fail "No configured local project found with alias '$ProjectAlias'." }
    if ($checked -eq 0 -and $discoveryHosts -eq 0) { Fail 'No configured local Gateway projects or discovery-capable loopback hosts found.' }

    $listenPort = if ($null -ne $gw.listen -and $null -ne $gw.listen.port) {
        [int]$gw.listen.port
    } else { 3790 }

    if ($changes -gt 0) {
        # Back up before replacing. The temporary file inherits the private ACL.
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$gwPath.bak-$stamp"
        $temp = "$gwPath.tmp-$([guid]::NewGuid().ToString('N'))"
        $json = $gw | ConvertTo-Json -Depth 80
        try {
            [IO.File]::WriteAllText($temp, $json + "`r`n", (New-Object Text.UTF8Encoding($false)))
            [IO.File]::Replace($temp, $gwPath, $backup)
        } finally {
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
        }
        Info "Gateway configuration updated ($changes setting group(s)); backup: $backup"
    } else {
        Info 'No Gateway configuration changes needed.'
    }

    # Run enrollment only AFTER the new config is saved, because the CLI reads
    # hosts[].access from that config. The live service stays up until every
    # necessary enrollment has succeeded; the old credential is not revoked.
    if ($hostsToReenroll.Count -gt 0) {
        foreach ($hostId in @($hostsToReenroll.Keys)) {
            Info "Re-enrolling Gateway host $hostId with its new access ceiling..."
            $savedPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                $enrollOutput = @(& $node $gatewayJs hosts enroll $hostId 2>&1 | ForEach-Object { [string]$_ })
                $enrollCode = $LASTEXITCODE
            } finally { $ErrorActionPreference = $savedPreference }
            $enrollOutput | ForEach-Object { Write-Host $_ }
            if ($enrollCode -ne 0) {
                # The running Gateway still uses its original config, so leave
                # it undisturbed. Restore the changed config for a clean retry.
                if ($changes -gt 0 -and (Test-Path -LiteralPath $backup)) {
                    Copy-Item -LiteralPath $backup -Destination $gwPath -Force
                    Info 'Enrollment failed; restored previous Gateway config from backup.'
                }
                Fail "Gateway host enrollment failed for $hostId (exit $enrollCode). No Gateway restart was attempted."
            }
        }
    }

    $listenerPid = Get-ListenerPid $listenPort
    if ($changes -gt 0 -and $null -ne $listenerPid) {
        if (-not (Test-GatewayProcess $listenerPid)) {
            Fail "TCP port $listenPort belongs to PID $listenerPid, not a verified Fleet Gateway node process. Not stopping it."
        }
        Info "Restarting Fleet Gateway on port $listenPort (PID $listenerPid); T3 is untouched..."
        Stop-Process -Id $listenerPid -ErrorAction Stop
        for ($i = 0; $i -lt 30 -and $null -ne (Get-ListenerPid $listenPort); $i++) {
            Start-Sleep -Milliseconds 300
        }
        if ($null -ne (Get-ListenerPid $listenPort)) {
            Fail "Fleet Gateway port $listenPort did not close. Not starting a second process."
        }
        $listenerPid = $null
    }
    if ($null -eq $listenerPid) {
        if (-not (Test-Path -LiteralPath $launcher)) {
            Fail "Gateway is not running and startup launcher is missing: $launcher"
        }
        Info 'Starting local Fleet Gateway...'
        $powershellExe = Join-Path $PSHOME 'powershell.exe'
        Start-Process -FilePath $powershellExe -ArgumentList @(
            '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
            '-File', ('"' + $launcher + '"')
        ) -WorkingDirectory $app -WindowStyle Hidden | Out-Null
        if (-not (Wait-Gateway $listenPort 16)) {
            Fail "Fleet Gateway did not start. Check: $base\gateway.log"
        }
    } else {
        Info "Gateway already running on port $listenPort; no restart needed."
    }

    if ($AllLocalProjects) {
        Info 'Batch policy update completed; project models and workspaces were left unchanged.'
        Info 'Gateway diagnostics next...'
    } else {
        Info "Workspace checks ready: $workspacesReady (Git validation); model sync + Gateway diagnostics next..."
    }
    if ($RuntimeMode -ne 'keep') {
        if ($AllLocalProjects) {
            Info "New jobs for $checked configured local alias(es) use $RuntimeMode; unaliased discovery on $discoveryHosts local host(s)."
            Info 'New aliases added later must explicitly be created with runtimeMode; Gateway does NOT inherit discovery mode for an alias.'
        } else {
            Info "New jobs for $ProjectAlias will use $RuntimeMode. Existing T3 threads keep their original runtime mode."
        }
        if ($RuntimeMode -eq 'full-access') {
            Write-Warning 'FULL ACCESS: AI commands can read or alter files outside the Git worktree under your Windows user account. Prefer a dedicated VM or restricted user for unattended work.'
        }
    }
    $doctor = @(& $node $gatewayJs doctor 2>&1 | ForEach-Object { [string]$_ })
    $doctor | ForEach-Object { Write-Host $_ }
    if (@($doctor | Where-Object { $_ -match '^FAIL\s' }).Count -gt 0) {
        Write-Warning 'Doctor reports FAIL checks. Inspect above before sending jobs.'
    } else {
        Write-Host ''
        Write-Host "READY: http://127.0.0.1:$listenPort/mcp" -ForegroundColor Green
        if ($AllLocalProjects) {
            Write-Warning 'Bulk permission update does not verify workspaces or models; test a NEW Job on each selected T3 project.'
        } elseif ($workspacesReady -gt 0) {
            Write-Host 'Workspace READY: new work_start jobs may use Git worktrees.' -ForegroundColor Green
            Write-Host 'Any earlier failed job is terminal; create a NEW job with a NEW requestId.'
        } else {
            Write-Warning 'No local workspace was verified. Model synchronization alone does not prove jobs can launch.'
        }
        Write-Host 'A probe_unverified WARN is informational; it does not block job launches.' 
    }
} catch {
    Write-Host "[Fleet Repair] FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}