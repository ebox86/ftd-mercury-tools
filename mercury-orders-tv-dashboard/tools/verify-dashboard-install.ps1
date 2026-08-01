param(
  [string]$BaseUrl = "http://127.0.0.1:5173",
  [string]$InstallRoot = "C:\FTDTools\Talaria",
  [switch]$Strict
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Invoke-JsonGet {
  param([Parameter(Mandatory = $true)] [string]$Url)
  return Invoke-RestMethod -Uri $Url -Method Get -Headers @{ Accept = "application/json" }
}

function Parse-DateKey {
  param([string]$Raw)
  $text = [string]$Raw
  if ([string]::IsNullOrWhiteSpace($text)) { return "" }

  $iso = [regex]::Match($text, "(\d{4})-(\d{2})-(\d{2})")
  if ($iso.Success) {
    return "$($iso.Groups[1].Value)-$($iso.Groups[2].Value)-$($iso.Groups[3].Value)"
  }

  $mdy = [regex]::Match($text, "(\d{1,2})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{4})")
  if ($mdy.Success) {
    $month = $mdy.Groups[1].Value.PadLeft(2, '0')
    $day = $mdy.Groups[2].Value.PadLeft(2, '0')
    $year = $mdy.Groups[3].Value
    return "$year-$month-$day"
  }

  return ""
}

function Get-TicketRows {
  param(
    [Parameter(Mandatory = $true)] [string]$Base,
    [Parameter(Mandatory = $true)] [string]$FromDate,
    [Parameter(Mandatory = $true)] [string]$ToDate
  )

  $query = @(
    "fromDate=$([uri]::EscapeDataString($FromDate))"
    "toDate=$([uri]::EscapeDataString($ToDate))"
    "notDelivered=true"
    "includeDelivered=false"
  ) -join "&"

  $url = "$Base/api/workflow/tickets/search?$query"
  $response = Invoke-JsonGet -Url $url
  return @($response.rows)
}

function To-UniqueIdSet {
  param([object[]]$Rows)
  $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($row in @($Rows)) {
    $id = [string]$row.ID
    if (-not [string]::IsNullOrWhiteSpace($id)) {
      [void]$set.Add($id.Trim())
    }
  }
  return $set
}

function Set-OverlapCount {
  param(
    [System.Collections.Generic.HashSet[string]]$Left,
    [System.Collections.Generic.HashSet[string]]$Right
  )
  $count = 0
  foreach ($value in $Left) {
    if ($Right.Contains($value)) { $count += 1 }
  }
  return $count
}

function Find-InstalledBundleMarker {
  param(
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [string]$Marker
  )

  $indexPath = Join-Path $Root "kiosk-app\dist\index.html"
  if (-not (Test-Path $indexPath)) {
    return [pscustomobject]@{
      IndexPath = $indexPath
      ScriptPath = ""
      Found = $false
      Reason = "index.html not found"
    }
  }

  $indexHtml = Get-Content -Raw -Path $indexPath
  $scriptMatch = [regex]::Match($indexHtml, 'src="/assets/([^"]+\.js)"')
  if (-not $scriptMatch.Success) {
    return [pscustomobject]@{
      IndexPath = $indexPath
      ScriptPath = ""
      Found = $false
      Reason = "No JS asset reference found in index.html"
    }
  }

  $scriptRelative = Join-Path "kiosk-app\dist\assets" $scriptMatch.Groups[1].Value
  $scriptPath = Join-Path $Root $scriptRelative
  if (-not (Test-Path $scriptPath)) {
    return [pscustomobject]@{
      IndexPath = $indexPath
      ScriptPath = $scriptPath
      Found = $false
      Reason = "Referenced JS asset not found on disk"
    }
  }

  $scriptBody = Get-Content -Raw -Path $scriptPath
  $contains = $scriptBody.Contains($Marker)
  return [pscustomobject]@{
    IndexPath = $indexPath
    ScriptPath = $scriptPath
    Found = $contains
    Reason = if ($contains) { "marker found" } else { "marker missing" }
  }
}

Write-Host "Checking dashboard runtime at $BaseUrl ..."
$webHealth = Invoke-JsonGet -Url "$BaseUrl/web-health"
$bridgeHealth = Invoke-JsonGet -Url "$BaseUrl/health"

$bundleCheck = Find-InstalledBundleMarker -Root $InstallRoot -Marker "Next day hidden:"

$today = (Get-Date).Date
$todayFrom = $today.ToString("yyyy-MM-ddTHH:mm:ss")
$todayTo = $today.AddDays(1).ToString("yyyy-MM-ddTHH:mm:ss")
$tomorrowFrom = $todayTo
$tomorrowTo = $today.AddDays(2).ToString("yyyy-MM-ddTHH:mm:ss")

$todayRows = Get-TicketRows -Base $BaseUrl -FromDate $todayFrom -ToDate $todayTo
$tomorrowRows = Get-TicketRows -Base $BaseUrl -FromDate $tomorrowFrom -ToDate $tomorrowTo

$todayIds = To-UniqueIdSet -Rows $todayRows
$tomorrowIds = To-UniqueIdSet -Rows $tomorrowRows
$overlap = Set-OverlapCount -Left $todayIds -Right $tomorrowIds
$todayOnly = $todayIds.Count - $overlap
$tomorrowOnly = $tomorrowIds.Count - $overlap

$todayDateMix = @{}
foreach ($row in $todayRows) {
  $key = Parse-DateKey -Raw ([string]$row.DELIVERY_DATE)
  if (-not $todayDateMix.ContainsKey($key)) { $todayDateMix[$key] = 0 }
  $todayDateMix[$key] += 1
}

$tomorrowDateMix = @{}
foreach ($row in $tomorrowRows) {
  $key = Parse-DateKey -Raw ([string]$row.DELIVERY_DATE)
  if (-not $tomorrowDateMix.ContainsKey($key)) { $tomorrowDateMix[$key] = 0 }
  $tomorrowDateMix[$key] += 1
}

Write-Host ""
Write-Host "Health:"
Write-Host "  web-health ok      : $($webHealth.ok)"
Write-Host "  bridge-health ok   : $($bridgeHealth.ok)"
Write-Host ""
Write-Host "Installed Bundle Marker:"
Write-Host "  index              : $($bundleCheck.IndexPath)"
Write-Host "  script             : $($bundleCheck.ScriptPath)"
Write-Host "  marker found       : $($bundleCheck.Found)"
Write-Host "  detail             : $($bundleCheck.Reason)"
Write-Host ""
Write-Host "Ticket Search Day Window Check:"
Write-Host "  today window       : $todayFrom -> $todayTo"
Write-Host "  tomorrow window    : $tomorrowFrom -> $tomorrowTo"
Write-Host "  today rows         : $($todayRows.Count)"
Write-Host "  tomorrow rows      : $($tomorrowRows.Count)"
Write-Host "  today unique IDs   : $($todayIds.Count)"
Write-Host "  tomorrow unique IDs: $($tomorrowIds.Count)"
Write-Host "  overlap IDs        : $overlap"
Write-Host "  today-only IDs     : $todayOnly"
Write-Host "  tomorrow-only IDs  : $tomorrowOnly"
Write-Host "  today date mix     : $(@($todayDateMix.GetEnumerator() | Sort-Object Name | ForEach-Object { ""$($_.Name):$($_.Value)"" }) -join ', ')"
Write-Host "  tomorrow date mix  : $(@($tomorrowDateMix.GetEnumerator() | Sort-Object Name | ForEach-Object { ""$($_.Name):$($_.Value)"" }) -join ', ')"

$hasCriticalFailure = $false
if (-not $webHealth.ok -or -not $bridgeHealth.ok) {
  $hasCriticalFailure = $true
  Write-Host ""
  Write-Host "FAIL: One or more health endpoints are not healthy."
}
if (-not $bundleCheck.Found) {
  $hasCriticalFailure = $true
  Write-Host ""
  Write-Host "FAIL: Installed frontend bundle marker not found."
}

if ($Strict -and $hasCriticalFailure) {
  exit 1
}

if ($hasCriticalFailure) {
  Write-Host ""
  Write-Host "Verification completed with failures."
  exit 0
}

Write-Host ""
Write-Host "Verification completed successfully."
