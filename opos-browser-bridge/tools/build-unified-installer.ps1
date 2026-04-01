param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [string]$Publisher = "FTD",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$serviceProject = Join-Path $projectRoot "service\FTD.OposBridge.Service\FTD.OposBridge.Service.csproj"
$installerProjectPath = Join-Path $projectRoot "installer\FTD.OposBridge.Unified.iss"
$installerScriptsRoot = Join-Path $projectRoot "installer\scripts"
$serviceScriptsRoot = Join-Path $projectRoot "service"
$stageRoot = Join-Path $projectRoot "artifacts\installer-unified\stage"
$stagePayloadRoot = Join-Path $stageRoot "payload"
$stageRuntimeRoot = Join-Path $stagePayloadRoot "service-runtime"
$stageServiceScriptsRoot = Join-Path $stagePayloadRoot "service-scripts"
$stageInstallerScriptsRoot = Join-Path $stageRoot "scripts"
$distRoot = Join-Path $projectRoot "dist"

if (-not (Test-Path $serviceProject)) {
  throw "Service project not found: $serviceProject"
}
if (-not (Test-Path $installerProjectPath)) {
  throw "Unified installer project not found: $installerProjectPath"
}
if (-not (Test-Path $installerScriptsRoot)) {
  throw "Installer script folder not found: $installerScriptsRoot"
}

$requiredInstallerScripts = @(
  "install-opos-bridge-unified.ps1",
  "uninstall-opos-bridge-unified.ps1"
)
foreach ($file in $requiredInstallerScripts) {
  $path = Join-Path $installerScriptsRoot $file
  if (-not (Test-Path $path)) {
    throw "Missing installer script: $path"
  }
}

$requiredServiceScripts = @(
  "install-opos-bridge-service.ps1",
  "install-opos-bridge-task.ps1",
  "migrate-script-bridge-to-service.ps1"
)
foreach ($file in $requiredServiceScripts) {
  $path = Join-Path $serviceScriptsRoot $file
  if (-not (Test-Path $path)) {
    throw "Missing service script: $path"
  }
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "dotnet CLI was not found on PATH."
}

if (Test-Path $stageRoot) {
  Remove-Item -Recurse -Force $stageRoot
}
New-Item -ItemType Directory -Path $stageRuntimeRoot, $stageServiceScriptsRoot, $stageInstallerScriptsRoot | Out-Null

Write-Host "Publishing OPOS bridge service runtime (win-x86 self-contained)..."
& dotnet publish $serviceProject -c Release -r win-x86 --self-contained true -o $stageRuntimeRoot
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

foreach ($file in $requiredServiceScripts) {
  Copy-Item -Path (Join-Path $serviceScriptsRoot $file) -Destination (Join-Path $stageServiceScriptsRoot $file) -Force
}

foreach ($file in $requiredInstallerScripts) {
  Copy-Item -Path (Join-Path $installerScriptsRoot $file) -Destination (Join-Path $stageInstallerScriptsRoot $file) -Force
}

Copy-Item -Path (Join-Path $projectRoot "README.md") -Destination (Join-Path $stageRoot "README.md") -Force
Copy-Item -Path (Join-Path $projectRoot "service\README.md") -Destination (Join-Path $stageRoot "SERVICE.README.md") -Force

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

Write-Host "Compiling unified OPOS bridge installer with Inno Setup..."
& $iscc.Source @compileArgs
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup compile failed with exit code $LASTEXITCODE"
}

$installerPath = Join-Path $distRoot "FTD.OposBridge.Unified.Setup.$Version.exe"
if (-not (Test-Path $installerPath)) {
  throw "Expected installer output not found: $installerPath"
}

Write-Host "Installer built: $installerPath"
Write-Output $installerPath
