<#
.SYNOPSIS
  Local dev build for FTD Fax Order Parser. No push to GitHub required.
  Builds TypeScript + both C# projects, then either:
    (a) Builds a real .exe installer if Inno Setup 6 is installed, or
    (b) Deploys directly to C:\FTDTools\FaxOrderParser so you can test immediately.

.PARAMETER Version       Installer version label. Default: 0.0.0-dev
.PARAMETER NodeRuntimeDir Path to a folder containing node.exe. Auto-downloaded if omitted.
.PARAMETER SkipInstaller  Deploy directly even if ISCC.exe is present.
.PARAMETER DeployOnly     Skip all build steps; re-deploy the existing stage.

.EXAMPLE
  # Full build + deploy (no installer needed)
  .\tools\dev-build.ps1

  # Full build + produce real installer (requires Inno Setup 6)
  .\tools\dev-build.ps1 -Version 1.0.0-test

  # Quick redeploy after editing C# without rebuilding everything
  .\tools\dev-build.ps1 -DeployOnly
#>
param(
  [string] $Version        = "0.0.0-dev",
  [string] $NodeRuntimeDir = "",
  [switch] $SkipInstaller,
  [switch] $DeployOnly
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$scriptRoot         = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot        = Split-Path -Parent $scriptRoot
$stageRoot          = Join-Path $projectRoot "artifacts\installer\stage"
$distRoot           = Join-Path $projectRoot "dist"
$installDir         = "C:\FTDTools\FaxOrderParser"
$nodeVersion        = "v20.19.0"
$serviceHostCsproj  = Join-Path $projectRoot "service-host\FTD.FaxParser.ServiceHost\FTD.FaxParser.ServiceHost.csproj"
$configAppCsproj    = Join-Path $projectRoot "config-app\FTD.FaxParser.ConfigApp\FTD.FaxParser.ConfigApp.csproj"
$installerIss       = Join-Path $projectRoot "installer\FTD.FaxOrderParser.iss"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-NodeRuntime {
  $toolsRoot  = Join-Path $projectRoot "artifacts\tooling-local"
  $extractDir = Join-Path $toolsRoot "node-runtime"
  $nodeDir    = Join-Path $extractDir "node-$nodeVersion-win-x64"

  if (Test-Path (Join-Path $nodeDir "node.exe")) {
    Write-Host "Node runtime cached at $nodeDir"
    return $nodeDir
  }

  Write-Host "Downloading Node.js $nodeVersion ..."
  New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

  $zipName = "node-$nodeVersion-win-x64.zip"
  $zipPath = Join-Path $toolsRoot $zipName

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
      Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/$zipName" -OutFile $zipPath
      break
    } catch {
      if ($attempt -eq 3) { throw }
      Start-Sleep -Seconds 3
    }
  }

  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

  if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
    throw "node.exe not found after extraction: $nodeDir"
  }
  return $nodeDir
}

# ---------------------------------------------------------------------------
# Resolve Node runtime (skipped for DeployOnly)
# ---------------------------------------------------------------------------

if (-not $DeployOnly) {
  if ([string]::IsNullOrWhiteSpace($NodeRuntimeDir)) {
    $NodeRuntimeDir = Get-NodeRuntime
  } else {
    $NodeRuntimeDir = [System.IO.Path]::GetFullPath($NodeRuntimeDir)
    if (-not (Test-Path (Join-Path $NodeRuntimeDir "node.exe"))) {
      throw "node.exe not found in: $NodeRuntimeDir"
    }
  }
}

# ---------------------------------------------------------------------------
# Find ISCC
# ---------------------------------------------------------------------------

$iscc = $null
if (-not $SkipInstaller) {
  $candidates = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  )
  $isccCmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($isccCmd) { $candidates += $isccCmd.Source }
  $iscc = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

  if (-not $iscc) {
    Write-Warning "Inno Setup 6 not found -- will deploy directly to $installDir."
    Write-Warning "Install from https://jrsoftware.org/isdl.php to enable installer builds."
  }
}

