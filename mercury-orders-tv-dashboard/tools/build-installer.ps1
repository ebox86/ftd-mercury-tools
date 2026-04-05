param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [Parameter(Mandatory = $true)] [string]$NodeRuntimeDir,
  [string]$ServiceHostRuntimeIdentifier = "win-x64",
  [string]$Publisher = "ebox86.com",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$installerProjectPath = Join-Path $projectRoot "installer\FTD.MercuryDashboard.iss"
$serviceHostProject = Join-Path $projectRoot "service-host\FTD.Mercury.Dashboard.ServiceHost\FTD.Mercury.Dashboard.ServiceHost.csproj"
$stageRoot = Join-Path $projectRoot "artifacts\installer\stage"
$distRoot = Join-Path $projectRoot "dist"

if (-not (Test-Path $installerProjectPath)) {
  throw "Installer project not found: $installerProjectPath"
}
if (-not (Test-Path $serviceHostProject)) {
  throw "Service-host project not found: $serviceHostProject"
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "dotnet CLI was not found on PATH."
}

$NodeRuntimeDir = [System.IO.Path]::GetFullPath($NodeRuntimeDir)
if (-not (Test-Path (Join-Path $NodeRuntimeDir "node.exe"))) {
  throw "Node runtime directory must contain node.exe. Got: $NodeRuntimeDir"
}

$kioskDist = Join-Path $projectRoot "kiosk-app\dist"
$bridgeServer = Join-Path $projectRoot "workflow-bridge\server.mjs"
$webHostServer = Join-Path $projectRoot "service-host\dashboard-web-server.mjs"
$serviceInstallScript = Join-Path $projectRoot "service\install-mercury-dashboard-services.ps1"
$serviceUninstallScript = Join-Path $projectRoot "service\uninstall-mercury-dashboard-services.ps1"
$referenceDir = Join-Path $projectRoot "reference"

if (-not (Test-Path (Join-Path $kioskDist "index.html"))) {
  throw "kiosk-app dist output is missing. Build kiosk-app first: npm run build"
}
if (-not (Test-Path $bridgeServer)) {
  throw "Bridge server file missing: $bridgeServer"
}
if (-not (Test-Path $webHostServer)) {
  throw "Dashboard web host file missing: $webHostServer"
}
if (-not (Test-Path $serviceInstallScript)) {
  throw "Service install script missing: $serviceInstallScript"
}
if (-not (Test-Path $serviceUninstallScript)) {
  throw "Service uninstall script missing: $serviceUninstallScript"
}
if (-not (Test-Path $referenceDir)) {
  throw "Reference directory missing: $referenceDir"
}

if (Test-Path $stageRoot) {
  Remove-Item -Recurse -Force $stageRoot
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null

$stageRuntime = Join-Path $stageRoot "runtime"
$stageServiceRuntime = Join-Path $stageRoot "service-runtime"
$stageKioskDist = Join-Path $stageRoot "kiosk-app\dist"
$stageBridge = Join-Path $stageRoot "workflow-bridge"
$stageReference = Join-Path $stageRoot "reference"
$stageServiceHost = Join-Path $stageRoot "service-host"
$stageService = Join-Path $stageRoot "service"

New-Item -ItemType Directory -Path $stageRuntime, $stageServiceRuntime, $stageKioskDist, $stageBridge, $stageReference, $stageServiceHost, $stageService | Out-Null

Copy-Item -Path (Join-Path $NodeRuntimeDir "*") -Destination $stageRuntime -Recurse
Copy-Item -Path (Join-Path $kioskDist "*") -Destination $stageKioskDist -Recurse
Copy-Item -Path $bridgeServer -Destination (Join-Path $stageBridge "server.mjs") -Force
Copy-Item -Path (Join-Path $projectRoot "workflow-bridge\package.json") -Destination (Join-Path $stageBridge "package.json") -Force
Copy-Item -Path (Join-Path $projectRoot "workflow-bridge\package-lock.json") -Destination (Join-Path $stageBridge "package-lock.json") -Force
Copy-Item -Path (Join-Path $referenceDir "*") -Destination $stageReference -Recurse
Copy-Item -Path $webHostServer -Destination (Join-Path $stageServiceHost "dashboard-web-server.mjs") -Force
Copy-Item -Path $serviceInstallScript -Destination (Join-Path $stageService "install-mercury-dashboard-services.ps1") -Force
Copy-Item -Path $serviceUninstallScript -Destination (Join-Path $stageService "uninstall-mercury-dashboard-services.ps1") -Force

Write-Host "Publishing dashboard service host ($ServiceHostRuntimeIdentifier self-contained)..."
& dotnet publish $serviceHostProject -c Release -r $ServiceHostRuntimeIdentifier --self-contained true -o $stageServiceRuntime
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$serviceHostExe = Join-Path $stageServiceRuntime "FTD.Mercury.Dashboard.ServiceHost.exe"
if (-not (Test-Path $serviceHostExe)) {
  throw "Compiled service host executable not found: $serviceHostExe"
}

if (-not (Test-Path $distRoot)) {
  New-Item -ItemType Directory -Path $distRoot | Out-Null
}

$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  throw "iscc.exe (Inno Setup compiler) was not found on PATH."
}

$defineVersion = "/DMyAppVersion=$Version"
$definePublisher = '/DMyAppPublisher="' + $Publisher + '"'
$defineUrl = '/DMyAppURL="' + $PublisherUrl + '"'

$compileArgs = @(
  $defineVersion,
  $definePublisher,
  $defineUrl,
  $installerProjectPath
)

Write-Host "Compiling Mercury dashboard installer with Inno Setup..."
& $iscc.Source @compileArgs
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup compile failed with exit code $LASTEXITCODE"
}

$installerPath = Join-Path $distRoot "FTD.MercuryDashboard.Setup.$Version.exe"
if (-not (Test-Path $installerPath)) {
  throw "Expected installer output not found: $installerPath"
}

Write-Host "Installer built: $installerPath"
Write-Output $installerPath
