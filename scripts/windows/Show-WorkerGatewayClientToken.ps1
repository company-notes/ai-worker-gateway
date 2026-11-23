#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Clipboard)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$file = Join-Path $env:LOCALAPPDATA 'AIWorkerGateway\client-token.dpapi'
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw 'No installed wrapper client token. Run Install-WorkerGateway.ps1 first.'
}

$cipher = [IO.File]::ReadAllText($file, [Text.Encoding]::ASCII)
$secret = ConvertTo-SecureString -String $cipher
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ($Clipboard) {
        Set-Clipboard -Value $token
        Write-Host 'Client bearer token copied to clipboard. Paste only into the MCP client secret field, then clear clipboard.'
    } else {
        Write-Warning 'Showing the wrapper client token locally. Do not paste it in chat, GitHub or logs.'
        Write-Output $token
    }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
