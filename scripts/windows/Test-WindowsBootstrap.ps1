#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$scripts = @(
    'Install-WorkerGateway.ps1',
    'Start-WorkerGateway.ps1',
    'Get-WorkerGatewayStatus.ps1',
    'Show-WorkerGatewayClientToken.ps1',
    'Uninstall-WorkerGateway.ps1'
)

foreach ($file in $scripts) {
    $filePath = Join-Path $PSScriptRoot $file
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($filePath, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -ne 0) {
        throw ('Invalid PowerShell syntax: ' + $file + ': ' + ($errors | Out-String))
    }
}

$settingsPath = Join-Path $env:LOCALAPPDATA 'AIWorkerGateway\settings.json'
$existedBefore = Test-Path -LiteralPath $settingsPath
$plan = & (Join-Path $PSScriptRoot 'Install-WorkerGateway.ps1') -PlanOnly
if ($plan.repository -ne $root) { throw 'Installer plan must resolve its repository.' }
if ($plan.changesUpstream -ne $false) { throw 'Installer must not claim to patch upstream.' }
if ($plan.createsWorkspaceProject -ne $false) { throw 'Installer must not claim to create a T3 Project.' }
if ($plan.startup -ne 'at-user-logon') { throw 'Startup type must be explicit.' }
if ($plan.assistantMCP -ne 'http://127.0.0.1:3791/mcp') { throw 'Client MCP must be 3791.' }
if ((Test-Path -LiteralPath $settingsPath) -ne $existedBefore) { throw 'PlanOnly must have no persistent effects.' }

$manual = & (Join-Path $PSScriptRoot 'Install-WorkerGateway.ps1') -PlanOnly -NoAutoStart
if ($manual.startup -ne 'manual') { throw 'Manual mode plan must be explicit.' }

$secret = ConvertTo-SecureString -String 'local-bootstrap-dpapi-test-0123456789' -AsPlainText -Force
$cipher = ConvertFrom-SecureString -SecureString $secret
$roundTrip = ConvertTo-SecureString -String $cipher
if ($roundTrip.Length -ne $secret.Length) { throw 'Windows user DPAPI round trip failed.' }

Write-Host 'Windows bootstrap parser, PlanOnly and DPAPI tests passed.'
