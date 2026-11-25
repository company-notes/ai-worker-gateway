#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'WindowlessStartup.ps1')

# Exercise the actual legacy Startup shortcut, scheduler registration, shared
# launcher and real Node process with isolated substitute Fleet files.
$fixture = Join-Path $env:TEMP ('awg-fleet-migration-' + [guid]::NewGuid().ToString('N'))
$fleetRoot = Join-Path $fixture "Fleet's installation"
$startupFolder = Join-Path $fixture 'Startup'
$app = Join-Path $fleetRoot 'app'
$data = Join-Path $fleetRoot 'data'
$config = Join-Path $fleetRoot 'config.json'
$log = Join-Path $fleetRoot 'gateway.log'
$taskName = 'AWG-Test-' + [guid]::NewGuid().ToString('N')
$process = $null
$probeProcess = $null
$releaseFile = Join-Path $data 'release'
$pidFile = Join-Path $data 'pid.txt'

New-Item -ItemType Directory -Path @($startupFolder, (Join-Path $app 'bin'), $data) -Force | Out-Null
try {
    $launcher = Initialize-WindowlessLauncher -StateRoot $fixture
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $legacyRunner = Join-Path $fleetRoot 'Start-T3FleetGateway.ps1'
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $qConfig, $qData, $qApp, $qNode, $qLog = @($config, $data, $app, $node, $log | ForEach-Object {
        "'" + $_.Replace("'", "''") + "'"
    })
    $legacyScript = @(
        '$ErrorActionPreference = ''Stop'''
        ('$env:T3FG_CONFIG = ' + $qConfig)
        ('$env:T3FG_DATA_DIR = ' + $qData)
        ('Set-Location -LiteralPath ' + $qApp)
        ('& ' + $qNode + " 'bin/t3-fleet-gateway.js' serve *> " + $qLog)
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText($legacyRunner, $legacyScript, [Text.Encoding]::UTF8)

    $configContent = '{"marker":"preserve existing Fleet config"}'
    [IO.File]::WriteAllText($config, $configContent)
    [IO.File]::WriteAllText($log, "Existing diagnostic history" + [Environment]::NewLine, [Text.Encoding]::Unicode)
    $nodeCode = @'
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const data = path.join(root, 'data');
if (process.argv[2] !== 'serve' ||
    process.env.T3FG_CONFIG !== path.join(root, 'config.json') ||
    process.env.T3FG_DATA_DIR !== data ||
    process.cwd() !== path.join(root, 'app')) {
    throw new Error('Incorrect Fleet invocation or environment');
}
console.log('Fleet stdout');
console.error('Fleet stderr');
fs.writeFileSync(path.join(data, 'pid.txt'), String(process.pid));
const deadline = Date.now() + 30000;
const timer = setInterval(() => {
    if (fs.existsSync(path.join(data, 'release'))) {
        clearInterval(timer);
        process.exitCode = 17;
    } else if (Date.now() > deadline) {
        clearInterval(timer);
        process.exitCode = 98;
    }
}, 100);
'@
    [IO.File]::WriteAllText((Join-Path $app 'bin\t3-fleet-gateway.js'), $nodeCode)

    $shortcutPath = Join-Path $startupFolder 'T3 Fleet Gateway.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellExe
    $shortcut.WorkingDirectory = $app
    $shortcut.Arguments = '-NoProfile -File "' + $legacyRunner + '"'
    $shortcut.Save()

    Move-LegacyFleetStartup -FleetRoot $fleetRoot -StartupFolder $startupFolder -NodePath $node -LauncherPath $launcher -TaskName $taskName
    if (-not (Test-Path -LiteralPath $shortcutPath) -or
        $null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        throw 'Migration must preserve a customized Startup shortcut.'
    }

    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $legacyRunner + '"'
    $shortcut.Save()
    Move-LegacyFleetStartup -FleetRoot $fleetRoot -StartupFolder $startupFolder -NodePath $node -LauncherPath $launcher -TaskName $taskName
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ((Test-Path -LiteralPath $shortcutPath) -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $launcher) {
        throw 'The known legacy shortcut must be replaced by exactly one windowless scheduled action.'
    }

    if ([IO.File]::ReadAllText($config) -cne $configContent -or [IO.File]::ReadAllText($legacyRunner) -cne $legacyScript) {
        throw 'Startup migration must preserve the original Fleet config and runner.'
    }

    # Run the registered action directly: the CI runner need not have an interactive
    # logon session. A real Node process waits for the native window probe.
    $process = Start-Process -FilePath $task.Actions[0].Execute -ArgumentList $task.Actions[0].Arguments -PassThru
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $pidFile); $attempt++) {
        if ($process.HasExited) {
            throw ('Fleet startup exited before the Node probe became ready. Inspect ' + (Join-Path $fleetRoot 'launcher.log'))
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $pidFile)) {
        throw 'Fleet startup did not launch the real Node probe.'
    }

    $probeSource = Join-Path $fixture 'ConsoleWindowProbe.cs'
    $probeExecutable = Join-Path $fixture 'ConsoleWindowProbe.exe'
    $probeCode = @'
using System;
using System.Runtime.InteropServices;
internal static class ConsoleWindowProbe
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    private static extern bool FreeConsole();

    public static int Main(string[] args)
    {
        if (!AttachConsole(uint.Parse(args[0])))
        {
            int error = Marshal.GetLastWin32Error();
            return error == 6 ? 0 : error;
        }

        bool hasWindow = GetConsoleWindow() != IntPtr.Zero;
        FreeConsole();
        return hasWindow ? 1 : 0;
    }
}
'@
    [IO.File]::WriteAllText($probeSource, $probeCode)
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    & $compiler /nologo /target:winexe ('/out:' + $probeExecutable) $probeSource
    if ($LASTEXITCODE -ne 0) {
        throw 'Native console-window probe could not be compiled.'
    }

    $nodeId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $probeProcess = Start-Process -FilePath $probeExecutable -ArgumentList ([string]$nodeId) -PassThru
    if (-not $probeProcess.WaitForExit(10000) -or $probeProcess.ExitCode -ne 0) {
        throw 'The actual Fleet Node process must have no allocated console window.'
    }

    [IO.File]::WriteAllText($releaseFile, 'done')
    if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 17) {
        throw 'The Fleet action must propagate the real Node process exit code.'
    }

    $runtimeLog = [IO.File]::ReadAllText($log)
    if ($runtimeLog -notmatch 'Existing diagnostic history' -or $runtimeLog -notmatch 'Fleet stdout' -or $runtimeLog -notmatch 'Fleet stderr') {
        throw 'Fleet startup must append both output streams without destroying diagnostic history.'
    }
} finally {
    if ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    if ($null -ne $probeProcess) {
        if (-not $probeProcess.HasExited) {
            Stop-Process -InputObject $probeProcess -Force
        }
        $probeProcess.Dispose()
    }

    if ($null -ne $process) {
        [IO.File]::WriteAllText($releaseFile, 'cleanup')
        if (-not $process.WaitForExit(30000)) {
            Stop-Process -InputObject $process -Force
        }
        $process.Dispose()
    }

    Remove-Item -LiteralPath $fixture -Recurse -Force
}

Write-Host 'Fleet legacy Startup migration and real Node windowless execution passed.'
