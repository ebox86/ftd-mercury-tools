param(
  [string]$LogicalName = "ZEBRA_SCANNER",
  [int]$Port = 17331,
  [int]$ClaimTimeoutMs = 3000,
  [int]$QueueClearThreshold = 2,
  [int]$QueueStaleMs = 1200,
  [int]$MaintenanceIntervalMs = 2000,
  [string]$InteropDllPath = "C:\Wings\Interop.OposScanner_1_9_Lib.dll",
  [switch]$VerboseLogging
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Write-Log {
  param([string]$Message)
  if ($VerboseLogging) {
    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Write-Host "[$stamp] $Message"
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

function Coerce-ScanString {
  param([object]$Value)
  if ($null -eq $Value) { return "" }
  if ($Value -is [byte[]]) {
    return [System.Text.Encoding]::ASCII.GetString($Value)
  }
  return [string]$Value
}

function Record-Scan {
  param(
    [string]$Label,
    [string]$Raw,
    [int]$DataType = 0
  )

  $labelSafe = ($Label -replace "[^\x20-\x7E]", "").Trim()
  $rawSafe = ($Raw -replace "[^\x20-\x7E]", "").Trim()
  $value = if ([string]::IsNullOrWhiteSpace($labelSafe)) { $rawSafe } else { $labelSafe }
  if ([string]::IsNullOrWhiteSpace($value)) { return }

  $nextSeq = [int64]$global:OposBridgeState.lastSeq + 1
  $global:OposBridgeState.lastSeq = $nextSeq
  $global:OposBridgeState.lastScan = [ordered]@{
    seq = $nextSeq
    value = $value
    label = $labelSafe
    raw = $rawSafe
    dataType = $DataType
    at = (Get-Date).ToString("o")
  }

  Write-Log "Recorded scan #${nextSeq}: $value"
}

function Try-RecordScanFromOposLog {
  param([string]$LogDir = "C:\Program Files\Zebra Technologies\Barcode Scanners\Scanner SDK\OPOS\Scanner OPOS\bin\Logs")

  try {
    if (-not (Test-Path $LogDir)) { return }

    $latestLog = Get-ChildItem -Path $LogDir -Filter "OPOS_SCANNER_*.log" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $latestLog) { return }

    $lines = Get-Content -Path $latestLog.FullName -Tail 400 -ErrorAction SilentlyContinue
    if (-not $lines) { return }

    $patternText = '^(?<date>\d{2}-\d{2}-\d{4}) \| (?<time>\d{2}:\d{2}:\d{2}:\d{3}).*DataEvent - ScanDataLabel = \[(?<label>[^\]]+)\]'
    $patternHex = '^(?<date>\d{2}-\d{2}-\d{4}) \| (?<time>\d{2}:\d{2}:\d{2}:\d{3}).*DataEvent - CS_DataLabel = \[(?<hex>[^\]]+)\]'
    $rows = @(
      foreach ($line in $lines) {
        if ($line -match $patternText) {
          [pscustomobject]@{
            key = "$($matches['date']) $($matches['time'])|$($matches['label'])"
            label = [string]$matches['label']
          }
        } elseif ($line -match $patternHex) {
          $hexPart = [string]$matches['hex']
          $byteMatches = [regex]::Matches($hexPart, '0x([0-9A-Fa-f]{2})')
          $bytes = @()
          foreach ($m in $byteMatches) {
            try {
              $bytes += [Convert]::ToByte($m.Groups[1].Value, 16)
            } catch {}
          }
          $decoded = ""
          if ($bytes.Count -gt 0) {
            try {
              $decoded = [System.Text.Encoding]::ASCII.GetString([byte[]]$bytes)
            } catch {}
          }
          $label = [string]($decoded -replace "[^\x20-\x7E]", "").Trim()
          if (-not [string]::IsNullOrWhiteSpace($label)) {
            [pscustomobject]@{
              key = "$($matches['date']) $($matches['time'])|$label"
              label = $label
            }
          }
        }
      }
    )

    if (-not $rows -or $rows.Count -eq 0) { return }
    $last = $rows[-1]
    if ([string]::IsNullOrWhiteSpace($last.label)) { return }
    if ($global:OposBridgeState.lastLogEventKey -eq $last.key) { return }

    $global:OposBridgeState.lastLogEventKey = $last.key
    Record-Scan -Label $last.label -Raw $last.label -DataType 0
  } catch {
    $global:OposBridgeState.lastError = "Log fallback error: $($_.Exception.Message)"
  }
}

function Ensure-ScannerInputState {
  param([switch]$Force)
  if ($scanner -eq $null) { return }

  try {
    if ($Force -or -not [bool]$scanner.DeviceEnabled) {
      $scanner.DeviceEnabled = $true
    }
  } catch {}

  try {
    if ($Force -or -not [bool]$scanner.DataEventEnabled) {
      $scanner.DataEventEnabled = $true
    }
  } catch {}
}

function Try-ClearScannerInputQueue {
  param([int]$MinCountToClear = 4)
  if ($scanner -eq $null) { return 0 }

  $before = 0
  try { $before = [int]$scanner.DataCount } catch { return 0 }
  if ($before -lt $MinCountToClear) { return $before }

  try {
    [void]$scanner.ClearInput()
    $global:OposBridgeState.queueClearCount = [int]$global:OposBridgeState.queueClearCount + 1
    $global:OposBridgeState.lastQueueClearAt = (Get-Date).ToString("o")
    Write-Log "Cleared OPOS input queue at DataCount=$before"
  } catch {
    $global:OposBridgeState.lastError = "ClearInput error: $($_.Exception.Message)"
  }

  $after = 0
  try { $after = [int]$scanner.DataCount } catch {}
  return $after
}

function Try-RecordScanFromQueue {
  if ($scanner -eq $null) { return $false }

  $count = 0
  try { $count = [int]$scanner.DataCount } catch { return $false }
  if ($count -le 0) { return $false }

  try {
    $label = Coerce-ScanString -Value $scanner.ScanDataLabel
    $raw = Coerce-ScanString -Value $scanner.ScanData
    $dataType = 0
    try { $dataType = [int]$scanner.ScanDataType } catch {}
    if (-not [string]::IsNullOrWhiteSpace([string]$label) -or -not [string]::IsNullOrWhiteSpace([string]$raw)) {
      Record-Scan -Label $label -Raw $raw -DataType $dataType
    }
    [void](Try-ClearScannerInputQueue -MinCountToClear 1)
    Ensure-ScannerInputState -Force
    return $true
  } catch {
    $global:OposBridgeState.lastError = "Queue scan read error: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-ScannerMaintenance {
  param([switch]$IncludeLogFallback)
  if ($scanner -eq $null) { return 0 }

  [void](Try-RecordScanFromQueue)

  if ($IncludeLogFallback) {
    Try-RecordScanFromOposLog
  }

  $dataCount = 0
  try { $dataCount = [int]$scanner.DataCount } catch {}
  $now = Get-Date
  if ($dataCount -gt 0) {
    if ([string]::IsNullOrWhiteSpace([string]$global:OposBridgeState.queueNonZeroSince)) {
      $global:OposBridgeState.queueNonZeroSince = $now.ToString("o")
    }

    $staleMs = 0
    try {
      $since = [datetime]::Parse([string]$global:OposBridgeState.queueNonZeroSince)
      $staleMs = ($now - $since).TotalMilliseconds
    } catch {
      $global:OposBridgeState.queueNonZeroSince = $now.ToString("o")
    }

    if ($dataCount -ge $QueueClearThreshold -or $staleMs -ge $QueueStaleMs) {
      $dataCount = Try-ClearScannerInputQueue -MinCountToClear 1
      Ensure-ScannerInputState -Force
      $global:OposBridgeState.queueNonZeroSince = ""
    }
  } else {
    $global:OposBridgeState.queueNonZeroSince = ""
  }
  return $dataCount
}

function Try-RearmScanner {
  if ($scanner -eq $null) { return $false }
  $ok = $false

  try {
    try { $scanner.DataEventEnabled = $false } catch {}
    try { [void]$scanner.ClearInput() } catch {}
    try { $scanner.DeviceEnabled = $false } catch {}
    Start-Sleep -Milliseconds 40
    try { $scanner.DeviceEnabled = $true } catch {}
    try { $scanner.DecodeData = $true } catch {}
    try { $scanner.DataEventEnabled = $true } catch {}
    Ensure-ScannerInputState -Force
    $ok = $true
  } catch {}

  if (-not $ok) {
    try {
      try { [void]$scanner.ReleaseDevice() } catch {}
      Start-Sleep -Milliseconds 80
      $claimResult = $scanner.ClaimDevice($ClaimTimeoutMs)
      if ($claimResult -eq 0) {
        try { $scanner.AutoDisable = $false } catch {}
        $scanner.DeviceEnabled = $true
        $scanner.DecodeData = $true
        $scanner.DataEventEnabled = $true
        Ensure-ScannerInputState -Force
        $ok = $true
      }
    } catch {}
  }

  if ($ok) {
    $global:OposBridgeState.rearmCount = [int]$global:OposBridgeState.rearmCount + 1
    $global:OposBridgeState.lastRearmAt = (Get-Date).ToString("o")
    Write-Log "Scanner rearm completed"
  } else {
    $global:OposBridgeState.lastError = "Scanner rearm failed at $((Get-Date).ToString('o'))"
  }
  return $ok
}

if (-not (Test-Path $InteropDllPath)) {
  throw "Interop DLL not found: $InteropDllPath"
}

Add-Type -Path $InteropDllPath

$global:OposBridgeState = [hashtable]::Synchronized(@{
  startedAt = (Get-Date).ToString("o")
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
    at = ""
  }
  service = [ordered]@{
    port = $Port
    url = "http://127.0.0.1:$Port"
  }
  lastLogEventKey = ""
  queueClearCount = 0
  lastQueueClearAt = ""
  rearmCount = 0
  lastRearmAt = ""
  queueNonZeroSince = ""
})

$scanner = $null
$listener = $null
$dataEventHandler = $null
$errorEventHandler = $null

function Cleanup {
  Write-Log "Cleaning up bridge resources..."

  if ($scanner -ne $null) {
    if ($dataEventHandler -ne $null) {
      try { $scanner.remove_DataEvent($dataEventHandler) } catch {}
      $dataEventHandler = $null
    }
    if ($errorEventHandler -ne $null) {
      try { $scanner.remove_ErrorEvent($errorEventHandler) } catch {}
      $errorEventHandler = $null
    }
    try { $scanner.DeviceEnabled = $false } catch {}
    try { [void]$scanner.ReleaseDevice() } catch {}
    try { [void]$scanner.Close() } catch {}
  }
  if ($listener -ne $null) {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
  }
  $global:OposBridgeState.scannerStatus = "stopped"
}

try {
  Write-Log "Creating OPOS scanner control object..."
  $scanner = New-Object OposScanner_1_9_Lib.OPOSScannerClass

  $openResult = $scanner.Open($LogicalName)
  if ($openResult -ne 0) {
    throw "Open($LogicalName) failed with OPOS result $openResult"
  }

  $claimResult = $scanner.ClaimDevice($ClaimTimeoutMs)
  if ($claimResult -ne 0) {
    throw "ClaimDevice($ClaimTimeoutMs) failed with OPOS result $claimResult"
  }

  try { $scanner.AutoDisable = $false } catch {}
  $scanner.DeviceEnabled = $true
  $scanner.DecodeData = $true
  $scanner.DataEventEnabled = $true
  Ensure-ScannerInputState -Force
  $global:OposBridgeState.scannerStatus = "ready"

  Write-Log "Scanner ready. LogicalName=$LogicalName, OpenResult=$($scanner.OpenResult)"

  $dataEventHandler = [OposScanner_1_9_Lib._IOPOSScannerEvents_DataEventEventHandler]{
    param([int]$Status)
    try {
      $label = Coerce-ScanString -Value $scanner.ScanDataLabel
      $raw = Coerce-ScanString -Value $scanner.ScanData
      $dataType = 0
      try { $dataType = [int]$scanner.ScanDataType } catch {}
      Record-Scan -Label $label -Raw $raw -DataType $dataType

      Ensure-ScannerInputState -Force
    } catch {
      $global:OposBridgeState.lastError = "DataEvent handler error: $($_.Exception.Message)"
      Ensure-ScannerInputState -Force
    }
  }
  $scanner.add_DataEvent($dataEventHandler)

  $errorEventHandler = [OposScanner_1_9_Lib._IOPOSScannerEvents_ErrorEventEventHandler]{
    param([int]$ResultCode, [int]$ResultCodeExtended, [int]$ErrorLocus, [ref]$pErrorResponse)
    try {
      $global:OposBridgeState.lastError = "Scanner ErrorEvent rc=$ResultCode rce=$ResultCodeExtended locus=$ErrorLocus at $((Get-Date).ToString('o'))"
      Ensure-ScannerInputState -Force
      try { $pErrorResponse.Value = 0 } catch {}
    } catch {}
  }
  $scanner.add_ErrorEvent($errorEventHandler)

  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:$Port/")
  $listener.Start()
  Write-Log "HTTP listener started at http://127.0.0.1:$Port/"

  $lastMaintenanceAt = Get-Date
  $pendingContext = $listener.BeginGetContext($null, $null)
  while ($listener.IsListening) {
    $now = Get-Date
    if (($now - $lastMaintenanceAt).TotalMilliseconds -ge $MaintenanceIntervalMs) {
      [void](Invoke-ScannerMaintenance)
      $lastMaintenanceAt = $now
    }

    if (-not $pendingContext.AsyncWaitHandle.WaitOne(200)) {
      continue
    }

    try {
      $context = $listener.EndGetContext($pendingContext)
      $pendingContext = $listener.BeginGetContext($null, $null)
    } catch {
      if (-not $listener.IsListening) { break }
      throw
    }

    $request = $context.Request
    $path = [string]$request.Url.AbsolutePath
    if ($path.Length -gt 1) { $path = $path.TrimEnd("/") }
    $path = $path.ToLowerInvariant()

    if ($request.HttpMethod -eq "OPTIONS") {
      Write-Response -Context $context -StatusCode 204 -Body $null
      continue
    }

    switch ($path) {
      "/" {
        Write-Response -Context $context -Body @{
          ok = $true
          name = "opos-scanner-bridge"
          startedAt = $global:OposBridgeState.startedAt
          scannerLogicalName = $global:OposBridgeState.scannerLogicalName
          scannerStatus = $global:OposBridgeState.scannerStatus
          port = $Port
        }
      }
      "/health" {
        $dataCount = Invoke-ScannerMaintenance
        Write-Response -Context $context -Body @{
          ok = $true
          scannerLogicalName = $global:OposBridgeState.scannerLogicalName
          scannerStatus = $global:OposBridgeState.scannerStatus
          lastError = $global:OposBridgeState.lastError
          lastSeq = $global:OposBridgeState.lastSeq
          dataCount = $dataCount
          queueClearCount = $global:OposBridgeState.queueClearCount
          lastQueueClearAt = $global:OposBridgeState.lastQueueClearAt
          rearmCount = $global:OposBridgeState.rearmCount
          lastRearmAt = $global:OposBridgeState.lastRearmAt
          queueNonZeroSince = $global:OposBridgeState.queueNonZeroSince
          startedAt = $global:OposBridgeState.startedAt
          now = (Get-Date).ToString("o")
        }
      }
      "/scan/latest" {
        # Fallback path if COM event callbacks are not dispatched in this host process.
        $dataCount = Invoke-ScannerMaintenance -IncludeLogFallback
        Write-Response -Context $context -Body @{
          ok = $true
          scan = $global:OposBridgeState.lastScan
          scannerStatus = $global:OposBridgeState.scannerStatus
          lastError = $global:OposBridgeState.lastError
          dataCount = $dataCount
          queueClearCount = $global:OposBridgeState.queueClearCount
          lastQueueClearAt = $global:OposBridgeState.lastQueueClearAt
          rearmCount = $global:OposBridgeState.rearmCount
          lastRearmAt = $global:OposBridgeState.lastRearmAt
          queueNonZeroSince = $global:OposBridgeState.queueNonZeroSince
        }
      }
      "/scan/clear" {
        [void](Try-ClearScannerInputQueue -MinCountToClear 1)
        Ensure-ScannerInputState -Force
        $global:OposBridgeState.lastScan = [ordered]@{
          seq = [int64]$global:OposBridgeState.lastSeq
          value = ""
          label = ""
          raw = ""
          dataType = 0
          at = ""
        }
        Write-Response -Context $context -Body @{
          ok = $true
          cleared = $true
          lastSeq = $global:OposBridgeState.lastSeq
          queueClearCount = $global:OposBridgeState.queueClearCount
          rearmCount = $global:OposBridgeState.rearmCount
        }
      }
      "/scanner/rearm" {
        $ok = Try-RearmScanner
        $dataCount = 0
        try { $dataCount = [int]$scanner.DataCount } catch {}
        Write-Response -Context $context -Body @{
          ok = $ok
          scannerStatus = $global:OposBridgeState.scannerStatus
          lastError = $global:OposBridgeState.lastError
          dataCount = $dataCount
          rearmCount = $global:OposBridgeState.rearmCount
          lastRearmAt = $global:OposBridgeState.lastRearmAt
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
  }
}
catch {
  $global:OposBridgeState.scannerStatus = "error"
  $global:OposBridgeState.lastError = $_.Exception.Message
  Write-Error $_
}
finally {
  Cleanup
}
