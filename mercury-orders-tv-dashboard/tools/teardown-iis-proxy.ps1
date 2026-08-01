param(
  [string]$SiteName = "Default Web Site",
  [string]$AppPath = "/Talaria",
  [string]$AppPoolName = "Talaria",
  [string]$PhysicalPath = "C:\FTDTools\Talaria\iis-app",
  [switch]$KeepFiles,
  [switch]$Silent
)

# Reverses setup-iis-proxy.ps1: removes the IIS application and app pool it
# created (and, unless -KeepFiles is passed, the physical folder/web.config
# it wrote). Does not touch the Node services, their ports, the firewall
# rule, or anything outside this one IIS app - safe to run repeatedly, and
# safe even if setup-iis-proxy.ps1 was never run (everything is a no-op if
# not found).
#
# Dev loop: run setup-iis-proxy.ps1, poke around, run this, repeat.
#
# -Silent is used when this runs as the Talaria installer's uninstall step:
# any failure is printed as a warning and the script exits 0 regardless, so
# it never blocks or fails the main uninstall. Run without -Silent by hand
# to see real errors.

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Assert-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw "Run this script from an elevated (Run as Administrator) PowerShell prompt."
  }
}

function Invoke-Teardown {
  Assert-Elevated

  if (-not (Get-Module -ListAvailable -Name WebAdministration)) {
    Write-Output "WebAdministration module not available (IIS not installed) - nothing to tear down."
    return
  }

  Import-Module WebAdministration

  $appName = $AppPath.Trim('/')
  $sitePath = "IIS:\Sites\$SiteName"

  if (Test-Path $sitePath) {
    $existingApp = Get-WebApplication -Site $SiteName -Name $appName -ErrorAction SilentlyContinue
    if ($existingApp) {
      Remove-WebApplication -Site $SiteName -Name $appName
      Write-Output ("Removed IIS application '/" + $appName + "' from '" + $SiteName + "'.")
    } else {
      Write-Output ("IIS application '/" + $appName + "' not found under '" + $SiteName + "' - nothing to remove.")
    }
  } else {
    Write-Output ("IIS site '" + $SiteName + "' not found - nothing to remove.")
  }

  if (Test-Path "IIS:\AppPools\$AppPoolName") {
    Remove-WebAppPool -Name $AppPoolName
    Write-Output ("Removed app pool '" + $AppPoolName + "'.")
  } else {
    Write-Output ("App pool '" + $AppPoolName + "' not found - nothing to remove.")
  }

  if (-not $KeepFiles) {
    if (Test-Path $PhysicalPath) {
      Remove-Item -Path $PhysicalPath -Recurse -Force
      Write-Output ("Removed physical path '" + $PhysicalPath + "'.")
    }
  } else {
    Write-Output ("Left physical path in place (-KeepFiles): " + $PhysicalPath)
  }

  Write-Output ""
  Write-Output "Teardown complete. The Node services (bridge/web) were not touched."
}

if ($Silent) {
  try {
    Invoke-Teardown
  } catch {
    Write-Output ("Talaria IIS proxy teardown skipped (optional step): " + $_.Exception.Message)
  }
  exit 0
} else {
  Invoke-Teardown
}
