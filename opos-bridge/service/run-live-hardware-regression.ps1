[CmdletBinding()]
param(
  [Parameter()]
  [string]$BaseUrl = 'http://127.0.0.1:17331',

  [Parameter()]
  [string]$Owner = 'live-regression',

  [Parameter()]
  [ValidateRange(1, 50)]
  [int]$ScanCount = 10,

  [Parameter()]
  [ValidateRange(5, 120)]
  [int]$ScanTimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Json([string]$url) {
  return Invoke-RestMethod -Uri $url -TimeoutSec 3
}

function Wait-ForNextScan([string]$owner, [int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $resp = Get-Json "$BaseUrl/scan/next?owner=$([uri]::EscapeDataString($owner))"
    $value = [string]$resp.scan.value
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return [pscustomobject]@{
        Seq = [int64]$resp.scan.seq
        Value = $value
        Source = [string]$resp.scan.source
        At = [string]$resp.scan.at
      }
    }

    Start-Sleep -Milliseconds 150
  }

  return $null
}

Write-Host "Checking bridge health at $BaseUrl ..."
$health = Get-Json "$BaseUrl/health"
if (-not $health.ok) {
  throw "Bridge health failed."
}
Write-Host ("Bridge status: scannerStatus={0}, claimed={1}, instanceLock={2}" -f $health.scannerStatus, $health.scannerClaimed, $health.instanceLock)

Write-Host "Acquiring scanner lease for owner '$Owner' ..."
$lease = Get-Json "$BaseUrl/scanner/lease?owner=$([uri]::EscapeDataString($Owner))&ms=6000"
if (-not $lease.claimed) {
  throw "Could not claim scanner lease for test owner '$Owner'."
}

Write-Host "Clearing scanner buffer before test ..."
[void](Get-Json "$BaseUrl/scan/clear")
[void](Get-Json "$BaseUrl/scanner/rearm")

$results = @()
$doubleScanSignals = 0
$lastValue = ''

Write-Host ""
Write-Host "Phase A: Browser modal sequential scans ($ScanCount scans)."
Write-Host "For each prompt, scan exactly one ticket in the MercuryHQ modal."
for ($i = 1; $i -le $ScanCount; $i++) {
  Write-Host ("[{0}/{1}] Scan ticket now..." -f $i, $ScanCount)
  $started = Get-Date
  $scan = Wait-ForNextScan -owner $Owner -timeoutSeconds $ScanTimeoutSeconds
  if ($null -eq $scan) {
    throw "Timeout waiting for scan #$i."
  }

  $latencyMs = [int](New-TimeSpan -Start $started -End (Get-Date)).TotalMilliseconds
  if ($scan.Value -eq $lastValue) {
    $doubleScanSignals++
  }
  $lastValue = $scan.Value

  $results += [pscustomobject]@{
    Phase = 'browser-seq'
    Index = $i
    Seq = $scan.Seq
    Value = $scan.Value
    Source = $scan.Source
    LatencyMs = $latencyMs
  }
  Write-Host ("  -> seq={0} value='{1}' source={2} latencyMs={3}" -f $scan.Seq, $scan.Value, $scan.Source, $latencyMs)
}

Write-Host ""
Write-Host "Phase B: Context switch to Mercury fat client."
Write-Host "1) Move focus to Mercury fat client."
Write-Host "2) Scan one ticket there."
Write-Host "3) Return here and press Enter."
[void](Read-Host)

Write-Host "Checking that browser bridge owner did not ingest Mercury-client scan while out of focus ..."
$leakScan = Wait-ForNextScan -owner $Owner -timeoutSeconds 3
$contextLeak = ($null -ne $leakScan)
if ($contextLeak) {
  Write-Warning ("Bridge owner received unexpected scan during Mercury-client phase: seq={0} value='{1}'" -f $leakScan.Seq, $leakScan.Value)
}
else {
  Write-Host "No cross-context scan leak detected."
}

Write-Host ""
Write-Host "Phase C: Return to browser modal and scan one new ticket once."
Write-Host "Scan once now..."
$singleBack = Wait-ForNextScan -owner $Owner -timeoutSeconds $ScanTimeoutSeconds
$backNeededSecondScan = $false
if ($null -eq $singleBack) {
  Write-Warning "No scan detected on first attempt. Scan once more now..."
  $singleBack = Wait-ForNextScan -owner $Owner -timeoutSeconds $ScanTimeoutSeconds
  $backNeededSecondScan = $true
}

if ($null -eq $singleBack) {
  throw "Failed to capture scan after returning from Mercury client context."
}

$results += [pscustomobject]@{
  Phase = 'browser-after-context'
  Index = 1
  Seq = $singleBack.Seq
  Value = $singleBack.Value
  Source = $singleBack.Source
  LatencyMs = 0
}

Write-Host ("Captured post-context scan: seq={0} value='{1}' source={2}" -f $singleBack.Seq, $singleBack.Value, $singleBack.Source)

Write-Host ""
Write-Host "Releasing lease and finalizing..."
[void](Get-Json "$BaseUrl/scanner/release?owner=$([uri]::EscapeDataString($Owner))")

$summary = [pscustomobject]@{
  BridgeUrl = $BaseUrl
  Owner = $Owner
  SequentialScanCount = $ScanCount
  SequentialDuplicateValueSignals = $doubleScanSignals
  ContextLeakDetected = $contextLeak
  NeededSecondScanAfterContextSwitch = $backNeededSecondScan
  Pass = (-not $contextLeak) -and (-not $backNeededSecondScan)
}

Write-Host ""
Write-Host "===== Live Hardware Regression Summary ====="
$summary | Format-List | Out-Host
Write-Host "==========================================="

Write-Host ""
Write-Host "Detailed captures:"
$results | Format-Table -AutoSize | Out-Host

if (-not $summary.Pass) {
  throw "Live hardware regression reported issues. See summary fields above."
}

Write-Host "Live hardware regression passed."

