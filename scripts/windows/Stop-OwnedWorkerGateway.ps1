#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$Entrypoint,
    [ValidateRange(1, 65535)][int]$ListenPort = 3791
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ListenerProcesses([int]$port) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return @()
    }

    $unexpected = @($listeners | Where-Object {
        $_.LocalAddress -ne '127.0.0.1' -and $_.LocalAddress -ne '::1'
    })
    if ($unexpected.Count -gt 0) {
        throw 'The Gateway port is also listening on a non-loopback address. Refusing to stop an unknown service.'
    }

    return @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Assert-OwnedGatewayProcess([int]$processId, [string]$expectedNodePath, [string]$expectedEntrypoint) {
    $candidate = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    if ($null -eq $candidate) {
        throw 'The Gateway listener process disappeared before ownership verification. Retry installation.'
    }

    $actualNodePath = [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
    $expectedNode = [IO.Path]::GetFullPath($expectedNodePath)
    if ($actualNodePath -ne $expectedNode) {
        throw 'Port belongs to a different executable. Refusing to stop an unknown service.'
    }

    $fullEntrypoint = [IO.Path]::GetFullPath($expectedEntrypoint)
    $quotedEntrypoint = [regex]::Escape($fullEntrypoint)
    $entrypointPattern = '(?:^|\s)(?:"' + $quotedEntrypoint + '"|' + $quotedEntrypoint + ')\s*$'
    if ([string]$candidate.CommandLine -notmatch $entrypointPattern) {
        throw 'Port belongs to a different Node script. Refusing to stop an unknown service.'
    }

    $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($owner.ReturnValue -ne 0 -or [string]$owner.Sid -ne $currentSid) {
        throw 'Gateway listener is not owned by the installing Windows user. Refusing to stop it.'
    }

    $process = Get-Process -Id $processId -ErrorAction Stop
    if ([Math]::Abs(($process.StartTime - $candidate.CreationDate).TotalSeconds) -gt 2) {
        throw 'Gateway listener process identity changed during verification. Retry installation.'
    }

    return $process
}

$owners = @(Get-ListenerProcesses $ListenPort)
if ($owners.Count -eq 0) {
    return
}
if ($owners.Count -ne 1) {
    throw 'Multiple processes listen on the Gateway port. Refusing automatic shutdown.'
}

$ownedProcess = Assert-OwnedGatewayProcess -processId ([int]$owners[0]) -expectedNodePath $NodePath -expectedEntrypoint $Entrypoint
try {
    Stop-Process -InputObject $ownedProcess -Force -ErrorAction Stop
    if (-not $ownedProcess.WaitForExit(5000)) {
        throw 'The verified Gateway process did not exit after the stop request.'
    }
} finally {
    $ownedProcess.Dispose()
}

Write-Host ('Stopped the verified local AI Worker Gateway process on port ' + $ListenPort + '.')
