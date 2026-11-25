#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$NodePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is our deployment wrapper, not an upstream Fleet source file.
$env:T3FG_CONFIG = Join-Path $PSScriptRoot 'config.json'
$env:T3FG_DATA_DIR = Join-Path $PSScriptRoot 'data'
$app = Join-Path $PSScriptRoot 'app'
$entrypoint = Join-Path $app 'bin\t3-fleet-gateway.js'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $entrypoint -PathType Leaf) -or
    -not (Test-Path -LiteralPath $env:T3FG_CONFIG -PathType Leaf) -or
    -not (Test-Path -LiteralPath $env:T3FG_DATA_DIR -PathType Container)) {
    throw 'The existing Fleet installation is incomplete; inspect its original files.'
}

[Reflection.Assembly]::LoadFrom($env:AWG_WINDOWLESS_LAUNCHER) | Out-Null
$arguments = '"' + $entrypoint + '" serve'
$exitCode = [AIWorkerGateway.Windows.WindowlessProcess]::run($NodePath, $arguments, $app, (Join-Path $PSScriptRoot 'gateway.log'))
exit $exitCode
