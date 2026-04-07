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

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmCmd = if ($npmCommand) { $npmCommand.Source } else { $null }
if (-not $npmCmd) {
  throw "Node.js/npm.cmd not found. Install Node.js and reopen terminal."
}

function Get-AvailableTcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$StartPort,
    [int]$MaxAttempts = 20
  )

  for ($offset = 0; $offset -lt $MaxAttempts; $offset++) {
    $candidate = $StartPort + $offset
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
      $listener.Start()
      $listener.Stop()
      return $candidate
    } catch {
      if ($listener) {
        try {
          $listener.Stop()
        } catch {
        }
      }
    }
  }

  throw "No available TCP port found starting at $StartPort."
}

$directApiBase = ([string]$env:WORKFLOW_API_BASE_URL).Trim()
$soapBase = ([string]$env:MERCURY_BASE_URL).Trim()
$kioskPort = 5173
if ($env:KIOSK_PORT -and [int]::TryParse(([string]$env:KIOSK_PORT), [ref]$kioskPort) -eq $false) {
  $kioskPort = 5173
}
$bridgePort = 17344
if ($env:BRIDGE_PORT -and [int]::TryParse(([string]$env:BRIDGE_PORT), [ref]$bridgePort) -eq $false) {
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
  $requestedBridgePort = $bridgePort
  $bridgePort = Get-AvailableTcpPort -StartPort $requestedBridgePort -MaxAttempts 25
  if ($bridgePort -ne $requestedBridgePort) {
    Write-Host "Bridge port $requestedBridgePort is in use. Using $bridgePort instead."
  }

  if (-not $env:MERCURY_SOAP_NAMESPACE) {
    $env:MERCURY_SOAP_NAMESPACE = "http://localhost/webservices/"
  }

  Write-Host "Starting workflow bridge server (SOAP -> /api/workflow)..."
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "`$env:PORT='$bridgePort'; `$env:MERCURY_BASE_URL='$soapBase'; `$env:MERCURY_SOAP_NAMESPACE='$($env:MERCURY_SOAP_NAMESPACE)'; Set-Location -LiteralPath '$PSScriptRoot\\workflow-bridge'; & '$npmCmd' install; & '$npmCmd' start"
  )

  Start-Sleep -Seconds 2
  $directApiBase = "http://127.0.0.1:$bridgePort"
}

$requestedKioskPort = $kioskPort
$kioskPort = Get-AvailableTcpPort -StartPort $requestedKioskPort -MaxAttempts 25
if ($kioskPort -ne $requestedKioskPort) {
  Write-Host "Kiosk port $requestedKioskPort is in use. Using $kioskPort instead."
}

Write-Host "Starting kiosk app..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "`$env:VITE_WORKFLOW_PROXY_TARGET='$directApiBase'; Set-Location -LiteralPath '$PSScriptRoot\\kiosk-app'; & '$npmCmd' install; & '$npmCmd' run dev -- --host --port $kioskPort"
)

Write-Host "Live dashboard boot started."
Write-Host "Kiosk UI:       http://127.0.0.1:$kioskPort"
Write-Host "Workflow API:   $directApiBase"
if ($mode -eq 'bridge') {
  Write-Host "Mercury SOAP:   $soapBase"
  Write-Host "Bridge health:  http://127.0.0.1:$bridgePort/health"
}

