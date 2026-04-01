param(
  [string]$ServiceHostExePath = "",
  [string]$BridgeServiceName = "FTD Mercury Workflow Bridge",
  [string]$WebServiceName = "FTD Mercury Dashboard Web"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
  }
}

function Invoke-ServiceHost {
  param(
    [Parameter(Mandatory = $true)] [string]$ExePath,
    [Parameter(Mandatory = $true)] [string[]]$Arguments
  )

  & $ExePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Service host command failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
  }
}

Assert-Admin

$appRoot = Split-Path -Parent $PSScriptRoot
if (-not $ServiceHostExePath) {
  $ServiceHostExePath = Join-Path $appRoot "service-runtime\FTD.Mercury.Dashboard.ServiceHost.exe"
}
$ServiceHostExePath = [System.IO.Path]::GetFullPath($ServiceHostExePath)
if (-not (Test-Path $ServiceHostExePath)) {
  throw "Service host executable not found: $ServiceHostExePath"
}

$webArgs = @(
  "--service-uninstall",
  "--service-role=web",
  "--service-name=$WebServiceName"
)

$bridgeArgs = @(
  "--service-uninstall",
  "--service-role=bridge",
  "--service-name=$BridgeServiceName"
)

Write-Host "Removing Mercury dashboard services..."
Invoke-ServiceHost -ExePath $ServiceHostExePath -Arguments $webArgs
Invoke-ServiceHost -ExePath $ServiceHostExePath -Arguments $bridgeArgs
Write-Host "Service removal completed."
