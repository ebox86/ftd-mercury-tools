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
$bridgeDir = Split-Path -Parent $BridgeScriptPath
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$BridgeScriptPath`" -LogicalName `"$LogicalName`" -Port $Port"

function Install-WithScheduledTaskModule {
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    throw "ScheduledTasks module cmdlets are unavailable."
  }

  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $taskArgs -WorkingDirectory $bridgeDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "FTD OPOS scanner bridge (localhost API for browser modal scanning)."
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

function Install-WithSchtasks {
  $taskRun = "`"$powershellExe`" $taskArgs"
  schtasks.exe /Create /F /SC ONLOGON /RL LIMITED /TN "$TaskName" /TR "$taskRun" | Out-Host
}

Write-Host "Creating/updating scheduled task: $TaskName"
$installedWithModule = $false

try {
  Install-WithScheduledTaskModule
  $installedWithModule = $true
} catch {
  Write-Warning "Register-ScheduledTask path failed: $($_.Exception.Message)"
  Write-Host "Falling back to schtasks.exe..."
  Install-WithSchtasks
}

Write-Host "Starting task now: $TaskName"
if ($installedWithModule) {
  try {
    Start-ScheduledTask -TaskName $TaskName
  } catch {
    Write-Warning "Start-ScheduledTask failed: $($_.Exception.Message). Trying schtasks /Run."
    schtasks.exe /Run /TN "$TaskName" | Out-Host
  }
} else {
  schtasks.exe /Run /TN "$TaskName" | Out-Host
}

try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  Write-Host ("Task status: State={0}, LastRunTime={1}, LastTaskResult={2}" -f $task.State, $info.LastRunTime, $info.LastTaskResult)
} catch {
  Write-Warning "Unable to read task info: $($_.Exception.Message)"
}

Write-Host "Done."
