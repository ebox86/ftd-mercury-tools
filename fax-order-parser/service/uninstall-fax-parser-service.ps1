param(
  [string]$AppRoot     = "C:\FTDTools\FaxOrderParser",
  [string]$ServiceName = "FTD Fax Order Parser"
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

$serviceHostExe = Join-Path $AppRoot "service-runtime\FTD.FaxParser.ServiceHost.exe"
if (-not (Test-Path $serviceHostExe)) {
  Write-Warning "Service host executable not found: $serviceHostExe - attempting sc.exe fallback."
  & sc.exe stop   $ServiceName 2>$null | Out-Null
  & sc.exe delete $ServiceName 2>$null | Out-Null
  Write-Host "Service '$ServiceName' removed (fallback)."
  exit 0
}

Write-Host "Uninstalling service '$ServiceName'..."

& $serviceHostExe "--service-uninstall" "--service-name=$ServiceName"

if ($LASTEXITCODE -ne 0) {
  throw "Service uninstallation failed (exit code $LASTEXITCODE)."
}

Write-Host "Service '$ServiceName' removed successfully."
