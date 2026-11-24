#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$title = [string]$payload.title
$message = [string]$payload.message
if (-not $title -or -not $message -or $title.Length -gt 80 -or $message.Length -gt 200) {
    throw 'Invalid desktop notification text.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
try {
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.BalloonTipTitle = $title
    $icon.BalloonTipText = $message
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $icon.ShowBalloonTip(8000)
    Start-Sleep -Seconds 9
} finally {
    $icon.Visible = $false
    $icon.Dispose()
}
