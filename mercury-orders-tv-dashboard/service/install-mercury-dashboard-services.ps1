param(
  [string]$NodeExePath = "",
  [string]$NssmExePath = "",
  [string]$BridgeServiceName = "FTD Mercury Workflow Bridge",
  [string]$WebServiceName = "FTD Mercury Dashboard Web",
  [int]$BridgePort = 17344,
  [int]$WebPort = 5173,
  [string]$MercuryBaseUrl = "http://127.0.0.1/WsMercuryWebAPI",
  [string]$MercurySoapNamespace = "http://localhost/webservices/",
  [string]$MercuryLocalNetworkOnly = "true",
  [string]$BridgeHost = "0.0.0.0",
  [string]$WebHost = "0.0.0.0"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Test-ValidPort {
  param([int]$Port)
  return ($Port -ge 1 -and $Port -le 65535)
}

function Test-ServiceExists {
  param([string]$Name)
  return $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-ValidPort -Port $BridgePort)) {
  throw "BridgePort must be between 1 and 65535. Got: $BridgePort"
}
if (-not (Test-ValidPort -Port $WebPort)) {
  throw "WebPort must be between 1 and 65535. Got: $WebPort"
}
if ($BridgePort -eq $WebPort) {
  throw "BridgePort and WebPort must be different."
}

$appRoot = Split-Path -Parent $PSScriptRoot

if (-not $NodeExePath) {
  $NodeExePath = Join-Path $appRoot "runtime\node.exe"
}
if (-not $NssmExePath) {
  $NssmExePath = Join-Path $appRoot "bin\nssm.exe"
}

$NodeExePath = [System.IO.Path]::GetFullPath($NodeExePath)
$NssmExePath = [System.IO.Path]::GetFullPath($NssmExePath)

$bridgeScriptPath = Join-Path $appRoot "workflow-bridge\server.mjs"
$webScriptPath = Join-Path $appRoot "service-host\dashboard-web-server.mjs"
$bridgeWorkingDir = Join-Path $appRoot "workflow-bridge"
$webWorkingDir = Join-Path $appRoot "service-host"
$logDir = Join-Path $appRoot "logs"

if (-not (Test-Path $NodeExePath)) {
  throw "Node executable not found: $NodeExePath"
}
if (-not (Test-Path $NssmExePath)) {
  throw "nssm executable not found: $NssmExePath"
}
if (-not (Test-Path $bridgeScriptPath)) {
  throw "Bridge script not found: $bridgeScriptPath"
}
if (-not (Test-Path $webScriptPath)) {
  throw "Web host script not found: $webScriptPath"
}
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Invoke-Nssm {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )
  & $NssmExePath @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "nssm failed (exit $LASTEXITCODE): $($Arguments -join ' ')"
  }
}

function Remove-ServiceIfPresent {
  param([string]$Name)
  if (-not (Test-ServiceExists -Name $Name)) {
    return
  }

  try {
    Invoke-Nssm -Arguments @("stop", $Name)
  } catch {
    # continue cleanup even if stop fails
  }
  Start-Sleep -Milliseconds 300

  try {
    Invoke-Nssm -Arguments @("remove", $Name, "confirm")
  } catch {
    & sc.exe delete $Name | Out-Null
  }
}

function Configure-Service {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string]$WorkingDir,
    [string]$LogPrefix,
    [string[]]$EnvironmentEntries,
    [string]$DependsOnService = ""
  )

  Invoke-Nssm -Arguments @("install", $Name, $NodeExePath, $ScriptPath)
  Invoke-Nssm -Arguments @("set", $Name, "AppDirectory", $WorkingDir)
  Invoke-Nssm -Arguments @("set", $Name, "Start", "SERVICE_AUTO_START")
  Invoke-Nssm -Arguments @("set", $Name, "AppStdout", (Join-Path $logDir "$LogPrefix.out.log"))
  Invoke-Nssm -Arguments @("set", $Name, "AppStderr", (Join-Path $logDir "$LogPrefix.err.log"))
  Invoke-Nssm -Arguments @("set", $Name, "AppRotateFiles", "1")
  Invoke-Nssm -Arguments @("set", $Name, "AppRotateOnline", "1")
  Invoke-Nssm -Arguments @("set", $Name, "AppRotateBytes", "10485760")
  Invoke-Nssm -Arguments @("set", $Name, "AppRotateSeconds", "86400")
  Invoke-Nssm -Arguments @("set", $Name, "AppExit", "Default", "Restart")

  $envBlock = ($EnvironmentEntries | Where-Object { $_ -and $_.Contains("=") }) -join "`n"
  if ($envBlock) {
    Invoke-Nssm -Arguments @("set", $Name, "AppEnvironmentExtra", $envBlock)
  }

  if ($DependsOnService) {
    Invoke-Nssm -Arguments @("set", $Name, "DependOnService", $DependsOnService)
  }
}

Write-Host "Installing Mercury dashboard services..."
Write-Host "App root: $appRoot"
Write-Host "Bridge service: $BridgeServiceName ($BridgeHost:$BridgePort)"
Write-Host "Web service: $WebServiceName ($WebHost:$WebPort)"

Remove-ServiceIfPresent -Name $WebServiceName
Remove-ServiceIfPresent -Name $BridgeServiceName

$bridgeEnv = @(
  "PORT=$BridgePort",
  "BRIDGE_HOST=$BridgeHost",
  "MERCURY_BASE_URL=$MercuryBaseUrl",
  "MERCURY_SOAP_NAMESPACE=$MercurySoapNamespace",
  "MERCURY_LOCAL_NETWORK_ONLY=$MercuryLocalNetworkOnly"
)
$webEnv = @(
  "WEB_PORT=$WebPort",
  "WEB_HOST=$WebHost",
  "WORKFLOW_API_BASE_URL=http://127.0.0.1:$BridgePort"
)

Configure-Service `
  -Name $BridgeServiceName `
  -ScriptPath $bridgeScriptPath `
  -WorkingDir $bridgeWorkingDir `
  -LogPrefix "workflow-bridge" `
  -EnvironmentEntries $bridgeEnv

Configure-Service `
  -Name $WebServiceName `
  -ScriptPath $webScriptPath `
  -WorkingDir $webWorkingDir `
  -LogPrefix "dashboard-web" `
  -EnvironmentEntries $webEnv `
  -DependsOnService $BridgeServiceName

Invoke-Nssm -Arguments @("start", $BridgeServiceName)
Invoke-Nssm -Arguments @("start", $WebServiceName)

Write-Host "Services installed successfully."
