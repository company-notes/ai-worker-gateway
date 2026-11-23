#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorkspacePath,
    [Parameter(Mandatory = $true)][string]$Title
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) {
    throw 'The managed worker workspace directory must already exist.'
}

$t3Command = Get-Command t3.cmd -ErrorAction SilentlyContinue
if ($null -eq $t3Command) {
    $t3Command = Get-Command t3.exe -ErrorAction Stop
}

# Always use the installed T3 CLI of the current Windows user. Do not bypass
# the running server by editing the T3 SQLite data or its service lock.
& $t3Command.Source project add $WorkspacePath --title $Title
exit $LASTEXITCODE
