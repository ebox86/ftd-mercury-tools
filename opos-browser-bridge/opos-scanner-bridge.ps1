param(
  [string]$LogicalName = "ZEBRA_SCANNER",
  [int]$Port = 17331,
  [int]$ClaimTimeoutMs = 3000,
  [int]$DefaultLeaseMs = 3500,
  [int]$MaxLeaseMs = 12000,
  [string]$InteropDllPath = "C:\Wings\Interop.OposScanner_1_9_Lib.dll",
  [string]$LogDirectory = "C:\ProgramData\FTD\OposBridge\Logs",
  [int]$MaxLogFileBytes = 1048576,
  [int]$MaxLogFiles = 5,
  [string]$EventLogName = "Application",
  [string]$EventLogSource = "FTD.OposBridge",
  [int]$PollingDebounceMs = 1200,
  [switch]$DisablePollingFallback,
  [switch]$DisableEventLog,
  [switch]$VerboseLogging
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$script:BridgeVersion = "1.3.4"
$script:LogFilePath = $null
$script:EventLogEnabled = $false
$script:EventLogSourceResolved = "Windows PowerShell"
$script:InstanceMutex = $null
$script:InstanceMutexName = ""
$script:LastPolledDataCount = -1
$script:LastPolledValue = ""
$script:LastPolledAt = [DateTime]::MinValue
$script:LastEmittedValue = ""
$script:LastEmittedDataCount = -1
$script:LastEmittedAt = [DateTime]::MinValue
$script:DuplicateEmitWindowMs = [Math]::Max(300, $PollingDebounceMs)
$script:ReplayGuardWindowMs = [Math]::Max(1500, [int]($PollingDebounceMs * 3))
$script:LastDeliveredSeq = [int64]0
$script:LastDeliveredSeqByOwner = @{}
$script:LastDeliveredValue = ""
$script:ReplayGuardValue = ""
$script:ReplayGuardUntil = [DateTime]::MinValue
$script:ClaimBaselineGuardMs = [Math]::Max(700, [int]($PollingDebounceMs + 150))
$script:ScannerClaimed = $false
$script:ScannerLeaseOwner = ""
$script:ScannerLeaseUntil = [DateTime]::MinValue
$script:ScannerLeaseDefaultMs = [Math]::Max(1000, $DefaultLeaseMs)
$script:ScannerLeaseMaxMs = [Math]::Max($script:ScannerLeaseDefaultMs, $MaxLeaseMs)

function Rotate-BridgeLogIfNeeded {
  if ([string]::IsNullOrWhiteSpace($script:LogFilePath)) { return }
  try {
    if (-not (Test-Path $script:LogFilePath)) { return }
    $maxBytes = [Math]::Max(262144, $MaxLogFileBytes)
    $maxFiles = [Math]::Max(2, $MaxLogFiles)
    $size = (Get-Item -Path $script:LogFilePath -ErrorAction SilentlyContinue).Length
    if ($size -lt $maxBytes) { return }

    for ($i = $maxFiles - 1; $i -ge 1; $i--) {
      $src = "$($script:LogFilePath).$i"
      $dst = "$($script:LogFilePath).$($i + 1)"
      if (Test-Path $dst) { Remove-Item -Path $dst -Force -ErrorAction SilentlyContinue }
      if (Test-Path $src) { Move-Item -Path $src -Destination $dst -Force -ErrorAction SilentlyContinue }
    }

    $firstArchive = "$($script:LogFilePath).1"
    if (Test-Path $firstArchive) { Remove-Item -Path $firstArchive -Force -ErrorAction SilentlyContinue }
    Move-Item -Path $script:LogFilePath -Destination $firstArchive -Force -ErrorAction SilentlyContinue
  } catch {
    # Avoid throwing from log rotation.
  }
}

function Initialize-BridgeLogging {
  try {
    if (-not (Test-Path $LogDirectory)) {
      New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    }
    $script:LogFilePath = Join-Path $LogDirectory "opos-scanner-bridge.log"
  } catch {
    $script:LogFilePath = $null
  }
}

function Initialize-BridgeEventLog {
  if ($DisableEventLog) { return }

  $resolved = "Windows PowerShell"
  $enabled = $true
  try {
    if (-not [string]::IsNullOrWhiteSpace($EventLogSource)) {
      if ([System.Diagnostics.EventLog]::SourceExists($EventLogSource)) {
        $resolved = $EventLogSource
      } else {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($isAdmin) {
          New-EventLog -LogName $EventLogName -Source $EventLogSource -ErrorAction Stop
          $resolved = $EventLogSource
        }
      }
    }
  } catch {
    # Keep fallback source enabled if custom source probing/registration fails.
    $enabled = $true
  }
  $script:EventLogSourceResolved = $resolved
  $script:EventLogEnabled = $enabled
}

function Write-Log {
  param(
    [string]$Message,
    [ValidateSet("DEBUG", "INFO", "WARN", "ERROR")] [string]$Level = "INFO",
    [int]$EventId = 1000
  )

  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
  $line = "[$stamp] [$Level] $Message"

  Rotate-BridgeLogIfNeeded
  if (-not [string]::IsNullOrWhiteSpace($script:LogFilePath)) {
    try {
      Add-Content -Path $script:LogFilePath -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {}
  }

  if ($VerboseLogging -or $Level -ne "INFO") {
    Write-Host $line
  }

  if ($script:EventLogEnabled -and $Level -ne "DEBUG") {
    try {
      $entryType = [System.Diagnostics.EventLogEntryType]::Information
      if ($Level -eq "WARN") { $entryType = [System.Diagnostics.EventLogEntryType]::Warning }
      if ($Level -eq "ERROR") { $entryType = [System.Diagnostics.EventLogEntryType]::Error }
      Write-EventLog -LogName $EventLogName -Source $script:EventLogSourceResolved -EntryType $entryType -EventId $EventId -Message $Message -ErrorAction Stop
    } catch {
      $script:EventLogEnabled = $false
    }
  }
}

function To-JsonBytes {
  param([object]$Object)
  return [System.Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Depth 8 -Compress))
}

function Write-Response {
  param(
    [Parameter(Mandatory = $true)] [System.Net.HttpListenerContext] $Context,
    [int]$StatusCode = 200,
    [object]$Body = $null
  )

  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.ContentType = "application/json; charset=utf-8"
  $response.Headers["Access-Control-Allow-Origin"] = "*"
  $response.Headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
  $response.Headers["Access-Control-Allow-Headers"] = "Content-Type"

  if ($null -ne $Body) {
    $bytes = To-JsonBytes -Object $Body
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $response.ContentLength64 = 0
  }

  $response.OutputStream.Close()
}

function Acquire-BridgeInstanceLock {
  $mutexBaseName = "FTD.OposBridge.Port$Port"

  foreach ($scope in @("Global", "Local")) {
    $createdNew = $false
    $mutexName = "$scope\$mutexBaseName"
    try {
      $candidateMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    } catch {
      if ($scope -eq "Global") {
        Write-Log "Global mutex unavailable, falling back to Local scope: $($_.Exception.Message)" -Level WARN -EventId 1201
        continue
      }
      throw "Failed to create '$mutexName': $($_.Exception.Message)"
    }

    if (-not $createdNew) {
      try { $candidateMutex.Dispose() } catch {}
      throw "Another bridge instance already holds mutex '$mutexName'."
    }

    $script:InstanceMutex = $candidateMutex
    $script:InstanceMutexName = $mutexName
    return
  }

  throw "Failed to acquire single-instance lock for '$mutexBaseName'."
}

function Normalize-LeaseOwner {
  param([string]$Owner)
  $raw = [string]$Owner
  if ([string]::IsNullOrWhiteSpace($raw)) { return "anonymous" }
  $trimmed = ($raw -replace "[^\w\-\.:]", "").Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) { return "anonymous" }
  if ($trimmed.Length -gt 80) { return $trimmed.Substring(0, 80) }
  return $trimmed
}

