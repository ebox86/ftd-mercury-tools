param(
  [Parameter(Mandatory = $true)] [string]$PackageVersion,
  [Parameter(Mandatory = $true)] [string]$InstallerUrl,
  [Parameter(Mandatory = $true)] [string]$InstallerSha256,
  [string]$PackageIdentifier = "FTD.OposBridge",
  [string]$Publisher = "FTD",
  [string]$PackageName = "FTD OPOS Bridge",
  [string]$Moniker = "ftd-opos-bridge",
  [string]$ShortDescription = "Installs the FTD OPOS scanner bridge and startup task for Mercury browser modal scanning.",
  [string]$ReleaseNotes = "Installs or updates the OPOS bridge scripts and startup task.",
  [string]$OutputRoot = ""
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Assert-Hex64 {
  param([string]$Value, [string]$Name)
  if ($Value -notmatch "^[A-Fa-f0-9]{64}$") {
    throw "$Name must be a 64-character SHA256 hex string."
  }
}

Assert-Hex64 -Value $InstallerSha256 -Name "InstallerSha256"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $projectRoot "artifacts\winget-manifests"
}

$idParts = $PackageIdentifier.Split(".")
$manifestDir = $OutputRoot
foreach ($part in $idParts) {
  $manifestDir = Join-Path $manifestDir $part
}
$manifestDir = Join-Path $manifestDir $PackageVersion

New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null

$today = (Get-Date).ToString("yyyy-MM-dd")

$versionManifest = @"
# yaml-language-server: `$schema=https://aka.ms/winget-manifest.version.1.9.0.schema.json
PackageIdentifier: $PackageIdentifier
PackageVersion: $PackageVersion
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.9.0
"@

$installerManifest = @"
# yaml-language-server: `$schema=https://aka.ms/winget-manifest.installer.1.9.0.schema.json
PackageIdentifier: $PackageIdentifier
PackageVersion: $PackageVersion
InstallerType: inno
Scope: machine
InstallModes:
  - interactive
  - silent
  - silentWithProgress
InstallerSwitches:
  Silent: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
  SilentWithProgress: /SILENT /SUPPRESSMSGBOXES /NORESTART /SP-
  Custom: /LOGICALNAME=ZEBRA_SCANNER /PORT=17331
UpgradeBehavior: install
ReleaseDate: $today
AppsAndFeaturesEntries:
  - DisplayName: $PackageName
    Publisher: $Publisher
Installers:
  - Architecture: x64
    InstallerUrl: $InstallerUrl
    InstallerSha256: $InstallerSha256
ManifestType: installer
ManifestVersion: 1.9.0
"@

$localeManifest = @"
# yaml-language-server: `$schema=https://aka.ms/winget-manifest.defaultLocale.1.9.0.schema.json
PackageIdentifier: $PackageIdentifier
PackageVersion: $PackageVersion
PackageLocale: en-US
Publisher: $Publisher
PackageName: $PackageName
Moniker: $Moniker
ShortDescription: $ShortDescription
ReleaseNotes: $ReleaseNotes
ManifestType: defaultLocale
ManifestVersion: 1.9.0
"@

$versionPath = Join-Path $manifestDir "$PackageIdentifier.yaml"
$installerPath = Join-Path $manifestDir "$PackageIdentifier.installer.yaml"
$localePath = Join-Path $manifestDir "$PackageIdentifier.locale.en-US.yaml"

Set-Content -Path $versionPath -Value $versionManifest -NoNewline
Set-Content -Path $installerPath -Value $installerManifest -NoNewline
Set-Content -Path $localePath -Value $localeManifest -NoNewline

Write-Host "Generated manifests in: $manifestDir"
Write-Output $manifestDir