# ---------------------------------------------------------------------------
# Ensure dotnet is on PATH (elevated sessions may not inherit user PATH)
# ---------------------------------------------------------------------------

$dotnetExe = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnetExe) {
  $dotnetCandidates = @(
    "C:\Program Files\dotnet",
    "C:\Program Files (x86)\dotnet",
    (Join-Path $env:LOCALAPPDATA "Microsoft\dotnet"),
    (Join-Path $env:ProgramFiles "dotnet")
  )
  $dotnetDir = $dotnetCandidates | Where-Object { $_ -and (Test-Path (Join-Path $_ "dotnet.exe")) } | Select-Object -First 1
  if ($dotnetDir) {
    $env:PATH = "$dotnetDir;$env:PATH"
    Write-Host "Found dotnet at $dotnetDir"
  } else {
    throw "dotnet not found. Download the .NET 8 SDK from https://aka.ms/dotnet/download"
  }
}

# Verify an SDK is installed (runtime-only installs cannot build)
$sdkList = & dotnet --list-sdks 2>&1
if (-not $sdkList) {
  throw ".NET SDK not found (only the runtime is installed). Download the .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0"
}

# ---------------------------------------------------------------------------
# Stage dirs
# ---------------------------------------------------------------------------

$stageRuntime        = Join-Path $stageRoot "runtime"
$stageServiceDir     = Join-Path $stageRoot "service"
$stageServiceRuntime = Join-Path $stageRoot "service-runtime"
$stageConfigApp      = Join-Path $stageRoot "config-app"

if (-not $DeployOnly) {
  if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
  New-Item -ItemType Directory -Path $stageRuntime, $stageServiceDir, $stageServiceRuntime, $stageConfigApp | Out-Null
}

# ---------------------------------------------------------------------------
# BUILD STEPS  (skipped with -DeployOnly)
# ---------------------------------------------------------------------------

if (-not $DeployOnly) {

  Write-Host ""
  Write-Host "[1/4] Copying Node.js runtime..." -ForegroundColor Cyan
  Copy-Item -Path (Join-Path $NodeRuntimeDir "*") -Destination $stageRuntime -Recurse

  $npmCmd = Join-Path $NodeRuntimeDir "npm.cmd"
  if (-not (Test-Path $npmCmd)) { $npmCmd = Join-Path $NodeRuntimeDir "npm" }

  # Ensure node.exe is on PATH so npm post-install scripts can find it
  $env:PATH = "$NodeRuntimeDir;$env:PATH"

  Write-Host ""
  Write-Host "[2/4] Building Node.js service (TypeScript)..." -ForegroundColor Cyan
  Push-Location $projectRoot
  & $npmCmd install
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install failed." }
  & $npmCmd run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "TypeScript build failed." }
  Pop-Location

  $distService = Join-Path $projectRoot "dist\service.js"
  if (-not (Test-Path $distService)) { throw "Compiled service.js not found." }

  Copy-Item (Join-Path $projectRoot "dist\*.js") -Destination $stageServiceDir -ErrorAction SilentlyContinue
  $nmSrc = Join-Path $projectRoot "node_modules"
  if (Test-Path $nmSrc) {
    Copy-Item $nmSrc -Destination (Join-Path $stageServiceDir "node_modules") -Recurse
  }
  $td = Join-Path $projectRoot "eng.traineddata"
  if (Test-Path $td) { Copy-Item $td -Destination $stageServiceDir }
  Copy-Item (Join-Path $projectRoot "service\*.ps1") -Destination $stageServiceDir -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "[3/4] Publishing C# service host..." -ForegroundColor Cyan
  dotnet publish $serviceHostCsproj -c Release -r win-x64 --output $stageServiceRuntime --no-self-contained /p:PublishSingleFile=true
  if ($LASTEXITCODE -ne 0) { throw "Service host publish failed." }

  Write-Host ""
  Write-Host "[4/4] Publishing WinForms config app..." -ForegroundColor Cyan
  dotnet publish $configAppCsproj -c Release -r win-x64 --output $stageConfigApp --no-self-contained /p:PublishSingleFile=true
  if ($LASTEXITCODE -ne 0) { throw "Config app publish failed." }

  $iconSrc = Join-Path $projectRoot "installer\assets\fax-parser.ico"
  if (Test-Path $iconSrc) {
    Copy-Item $iconSrc -Destination (Join-Path $stageConfigApp "app-icon.ico") -Force
  }
}