function Get-LeaseRemainingMs {
  if ($script:ScannerLeaseUntil -le (Get-Date)) { return 0 }
  return [Math]::Max(0, [int](($script:ScannerLeaseUntil - (Get-Date)).TotalMilliseconds))
}

function Set-ScannerStatus {
  param([string]$Status)
  $global:OposBridgeState.scannerStatus = $Status
}

function Clear-LastScanPayload {
  $global:OposBridgeState.lastScan = [ordered]@{
    seq = [int64]$global:OposBridgeState.lastSeq
    value = ""
    label = ""
    raw = ""
    dataType = 0
    source = ""
    at = ""
  }
}

function Clear-LeaseTracking {
  $script:ScannerLeaseOwner = ""
  $script:ScannerLeaseUntil = [DateTime]::MinValue
}

function Apply-ScannerRuntimeSettings {
  param([object]$ScannerObject = $scanner)
  if ($ScannerObject -eq $null) { return }
  try { $ScannerObject.FreezeEvents = $false } catch {}
  try { $ScannerObject.AutoDisable = $false } catch {}
  try { $ScannerObject.DecodeData = $true } catch {}
  try { $ScannerObject.DeviceEnabled = $true } catch {}
  try { $ScannerObject.DataEventEnabled = $true } catch {}
}

function Initialize-ClaimBaseline {
  if ($scanner -eq $null) { return }
  $snapshot = Read-ScannerSnapshot
  $baselineValue = ""
  $baselineDataCount = -1
  try { $baselineValue = [string]$snapshot.value } catch { $baselineValue = "" }
  try { $baselineDataCount = [int]$snapshot.dataCount } catch { $baselineDataCount = -1 }

  $now = Get-Date
  $script:LastPolledValue = $baselineValue
  $script:LastPolledDataCount = $baselineDataCount
  $script:LastPolledAt = $now

  if (-not [string]::IsNullOrWhiteSpace($baselineValue)) {
    $guardMs = [Math]::Max(250, $script:ClaimBaselineGuardMs)
    $script:ReplayGuardValue = $baselineValue
    $script:ReplayGuardUntil = $now.AddMilliseconds($guardMs)
    if ($VerboseLogging) {
      Write-Log "Claim baseline armed (value='$baselineValue', dataCount=$baselineDataCount, guardMs=$guardMs)" -Level DEBUG
    }
  }
}

