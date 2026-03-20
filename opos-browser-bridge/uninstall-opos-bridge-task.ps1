param(
  [string]$TaskName = "FTD OPOS Scanner Bridge",
  [string]$BridgeScriptPath = "C:\FTDTools\OposBridge\opos-scanner-bridge.ps1"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

Write-Host "Stopping scheduled task (if running): $TaskName"
try {
  schtasks.exe /End /TN "$TaskName" | Out-Host
} catch {
}

Write-Host "Deleting scheduled task (if present): $TaskName"
try {
  schtasks.exe /Delete /F /TN "$TaskName" | Out-Host
} catch {
}

if (Test-Path $BridgeScriptPath) {
  Write-Host "Stopping bridge process(es) running: $BridgeScriptPath"
  $escapedPath = [Regex]::Escape($BridgeScriptPath)
  $bridgeProcs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -match $escapedPath }

  foreach ($proc in $bridgeProcs) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Host "Stopped process id $($proc.ProcessId)"
    } catch {
      Write-Warning "Could not stop process id $($proc.ProcessId): $($_.Exception.Message)"
    }
  }
}

Write-Host "Task cleanup completed."
