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
  [string]$ServiceName = 'FTD.OposBridge.Service',

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

function Resolve-TaskUser {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $currentSessionId = $null
  try {
    $currentSessionId = (Get-Process -Id $PID -ErrorAction Stop).SessionId
  } catch {
    $currentSessionId = $null
  }

  try {
    $explorers = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop)
    if ($null -ne $currentSessionId) {
      $explorers = @($explorers | Where-Object { $_.SessionId -eq $currentSessionId }) + @($explorers | Where-Object { $_.SessionId -ne $currentSessionId })
    }

    foreach ($explorer in $explorers) {
      try {
        $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwner -ErrorAction Stop
        if ($owner.ReturnValue -eq 0 -and -not [string]::IsNullOrWhiteSpace($owner.User)) {
          $candidateUser = $owner.User.Trim()
          if ($candidateUser -match '^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$' -or
              $candidateUser -match '^(DWM-|UMFD-)') {
            continue
          }

          if ([string]::IsNullOrWhiteSpace($owner.Domain)) {
            return $candidateUser
          }

          return "$($owner.Domain)\$candidateUser"
        }
      } catch {
        # Try next explorer process.
      }
    }
  } catch {
    # Fall through to current identity and computer-system lookup.
  }

  if (-not [string]::IsNullOrWhiteSpace($currentUser) -and
      -not $currentUser.Equals('NT AUTHORITY\SYSTEM', [StringComparison]::OrdinalIgnoreCase) -and
      -not $currentUser.Equals('SYSTEM', [StringComparison]::OrdinalIgnoreCase)) {
    return $currentUser
  }

  try {
    $interactiveUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
    if (-not [string]::IsNullOrWhiteSpace($interactiveUser)) {
      return $interactiveUser
    }
  } catch {
    # Fall through to current identity.
  }

  return $currentUser
}

function Get-TaskUserCandidates {
  $candidates = New-Object System.Collections.Generic.List[string]

  function Add-Candidate([string]$value) {
    $normalized = ''
    if ($null -ne $value) {
      $normalized = $value.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($normalized)) {
      return
    }

    foreach ($existing in $candidates) {
      if ($existing.Equals($normalized, [StringComparison]::OrdinalIgnoreCase)) {
        return
      }
    }

    $candidates.Add($normalized)
  }

  Add-Candidate (Resolve-TaskUser)
  Add-Candidate ([Security.Principal.WindowsIdentity]::GetCurrent().Name)

  if (-not [string]::IsNullOrWhiteSpace($env:USERDOMAIN) -and -not [string]::IsNullOrWhiteSpace($env:USERNAME)) {
    Add-Candidate ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME)
  }

  Add-Candidate $env:USERNAME

  return @($candidates)
}

function ConvertTo-ExeArgumentString {
  param([string[]]$Args)

  $parts = foreach ($arg in $Args) {
    if ($null -eq $arg) {
      '""'
      continue
    }

    if ($arg -match '[\s"]') {
      '"' + $arg.Replace('"', '\"') + '"'
    } else {
      $arg
    }
  }

  return ($parts -join ' ')
}

function ConvertTo-EncodedLaunchCommand {
  param(
    [string]$ExePath,
    [string[]]$Arguments
  )

  $escapedExe = $ExePath.Replace("'", "''")
  $argLines = foreach ($arg in $Arguments) {
    "'" + ($arg.Replace("'", "''")) + "'"
  }

  $script = @(
    '$argv = @('
    ($argLines -join ",`r`n")
    ')'
    "& '$escapedExe' @argv"
  ) -join "`r`n"

  return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
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
  $taskUsers = @(Get-TaskUserCandidates)
  if ($taskUsers.Count -eq 0) {
    throw "Unable to resolve task user for scheduled task '$TaskName'."
  }
  $argsList = @(
    "--port=$Port"
    "--service-name=$ServiceName"
    "--logical-name=$LogicalName"
    "--scanner-mode=$ScannerMode"
    "--claim-timeout-ms=$ClaimTimeoutMs"
    "--log-level=$LogLevel"
  )

  if ($HostMode -eq 'agent-relay') {
    $argsList += @(
      '--agent-relay'
      "--bridge-base-url=$BridgeBaseUrl"
    )
  } elseif ($HostMode -eq 'tray-companion') {
    $argsList = @(
      '--tray-companion'
      "--port=$Port"
      "--service-name=$ServiceName"
      "--bridge-base-url=$BridgeBaseUrl"
      "--logical-name=$LogicalName"
      "--scanner-mode=$ScannerMode"
      "--log-level=$LogLevel"
    )
  }

  if ($HideWindow) {
    # Let the EXE hide its own console window. Running directly is more reliable than a hidden PowerShell wrapper.
    $argsList += '--hide-console=true'
  }

  $argLine = ConvertTo-ExeArgumentString -Args $argsList
  $workingDir = Split-Path -Parent $exe
  $action = New-ScheduledTaskAction -Execute $exe -Argument $argLine -WorkingDirectory $workingDir
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
  $registerErrors = New-Object System.Collections.Generic.List[string]
  $registeredForUser = ''

  foreach ($taskUser in $taskUsers) {
    try {
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
      $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Highest
      $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
      Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
      $registeredForUser = $taskUser
      break
    } catch {
      $registerErrors.Add(("{0}: {1}" -f $taskUser, $_.Exception.Message))
      Write-Warning ("Unable to register task '{0}' for user '{1}': {2}" -f $TaskName, $taskUser, $_.Exception.Message)
    }
  }

  if ([string]::IsNullOrWhiteSpace($registeredForUser)) {
    $detail = ($registerErrors -join '; ')
    throw "Unable to register task '$TaskName' for any candidate user. $detail"
  }

  Write-Host ("Scheduled task '{0}' registered for user '{1}'." -f $TaskName, $registeredForUser)
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