function Ensure-ScannerClaim {
  param(
    [int]$TimeoutMs = $ClaimTimeoutMs,
    [string]$Reason = "lease"
  )

  if ($scanner -eq $null) { return $false }
  if ($script:ScannerClaimed) {
    Apply-ScannerRuntimeSettings -ScannerObject $scanner
    Set-ScannerStatus -Status "ready"
    return $true
  }

  try {
    $claimResult = $scanner.ClaimDevice([Math]::Max(100, $TimeoutMs))
    if ($claimResult -ne 0) {
      throw "ClaimDevice($TimeoutMs) failed with OPOS result $claimResult"
    }
    Apply-ScannerRuntimeSettings -ScannerObject $scanner
    Initialize-ClaimBaseline
    $script:ScannerClaimed = $true
    Set-ScannerStatus -Status "ready"
    Write-Log "Scanner claim acquired (reason=$Reason)."
    return $true
  } catch {
    $script:ScannerClaimed = $false
    $global:OposBridgeState.lastError = "Scanner claim failed ($Reason): $($_.Exception.Message)"
    Set-ScannerStatus -Status "open"
    Write-Log $global:OposBridgeState.lastError -Level WARN -EventId 2103
    return $false
  }
}

function Release-ScannerClaim {
  param([string]$Reason = "lease-release")
  if ($scanner -eq $null) {
    $script:ScannerClaimed = $false
    Clear-LeaseTracking
    return $false
  }

  if (-not $script:ScannerClaimed) {
    Clear-LeaseTracking
    Set-ScannerStatus -Status "open"
    return $false
  }

  try { $scanner.DataEventEnabled = $false } catch {}
  try { $scanner.DeviceEnabled = $false } catch {}
  try { [void]$scanner.ReleaseDevice() } catch {}
  $script:ScannerClaimed = $false
  $script:LastPolledDataCount = -1
  $script:LastPolledValue = ""
  $script:LastPolledAt = [DateTime]::MinValue
  $script:LastEmittedValue = ""
  $script:LastEmittedDataCount = -1
  $script:LastEmittedAt = [DateTime]::MinValue
  $script:LastDeliveredValue = ""
  $script:ReplayGuardValue = ""
  $script:ReplayGuardUntil = [DateTime]::MinValue
  $script:LastDeliveredSeqByOwner = @{}
  Clear-LeaseTracking
  Clear-LastScanPayload
  Set-ScannerStatus -Status "open"
  Write-Log "Scanner claim released (reason=$Reason)."
  return $true
}

function Acquire-OrRenewScannerLease {
  param(
    [string]$Owner = "anonymous",
    [int]$RequestedMs = 0
  )
  $leaseOwner = Normalize-LeaseOwner -Owner $Owner
  $leaseMs = if ($RequestedMs -gt 0) { $RequestedMs } else { $script:ScannerLeaseDefaultMs }
  $leaseMs = [Math]::Min($script:ScannerLeaseMaxMs, [Math]::Max(500, $leaseMs))
  $claimed = Ensure-ScannerClaim -TimeoutMs $ClaimTimeoutMs -Reason "lease:$leaseOwner"
  if (-not $claimed) { return $false }
  $script:ScannerLeaseOwner = $leaseOwner
  $script:ScannerLeaseUntil = (Get-Date).AddMilliseconds($leaseMs)
  return $true
}

function Maintain-ScannerLease {
  if (-not $script:ScannerClaimed) { return }
  if ($script:ScannerLeaseUntil -eq [DateTime]::MinValue) { return }
  if ((Get-Date) -lt $script:ScannerLeaseUntil) { return }
  [void](Release-ScannerClaim -Reason "lease-expired")
}

function Normalize-ScanValue {
  param([string]$InputValue)
  if ($null -eq $InputValue) { return "" }
  return (($InputValue -replace "[^\x20-\x7E]", "").Trim())
}

function Read-ScannerSnapshot {
  if ($scanner -eq $null) {
    return [pscustomobject]@{ value = ""; label = ""; raw = ""; dataCount = -1; dataType = 0 }
  }

  $label = ""
  $raw = ""
  $value = ""
  $dataCount = -1
  $dataType = 0

  try { $label = [string]$scanner.ScanDataLabel } catch { $label = "" }
  try { $raw = [string]$scanner.ScanData } catch { $raw = "" }
  try { $dataCount = [int]$scanner.DataCount } catch { $dataCount = -1 }
  try { $dataType = [int]$scanner.ScanDataType } catch { $dataType = 0 }

  $value = if ([string]::IsNullOrWhiteSpace($label)) { $raw } else { $label }
  $value = Normalize-ScanValue -InputValue $value

  return [pscustomobject]@{
    value = $value
    label = $label
    raw = $raw
    dataCount = $dataCount
    dataType = $dataType
  }
}

