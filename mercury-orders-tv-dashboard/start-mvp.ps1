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
$bridgePort = 17344
if ($env:BRIDGE_PORT -and [int]::TryParse(([string]$env:BRIDGE_PORT), [ref]$bridgePort) -eq $false) {
  $bridgePort = 17344
}

Write-Host "Starting Mercury workflow bridge..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "$env:PORT='$bridgePort'; cd '$PSScriptRoot\\workflow-bridge'; & '$npmCmd' install; & '$npmCmd' start"
)

Start-Sleep -Seconds 2

Write-Host "Starting kiosk app..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "cd '$PSScriptRoot\\kiosk-app'; & '$npmCmd' install; & '$npmCmd' run dev -- --host"
)

Write-Host "MVP boot started."
Write-Host "Workflow API: http://127.0.0.1:$bridgePort/health"
Write-Host "Kiosk UI: http://127.0.0.1:5173"

