param(
  [string]$LegacyTaskName = "FTD OPOS Scanner Bridge",
  [string]$LegacyBridgeScriptPath = "C:\FTDTools\OposBridge\opos-scanner-bridge.ps1",
  [string]$ServiceInstallerScriptPath = "",
  [string]$ServiceName = "FTD.OposBridge.Service",
  [string]$InstallRoot = "C:\FTDTools\OposBridgeService",
  [string]$LogicalName = "ZEBRA_SCANNER",
  [int]$Port = 17331,
  [ValidateSet("opos", "mock")]
  [string]$ScannerMode = "opos",
  [ValidateSet('trace', 'debug', 'information', 'warning', 'error', 'critical', 'none')]
  [string]$LogLevel = 'information',
  [switch]$SkipPublish,
  [ValidateSet("localservice", "networkservice", "localsystem", "current-user", "custom")]
  [string]$ServiceAccount = "localsystem",
  [ValidateSet('auto', 'demand', 'disabled')]
  [string]$ServiceStartMode = 'auto',
  [string]$ServiceUser = "",
  [PSCredential]$Credential,
  [switch]$PromptForCredential,
  [int]$ServiceRestartDelayMs = 60000,
  [switch]$UseAgentRelayHost,
  [switch]$EnableTaskFallback,
  [string]$TaskName = "FTD OPOS Bridge EXE",
  [string]$TrayTaskName = "FTD OPOS Bridge Tray",
  [switch]$NoTrayCompanion,
  [switch]$KeepLegacyTask,
  [switch]$DryRun,
  [bool]$TrayOnLogin = $true
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-ServiceInstallerPath {
  param([string]$rawPath)

  if (-not [string]::IsNullOrWhiteSpace($rawPath)) {
    return (Resolve-Path $rawPath).Path
  }

  $defaultPath = Join-Path $PSScriptRoot "install-opos-bridge-service.ps1"
  if (-not (Test-Path $defaultPath)) {
    throw "Service installer script not found: $defaultPath"
  }

  return (Resolve-Path $defaultPath).Path
}

function Resolve-TaskInstallerPath {
  $defaultPath = Join-Path $PSScriptRoot "install-opos-bridge-task.ps1"
  if (-not (Test-Path $defaultPath)) {
    throw "Task installer script not found: $defaultPath"
  }

  return (Resolve-Path $defaultPath).Path
}

function Invoke-Step {
  param(
    [string]$Message,
    [scriptblock]$Action
  )

  Write-Host $Message
  if ($DryRun.IsPresent) {
    Write-Host "  [DryRun] Skipped."
    return
  }

  & $Action
}

function Stop-LegacyTask {
  param([string]$taskName)

  try {
    if (Get-Command Stop-ScheduledTask -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    } else {
      schtasks.exe /End /TN "$taskName" | Out-Null
    }
  } catch {
    Write-Warning "Unable to stop task '$taskName': $($_.Exception.Message)"
  }
}

function Remove-LegacyTask {
  param([string]$taskName)

  try {
    if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    } else {
      schtasks.exe /Delete /F /TN "$taskName" | Out-Null
    }
  } catch {
    Write-Warning "Unable to remove task '$taskName': $($_.Exception.Message)"
  }
}

function Stop-LegacyBridgeProcesses {
  param([string]$scriptPath)

  if ([string]::IsNullOrWhiteSpace($scriptPath) -or -not (Test-Path $scriptPath)) {
    Write-Host "Legacy bridge script path not found. Skipping process cleanup."
    return
  }

  $resolved = (Resolve-Path $scriptPath).Path
  $escaped = [Regex]::Escape($resolved)
  $procs = @(
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $escaped }
  )

  if ($procs.Count -eq 0) {
    Write-Host "No running legacy bridge process found."
    return
  }

  foreach ($proc in $procs) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Host ("Stopped legacy bridge process id {0}" -f $proc.ProcessId)
    } catch {
      Write-Warning ("Could not stop process id {0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
    }
  }
}

function Stop-TaskHost {
  param(
    [string]$taskInstallerPath,
    [string]$taskName,
    [string]$installRoot
  )

  try {
    & $taskInstallerPath -Action stop -TaskName $taskName | Out-Null
  } catch {
    # Ignore if task host is not present.
  }

  $exePath = Join-Path $installRoot "FTD.OposBridge.Service.exe"
  if (Test-Path $exePath) {
    $escaped = [Regex]::Escape((Resolve-Path $exePath).Path)
    $procs = @(
      Get-CimInstance Win32_Process -Filter "Name='FTD.OposBridge.Service.exe'" -ErrorAction SilentlyContinue |
        Where-Object { ($_.ExecutablePath -match $escaped) -or ($_.CommandLine -match $escaped) }
    )

    foreach ($proc in $procs) {
      try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Host ("Stopped bridge EXE process id {0}" -f $proc.ProcessId)
      } catch {
        Write-Warning ("Could not stop bridge EXE process id {0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
      }
    }
  }
}

if (-not (Test-IsAdmin)) {
  throw "Run this script from an elevated (Administrator) PowerShell session."
}

$installerPath = Resolve-ServiceInstallerPath -rawPath $ServiceInstallerScriptPath
$taskInstallerPath = Resolve-TaskInstallerPath

Invoke-Step -Message ("Stopping legacy scheduled task '{0}' ..." -f $LegacyTaskName) -Action {
  Stop-LegacyTask -taskName $LegacyTaskName
}

if (-not $KeepLegacyTask.IsPresent) {
  Invoke-Step -Message ("Removing legacy scheduled task '{0}' ..." -f $LegacyTaskName) -Action {
    Remove-LegacyTask -taskName $LegacyTaskName
  }
} else {
  Write-Host ("Keeping legacy task '{0}' by request." -f $LegacyTaskName)
}