# ---------------------------------------------------------------------------
# INSTALLER  or  DIRECT DEPLOY
# ---------------------------------------------------------------------------

if ($iscc) {

  Write-Host ""
  Write-Host "Running InnoSetup..." -ForegroundColor Cyan
  if (-not (Test-Path $distRoot)) { New-Item -ItemType Directory -Path $distRoot | Out-Null }

  $iconSrc = Join-Path $projectRoot "installer\assets\fax-parser.ico"
  if (-not (Test-Path $iconSrc)) { [System.IO.File]::WriteAllBytes($iconSrc, [byte[]]@()) }

  & $iscc $installerIss `
    "/DMyAppVersion=$Version" `
    "/DMyAppPublisher=ebox86.com" `
    "/DMyAppURL=https://github.com/ebox86/ftd-mercury-tools" `
    "/DStageDir=$stageRoot"

  if ($LASTEXITCODE -ne 0) { throw "InnoSetup failed." }

  Write-Host ""
  Write-Host "Build complete. Installer:" -ForegroundColor Green
  Get-ChildItem $distRoot -Filter "FTD.FaxOrderParser.Setup.*.exe" |
    ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Cyan }

} else {

  Write-Host ""
  Write-Host "Deploying to $installDir ..." -ForegroundColor Cyan

  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

  if (-not $isAdmin) {
    Write-Warning "Not running as Administrator -- service registration will be skipped."
    Write-Warning "Re-run from an elevated PowerShell to register the Windows service."
  }

  # Stop the service if running so files are not locked
  $svc = Get-Service "FTD Fax Order Parser" -ErrorAction SilentlyContinue
  if ($svc -and $isAdmin -and $svc.Status -eq "Running") {
    Write-Host "Stopping service..."
    Stop-Service "FTD Fax Order Parser" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  # Copy stage -> install dir (mirrors InnoSetup [Files] layout)
  $map = @{
    $stageRuntime        = Join-Path $installDir "runtime"
    $stageServiceDir     = Join-Path $installDir "service"
    $stageServiceRuntime = Join-Path $installDir "service-runtime"
    $stageConfigApp      = Join-Path $installDir "config-app"
  }

  foreach ($src in $map.Keys) {
    $dst = $map[$src]
    if (-not (Test-Path $src)) { Write-Warning "Stage dir missing: $src (skipped)"; continue }
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    Write-Host "  $src -> $dst"
  }

  # Create ProgramData dirs (mirrors InnoSetup [Dirs])
  New-Item -ItemType Directory -Path (Join-Path $env:ProgramData "FTD\FaxOrderParser") -Force | Out-Null
  New-Item -ItemType Directory -Path "C:\received_faxes" -Force | Out-Null

  # Register / update the Windows service
  if ($isAdmin) {
    $installScript = Join-Path $installDir "service\install-fax-parser-service.ps1"
    if (Test-Path $installScript) {
      Write-Host "Registering service..."
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript -AppRoot $installDir
    } else {
      Write-Warning "install-fax-parser-service.ps1 not found -- service not registered."
    }
  }

  Write-Host ""
  Write-Host "Deployed to $installDir" -ForegroundColor Green
  Write-Host "  Config app : $installDir\config-app\FaxParserConfig.exe" -ForegroundColor Cyan
  Write-Host "  Launch     : Start-Process '$installDir\config-app\FaxParserConfig.exe'" -ForegroundColor Cyan
}
