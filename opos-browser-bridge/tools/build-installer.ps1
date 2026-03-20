param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [string]$Publisher = "FTD",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$issPath = Join-Path $projectRoot "installer\FTD.OposBridge.iss"
$distDir = Join-Path $projectRoot "dist"

if (-not (Test-Path $issPath)) {
  throw "Inno Setup project not found: $issPath"
}

if (-not (Test-Path $distDir)) {
  New-Item -ItemType Directory -Path $distDir | Out-Null
}

$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  throw "iscc.exe (Inno Setup compiler) not found on PATH."
}

$compileArgs = @(
  "/DMyAppVersion=$Version",
  "/DMyAppPublisher=$Publisher",
  "/DMyAppURL=$PublisherUrl",
  $issPath
)

Write-Host "Compiling installer with iscc.exe..."
& $iscc.Source @compileArgs
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup compilation failed with exit code $LASTEXITCODE"
}

$installerPath = Join-Path $distDir "FTD.OposBridge.Setup.$Version.exe"
if (-not (Test-Path $installerPath)) {
  throw "Expected installer not found: $installerPath"
}

Write-Host "Installer built: $installerPath"
Write-Output $installerPath
