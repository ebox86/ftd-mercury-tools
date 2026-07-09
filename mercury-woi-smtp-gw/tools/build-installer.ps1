param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [Parameter(Mandatory = $true)] [string]$NodeRuntimeDir,
  [string]$Publisher    = "ebox86.com",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot    = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot   = Split-Path -Parent $scriptRoot
$installerIss  = Join-Path $projectRoot "installer\FTD.WoiSmtpGateway.iss"
$stageRoot     = Join-Path $projectRoot "artifacts\installer\stage"
$distRoot      = Join-Path $projectRoot "dist"

# Verify prerequisites

if (-not (Test-Path $installerIss)) { throw "Installer script not found: $installerIss" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found on PATH." }

$NodeRuntimeDir = [System.IO.Path]::GetFullPath($NodeRuntimeDir)
if (-not (Test-Path (Join-Path $NodeRuntimeDir "node.exe"))) {
  throw "Node runtime directory must contain node.exe. Got: $NodeRuntimeDir"
}

# Check InnoSetup
$isccOnPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$isccCandidates = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe",
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
) | Where-Object { $_ -and (Test-Path $_) }
if ($isccOnPath -and (Test-Path $isccOnPath.Source)) {
  $isccCandidates += $isccOnPath.Source
}
if (-not $isccCandidates) { throw "Inno Setup 6 (ISCC.exe) not found. Install from https://jrsoftware.org/isdl.php" }
$iscc = @($isccCandidates)[0]

# Clean / create stage

if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
$stageRuntime   = Join-Path $stageRoot "runtime"
$stageServiceDir = Join-Path $stageRoot "service"

New-Item -ItemType Directory -Path $stageRuntime, $stageServiceDir | Out-Null

# 1. Copy bundled Node.js runtime

Write-Host "Copying Node.js runtime from $NodeRuntimeDir ..."
Copy-Item -Path (Join-Path $NodeRuntimeDir "*") -Destination $stageRuntime -Recurse

# 2. Build Node.js service (TypeScript to dist)

Write-Host "Building Node.js service (TypeScript)..."
Push-Location $projectRoot
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install failed (exit code $LASTEXITCODE)." }
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "TypeScript build failed (exit code $LASTEXITCODE)." }
Pop-Location

# Copy compiled service.js and its runtime dependencies
$distService = Join-Path $projectRoot "dist\service.js"
if (-not (Test-Path $distService)) { throw "Compiled service.js not found: $distService" }

Copy-Item $distService -Destination $stageServiceDir
Copy-Item (Join-Path $projectRoot "dist\*.js") -Destination $stageServiceDir -ErrorAction SilentlyContinue

# Copy node_modules needed at runtime
$serviceModules = Join-Path $projectRoot "node_modules"
if (Test-Path $serviceModules) {
  Copy-Item $serviceModules -Destination (Join-Path $stageServiceDir "node_modules") -Recurse
}

# Copy service management scripts
Copy-Item (Join-Path $projectRoot "service\install-woi-smtp-gateway.ps1")   -Destination $stageServiceDir
Copy-Item (Join-Path $projectRoot "service\uninstall-woi-smtp-gateway.ps1") -Destination $stageServiceDir

# 3. Run InnoSetup

if (-not (Test-Path $distRoot)) { New-Item -ItemType Directory -Path $distRoot | Out-Null }

Write-Host "Running InnoSetup..."
& $iscc $installerIss `
  "/DMyAppVersion=$Version" `
  "/DMyAppPublisher=$Publisher" `
  "/DMyAppURL=$PublisherUrl" `
  "/DStageDir=$stageRoot"

if ($LASTEXITCODE -ne 0) { throw "InnoSetup failed (exit code $LASTEXITCODE)." }

Write-Host ""
Write-Host "Build complete. Installer output:" -ForegroundColor Green
Get-Item (Join-Path $distRoot "FTD.WoiSmtpGateway.Setup.*.exe") | ForEach-Object { Write-Host $_.FullName }