function Drain-ScannerBuffer {
  param(
    [int]$MaxIterations = 8,
    [int]$DelayMs = 25
  )

  if ($scanner -eq $null) { return (Read-ScannerSnapshot) }

  $iterations = [Math]::Max(1, $MaxIterations)
  $delay = [Math]::Max(0, $DelayMs)
  $snapshot = Read-ScannerSnapshot

  for ($i = 0; $i -lt $iterations; $i++) {
    if ([string]::IsNullOrWhiteSpace([string]$snapshot.value)) { break }
    try { $scanner.ClearInput() } catch {}
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    $next = Read-ScannerSnapshot
    $sameValue = ([string]$next.value -eq [string]$snapshot.value)
    $sameCount = ([int]$next.dataCount -eq [int]$snapshot.dataCount)
    $snapshot = $next
    if ($sameValue -and $sameCount) { break }
  }

  return $snapshot
}

function Update-ScanState {
  param(
    [string]$Value,
    [string]$Label,
    [string]$Raw,
    [int]$DataType = 0,
    [string]$Source = "event",
    [int]$DataCount = -1
  )

  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }

  $now = Get-Date
  $sinceLastEmitMs = [double]::PositiveInfinity
  if ($script:LastEmittedAt -ne [DateTime]::MinValue) {
    $sinceLastEmitMs = ($now - $script:LastEmittedAt).TotalMilliseconds
  }
  # After /scan/clear or /scan/next delivery, some OPOS stacks replay the previous label.
  # Suppress that stale replay window for all sources.
  if (-not [string]::IsNullOrWhiteSpace($script:ReplayGuardValue)) {
    if ($Value -eq $script:ReplayGuardValue -and $now -lt $script:ReplayGuardUntil) {
      return $false
    }
  }

  # Suppress stale duplicate echoes while still allowing intentional rescans.
  # Rule set:
  # 1) Same Value + same DataCount => suppress only during short duplicate window.
  # 2) Same Value + unknown DataCount => suppress only during short duplicate window.
  # 3) Same Value outside duplicate window => allow.
  # 4) Same Value + advanced DataCount => allow immediately.
  if ($Value -eq $script:LastEmittedValue) {
    $withinDuplicateWindow = $sinceLastEmitMs -lt $script:DuplicateEmitWindowMs
    if ($DataCount -ge 0 -and $script:LastEmittedDataCount -ge 0) {
      if ($DataCount -eq $script:LastEmittedDataCount -and $withinDuplicateWindow) { return $false }
    } elseif ($withinDuplicateWindow) {
      return $false
    }
  }

  $nextSeq = [int64]$global:OposBridgeState.lastSeq + 1
  $global:OposBridgeState.lastSeq = $nextSeq
  $global:OposBridgeState.lastScan = [ordered]@{
    seq = $nextSeq
    value = $Value
    label = $Label
    raw = $Raw
    dataType = $DataType
    source = $Source
    at = (Get-Date).ToString("o")
  }
  $script:LastEmittedValue = $Value
  $script:LastEmittedDataCount = $DataCount
  $script:LastEmittedAt = $now
  if ($Value -ne $script:ReplayGuardValue) {
    $script:ReplayGuardValue = ""
    $script:ReplayGuardUntil = [DateTime]::MinValue
  }
  return $true
}

