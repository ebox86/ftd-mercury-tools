param(
  [string]$ServiceName = "FTD WOI SMTP Gateway"
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

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existingService) {
  Write-Host "Service '$ServiceName' not found. Nothing to uninstall."
  exit 0
}

Write-Host "Uninstalling service '$ServiceName'..."

Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

sc.exe delete "$ServiceName" | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Service deletion failed (exit code $LASTEXITCODE)."
}

Write-Host "Service '$ServiceName' uninstalled successfully." -ForegroundColor Green
