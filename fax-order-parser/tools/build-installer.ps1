param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [Parameter(Mandatory = $true)] [string]$NodeRuntimeDir,
  [string]$ServiceHostRuntimeIdentifier = "win-x64",
  [string]$ConfigAppRuntimeIdentifier   = "win-x64",
  [string]$Publisher    = "ebox86.com",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot    = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot   = Split-Path -Parent $scriptRoot
$installerIss      = Join-Path $projectRoot "installer\FTD.FaxOrderParser.iss"
$serviceHostCsproj = Join-Path $projectRoot "service-host\FTD.FaxParser.ServiceHost\FTD.FaxParser.ServiceHost.csproj"
$configAppCsproj   = Join-Path $projectRoot "config-app\FTD.FaxParser.ConfigApp\FTD.FaxParser.ConfigApp.csproj"
$stageRoot     = Join-Path $projectRoot "artifacts\installer\stage"
$distRoot      = Join-Path $projectRoot "dist"

# ── Verify prerequisites ───────────────────────────────────────────────────────

if (-not (Test-Path $installerIss))      { throw "Installer script not found: $installerIss" }
if (-not (Test-Path $serviceHostCsproj)) { throw "Service host project not found: $serviceHostCsproj" }
if (-not (Test-Path $configAppCsproj))   { throw "Config app project not found: $configAppCsproj" }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw "dotnet CLI not found on PATH." }
if (-not (Get-Command npm    -ErrorAction SilentlyContinue)) { throw "npm not found on PATH." }

$NodeRuntimeDir = [System.IO.Path]::GetFullPath($NodeRuntimeDir)
if (-not (Test-Path (Join-Path $NodeRuntimeDir "node.exe"))) {
  throw "Node runtime directory must contain node.exe. Got: $NodeRuntimeDir"
}

# Check InnoSetup
$isccViaPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$isccCandidates = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
  if ($isccViaPath) { $isccViaPath.Source }
) | Where-Object { $_ -and (Test-Path $_) }
if (-not $isccCandidates) { throw "Inno Setup 6 (ISCC.exe) not found. Install from https://jrsoftware.org/isdl.php" }
$iscc = $isccCandidates[0]

# ── Clean / create stage ───────────────────────────────────────────────────────

if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
$stageRuntime       = Join-Path $stageRoot "runtime"
$stageServiceDir    = Join-Path $stageRoot "service"
$stageServiceRuntime = Join-Path $stageRoot "service-runtime"
$stageConfigApp     = Join-Path $stageRoot "config-app"

New-Item -ItemType Directory -Path $stageRuntime, $stageServiceDir, $stageServiceRuntime, $stageConfigApp | Out-Null

# ── 1. Copy bundled Node.js runtime ───────────────────────────────────────────

Write-Host "Copying Node.js runtime from $NodeRuntimeDir ..."
Copy-Item -Path (Join-Path $NodeRuntimeDir "*") -Destination $stageRuntime -Recurse

# ── 2. Build Node.js service (TypeScript → dist) ──────────────────────────────

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

# Copy Tesseract trained data
$trainedData = Join-Path $projectRoot "eng.traineddata"
if (Test-Path $trainedData) {
  Copy-Item $trainedData -Destination $stageServiceDir
}

# Copy service management scripts
Copy-Item (Join-Path $projectRoot "service\install-fax-parser-service.ps1")   -Destination $stageServiceDir
Copy-Item (Join-Path $projectRoot "service\uninstall-fax-parser-service.ps1") -Destination $stageServiceDir

# ── 3. Build C# service host ───────────────────────────────────────────────────

Write-Host "Publishing C# service host ($ServiceHostRuntimeIdentifier)..."
dotnet publish $serviceHostCsproj `
  --configuration Release `
  --runtime $ServiceHostRuntimeIdentifier `
  --output $stageServiceRuntime `
  --no-self-contained `
  /p:PublishSingleFile=true

if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit code $LASTEXITCODE)." }

# ── 4. Publish WinForms config app ───────────────────────────────────────────

Write-Host "Publishing WinForms config app ($ConfigAppRuntimeIdentifier)..."
dotnet publish $configAppCsproj `
  --configuration Release `
  --runtime $ConfigAppRuntimeIdentifier `
  --output $stageConfigApp `
  --no-self-contained `
  /p:PublishSingleFile=true

if ($LASTEXITCODE -ne 0) { throw "Config app publish failed (exit code $LASTEXITCODE)." }

# ── 5. Copy app icon next to config exe (loaded at runtime by MainForm) ───────

$iconSrc = Join-Path $projectRoot "installer\assets\fax-parser.ico"
if (Test-Path $iconSrc) {
  Copy-Item $iconSrc -Destination (Join-Path $stageConfigApp "app-icon.ico") -Force
}

# ── 6. Copy icon to installer assets ─────────────────────────────────────────

$iconSrc = Join-Path $projectRoot "installer\assets\fax-parser.ico"
if (-not (Test-Path $iconSrc)) {
  Write-Warning "Icon file not found: $iconSrc — using a placeholder. The installer icon will be missing."
  # Create empty placeholder so InnoSetup doesn't fail
  [System.IO.File]::WriteAllBytes($iconSrc, [byte[]]@())
}

# ── 7. Run InnoSetup ─────────────────────────────────────────────────────────

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
Get-ChildItem (Join-Path $projectRoot "dist") -Filter "FTD.FaxOrderParser.Setup.*.exe" |
  ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Cyan }
