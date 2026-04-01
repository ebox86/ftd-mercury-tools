[CmdletBinding()]
param(
    [string]$SiteName = 'FTD.XoapWeatherShim',
    [string]$HostName = 'xoap.weather.com',
    [string]$InstallRoot = 'C:\FTDTools\XoapWeatherShim',
    [switch]$RemoveInstallRoot
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell session (Run as Administrator).'
    }
}

function Remove-HostsEntry {
    param(
        [string]$HostsPath,
        [string]$HostName
    )

    if (-not (Test-Path $HostsPath)) {
        return
    }

    $escapedHost = [regex]::Escape($HostName)
    $existingLines = @(Get-Content -Path $HostsPath -ErrorAction Stop)
    $filtered = @()

    foreach ($line in $existingLines) {
        if ($line -match "^\s*\d+\.\d+\.\d+\.\d+\s+$escapedHost(\s|$)") {
            continue
        }
        $filtered += $line
    }

    $hostFile = Get-Item -LiteralPath $HostsPath -ErrorAction Stop
    $wasReadOnly = $hostFile.IsReadOnly

    if ($wasReadOnly) {
        Set-ItemProperty -LiteralPath $HostsPath -Name IsReadOnly -Value $false
    }

    try {
        $content = [string]::Join([Environment]::NewLine, $filtered)
        if ($content.Length -gt 0) {
            $content += [Environment]::NewLine
        }

        [System.IO.File]::WriteAllText($HostsPath, $content, [System.Text.Encoding]::ASCII)
    }
    finally {
        if ($wasReadOnly) {
            Set-ItemProperty -LiteralPath $HostsPath -Name IsReadOnly -Value $true
        }
    }
}

Assert-Admin
Import-Module WebAdministration -ErrorAction Stop

if (Get-Website -Name $SiteName -ErrorAction SilentlyContinue) {
    Write-Host "Stopping/removing IIS site $SiteName ..."
    Stop-Website -Name $SiteName -ErrorAction SilentlyContinue
    Remove-Website -Name $SiteName
}

if (Test-Path "IIS:\AppPools\$SiteName") {
    Write-Host "Removing app pool $SiteName ..."
    Remove-WebAppPool -Name $SiteName
}

$hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
Write-Host "Removing hosts entry for $HostName ..."
Remove-HostsEntry -HostsPath $hostsPath -HostName $HostName

if ($RemoveInstallRoot) {
    $resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    if ($resolvedInstallRoot -like 'C:\FTDTools\XoapWeatherShim*' -and (Test-Path $resolvedInstallRoot)) {
        Write-Host "Removing install root $resolvedInstallRoot ..."
        Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
    } else {
        throw "Refusing to remove unexpected path: $resolvedInstallRoot"
    }
}

Write-Host 'Uninstall complete.'
