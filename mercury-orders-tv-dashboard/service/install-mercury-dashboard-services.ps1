param(
  [string]$ServiceHostExePath = "",
  [string]$NodeExePath = "",
  [string]$BridgeServiceName = "Talaria Bridge",
  [string]$WebServiceName = "Talaria Web",
  [int]$BridgePort = 17344,
  [int]$WebPort = 5173,
  [string]$MercuryBaseUrl = "http://127.0.0.1/WsMercuryWebAPI",
  [string]$MercurySoapNamespace = "http://localhost/webservices/",
  [string]$MercuryLocalNetworkOnly = "true",
  [string]$MapboxToken = "",
  [string]$BridgeHost = "0.0.0.0",
  [string]$WebHost = "0.0.0.0"
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

function Assert-PortRange {
  param([int]$Port, [string]$Name)
  if ($Port -lt 1 -or $Port -gt 65535) {
    throw "$Name must be between 1 and 65535. Got: $Port"
  }
}

function Normalize-BoolString {
  param([string]$Value)
  $text = ("" + $Value).Trim().ToLowerInvariant()
  if ($text -in @("1", "true", "yes", "on")) { return "true" }
  if ($text -in @("0", "false", "no", "off")) { return "false" }
  throw "MercuryLocalNetworkOnly must be true/false (or yes/no, 1/0). Got: $Value"
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

Assert-PortRange -Port $BridgePort -Name "BridgePort"
Assert-PortRange -Port $WebPort -Name "WebPort"
if ($BridgePort -eq $WebPort) {
  throw "BridgePort and WebPort must be different."
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

$resolvedNodeExePath = ""
if ($NodeExePath) {
  $resolvedNodeExePath = [System.IO.Path]::GetFullPath($NodeExePath)
  if (-not (Test-Path $resolvedNodeExePath)) {
    throw "Node executable not found: $resolvedNodeExePath"
  }
}

$normalizedLocalNetworkOnly = Normalize-BoolString -Value $MercuryLocalNetworkOnly

$bridgeArgs = @(
  "--service-install",
  "--service-role=bridge",
  "--service-name=$BridgeServiceName",
  "--bridge-port=$BridgePort",
  "--bridge-host=$BridgeHost",
  "--mercury-base-url=$MercuryBaseUrl",
  "--mercury-soap-namespace=$MercurySoapNamespace",
  "--mercury-local-network-only=$normalizedLocalNetworkOnly"
)

if ($resolvedNodeExePath) {
  $bridgeArgs += "--node-exe=$resolvedNodeExePath"
}

if ($MapboxToken) {
  $bridgeArgs += "--mapbox-token=$MapboxToken"
}

$webArgs = @(
  "--service-install",
  "--service-role=web",
  "--service-name=$WebServiceName",
  "--depends-on-service=$BridgeServiceName",
  "--web-port=$WebPort",
  "--web-host=$WebHost",
  "--workflow-api-base-url=http://127.0.0.1:$BridgePort"
)

if ($resolvedNodeExePath) {
  $webArgs += "--node-exe=$resolvedNodeExePath"
}

Write-Host "Installing Mercury dashboard services using compiled service host..."
Invoke-ServiceHost -ExePath $ServiceHostExePath -Arguments $bridgeArgs
Invoke-ServiceHost -ExePath $ServiceHostExePath -Arguments $webArgs
Write-Host "Services installed successfully."
