#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Exercise the installer action itself with an isolated script in place of the Gateway.
# The probe checks actual console attachment, not the visibility flag or window title.
$fixture = Join-Path $env:TEMP ('awg-windowless-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$process = $null
try {
    $runner = Join-Path $fixture 'Probe.ps1'
    $launcherLog = Join-Path $fixture 'launcher.log'
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $probe = @'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] processes, uint count); }'
$count = [ConsoleProbe]::GetConsoleProcessList((New-Object 'uint32[]' 1), 1)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'console-count.txt'), [string]$count)
Write-Output 'Windowless probe output'
exit 17
'@
    [IO.File]::WriteAllText($runner, $probe, (New-Object Text.UTF8Encoding($false)))

    $module = Join-Path $PSScriptRoot 'WindowlessStartup.ps1'
    if (Test-Path -LiteralPath $module) {
        . $module
        $launcher = Initialize-WindowlessLauncher -StateRoot $fixture
    }

    $tokens = $null
    $errors = $null
    $installer = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PSScriptRoot 'Install-WorkerGateway.ps1'), [ref]$tokens, [ref]$errors)
    $assignments = @($installer.FindAll({
        param($item)
        $item -is [Management.Automation.Language.AssignmentStatementAst] -and
            $item.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $item.Left.VariablePath.UserPath -eq 'action'
    }, $true))
    if ($errors.Count -ne 0 -or $assignments.Count -ne 1) {
        throw 'Cannot identify the actual installer scheduled action.'
    }

    . ([scriptblock]::Create($assignments[0].Extent.Text))
    $process = Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -PassThru
    if (-not $process.WaitForExit(30000)) {
        throw 'The scheduled action did not propagate the probe exit.'
    }

    $countFile = Join-Path $fixture 'console-count.txt'
    if (-not (Test-Path -LiteralPath $countFile)) {
        throw 'The scheduled action did not run the console probe.'
    }

    $consoleCount = [int](Get-Content -LiteralPath $countFile -Raw)
    if ($consoleCount -ne 0) {
        throw "Regression: Gateway startup attached a console ($consoleCount processes); expected no console."
    }
    if ($process.ExitCode -ne 17) {
        throw 'The background launcher must preserve the child exit code for Task Scheduler restart.'
    }
    if (-not (Select-String -LiteralPath $launcherLog -Pattern 'Windowless probe output' -Quiet)) {
        throw 'Background startup must preserve child output in a diagnostic log.'
    }
} finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
        }
        $process.Dispose()
    }
    Remove-Item -LiteralPath $fixture -Recurse -Force
}

Write-Host 'Windowless startup process scenario passed.'
