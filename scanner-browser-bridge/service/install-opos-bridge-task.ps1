[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'status')]
  [string]$Action = 'install',

  [Parameter()]
  [string]$TaskName = 'FTD OPOS Bridge EXE',

  [Parameter()]
  [string]$InstallRoot = 'C:\FTDTools\OposBridgeService',

  [Parameter()]
  [string]$ExePath = '',

  [Parameter()]
  [ValidateRange(1024, 65535)]
  [int]$Port = 17331,

  [Parameter()]
  [string]$LogicalName = 'ZEBRA_SCANNER',

  [Parameter()]
  [ValidateSet('opos', 'mock')]
  [string]$ScannerMode = 'opos',

  [Parameter()]
  [ValidateRange(100, 60000)]
  [int]$ClaimTimeoutMs = 3000,

  [Parameter()]
  [ValidateSet('trace', 'debug', 'information', 'warning', 'error', 'critical', 'none')]
  [string]$LogLevel = 'information',

  [Parameter()]
  [ValidateSet('bridge', 'agent-relay', 'tray-companion')]
  [string]$HostMode = 'bridge',

  [Parameter()]
  [string]$BridgeBaseUrl = 'http://127.0.0.1:17331',

  [Parameter()]
  [bool]$HideWindow = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-Exe {
  if (-not [string]::IsNullOrWhiteSpace($ExePath)) {
    return (Resolve-Path -LiteralPath $ExePath).Path
  }

  $defaultExe = Join-Path $InstallRoot 'FTD.OposBridge.Service.exe'
  if (-not (Test-Path -LiteralPath $defaultExe)) {
    throw "EXE not found: $defaultExe"
  }

  return (Resolve-Path -LiteralPath $defaultExe).Path
}

function Task-Exists([string]$name) {
  try {
    $null = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    return $true
  }
  catch {
    return $false
  }
}

function Start-TaskNow([string]$name) {
  try {
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
  }
  catch {
    schtasks.exe /Run /TN "$name" | Out-Null
  }
}

function Stop-TaskNow([string]$name) {
  try {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  }
  catch {
    schtasks.exe /End /TN "$name" | Out-Null
  }
}

function Install-Task {
  $exe = Resolve-Exe
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $argLine = "--port=$Port --logical-name=$LogicalName --scanner-mode=$ScannerMode --claim-timeout-ms=$ClaimTimeoutMs --log-level=$LogLevel"
  if ($HostMode -eq 'agent-relay') {
    $argLine = "$argLine --agent-relay --bridge-base-url=$BridgeBaseUrl"
  } elseif ($HostMode -eq 'tray-companion') {
    $argLine = "--tray-companion --port=$Port --bridge-base-url=$BridgeBaseUrl --logical-name=$LogicalName --scanner-mode=$ScannerMode --log-level=$LogLevel"
  }
  $workingDir = Split-Path -Parent $exe

  if ($HideWindow) {
    $powershellExe = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $escapedExe = $exe.Replace("'", "''")
    $command = "& '$escapedExe' $argLine"
    $hiddenArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`""
    $action = New-ScheduledTaskAction -Execute $powershellExe -Argument $hiddenArgs -WorkingDirectory $workingDir
  } else {
    $action = New-ScheduledTaskAction -Execute $exe -Argument $argLine -WorkingDirectory $workingDir
  }
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  $description = switch ($HostMode) {
    'agent-relay' { "FTD OPOS Bridge EXE agent relay host." }
    'tray-companion' { "FTD OPOS Bridge EXE tray companion." }
    default { "FTD OPOS Bridge EXE host." }
  }
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  Start-TaskNow -name $TaskName
}

function Uninstall-Task {
  Stop-TaskNow -name $TaskName
  if (Task-Exists -name $TaskName) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}

function Show-Status {
  if (-not (Task-Exists -name $TaskName)) {
    Write-Host "Task '$TaskName' not found."
    return
  }

  $task = Get-ScheduledTask -TaskName $TaskName
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host ("TaskName: {0}" -f $task.TaskName)
  Write-Host ("State: {0}" -f $task.State)
  Write-Host ("LastRunTime: {0}" -f $info.LastRunTime)
  Write-Host ("LastTaskResult: {0}" -f $info.LastTaskResult)

  try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 2
    Write-Host ("Health: ok={0}, scannerStatus={1}, claimed={2}" -f $health.ok, $health.scannerStatus, $health.scannerClaimed)
  }
  catch {
    Write-Host "Health: not reachable on configured port."
  }
}

switch ($Action) {
  'install' { Install-Task }
  'uninstall' { Uninstall-Task }
  'start' { Start-TaskNow -name $TaskName }
  'stop' { Stop-TaskNow -name $TaskName }
  'status' { Show-Status }
  default { throw "Unsupported action: $Action" }
}
