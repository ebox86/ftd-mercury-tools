$ErrorActionPreference = "Stop"

$nodeCandidates = @()
if ($env:ProgramFiles) {
  $nodeCandidates += Join-Path $env:ProgramFiles 'nodejs'
}
if (${env:ProgramFiles(x86)}) {
  $nodeCandidates += Join-Path ${env:ProgramFiles(x86)} 'nodejs'
}
$nodeCandidates = $nodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

foreach ($nodeDir in $nodeCandidates) {
  if (-not (($env:Path -split ';') -contains $nodeDir)) {
    $env:Path = "$nodeDir;$env:Path"
  }
}

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $npmCmd) {
  throw "Node.js/npm.cmd not found. Install Node.js and reopen terminal."
}

$directApiBase = String($env:WORKFLOW_API_BASE_URL).Trim()
$soapBase = String($env:MERCURY_BASE_URL).Trim()
$bridgePort = 17344
if ($env:BRIDGE_PORT -and [int]::TryParse(String($env:BRIDGE_PORT), [ref]$bridgePort) -eq $false) {
  $bridgePort = 17344
}
$mode = ''

if ($soapBase) {
  $mode = 'bridge'
} elseif ($directApiBase) {
  $mode = 'direct'
} else {
  throw "Set WORKFLOW_API_BASE_URL (direct /api host) OR MERCURY_BASE_URL (SOAP host)."
}

if ($mode -eq 'bridge') {
  if (-not $env:MERCURY_SOAP_NAMESPACE) {
    $env:MERCURY_SOAP_NAMESPACE = "http://localhost/webservices/"
  }

  Write-Host "Starting workflow bridge server (SOAP -> /api/workflow)..."
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "$env:PORT='$bridgePort'; $env:MERCURY_BASE_URL='$soapBase'; $env:MERCURY_SOAP_NAMESPACE='$($env:MERCURY_SOAP_NAMESPACE)'; cd '$PSScriptRoot\\workflow-bridge'; & '$npmCmd' install; & '$npmCmd' start"
  )

  Start-Sleep -Seconds 2
  $directApiBase = "http://127.0.0.1:$bridgePort"
}

Write-Host "Starting kiosk app..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "$env:VITE_WORKFLOW_PROXY_TARGET='$directApiBase'; cd '$PSScriptRoot\\kiosk-app'; & '$npmCmd' install; & '$npmCmd' run dev -- --host"
)

Write-Host "Live dashboard boot started."
Write-Host "Kiosk UI:       http://127.0.0.1:5173"
Write-Host "Workflow API:   $directApiBase"
if ($mode -eq 'bridge') {
  Write-Host "Mercury SOAP:   $soapBase"
  Write-Host "Bridge health:  http://127.0.0.1:$bridgePort/health"
}

