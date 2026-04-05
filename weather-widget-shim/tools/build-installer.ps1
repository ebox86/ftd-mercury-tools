param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [string]$Publisher = "ebox86.com",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$installerProjectPath = Join-Path $projectRoot "installer\FTD.WeatherXoapShim.iss"
$stageRoot = Join-Path $projectRoot "artifacts\installer\stage"
$distRoot = Join-Path $projectRoot "dist"

if (-not (Test-Path $installerProjectPath)) {
  throw "Installer project not found: $installerProjectPath"
}

$siteRoot = Join-Path $projectRoot "site"
$scriptsRoot = Join-Path $projectRoot "scripts"
if (-not (Test-Path (Join-Path $siteRoot "web.config"))) {
  throw "site/web.config missing under $siteRoot"
}
if (-not (Test-Path (Join-Path $scriptsRoot "install-weather-xoap-shim.ps1"))) {
  throw "install script missing under $scriptsRoot"
}
if (-not (Test-Path (Join-Path $scriptsRoot "uninstall-weather-xoap-shim.ps1"))) {
  throw "uninstall script missing under $scriptsRoot"
}

if (Test-Path $stageRoot) {
  Remove-Item -Recurse -Force $stageRoot
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null

$stageSite = Join-Path $stageRoot "site"
$stageScripts = Join-Path $stageRoot "scripts"
$stageRootReadme = Join-Path $stageRoot "README.md"
New-Item -ItemType Directory -Path $stageSite, $stageScripts | Out-Null

Copy-Item -Path (Join-Path $siteRoot "*") -Destination $stageSite -Recurse
Copy-Item -Path (Join-Path $scriptsRoot "*") -Destination $stageScripts -Recurse
Copy-Item -Path (Join-Path $projectRoot "README.md") -Destination $stageRootReadme -Force

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

Write-Host "Compiling Weather XOAP shim installer with Inno Setup..."
& $iscc.Source @compileArgs
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup compile failed with exit code $LASTEXITCODE"
}

$installerPath = Join-Path $distRoot "FTD.WeatherXoapShim.Setup.$Version.exe"
if (-not (Test-Path $installerPath)) {
  throw "Expected installer output not found: $installerPath"
}

Write-Host "Installer built: $installerPath"
Write-Output $installerPath
