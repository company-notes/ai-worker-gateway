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
    'Uninstall-WorkerGateway.ps1',
    'Register-T3Project.ps1',
    'New-ManagedFleetGrant.ps1',
    'Stop-OwnedWorkerGateway.ps1'
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

# Regression: a real user upgrading an existing install already has settings.json.
# Under StrictMode the installer must load it before choosing the local host.
$installerSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-WorkerGateway.ps1') -Raw -Encoding UTF8
$existingRead = $installerSource.IndexOf('if (-not $ProvisionHost -and $null -ne $existing', [StringComparison]::Ordinal)
$existingInit = $installerSource.IndexOf('$existing = $null', [StringComparison]::Ordinal)
if ($existingRead -lt 0 -or $existingInit -lt 0 -or $existingInit -ge $existingRead) {
    throw 'Upgrade regression: existing settings must be initialized before they are read for host selection under StrictMode.'
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

$provisioningPlan = & (Join-Path $PSScriptRoot 'Install-WorkerGateway.ps1') -PlanOnly -EnableProvisioning
if ($provisioningPlan.enablesProvisioning -ne $true) {
    throw 'Provisioning mode must be explicit, and PlanOnly cannot create a T3 project.'
}

$noProvisioning = & (Join-Path $PSScriptRoot 'Install-WorkerGateway.ps1') -PlanOnly -NoProvisioning
if ($noProvisioning.enablesProvisioning -ne $false) {
    throw 'A local operator must be able to decline automatic workspace provisioning.'
}
if ((Test-Path -LiteralPath $settingsPath) -ne $existedBefore) {
    throw 'Planning provisioning must not create or alter a persisted configuration.'
}

$secret = ConvertTo-SecureString -String 'local-bootstrap-dpapi-test-0123456789' -AsPlainText -Force
$cipher = ConvertFrom-SecureString -SecureString $secret
$roundTrip = ConvertTo-SecureString -String $cipher
if ($roundTrip.Length -ne $secret.Length) { throw 'Windows user DPAPI round trip failed.' }

# A real, isolated process exercises the original Fleet CLI's stdout contract.
# No production gateway, T3 service, token, or database is touched.
$fixture = Join-Path $env:TEMP ('awg-managed-grant-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
try {
    $mockCli = Join-Path $fixture 'mock-fleet.cjs'
    $mock = @'
const args = process.argv.slice(2);
if (args.join(' ') !== 'clients token --name ai-worker-gateway --access operate --hosts my-pc --ttl 1y') {
    process.stderr.write('Unexpected test command');
    process.exit(8);
}
process.stdout.write('Created client 12345678-1234-1234-1234-123456789012 ("ai-worker-gateway", operate access to host my-pc only). Its token expires in 1y:\n');
process.stdout.write('private-test-grant-0123456789012345678901234\n');
process.stdout.write('This is the only time the token is shown.\n');
process.stdout.write('Token ID: abc\n');
'@
    [IO.File]::WriteAllText($mockCli, $mock, (New-Object Text.UTF8Encoding($false)))
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $grant = & (Join-Path $PSScriptRoot 'New-ManagedFleetGrant.ps1') -NodePath $node -FleetCliPath $mockCli -HostId 'my-pc'
    if ($null -eq $grant -or $null -eq $grant.secret -or $grant.secret.Length -lt 24) {
        throw 'Installer must produce an encrypted-only in-memory managed operate credential.'
    }
    if ($grant.clientId -ne '12345678-1234-1234-1234-123456789012') {
        throw 'Installer must retain the managed client ID for lifecycle management.'
    }
} finally {
    Remove-Item -LiteralPath $fixture -Force -Recurse -ErrorAction SilentlyContinue
}

# Scenario: stopping the scheduled task leaves its node.exe child listening.
# A real Node socket owner must be stopped only if every ownership check matches.
$processTestRoot = Join-Path $env:TEMP ('awg-stop-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $processTestRoot | Out-Null
$gatewayProcess = $null
$unrelatedProcess = $null
try {
    $entrypointFolder = Join-Path $processTestRoot 'src'
    New-Item -ItemType Directory -Path $entrypointFolder | Out-Null
    $entrypoint = Join-Path $entrypointFolder 'main.js'
    $unrelatedEntrypoint = Join-Path $entrypointFolder 'unrelated.js'
    $gatewayPort = Get-Random -Minimum 48000 -Maximum 58000
    $unrelatedPort = Get-Random -Minimum 58000 -Maximum 63000
    $gatewayCode = "require('node:net').createServer(() => {}).listen($gatewayPort, '127.0.0.1');"
    $unrelatedCode = "require('node:net').createServer(() => {}).listen($unrelatedPort, '127.0.0.1');"
    [IO.File]::WriteAllText($entrypoint, $gatewayCode, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($unrelatedEntrypoint, $unrelatedCode, (New-Object Text.UTF8Encoding($false)))
    $gatewayProcess = Start-Process -FilePath $node -ArgumentList ('"' + $entrypoint + '"') -WindowStyle Hidden -PassThru
    $unrelatedProcess = Start-Process -FilePath $node -ArgumentList ('"' + $unrelatedEntrypoint + '"') -WindowStyle Hidden -PassThru

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $gatewayListeners = @(Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue)
        $unrelatedListeners = @(Get-NetTCPConnection -LocalPort $unrelatedPort -State Listen -ErrorAction SilentlyContinue)
        if ($gatewayListeners.Count -gt 0 -and $unrelatedListeners.Count -gt 0) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 150
    }
    if (-not $ready) { throw 'Fixture Node servers never reached listening state.' }

    $stopScript = Join-Path $PSScriptRoot 'Stop-OwnedWorkerGateway.ps1'
    $blocked = $false
    try {
        & $stopScript -NodePath $node -Entrypoint $entrypoint -ListenPort $unrelatedPort
    } catch {
        $blocked = $true
    }
    if (-not $blocked -or $unrelatedProcess.HasExited) {
        throw 'The installer must refuse to stop an unrelated Node listener.'
    }

    & $stopScript -NodePath $node -Entrypoint $entrypoint -ListenPort $gatewayPort | Out-Null
    if (-not $gatewayProcess.WaitForExit(5000)) {
        throw 'Stopping the installer-owned Gateway must also terminate its listening Node process.'
    }
    if ($unrelatedProcess.HasExited) {
        throw 'Stopping the owned Gateway must preserve unrelated services.'
    }
} finally {
    if ($null -ne $gatewayProcess) {
        if (-not $gatewayProcess.HasExited) { Stop-Process -Id $gatewayProcess.Id -Force }
        $gatewayProcess.Dispose()
    }
    if ($null -ne $unrelatedProcess) {
        if (-not $unrelatedProcess.HasExited) { Stop-Process -Id $unrelatedProcess.Id -Force }
        $unrelatedProcess.Dispose()
    }
    Remove-Item -LiteralPath $processTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

& (Join-Path $PSScriptRoot 'Test-WindowlessStartup.ps1')

Write-Host 'Windows bootstrap parser, PlanOnly and DPAPI tests passed.'
