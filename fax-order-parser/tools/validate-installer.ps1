# validate-installer.ps1
# Syntax-checks FTD.FaxOrderParser.iss without building a full installer.
# Requires Inno Setup 6 to be installed locally.
# Usage: .\tools\validate-installer.ps1

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot  = Split-Path -Parent $scriptRoot
$installerIss = Join-Path $projectRoot "installer\FTD.FaxOrderParser.iss"

$isccViaPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$isccCandidates = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
  if ($isccViaPath) { $isccViaPath.Source }
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $isccCandidates) {
  Write-Warning "Inno Setup 6 not found locally - skipping .iss syntax check."
  exit 0
}
$iscc = $isccCandidates[0]

# ISCC has no dedicated syntax-only mode, so we compile against a dummy stage
# that contains the minimum files the [Files] section references.  Missing
# source files that have the skipifsourcedoesntexist flag are ignored; required
# files (icon, .exe, .ps1) need at least an empty placeholder.
$tmpStage = Join-Path ([System.IO.Path]::GetTempPath()) "iss-validate-$([System.Guid]::NewGuid())"
$tmpDist  = Join-Path ([System.IO.Path]::GetTempPath()) "iss-validate-dist-$([System.Guid]::NewGuid())"

try {
  foreach ($sub in @("runtime","service","service-runtime","config-app")) {
    $subDir = Join-Path $tmpStage $sub
    New-Item -ItemType Directory -Path $subDir -Force | Out-Null
    # ISCC requires at least one matching file for wildcard [Files] entries
    [System.IO.File]::WriteAllBytes((Join-Path $subDir "placeholder.tmp"), [byte[]]@())
  }

  # Stub required files so ISCC can resolve them during parsing
  $stubs = @(
    "service-runtime\FTD.FaxParser.ServiceHost.exe",
    "config-app\FaxParserConfig.exe",
    "service\install-fax-parser-service.ps1",
    "service\uninstall-fax-parser-service.ps1"
  )
  foreach ($stub in $stubs) {
    $dest = Join-Path $tmpStage $stub
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    [System.IO.File]::WriteAllBytes($dest, [byte[]]@())
  }

  # Stub the icon next to the .iss file if it's missing
  $iconSrc = Join-Path $projectRoot "installer\assets\fax-parser.ico"
  $iconTemp = $null
  if (-not (Test-Path $iconSrc)) {
    $iconTemp = $iconSrc
    New-Item -ItemType Directory -Path (Split-Path $iconTemp) -Force | Out-Null
    [System.IO.File]::WriteAllBytes($iconTemp, [byte[]]@())
  }

  New-Item -ItemType Directory -Path $tmpDist -Force | Out-Null

  Write-Host "Validating $installerIss ..."
  & $iscc $installerIss `
    "/DMyAppVersion=0.0.0-validate" `
    "/DStageDir=$tmpStage" `
    "/O$tmpDist"

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Inno Setup syntax check FAILED (exit code $LASTEXITCODE)."
    exit $LASTEXITCODE
  }

  Write-Host "Inno Setup syntax check PASSED." -ForegroundColor Green
} finally {
  if (Test-Path $tmpStage) { Remove-Item -Recurse -Force $tmpStage }
  if (Test-Path $tmpDist)  { Remove-Item -Recurse -Force $tmpDist }
  if ($iconTemp -and (Test-Path $iconTemp)) { Remove-Item -Force $iconTemp }
}
