param(
  [string]$InstallRoot = "C:\FTDTools\OposBridge",
  [string]$LogicalName = "ZEBRA_SCANNER",
  [int]$Port = 17331,
  [int]$HealthTimeoutSec = 20,
  [switch]$SkipTaskInstall,
  [switch]$SkipHealthCheck
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[OPOS Bootstrap] $Message"
}

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$requiredFiles = @(
  "opos-scanner-bridge.ps1",
  "install-opos-bridge-task.ps1"
)

Write-Step "Source folder: $sourceRoot"
Write-Step "Install folder: $InstallRoot"

foreach ($file in $requiredFiles) {
  $src = Join-Path $sourceRoot $file
  if (-not (Test-Path $src)) {
    throw "Required source file not found: $src"
  }
}

if (-not (Test-Path $InstallRoot)) {
  Write-Step "Creating $InstallRoot"
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
}

foreach ($file in $requiredFiles) {
  $src = Join-Path $sourceRoot $file
  $dst = Join-Path $InstallRoot $file
  Copy-Item -Path $src -Destination $dst -Force
  Write-Step "Copied $file"
}

$bridgeScriptPath = Join-Path $InstallRoot "opos-scanner-bridge.ps1"
$taskInstallerPath = Join-Path $InstallRoot "install-opos-bridge-task.ps1"

if (-not $SkipTaskInstall) {
  Write-Step "Installing and starting scheduled task..."
  & $taskInstallerPath -BridgeScriptPath $bridgeScriptPath -LogicalName $LogicalName -Port $Port
} else {
  Write-Step "Skipping scheduled task installation by request."
}

if (-not $SkipHealthCheck) {
  $healthUrl = "http://127.0.0.1:$Port/health"
  Write-Step "Checking health at $healthUrl"
  $deadline = (Get-Date).AddSeconds([Math]::Max(5, $HealthTimeoutSec))
  $health = $null

  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -Method GET -TimeoutSec 2
      if ($null -ne $health) { break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if ($null -eq $health) {
    throw "Bridge health check failed at $healthUrl"
  }

  $scannerStatus = [string]$health.scannerStatus
  Write-Step ("Health OK. scannerStatus={0}, lastSeq={1}" -f $scannerStatus, $health.lastSeq)

  if ($scannerStatus -ne "ready") {
    Write-Warning "Bridge is reachable but scannerStatus is '$scannerStatus'. Check OPOS logical name and scanner availability."
  }
} else {
  Write-Step "Skipping health check by request."
}

Write-Step "Done."
Write-Step "Open in browser to verify anytime: http://127.0.0.1:$Port/health"
