# Corrected from uploaded terminal transcript: prompt prefix was not PowerShell code.
# Gateway host pairing (NOT T3 Desktop's 't3 pair').
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'T3FleetGateway'
$app = Join-Path $base 'app'
if (-not (Test-Path -LiteralPath (Join-Path $app 'bin\t3-fleet-gateway.js'))) {
    throw "Fleet Gateway CLI not found in $app"
}
$env:T3FG_CONFIG = Join-Path $base 'config.json'
$env:T3FG_DATA_DIR = Join-Path $base 'data'
Push-Location $app
try {
    node .\bin\t3-fleet-gateway.js pair
    if ($LASTEXITCODE -ne 0) { throw "Fleet Gateway pair failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