function Poll-ScannerState {
  if ($DisablePollingFallback) { return }
  if ($scanner -eq $null) { return }
  if (-not $script:ScannerClaimed) { return }
  if ($global:OposBridgeState.scannerStatus -ne "ready") { return }

  $dataCount = -1
  $label = ""
  $raw = ""
  $value = ""
  $dataType = 0

  try {
    $deviceEnabled = $true
    try { $deviceEnabled = [bool]$scanner.DeviceEnabled } catch { $deviceEnabled = $true }
    if (-not $deviceEnabled) {
      Apply-ScannerRuntimeSettings -ScannerObject $scanner
    }
    try { $dataCount = [int]$scanner.DataCount } catch { $dataCount = -1 }
    try { $label = [string]$scanner.ScanDataLabel } catch { $label = "" }
    try { $raw = [string]$scanner.ScanData } catch { $raw = "" }
    try { $dataType = [int]$scanner.ScanDataType } catch { $dataType = 0 }
  } catch {
    return
  }

  $value = if ([string]::IsNullOrWhiteSpace($label)) { $raw } else { $label }
  $value = Normalize-ScanValue -InputValue $value
  if ([string]::IsNullOrWhiteSpace($value)) {
    # Reset polling baseline when scanner reports empty.
    $script:LastPolledValue = ""
    $script:LastPolledDataCount = $dataCount
    $script:LastPolledAt = Get-Date
    return
  }

  $now = Get-Date
  $capture = $false

  if ($dataCount -ge 0) {
    if ($dataCount -ne $script:LastPolledDataCount -or $value -ne $script:LastPolledValue) {
      $capture = $true
    }
  } else {
    # With unknown DataCount, never emit the same value repeatedly on timer.
    # Capture only on observed value change.
    if ($value -ne $script:LastPolledValue) { $capture = $true }
  }

  if (-not $capture) {
    # Do not clear on unchanged snapshots.
    # Some OPOS stacks keep DataCount at 0 while a stale label is visible, and
    # frequent ClearInput calls can mask subsequent same-label rescans.
    # We wait for either value/dataCount change (or DataEvent) to confirm a new scan.
    try { $scanner.DataEventEnabled = $true } catch {}
    return
  }

  $accepted = Update-ScanState -Value $value -Label $label -Raw $raw -DataType $dataType -Source "poll" -DataCount $dataCount
  $script:LastPolledValue = $value
  $script:LastPolledDataCount = $dataCount
  $script:LastPolledAt = $now
  try { $scanner.ClearInput() } catch {}
  if ($VerboseLogging) {
    if ($accepted) {
      Write-Log "Polling fallback captured scan (dataCount=$dataCount)" -Level DEBUG
    } else {
      Write-Log "Polling suppressed stale scan (dataCount=$dataCount)" -Level DEBUG
    }
  }

  try { $scanner.DataEventEnabled = $true } catch {}
}

Initialize-BridgeLogging
Initialize-BridgeEventLog
Acquire-BridgeInstanceLock
Write-Log "Starting OPOS bridge v$script:BridgeVersion (LogicalName=$LogicalName, Port=$Port, PID=$PID, Mutex=$script:InstanceMutexName)" -Level INFO -EventId 1100

if (-not (Test-Path $InteropDllPath)) {
  throw "Interop DLL not found: $InteropDllPath"
}

Add-Type -Path $InteropDllPath

$global:OposBridgeState = [hashtable]::Synchronized(@{
  bridgeVersion = $script:BridgeVersion
  startedAt = (Get-Date).ToString("o")
  processId = $PID
  hostVersion = [string]$PSVersionTable.PSVersion
  scannerLogicalName = $LogicalName
  scannerStatus = "starting"
  lastError = ""
  lastSeq = [int64]0
  lastScan = [ordered]@{
    seq = [int64]0
    value = ""
    label = ""
    raw = ""
    dataType = 0
    source = ""
    at = ""
  }
  service = [ordered]@{
    port = $Port
    url = "http://127.0.0.1:$Port"
  }
  logging = [ordered]@{
    logDirectory = $LogDirectory
    logFile = $(if ([string]::IsNullOrWhiteSpace($script:LogFilePath)) { "" } else { $script:LogFilePath })
    eventLogEnabled = [bool]$script:EventLogEnabled
    eventLogSource = $script:EventLogSourceResolved
    instanceLock = $script:InstanceMutexName
  }
})

$scanner = $null
$listener = $null
$subscriptions = @()

