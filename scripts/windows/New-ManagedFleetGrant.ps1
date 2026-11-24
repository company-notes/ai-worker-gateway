#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$FleetCliPath,
    [Parameter(Mandatory = $true)][string]$HostId,
    [string]$FleetConfigPath,
    [string]$FleetDataDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($HostId -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') {
    throw 'Host ID must be a configured local Fleet host.'
}

if (-not (Test-Path -LiteralPath $FleetCliPath -PathType Leaf)) {
    throw 'Installed Fleet CLI not found. The local Fleet service must be installed first.'
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'Node.js executable not found.'
}

$oldConfig = $env:T3FG_CONFIG
$oldDataDir = $env:T3FG_DATA_DIR
try {
    if ($FleetConfigPath) { $env:T3FG_CONFIG = $FleetConfigPath }
    if ($FleetDataDir) { $env:T3FG_DATA_DIR = $FleetDataDir }

    # All stdout and stderr stay in memory. The issued token never goes to
    # terminal output, log files, command arguments or a Git-tracked file.
    $raw = @(& $NodePath $FleetCliPath clients token --name ai-worker-gateway --access operate --hosts $HostId --ttl 1y 2>&1)
    $exitCode = $LASTEXITCODE
} finally {
    if ($null -eq $oldConfig) {
        Remove-Item Env:T3FG_CONFIG -ErrorAction SilentlyContinue
    } else {
        $env:T3FG_CONFIG = $oldConfig
    }
    if ($null -eq $oldDataDir) {
        Remove-Item Env:T3FG_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:T3FG_DATA_DIR = $oldDataDir
    }
}

if ($exitCode -ne 0) {
    throw 'The installed Fleet CLI could not create the Gateway internal operate grant. See local Fleet service configuration; no token is required from the user.'
}

$lines = @($raw | ForEach-Object { [string]$_ })
$header = $null
$clientId = $null
$issuedToken = $null
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i].Trim()
    if ($line -match '^Created client ([a-zA-Z0-9_-]{8,100}) \("ai-worker-gateway", operate access to host ([a-z0-9][a-z0-9-]{0,31}) only\)\. Its token') {
        if ($null -ne $header) {
            throw 'Fleet CLI returned ambiguous credential output; no token was accepted.'
        }
        $header = $line
        $clientId = $Matches[1]
        if ($Matches[2].Trim() -ne $HostId) {
            throw 'Fleet CLI did not confirm the requested local host scope.'
        }
        if ($i + 1 -ge $lines.Count) {
            throw 'Fleet CLI did not return a credential.'
        }
        $issuedToken = $lines[$i + 1].Trim()
    }
}

if ($null -eq $header -or
    $issuedToken -notmatch '^[A-Za-z0-9._~-]{24,512}$') {
    throw 'Fleet CLI output did not contain exactly one supported operate credential; no token was accepted.'
}

$secret = ConvertTo-SecureString -String $issuedToken -AsPlainText -Force
$issuedToken = $null
$raw = $null
$lines = $null

[pscustomobject]@{
    secret = $secret
    clientId = $clientId
}
