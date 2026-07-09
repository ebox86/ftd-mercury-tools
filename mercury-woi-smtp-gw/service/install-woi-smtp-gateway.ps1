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

$nodeExe = Join-Path $AppRoot "runtime\node.exe"
if (-not (Test-Path $nodeExe)) {
  throw "Node.js executable not found: $nodeExe"
}

$serviceJs = Join-Path $AppRoot "service\service.js"
if (-not (Test-Path $serviceJs)) {
  throw "Service script not found: $serviceJs"
}

$logDir = Join-Path $env:ProgramData "FTD\WoiSmtpGateway\logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Ensure service doesn't already exist
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
  Write-Host "Service already exists. Stopping and removing old service..."
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  sc.exe delete "$ServiceName" | Out-Null
  Start-Sleep -Milliseconds 500
}

Write-Host "Installing service '$ServiceName'..."
$serviceBinPath = "`"$nodeExe`" `"$serviceJs`""

# Create the service using sc.exe
sc.exe create "$ServiceName" `
  binPath= "$serviceBinPath" `
  displayName= "$ServiceName" `
  start= "$StartMode"

if ($LASTEXITCODE -ne 0) {
  throw "Service creation failed (exit code $LASTEXITCODE)."
}

# Set recovery options: restart on failure after 5 seconds
sc.exe failure "$ServiceName" reset= 86400 actions= restart/5000

# Set working directory environment variable
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" `
  -Name "WorkingDirectory" `
  -Value (Join-Path $AppRoot "service") `
  -Force | Out-Null

Write-Host "Service '$ServiceName' created successfully."
Write-Host "Starting service..."

Start-Service -Name $ServiceName

if ($LASTEXITCODE -ne 0) {
  Write-Warning "Failed to start service immediately (it may start on next reboot). Manual start may be required."
}

Write-Host "Service '$ServiceName' installed and started." -ForegroundColor Green
