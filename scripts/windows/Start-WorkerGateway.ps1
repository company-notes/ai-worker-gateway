#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stateRoot = Join-Path $env:LOCALAPPDATA 'AIWorkerGateway'
$settingsFile = Join-Path $stateRoot 'settings.json'
if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) {
    throw 'AI Worker Gateway has not been configured. Run Install-WorkerGateway.ps1 first.'
}

function Read-ClientSecret([string]$file) {
    $cipher = [IO.File]::ReadAllText($file, [Text.Encoding]::ASCII)
    $secure = ConvertTo-SecureString -String $cipher
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

$settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$entrypoint = Join-Path $settings.repoRoot 'src\main.js'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw 'The configured repository location no longer exists. Re-run the installer after moving the checkout.'
}
if (-not (Test-Path -LiteralPath $settings.nodePath -PathType Leaf)) {
    throw 'The configured Node executable no longer exists. Re-run the installer after updating Node.'
}

$env:AWG_CLIENT_TOKEN = Read-ClientSecret (Join-Path $stateRoot 'client-token.dpapi')
$env:AWG_UPSTREAM_TOKEN = Read-ClientSecret (Join-Path $stateRoot 'upstream-token.dpapi')
$env:AWG_UPSTREAM_MCP_URL = [string]$settings.upstreamURL
$env:AWG_LISTEN_HOST = [string]$settings.listenHost
$env:AWG_LISTEN_PORT = [string]$settings.listenPort
$env:AWG_NOTIFICATION_STATE_DIR = $stateRoot
$env:AWG_NOTIFICATION_STORAGE_KEY = Read-ClientSecret (Join-Path $stateRoot 'notification-storage-key.dpapi')

Remove-Item Env:AWG_WORKSPACE_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:AWG_GENERAL_PROJECT -ErrorAction SilentlyContinue
Remove-Item Env:AWG_PROVISION_HOST -ErrorAction SilentlyContinue
Remove-Item Env:AWG_PROVISION_MODEL_SELECTION -ErrorAction SilentlyContinue
if ($settings.workspaceRoot) { $env:AWG_WORKSPACE_ROOT = [string]$settings.workspaceRoot }
if ($settings.generalProject) { $env:AWG_GENERAL_PROJECT = [string]$settings.generalProject }
if ($null -ne $settings.PSObject.Properties['provision_host'] -and $settings.provision_host) {
    $env:AWG_PROVISION_HOST = [string]$settings.provision_host
}
if ($null -ne $settings.PSObject.Properties['provision_model_selection'] -and $settings.provision_model_selection) {
    $model = $settings.provision_model_selection
    $selection = @{
        instanceId = [string]$model.instance_id
        model = [string]$model.model
    }
    $env:AWG_PROVISION_MODEL_SELECTION = $selection | ConvertTo-Json -Depth 10 -Compress
}

$logFile = Join-Path $stateRoot 'gateway.log'
Push-Location -LiteralPath $settings.repoRoot
try {
    & $settings.nodePath $entrypoint *> $logFile
    if ($LASTEXITCODE -ne 0) { throw ('Worker Gateway process exited with status ' + $LASTEXITCODE) }
} finally {
    Pop-Location
}
