# Shared Windows deployment helpers. The GUI-subsystem launcher and its
# process class use CREATE_NO_WINDOW instead of asking a console to hide itself.

function Initialize-WindowlessLauncher([string]$StateRoot) {
    $source = Join-Path $PSScriptRoot 'WindowlessLauncher.cs'
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $buildRoot = Join-Path (Join-Path $StateRoot 'launchers') $hash
    $launcherPath = Join-Path $buildRoot 'WindowlessLauncher.exe'
    if (Test-Path -LiteralPath $launcherPath -PathType Leaf) {
        return $launcherPath
    }

    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
        throw 'The Windows .NET Framework C# compiler is missing; cannot install windowless startup.'
    }

    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    $temporary = Join-Path $buildRoot ([guid]::NewGuid().ToString('N') + '.exe')
    try {
        $compilerOutput = & $compiler /nologo /target:winexe ('/out:' + $temporary) $source 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporary -PathType Leaf)) {
            throw ('Windowless launcher compilation failed: ' + ($compilerOutput | Out-String))
        }

        Move-Item -LiteralPath $temporary -Destination $launcherPath
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }

    return $launcherPath
}

function New-WindowlessTaskAction([string]$LauncherPath, [string]$RunnerPath, [string]$LogPath, [string[]]$RunnerArguments = @()) {
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @($powershellExe, $RunnerPath, $LogPath) + $RunnerArguments
    $quoted = @($arguments | ForEach-Object {
        if ($_ -match '["\r\n]' -or $_.EndsWith('\')) {
            throw 'Invalid argument for the Windows Gateway startup action.'
        }
        '"' + $_ + '"'
    })

    return New-ScheduledTaskAction -Execute $LauncherPath -Argument ($quoted -join ' ')
}

function Register-WindowlessGatewayTask([string]$TaskName, $Action) {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable

    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
}

function Move-LegacyFleetStartup([string]$FleetRoot, [string]$StartupFolder, [string]$NodePath, [string]$LauncherPath, [string]$TaskName = 'AIWorkerGateway-Fleet') {
    $shortcutPath = Join-Path $StartupFolder 'T3 Fleet Gateway.lnk'
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
        return
    }

    $legacyRunner = Join-Path $FleetRoot 'Start-T3FleetGateway.ps1'
    $app = Join-Path $FleetRoot 'app'
    $config = Join-Path $FleetRoot 'config.json'
    $data = Join-Path $FleetRoot 'data'
    $log = Join-Path $FleetRoot 'gateway.log'
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $legacyArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $legacyRunner + '"'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.TargetPath -ne $powershellExe -or $shortcut.Arguments -cne $legacyArguments -or $shortcut.WorkingDirectory -ne $app) {
        Write-Warning 'Fleet Startup shortcut is not the known legacy installation; leaving it unchanged.'
        return
    }

    # Match the generated legacy runner exactly before replacing its startup path.
    # A customized upstream configuration or launcher must remain operator-owned.
    if (-not (Test-Path -LiteralPath $legacyRunner -PathType Leaf)) {
        Write-Warning 'Fleet Startup runner is missing; leaving its shortcut unchanged.'
        return
    }

    $qConfig, $qData, $qApp, $qNode, $qLog = @($config, $data, $app, $NodePath, $log | ForEach-Object {
        "'" + $_.Replace("'", "''") + "'"
    })
    $expected = @(
        '$ErrorActionPreference = ''Stop'''
        ('$env:T3FG_CONFIG = ' + $qConfig)
        ('$env:T3FG_DATA_DIR = ' + $qData)
        ('Set-Location -LiteralPath ' + $qApp)
        ('& ' + $qNode + " 'bin/t3-fleet-gateway.js' serve *> " + $qLog)
    ) -join "`n"
    $actual = (Get-Content -LiteralPath $legacyRunner -Raw -Encoding UTF8).Replace("`r`n", "`n").Trim()
    if ($actual -cne $expected) {
        Write-Warning 'Fleet Startup runner differs from the known legacy script; leaving it unchanged.'
        return
    }

    $managedRunner = Join-Path $FleetRoot 'Start-ManagedFleetGateway.ps1'
    $runnerSource = Join-Path $PSScriptRoot 'Start-ManagedFleetGateway.ps1'
    if ((Test-Path -LiteralPath $managedRunner) -and
        (Get-FileHash -LiteralPath $managedRunner).Hash -ne (Get-FileHash -LiteralPath $runnerSource).Hash) {
        throw 'The Fleet background runner path is occupied by a different file.'
    }

    $action = New-WindowlessTaskAction -LauncherPath $LauncherPath -RunnerPath $managedRunner -LogPath (Join-Path $FleetRoot 'launcher.log') -RunnerArguments @($NodePath)
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        if (@($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ne $action.Execute -or
            $existing.Actions[0].Arguments -cne $action.Arguments) {
            throw 'The Fleet background task name is occupied by a different action.'
        }
    }

    Copy-Item -LiteralPath $runnerSource -Destination $managedRunner -Force
    if ($null -eq $existing) {
        Register-WindowlessGatewayTask -TaskName $TaskName -Action $action
    }

    try {
        Remove-Item -LiteralPath $shortcutPath -Force
    } catch {
        if ($null -eq $existing) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        throw
    }

    Write-Host 'Fleet startup migrated to a windowless task. The running 3790 service was preserved; the new action takes effect at the next Windows sign-in.'
}
