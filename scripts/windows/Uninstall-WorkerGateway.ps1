#Requires -Version 5.1
[CmdletBinding()]
param([switch]$DeleteLocalSecrets)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'AIWorkerGateway'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    $owned = @($task.Actions | Where-Object { $_.Arguments -like '*Start-WorkerGateway.ps1*' }).Count -eq 1
    if (-not $owned) { throw 'The scheduled task name is in use by another program; refusing to remove it.' }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Host 'Removed AI Worker Gateway auto-start task. Original T3 and Fleet services were not touched.'

if ($DeleteLocalSecrets) {
    $stateRoot = Join-Path $env:LOCALAPPDATA 'AIWorkerGateway'
    Write-Warning 'Deleting local wrapper token/config files. This does not revoke Fleet client tokens; revoke those separately in the original Fleet CLI.'
    foreach ($name in @('client-token.dpapi', 'upstream-token.dpapi', 'settings.json')) {
        $file = Join-Path $stateRoot $name
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            Remove-Item -LiteralPath $file -Force
        }
    }
} else {
    Write-Host 'Local encrypted tokens/config remain for reinstall. Use -DeleteLocalSecrets to remove them explicitly.'
}
