param(
  [string]$SiteName = "Default Web Site",
  [string]$AppPath = "/Talaria",
  [string]$AppPoolName = "Talaria",
  [string]$PhysicalPath = "C:\FTDTools\Talaria\iis-app",
  [string]$UpstreamUrl = "http://127.0.0.1:5173",
  [switch]$Silent
)

# Fronts the existing Node "Dashboard Web" service (which already proxies
# /api/* to the workflow bridge) with IIS on port 80, under a dedicated app
# path - so TVs hit http://<server>/Talaria/ instead of a raw custom port,
# matching the box's existing IIS-on-80 convention (WaFTDReports,
# WsMercuryWebAPI, etc. all live under Default Web Site the same way).
#
# This script is ADDITIVE ONLY: it does not touch the Node services' host or
# port bindings, the Windows Firewall rule, or the 2 TVs' existing shortcuts.
# Once you've confirmed http://<server>/Talaria/ works and repointed both
# TVs at it, you can optionally lock the Node services down to 127.0.0.1-only
# as a separate, deliberate follow-up step - not part of this script.
#
# Requires: an elevated PowerShell prompt, and the IIS URL Rewrite Module +
# Application Request Routing (ARR) already installed. If they're missing,
# this script tells you where to get them and stops - it does not attempt
# to silently download or install them.
#
# -Silent is used when this runs as an optional post-install step from the
# Talaria installer: any failure (modules missing, IIS not present, etc.) is
# printed as a warning and the script exits 0 regardless, so this never
# blocks or fails the main install. Run it without -Silent by hand to see
# real errors.

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Assert-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw "Run this script from an elevated (Run as Administrator) PowerShell prompt."
  }
}

function Install-IisModuleViaWinget {
  param(
    [Parameter(Mandatory = $true)] [string]$WingetId,
    [Parameter(Mandatory = $true)] [string]$FriendlyName
  )

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Output "  winget not available - skipping auto-install."
    return $false
  }

  Write-Output ("  Installing " + $FriendlyName + " via winget...")
  & winget.exe install --id $WingetId --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  return $LASTEXITCODE -eq 0
}

function Assert-IisModules {
  $rewritePath = "$env:SystemRoot\System32\inetsrv\rewrite.dll"
  $arrPath = "$env:ProgramFiles\IIS\Application Request Routing\requestRouter.dll"

  $installedSomething = $false
  # winget reliably works elevated-interactive (which is what this installer
  # runs as via UAC) - it's non-elevated/SYSTEM contexts (services, scheduled
  # tasks) where it's known to be unreliable, which doesn't apply here.
  if (-not (Test-Path $rewritePath)) {
    if (Install-IisModuleViaWinget -WingetId "Microsoft.IIS.URLRewrite" -FriendlyName "IIS URL Rewrite Module") {
      $installedSomething = $true
    }
  }
  if (-not (Test-Path $arrPath)) {
    if (Install-IisModuleViaWinget -WingetId "Microsoft.IIS.ApplicationRequestRouting" -FriendlyName "IIS Application Request Routing") {
      $installedSomething = $true
    }
  }
  if ($installedSomething) {
    Write-Output "  Restarting IIS so the new module(s) are picked up..."
    iisreset /noforce | Out-Null
  }

  $missing = @()
  if (-not (Test-Path $rewritePath)) { $missing += "URL Rewrite Module: https://www.iis.net/downloads/microsoft/url-rewrite" }
  if (-not (Test-Path $arrPath)) { $missing += "Application Request Routing: https://www.iis.net/downloads/microsoft/application-request-routing" }

  if ($missing.Count -gt 0) {
    Write-Output "Missing required IIS modules (auto-install unavailable or failed). Install these, then re-run this script:"
    $missing | ForEach-Object { Write-Output ("  - " + $_) }
    throw "Required IIS modules are not installed."
  }
}

function Invoke-Setup {
  Assert-Elevated
  Assert-IisModules

  Import-Module WebAdministration

  # ARR's reverse-proxy feature is off by default even once the module is
  # installed - this turns it on at the server level (safe to run repeatedly).
  Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST" -filter "system.webServer/proxy" -name "enabled" -value "True"

  if (-not (Test-Path $PhysicalPath)) {
    New-Item -ItemType Directory -Path $PhysicalPath -Force | Out-Null
  }

$webConfigPath = Join-Path $PhysicalPath "web.config"
$webConfigLines = @(
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<configuration>',
  '  <system.webServer>',
  '    <rewrite>',
  '      <rules>',
  '        <rule name="Talaria trailing slash" stopProcessing="true">',
  '          <match url="^/?$" />',
  ('          <action type="Redirect" url="' + $AppPath + '/" redirectType="Permanent" />'),
  '        </rule>',
  '        <rule name="Talaria reverse proxy" stopProcessing="true">',
  '          <match url="(.*)" />',
  ('          <action type="Rewrite" url="' + $UpstreamUrl + '/{R:1}" />'),
  '        </rule>',
  '      </rules>',
  '    </rewrite>',
  '  </system.webServer>',
  '</configuration>'
)
Set-Content -Path $webConfigPath -Value $webConfigLines -Encoding UTF8

$sitePath = "IIS:\Sites\$SiteName"
if (-not (Test-Path $sitePath)) {
  throw "IIS site '$SiteName' not found. Pass -SiteName to match an existing site."
}

$appName = $AppPath.Trim('/')
$iisAppPath = "IIS:\Sites\$SiteName\$appName"

if (-not (Test-Path "IIS:\AppPools\$AppPoolName")) {
  New-WebAppPool -Name $AppPoolName | Out-Null
  Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name managedRuntimeVersion -Value ""
}

$existingApp = Get-WebApplication -Site $SiteName -Name $appName -ErrorAction SilentlyContinue
if ($existingApp) {
  Write-Output ("IIS application '/" + $appName + "' already exists under '" + $SiteName + "' - updating physical path/app pool only.")
  Set-ItemProperty $iisAppPath -Name physicalPath -Value $PhysicalPath
  Set-ItemProperty $iisAppPath -Name applicationPool -Value $AppPoolName
} else {
  New-WebApplication -Site $SiteName -Name $appName -PhysicalPath $PhysicalPath -ApplicationPool $AppPoolName | Out-Null
}

  Restart-WebAppPool -Name $AppPoolName

  Write-Output ""
  Write-Output ("Done. Proxying http://<this-server>" + $AppPath + "/*  ->  " + $UpstreamUrl + "/*")
  Write-Output ("Test from this machine:  Invoke-WebRequest http://127.0.0.1" + $AppPath + "/ -UseBasicParsing")
  Write-Output ("Test from the LAN:       http://<this-server-name-or-ip>" + $AppPath + "/")
  Write-Output ""
  Write-Output "The Node services are still also reachable directly on their own ports (unchanged)."
  Write-Output ("Once you've confirmed the TVs work through " + $AppPath + " and repointed them, you can")
  Write-Output "consider locking the Node services to 127.0.0.1-only as a separate follow-up step."
}

if ($Silent) {
  try {
    Invoke-Setup
  } catch {
    Write-Output ("Talaria IIS proxy setup skipped (optional step): " + $_.Exception.Message)
  }
  exit 0
} else {
  Invoke-Setup
}
