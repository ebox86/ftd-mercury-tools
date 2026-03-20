param(
  [string]$BridgeScriptPath = "C:\FTDTools\OposBridge\opos-scanner-bridge.ps1",
  [string]$LogicalName = "ZEBRA_SCANNER",
  [int]$Port = 17331,
  [string]$TaskName = "FTD OPOS Scanner Bridge"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

if (-not (Test-Path $BridgeScriptPath)) {
  throw "Bridge script not found: $BridgeScriptPath"
}

$powershellExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$BridgeScriptPath`" -LogicalName `"$LogicalName`" -Port $Port"
$taskRun = "`"$powershellExe`" $taskArgs"

Write-Host "Creating/updating scheduled task: $TaskName"
schtasks.exe /Create /F /SC ONLOGON /RL LIMITED /TN "$TaskName" /TR "$taskRun" | Out-Host

Write-Host "Starting task now: $TaskName"
schtasks.exe /Run /TN "$TaskName" | Out-Host

Write-Host "Done."
