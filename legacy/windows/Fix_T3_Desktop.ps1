$p = "$HOME\.t3\userdata\desktop-settings.json"

if (Test-Path $p) {
    Copy-Item $p "$p.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    $settings = Get-Content $p -Raw | ConvertFrom-Json
} else {
    $settings = [PSCustomObject]@{}
}

if ($settings.PSObject.Properties['localEnvironmentEnabled']) {
    $settings.localEnvironmentEnabled = $false
} else {
    $settings | Add-Member -NotePropertyName localEnvironmentEnabled -NotePropertyValue $false
}

$json = $settings | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText(
    $p,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "T3 Desktop local server disabled. Reopen T3 Code."
Write-Host "After open, continue"
pause 
t3 pair --base-dir "$HOME\.t3"