function Cleanup {
  Write-Log "Cleaning up bridge resources..."
  foreach ($sub in $subscriptions) {
    try { Unregister-Event -SourceIdentifier $sub.Name -ErrorAction SilentlyContinue } catch {}
    try { Remove-Job -Id $sub.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  $subscriptions = @()

  if ($scanner -ne $null) {
    [void](Release-ScannerClaim -Reason "shutdown")
    try { [void]$scanner.Close() } catch {}
  }
  if ($listener -ne $null) {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
  }
  if ($script:InstanceMutex -ne $null) {
    try { $script:InstanceMutex.ReleaseMutex() | Out-Null } catch {}
    try { $script:InstanceMutex.Dispose() } catch {}
    $script:InstanceMutex = $null
    $script:InstanceMutexName = ""
  }
  $global:OposBridgeState.scannerStatus = "stopped"
  Write-Log "Bridge stopped." -Level INFO -EventId 1101
}

try {
  Write-Log "Creating OPOS scanner control object..."
  $scanner = New-Object OposScanner_1_9_Lib.OPOSScannerClass

  $openResult = $scanner.Open($LogicalName)
  if ($openResult -ne 0) {
    throw "Open($LogicalName) failed with OPOS result $openResult"
  }
  Set-ScannerStatus -Status "open"
  Clear-LeaseTracking
  Write-Log "Scanner opened (unclaimed). LogicalName=$LogicalName, OpenResult=$($scanner.OpenResult)"

  $subscriptions += Register-ObjectEvent -InputObject $scanner -EventName DataEvent -SourceIdentifier "OposBridge.DataEvent" -Action {
    try {
      $s = $event.Sender
      if (-not $script:ScannerClaimed) { return }
      $label = [string]$s.ScanDataLabel
      $raw = [string]$s.ScanData
      $value = if ([string]::IsNullOrWhiteSpace($label)) { $raw } else { $label }
      $value = Normalize-ScanValue -InputValue $value
      $dataCount = -1
      try { $dataCount = [int]$s.DataCount } catch { $dataCount = -1 }
      [void](Update-ScanState -Value $value -Label $label -Raw $raw -DataType ([int]$s.ScanDataType) -Source "event" -DataCount $dataCount)

      $script:LastPolledValue = $value
      $script:LastPolledDataCount = $dataCount
      $script:LastPolledAt = Get-Date
      try { $s.ClearInput() } catch {}
      if ($script:ScannerClaimed) { Apply-ScannerRuntimeSettings -ScannerObject $s }
    } catch {
      $global:OposBridgeState.lastError = "DataEvent handler error: $($_.Exception.Message)"
      Write-Log $global:OposBridgeState.lastError -Level ERROR -EventId 2101
      if ($script:ScannerClaimed) { try { $event.Sender.DataEventEnabled = $true } catch {} }
    }
  }

  $subscriptions += Register-ObjectEvent -InputObject $scanner -EventName ErrorEvent -SourceIdentifier "OposBridge.ErrorEvent" -Action {
    try {
      $global:OposBridgeState.lastError = "Scanner ErrorEvent received at $((Get-Date).ToString('o'))"
      Write-Log $global:OposBridgeState.lastError -Level WARN -EventId 2102
      if ($script:ScannerClaimed) { try { $event.Sender.DataEventEnabled = $true } catch {} }
    } catch {}
  }

  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:$Port/")
  $listener.Start()
  Write-Log "HTTP listener started at http://127.0.0.1:$Port/"

  while ($listener.IsListening) {
    $pending = $listener.BeginGetContext($null, $null)
    while ($listener.IsListening -and -not $pending.AsyncWaitHandle.WaitOne(100)) {
      Maintain-ScannerLease
      Poll-ScannerState
    }
    if (-not $listener.IsListening) { break }

    $context = $listener.EndGetContext($pending)
    $request = $context.Request
    Maintain-ScannerLease
    Poll-ScannerState
    $path = [string]$request.Url.AbsolutePath
    if ($path.Length -gt 1) { $path = $path.TrimEnd("/") }
    $path = $path.ToLowerInvariant()

    if ($request.HttpMethod -eq "OPTIONS") {
      Write-Response -Context $context -StatusCode 204 -Body $null
      continue
    }

    try {
      switch ($path) {
        "/" {
          $leaseRemainingMs = Get-LeaseRemainingMs
          Write-Response -Context $context -Body @{
            ok = $true
            name = "opos-scanner-bridge"
            version = $script:BridgeVersion
            startedAt = $global:OposBridgeState.startedAt
            processId = $global:OposBridgeState.processId
            scannerLogicalName = $global:OposBridgeState.scannerLogicalName
            scannerStatus = $global:OposBridgeState.scannerStatus
            scannerClaimed = [bool]$script:ScannerClaimed
            scannerLeaseOwner = $script:ScannerLeaseOwner
            scannerLeaseRemainingMs = $leaseRemainingMs
            port = $Port
          }
        }
        "/health" {
          $guardRemainingMs = 0
          $leaseRemainingMs = Get-LeaseRemainingMs
          $scannerDeviceEnabled = $null
          $scannerAutoDisable = $null
          if ($scanner -ne $null) {
            try { $scannerDeviceEnabled = [bool]$scanner.DeviceEnabled } catch { $scannerDeviceEnabled = $null }
            try { $scannerAutoDisable = [bool]$scanner.AutoDisable } catch { $scannerAutoDisable = $null }
          }
          if ($script:ReplayGuardUntil -gt (Get-Date)) {
            $guardRemainingMs = [int](($script:ReplayGuardUntil - (Get-Date)).TotalMilliseconds)
          }
          Write-Response -Context $context -Body @{
            ok = $true
            version = $script:BridgeVersion
            processId = $global:OposBridgeState.processId
            scannerLogicalName = $global:OposBridgeState.scannerLogicalName
            scannerStatus = $global:OposBridgeState.scannerStatus
            scannerClaimed = [bool]$script:ScannerClaimed
            scannerDeviceEnabled = $scannerDeviceEnabled
            scannerAutoDisable = $scannerAutoDisable
            scannerLeaseOwner = $script:ScannerLeaseOwner
            scannerLeaseRemainingMs = $leaseRemainingMs
            scannerLeaseExpiresAt = $(if ($leaseRemainingMs -gt 0) { $script:ScannerLeaseUntil.ToString("o") } else { "" })
            scannerLeaseDefaultMs = $script:ScannerLeaseDefaultMs
            scannerLeaseMaxMs = $script:ScannerLeaseMaxMs
            lastError = $global:OposBridgeState.lastError
            lastSeq = $global:OposBridgeState.lastSeq
            logFile = $global:OposBridgeState.logging.logFile
            eventLogEnabled = $global:OposBridgeState.logging.eventLogEnabled
            eventLogSource = $global:OposBridgeState.logging.eventLogSource
            instanceLock = $global:OposBridgeState.logging.instanceLock
            replayGuardActive = (-not [string]::IsNullOrWhiteSpace($script:ReplayGuardValue) -and $guardRemainingMs -gt 0)
            replayGuardRemainingMs = $guardRemainingMs
            replayGuardWindowMs = $script:ReplayGuardWindowMs
            duplicateEmitWindowMs = $script:DuplicateEmitWindowMs
            startedAt = $global:OposBridgeState.startedAt
            now = (Get-Date).ToString("o")
          }
        }
        "/scan/latest" {
          Write-Response -Context $context -Body @{
            ok = $true
            scan = $global:OposBridgeState.lastScan
            scannerStatus = $global:OposBridgeState.scannerStatus
            lastError = $global:OposBridgeState.lastError
          }
        }
        "/scan/next" {
          $owner = Normalize-LeaseOwner -Owner ([string]$request.QueryString["owner"])
          if ([string]::IsNullOrWhiteSpace($owner)) { $owner = "anonymous" }

          if ($script:LastDeliveredSeqByOwner.Count -gt 256 -and -not $script:LastDeliveredSeqByOwner.ContainsKey($owner)) {
            $preserve = @{}
            if (-not [string]::IsNullOrWhiteSpace($script:ScannerLeaseOwner) -and $script:LastDeliveredSeqByOwner.ContainsKey($script:ScannerLeaseOwner)) {
              try { $preserve[$script:ScannerLeaseOwner] = [int64]$script:LastDeliveredSeqByOwner[$script:ScannerLeaseOwner] } catch {}
            }
            $script:LastDeliveredSeqByOwner = $preserve
          }

          $ownerDeliveredSeq = [int64]$script:LastDeliveredSeq
          if ($script:LastDeliveredSeqByOwner.ContainsKey($owner)) {
            try { $ownerDeliveredSeq = [int64]$script:LastDeliveredSeqByOwner[$owner] } catch { $ownerDeliveredSeq = [int64]$script:LastDeliveredSeq }
          } else {
            $ownerDeliveredSeq = [int64]$script:LastDeliveredSeq
            $script:LastDeliveredSeqByOwner[$owner] = $ownerDeliveredSeq
          }

          $scan = $global:OposBridgeState.lastScan
          $seq = [int64]($scan.seq -as [int64])
          if ($seq -gt $ownerDeliveredSeq -and -not [string]::IsNullOrWhiteSpace([string]$scan.value)) {
            $script:LastDeliveredSeqByOwner[$owner] = $seq
            if ($seq -gt $script:LastDeliveredSeq) {
              $script:LastDeliveredSeq = $seq
            }
            $deliveredScan = $scan
            $deliveredValue = ""
            try { $deliveredValue = Normalize-ScanValue -InputValue ([string]$deliveredScan.value) } catch { $deliveredValue = "" }
            $script:LastDeliveredValue = $deliveredValue
            if (-not [string]::IsNullOrWhiteSpace($deliveredValue)) {
              $script:ReplayGuardValue = $deliveredValue
              $script:ReplayGuardUntil = (Get-Date).AddMilliseconds($script:ReplayGuardWindowMs)
            }
            Write-Response -Context $context -Body @{
              ok = $true
              owner = $owner
              scan = $deliveredScan
              scannerStatus = $global:OposBridgeState.scannerStatus
              lastError = $global:OposBridgeState.lastError
            }
          } else {
            Write-Response -Context $context -Body @{
              ok = $true
              owner = $owner
              scan = [ordered]@{
                seq = [int64]$ownerDeliveredSeq
                value = ""
                label = ""
                raw = ""
                dataType = 0
                source = ""
                at = ""
              }
              scannerStatus = $global:OposBridgeState.scannerStatus
              lastError = $global:OposBridgeState.lastError
            }
          }
        }
        "/scan/clear" {
          $previousScanValue = ""
          try {
            $previousScanValue = Normalize-ScanValue -InputValue ([string]$global:OposBridgeState.lastScan.value)
          } catch {
            $previousScanValue = ""
          }
          if ([string]::IsNullOrWhiteSpace($previousScanValue)) {
            try {
              $previousScanValue = Normalize-ScanValue -InputValue ([string]$script:LastDeliveredValue)
            } catch {
              $previousScanValue = ""
            }
          }
          $baseline = Drain-ScannerBuffer -MaxIterations 10 -DelayMs 20
          $baselineDataCount = -1
          $baselineValue = ""
          try { $baselineDataCount = [int]($baseline.dataCount) } catch { $baselineDataCount = -1 }
          try { $baselineValue = [string]($baseline.value) } catch { $baselineValue = "" }
          $script:LastPolledDataCount = $baselineDataCount
          $script:LastPolledValue = $baselineValue
          $script:LastPolledAt = Get-Date
          $script:LastEmittedDataCount = $baselineDataCount
          $script:LastEmittedValue = $baselineValue
          $script:LastEmittedAt = Get-Date
          if (-not [string]::IsNullOrWhiteSpace($previousScanValue)) {
            $script:ReplayGuardValue = $previousScanValue
            $script:ReplayGuardUntil = (Get-Date).AddMilliseconds($script:ReplayGuardWindowMs)
            if ([string]::IsNullOrWhiteSpace([string]$script:LastPolledValue)) {
              $script:LastPolledValue = $previousScanValue
            }
          } elseif ($script:ReplayGuardUntil -le (Get-Date)) {
            # Preserve an active replay guard when clear is called repeatedly
            # (for example clear -> rearm -> clear during modal startup).
            $script:ReplayGuardValue = ""
            $script:ReplayGuardUntil = [DateTime]::MinValue
          }
          $script:LastDeliveredSeq = [int64]$global:OposBridgeState.lastSeq
          $script:LastDeliveredSeqByOwner = @{}
          Clear-LastScanPayload
          Write-Response -Context $context -Body @{
            ok = $true
            cleared = $true
            lastSeq = $global:OposBridgeState.lastSeq
          }
        }
        "/scanner/lease" {
          $owner = Normalize-LeaseOwner -Owner ([string]$request.QueryString["owner"])
          $requestedMs = 0
          try { $requestedMs = [int]$request.QueryString["ms"] } catch { $requestedMs = 0 }
          $requestedMs = if ($requestedMs -gt 0) { $requestedMs } else { $script:ScannerLeaseDefaultMs }
          $requestedMs = [Math]::Min($script:ScannerLeaseMaxMs, [Math]::Max(500, $requestedMs))
          $claimed = Acquire-OrRenewScannerLease -Owner $owner -RequestedMs $requestedMs
          $remainingMs = Get-LeaseRemainingMs
          Write-Response -Context $context -Body @{
            ok = $true
            claimed = [bool]$claimed
            scannerClaimed = [bool]$script:ScannerClaimed
            scannerStatus = $global:OposBridgeState.scannerStatus
            scannerLeaseOwner = $script:ScannerLeaseOwner
            scannerLeaseRemainingMs = $remainingMs
            scannerLeaseExpiresAt = $(if ($remainingMs -gt 0) { $script:ScannerLeaseUntil.ToString("o") } else { "" })
            lastError = $global:OposBridgeState.lastError
            lastSeq = $global:OposBridgeState.lastSeq
          }
        }
        "/scanner/release" {
          $owner = Normalize-LeaseOwner -Owner ([string]$request.QueryString["owner"])
          $force = ([string]$request.QueryString["force"]) -eq "1"
          $ownerMatches = [string]::IsNullOrWhiteSpace($script:ScannerLeaseOwner) -or ($owner -eq $script:ScannerLeaseOwner)
          $released = $false
          if ($force -or $ownerMatches) {
            $released = Release-ScannerClaim -Reason "api-release:$owner"
          }
          if (-not [string]::IsNullOrWhiteSpace($owner) -and $script:LastDeliveredSeqByOwner.ContainsKey($owner)) {
            [void]$script:LastDeliveredSeqByOwner.Remove($owner)
          }
          Write-Response -Context $context -Body @{
            ok = $true
            released = [bool]$released
            ownerAccepted = [bool]($force -or $ownerMatches)
            scannerClaimed = [bool]$script:ScannerClaimed
            scannerStatus = $global:OposBridgeState.scannerStatus
            scannerLeaseOwner = $script:ScannerLeaseOwner
            scannerLeaseRemainingMs = Get-LeaseRemainingMs
            lastError = $global:OposBridgeState.lastError
            lastSeq = $global:OposBridgeState.lastSeq
          }
        }
        "/scanner/rearm" {
          $rearmed = $false
          try {
            if ($scanner -ne $null -and $script:ScannerClaimed) {
              Apply-ScannerRuntimeSettings -ScannerObject $scanner
              $rearmed = $true
            }
          } catch {}
          Write-Response -Context $context -Body @{
            ok = $true
            rearmed = $rearmed
            scannerClaimed = [bool]$script:ScannerClaimed
            scannerStatus = $global:OposBridgeState.scannerStatus
            lastSeq = $global:OposBridgeState.lastSeq
          }
        }
        default {
          Write-Response -Context $context -StatusCode 404 -Body @{
            ok = $false
            error = "Not found"
            path = $path
          }
        }
      }
    } catch {
      $routeError = "Route '$path' failed: $($_.Exception.Message)"
      $global:OposBridgeState.lastError = $routeError
      Write-Log $routeError -Level ERROR -EventId 4100
      Write-Response -Context $context -StatusCode 500 -Body @{
        ok = $false
        error = $routeError
        path = $path
      }
    }
  }
}
catch {
  $global:OposBridgeState.scannerStatus = "error"
  $global:OposBridgeState.lastError = $_.Exception.Message
  Write-Log "Bridge fatal error: $($_.Exception.Message)" -Level ERROR -EventId 9100
  Write-Error $_
}
finally {
  Cleanup
}
