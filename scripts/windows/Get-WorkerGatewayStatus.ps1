#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stateRoot = Join-Path $env:LOCALAPPDATA 'AIWorkerGateway'
$settingsFile = Join-Path $stateRoot 'settings.json'
$task = Get-ScheduledTask -TaskName 'AIWorkerGateway' -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) {
    Write-Host 'Worker Gateway has not been installed for this Windows user.'
    return
}

$settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$taskState = if ($null -eq $task) { 'not registered' } else { [string]$task.State }
Write-Host ('Startup task: ' + $taskState + ' (trigger: Windows user logon, not pre-login boot)')
Write-Host ('Repository: ' + $settings.repoRoot)
Write-Host ('MCP URL: http://127.0.0.1:' + $settings.listenPort + '/mcp')
Write-Host ('General execution alias: ' + $(if ($settings.generalProject) { $settings.generalProject } else { 'NOT CONFIGURED' }))
Write-Host ('Skill package: ' + (Join-Path $stateRoot 'skills\session-router\SKILL.md'))

$client = New-Object Net.Sockets.TcpClient
try {
    $async = $client.BeginConnect('127.0.0.1', [int]$settings.listenPort, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(800)) { throw 'Port is not listening' }
    $client.EndConnect($async)
    Write-Host 'Listener: TCP reachable (not a guarantee of authenticated MCP or upstream health)'
} catch {
    Write-Warning ('Listener: not reachable (' + $_.Exception.Message + ')')
} finally {
    $client.Dispose()
}
