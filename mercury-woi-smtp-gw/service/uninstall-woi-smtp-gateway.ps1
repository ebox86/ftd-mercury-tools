param(
  [string]$AppRoot     = "C:\FTDTools\WoiSmtpGateway",
  [string]$ServiceName = "FTD Mercury Mail Gateway",
  [string[]]$LegacyServiceNames = @("FTD WOI SMTP Gateway")
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
function Uninstall-ServiceByName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) {
    return
  }

  $existingService = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $existingService) {
    return
  }

  if (Test-Path $serviceHostExe) {
    Write-Host "Uninstalling service '$name'..."
    & $serviceHostExe `
      "--service-uninstall" `
      "--service-name=$name"

    if ($LASTEXITCODE -ne 0) {
      throw "Service uninstallation failed for '$name' (exit code $LASTEXITCODE)."
    }

    Write-Host "Service '$name' uninstalled successfully." -ForegroundColor Green
    return
  }

  Write-Host "Uninstalling service '$name'..."

  Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  sc.exe delete "$name" | Out-Null

  if ($LASTEXITCODE -ne 0) {
    throw "Service deletion failed for '$name' (exit code $LASTEXITCODE)."
  }

  Write-Host "Service '$name' uninstalled successfully." -ForegroundColor Green
}

$removedAny = $false
$names = @($ServiceName) + $LegacyServiceNames
foreach ($name in $names) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($service) {
    Uninstall-ServiceByName $name
    $removedAny = $true
  }
}

if (-not $removedAny) {
  Write-Host "Service '$ServiceName' not found. Nothing to uninstall."
}
