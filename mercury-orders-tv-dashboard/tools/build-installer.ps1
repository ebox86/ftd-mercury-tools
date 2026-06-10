param(
  [Parameter(Mandatory = $true)] [string]$Version,
  [Parameter(Mandatory = $true)] [string]$NodeRuntimeDir,
  [string]$ServiceHostRuntimeIdentifier = "win-x64",
  [string]$Publisher = "ebox86.com",
  [string]$PublisherUrl = "https://github.com/example/ftd-mercury-tools",
  [string]$MapboxToken = ""
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

$defineVersion = "/DMyAppVersion=$Version"
$definePublisher = '/DMyAppPublisher="' + $Publisher + '"'
$defineUrl = '/DMyAppURL="' + $PublisherUrl + '"'

function Normalize-MapboxToken {
  param([string]$RawToken)
  $token = ""
  if ($null -ne $RawToken) {
    $token = $RawToken.Trim()
  }
  if ($token -match '(?i)^(MAPBOX_TOKEN|MAPBOX_ACCESS_TOKEN)\s*=\s*(.*)$') {
    $token = $Matches[2].Trim()
  }
  if (($token.StartsWith('"') -and $token.EndsWith('"')) -or ($token.StartsWith("'") -and $token.EndsWith("'"))) {
    $token = $token.Substring(1, $token.Length - 2).Trim()
  }
  return $token
}

function Read-MapboxTokenFromEnvFile {
  param([string]$EnvPath)

  if (-not (Test-Path $EnvPath)) {
    return ""
  }

  $lines = Get-Content -Path $EnvPath -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    $text = ([string]$line).Trim()
    if (-not $text -or $text.StartsWith("#")) {
      continue
    }
    if ($text -match '^(?i)\s*(MAPBOX_TOKEN|MAPBOX_ACCESS_TOKEN)\s*=\s*(.*)$') {
      return Normalize-MapboxToken $Matches[2]
    }
  }

  return ""
}

function Read-WebResponseBody {
  param($Response)

  if ($null -eq $Response) {
    return ""
  }

  try {
    if ($Response.PSObject.Properties.Name -contains "Content") {
      $content = $Response.Content
      if ($null -ne $content) {
        if ($content -is [byte[]]) {
          return [System.Text.Encoding]::UTF8.GetString($content)
        }
        if ($content.PSObject.Methods.Name -contains "ReadAsStringAsync") {
          return $content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
        return [string]$content
      }
    }

    if ($Response.PSObject.Methods.Name -notcontains "GetResponseStream") {
      return ""
    }

    $stream = $Response.GetResponseStream()
    if ($null -eq $stream) {
      return ""
    }

    $reader = [System.IO.StreamReader]::new($stream)
    return $reader.ReadToEnd()
  } catch {
    return ""
  }
}

function Invoke-MapboxValidationRequest {
  param(
    [Parameter(Mandatory = $true)] [string]$Name,
    [Parameter(Mandatory = $true)] [string]$Uri
  )

  try {
    return Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 20 -UseBasicParsing
  } catch {
    $status = ""
    $body = ""
    $errorResponse = $null
    if ($_.Exception.PSObject.Properties.Name -contains "Response") {
      $errorResponse = $_.Exception.Response
    }
    if ($null -ne $errorResponse) {
      try { $status = " HTTP $([int]$errorResponse.StatusCode)" } catch { $status = "" }
      $body = (Read-WebResponseBody $errorResponse).Trim()
    }

    if ($body.Length -gt 240) {
      $body = $body.Substring(0, 240)
    }

    $bodySuffix = ""
    if ($body) {
      $bodySuffix = " Body: $body"
    }

    throw "MAPBOX_TOKEN validation failed for ${Name}.${status} $($_.Exception.Message)$bodySuffix"
  }
}

function Get-JsonPropertyValue {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Test-MapboxGeocoding {
  param([Parameter(Mandatory = $true)] [string]$Token)

  $queries = @(
    "1600 Pennsylvania Ave NW Washington DC 20500",
    "608 Foreland Street Pittsburgh PA 15212",
    "1222 E Carson St Pittsburgh PA 15203"
  )

  foreach ($query in $queries) {
    $encodedQuery = [System.Uri]::EscapeDataString($query)
    $encodedToken = [System.Uri]::EscapeDataString($Token)
    $uri = "https://api.mapbox.com/search/geocode/v6/forward?q=$encodedQuery&country=US&limit=1&autocomplete=false&types=address,street,place,postcode&access_token=$encodedToken"
    $response = Invoke-MapboxValidationRequest -Name "Mapbox v6 forward geocoding" -Uri $uri
    $json = (Read-WebResponseBody $response) | ConvertFrom-Json
    $features = Get-JsonPropertyValue -Object $json -Name "features"
    $featureCount = 0
    if ($null -ne $features) {
      $featureCount = @($features).Count
    }

    if ($featureCount -gt 0) {
      Write-Host "MAPBOX_TOKEN v6 geocoding validated with $featureCount match(es)."
      return
    }

    Write-Host "Mapbox v6 validation query returned no matches: $query"
  }

  throw "MAPBOX_TOKEN validation returned no v6 geocoding results for validation queries."
}

function Test-MapboxTokenForInstaller {
  param([Parameter(Mandatory = $true)] [string]$Token)

  $encodedMapboxToken = [System.Uri]::EscapeDataString($Token)
  Test-MapboxGeocoding -Token $Token

  $staticMapUri = "https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/pin-s+176b87(-79.999037,40.454896)/-79.999037,40.454896,13,0/320x180@2x?access_token=$encodedMapboxToken&attribution=false&logo=false"
  [void](Invoke-MapboxValidationRequest -Name "Mapbox Static Images" -Uri $staticMapUri)
  Write-Host "MAPBOX_TOKEN validated for installer geocoding and static maps."
}

$MapboxToken = Normalize-MapboxToken $MapboxToken
if (-not $MapboxToken) {
  $MapboxToken = Normalize-MapboxToken ([string]$env:MAPBOX_TOKEN)
}
if (-not $MapboxToken) {
  $MapboxToken = Normalize-MapboxToken ([string]$env:MAPBOX_ACCESS_TOKEN)
}
if (-not $MapboxToken) {
  $MapboxToken = Read-MapboxTokenFromEnvFile (Join-Path $projectRoot ".env")
}
if (-not $MapboxToken) {
  $MapboxToken = Read-MapboxTokenFromEnvFile (Join-Path $projectRoot "workflow-bridge\.env")
}

if ($MapboxToken) {
  Test-MapboxTokenForInstaller -Token $MapboxToken
} else {
  Write-Warning "No MAPBOX_TOKEN was provided. The generated installer will install successfully, but delivery-map geocoding/static maps will be disabled."
}

$compileArgs = @(
  $defineVersion,
  $definePublisher,
  $defineUrl,
  $installerProjectPath
)

if ($MapboxToken) {
  $escapedMapboxToken = $MapboxToken.Replace('"', '""')
  $compileArgs = @(
    $defineVersion,
    $definePublisher,
    $defineUrl,
    '/DEmbeddedMapboxToken="' + $escapedMapboxToken + '"',
    $installerProjectPath
  )
}

$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  throw "iscc.exe (Inno Setup compiler) was not found on PATH."
}

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
