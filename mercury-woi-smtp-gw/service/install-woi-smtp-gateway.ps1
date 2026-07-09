param(
  [string]$AppRoot       = "C:\FTDTools\WoiSmtpGateway",
  [string]$ServiceName   = "FTD WOI SMTP Gateway",
  [string]$StartMode     = "auto"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must run as Administrator."
  }
}

Assert-Admin

$serviceHostExe = Join-Path $AppRoot "service-runtime\FTD.WoiSmtpGateway.ServiceHost.exe"
if (-not (Test-Path $serviceHostExe)) {
  throw "Service host executable not found: $serviceHostExe"
}

$nodeExe = Join-Path $AppRoot "runtime\node.exe"
if (-not (Test-Path $nodeExe)) {
  throw "Node.js executable not found: $nodeExe"
}

$scriptPath = Join-Path $AppRoot "service\service.js"
if (-not (Test-Path $scriptPath)) {
  throw "Service script not found: $scriptPath"
}

$logDir = Join-Path $env:ProgramData "FTD\WoiSmtpGateway\logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

Write-Host "Installing service '$ServiceName'..."

& $serviceHostExe `
  "--service-install" `
  "--service-name=$ServiceName" `
  "--node-exe=$nodeExe" `
  "--script-path=$scriptPath" `
  "--working-dir=$(Join-Path $AppRoot 'service')" `
  "--log-dir=$logDir" `
  "--start-mode=$StartMode"

if ($LASTEXITCODE -ne 0) {
  throw "Service installation failed (exit code $LASTEXITCODE)."
}

Write-Host "Service '$ServiceName' installed and started successfully." -ForegroundColor Green
