param(
  [string]$LogicalName = "ZEBRA_SCANNER",
  [int]$Port = 17331,
  [int]$ClaimTimeoutMs = 3000,
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

  $scanner.DeviceEnabled = $true
  $scanner.DecodeData = $true
  $scanner.DataEventEnabled = $true
  $global:OposBridgeState.scannerStatus = "ready"

  Write-Log "Scanner ready. LogicalName=$LogicalName, OpenResult=$($scanner.OpenResult)"

  $subscriptions += Register-ObjectEvent -InputObject $scanner -EventName DataEvent -SourceIdentifier "OposBridge.DataEvent" -Action {
    try {
      $s = $event.Sender
      $label = [string]$s.ScanDataLabel
      $raw = [string]$s.ScanData
      $value = if ([string]::IsNullOrWhiteSpace($label)) { $raw } else { $label }
      $value = ($value -replace "[^\x20-\x7E]", "").Trim()

      if (-not [string]::IsNullOrWhiteSpace($value)) {
        $nextSeq = [int64]$global:OposBridgeState.lastSeq + 1
        $global:OposBridgeState.lastSeq = $nextSeq
        $global:OposBridgeState.lastScan = [ordered]@{
          seq = $nextSeq
          value = $value
          label = $label
          raw = $raw
          dataType = [int]$s.ScanDataType
          at = (Get-Date).ToString("o")
        }
      }

      $s.DataEventEnabled = $true
    } catch {
      $global:OposBridgeState.lastError = "DataEvent handler error: $($_.Exception.Message)"
      try { $event.Sender.DataEventEnabled = $true } catch {}
    }
  }

  $subscriptions += Register-ObjectEvent -InputObject $scanner -EventName ErrorEvent -SourceIdentifier "OposBridge.ErrorEvent" -Action {
    try {
      $global:OposBridgeState.lastError = "Scanner ErrorEvent received at $((Get-Date).ToString('o'))"
      try { $event.Sender.DataEventEnabled = $true } catch {}
    } catch {}
  }

  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:$Port/")
  $listener.Start()
  Write-Log "HTTP listener started at http://127.0.0.1:$Port/"

  while ($listener.IsListening) {
    $context = $listener.GetContext()
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
        Write-Response -Context $context -Body @{
          ok = $true
          scannerLogicalName = $global:OposBridgeState.scannerLogicalName
          scannerStatus = $global:OposBridgeState.scannerStatus
          lastError = $global:OposBridgeState.lastError
          lastSeq = $global:OposBridgeState.lastSeq
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
      "/scan/clear" {
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