Invoke-Step -Message "Stopping any running legacy bridge PowerShell process ..." -Action {
  Stop-LegacyBridgeProcesses -scriptPath $LegacyBridgeScriptPath
}

Invoke-Step -Message ("Stopping bridge task host '{0}' and stale EXE processes ..." -f $TaskName) -Action {
  Stop-TaskHost -taskInstallerPath $taskInstallerPath -taskName $TaskName -installRoot $InstallRoot
}

if (-not [string]::IsNullOrWhiteSpace($TrayTaskName)) {
  Invoke-Step -Message ("Stopping tray companion task host '{0}' ..." -f $TrayTaskName) -Action {
    try {
      & $taskInstallerPath -Action stop -TaskName $TrayTaskName | Out-Null
    } catch {}
    try {
      & $taskInstallerPath -Action uninstall -TaskName $TrayTaskName | Out-Null
    } catch {}
  }
}

$installArgs = @{
  Action = "install"
  ServiceName = $ServiceName
  InstallRoot = $InstallRoot
  LogicalName = $LogicalName
  Port = $Port
  ScannerMode = $(if ($UseAgentRelayHost.IsPresent) { "mock" } else { $ScannerMode })
  LogLevel = $LogLevel
  ServiceAccount = $ServiceAccount
  StartMode = $ServiceStartMode
  ServiceRestartDelayMs = $ServiceRestartDelayMs
}

if ($SkipPublish.IsPresent) { $installArgs["SkipPublish"] = $true }
if (-not [string]::IsNullOrWhiteSpace($ServiceUser)) { $installArgs["ServiceUser"] = $ServiceUser }
if ($null -ne $Credential) { $installArgs["Credential"] = $Credential }
if ($PromptForCredential.IsPresent) { $installArgs["PromptForCredential"] = $true }

$serviceInstallFailed = $false
$usedTaskFallback = $false
try {
  Invoke-Step -Message "Installing and starting EXE bridge service ..." -Action {
    & $installerPath @installArgs
  }
}
catch {
  $serviceInstallFailed = $true
  Write-Warning ("Service-host start failed: {0}" -f $_.Exception.Message)
}

if ($serviceInstallFailed -and $EnableTaskFallback.IsPresent) {
  Write-Host "Falling back to EXE interactive scheduled task host ..."
  $usedTaskFallback = $true
  $taskArgs = @{
    Action = "install"
    TaskName = $TaskName
    InstallRoot = $InstallRoot
    ServiceName = $ServiceName
    Port = $Port
    LogicalName = $LogicalName
    ScannerMode = $ScannerMode
    LogLevel = $LogLevel
  }
  if (-not [string]::IsNullOrWhiteSpace($ServiceUser)) {
    Write-Warning "ServiceUser is ignored in task fallback mode."
  }
  if ($DryRun.IsPresent) {
    Write-Host "  [DryRun] Would install/start EXE task host."
  } else {
    & $taskInstallerPath @taskArgs
  }
} elseif ($serviceInstallFailed) {
  throw "EXE service install/start failed and task fallback is disabled."
}

if ($UseAgentRelayHost.IsPresent) {
  Write-Host "Configuring EXE user-session OPOS agent relay task ..."
  $agentTaskArgs = @{
    Action = "install"
    TaskName = $TaskName
    InstallRoot = $InstallRoot
    ServiceName = $ServiceName
    LogicalName = $LogicalName
    Port = $Port
    ScannerMode = "opos"
    LogLevel = $LogLevel
    HostMode = "agent-relay"
    BridgeBaseUrl = ("http://127.0.0.1:{0}" -f $Port)
  }

  if ($DryRun.IsPresent) {
    Write-Host "  [DryRun] Would install/start agent relay task host."
  } else {
    try {
      & $taskInstallerPath @agentTaskArgs
    } catch {
      Write-Warning ("Unable to configure agent relay task '{0}': {1}" -f $TaskName, $_.Exception.Message)
    }
  }
}

if (-not $NoTrayCompanion.IsPresent -and -not $usedTaskFallback -and $TrayOnLogin) {
  Write-Host "Configuring EXE user-session tray companion task ..."
  $trayTaskArgs = @{
    Action = "install"
    TaskName = $TrayTaskName
    InstallRoot = $InstallRoot
    ServiceName = $ServiceName
    LogicalName = $LogicalName
    Port = $Port
    ScannerMode = "opos"
    LogLevel = $LogLevel
    HostMode = "tray-companion"
    BridgeBaseUrl = ("http://127.0.0.1:{0}" -f $Port)
  }

  if ($DryRun.IsPresent) {
    Write-Host "  [DryRun] Would install/start tray companion task host."
  } else {
    try {
      & $taskInstallerPath @trayTaskArgs
    } catch {
      Write-Warning ("Unable to configure tray companion task '{0}': {1}" -f $TrayTaskName, $_.Exception.Message)
    }
  }
} elseif ($usedTaskFallback) {
  Write-Host "Skipping dedicated tray companion task because task fallback host already runs interactively."
} else {
  Write-Host "Tray companion will NOT be started on login (user unchecked option)."
  try {
    & $taskInstallerPath -Action uninstall -TaskName $TrayTaskName -ServiceName $ServiceName | Out-Null
  } catch {
    Write-Warning "Could not remove tray companion scheduled task: $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "Migration complete."
Write-Host ("EXE service: {0}" -f $ServiceName)
Write-Host ("Bridge URL: http://127.0.0.1:{0}" -f $Port)
