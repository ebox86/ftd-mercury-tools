[CmdletBinding()]
param(
    [string]$SiteName = 'FTD.XoapWeatherShim',
    [string]$HostName = 'xoap.weather.com',
    [string]$InstallRoot = 'C:\FTDTools\XoapWeatherShim',
    [switch]$SkipHostsEntry,
    [switch]$SkipIisPrereqs
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell session (Run as Administrator).'
    }
}

function Update-HostsEntry {
    param(
        [string]$HostsPath,
        [string]$HostName
    )

    $escapedHost = [regex]::Escape($HostName)
    $existingLines = if (Test-Path $HostsPath) { @(Get-Content -Path $HostsPath -ErrorAction Stop) } else { @() }

    $filtered = @()
    foreach ($line in $existingLines) {
        if ($line -match "^\s*\d+\.\d+\.\d+\.\d+\s+$escapedHost(\s|$)") {
            continue
        }
        $filtered += $line
    }

    $filtered += "127.0.0.1`t$HostName"

    if (-not (Test-Path -LiteralPath $HostsPath)) {
        New-Item -Path $HostsPath -ItemType File -Force | Out-Null
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

function Ensure-IisPrerequisites {
    $restartNeeded = $false
    $serverFeatureCommand = Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue

    if ($serverFeatureCommand) {
        $requiredServerFeatures = @(
            'Web-Server',
            'Web-App-Dev',
            'Web-Asp-Net45',
            'Web-Net-Ext45',
            'Web-ISAPI-Ext',
            'Web-ISAPI-Filter',
            'Web-Mgmt-Console'
        )

        $featureState = Get-WindowsFeature -Name $requiredServerFeatures -ErrorAction SilentlyContinue
        $missingServerFeatures = @($featureState | Where-Object { $_ -and -not $_.Installed } | Select-Object -ExpandProperty Name)
        if ($missingServerFeatures.Count -gt 0) {
            Write-Host "Installing IIS prerequisites (server features): $($missingServerFeatures -join ', ') ..."
            $result = Install-WindowsFeature -Name $missingServerFeatures -IncludeManagementTools -ErrorAction Stop
            if ($result.RestartNeeded -eq 'Yes') {
                $restartNeeded = $true
            }
        }
    } else {
        $requiredOptionalFeatures = @(
            'IIS-WebServerRole',
            'IIS-WebServer',
            'IIS-CommonHttpFeatures',
            'IIS-DefaultDocument',
            'IIS-StaticContent',
            'IIS-ApplicationDevelopment',
            'IIS-ASPNET45',
            'IIS-NetFxExtensibility45',
            'IIS-ISAPIExtensions',
            'IIS-ISAPIFilter',
            'IIS-ManagementConsole'
        )

        foreach ($feature in $requiredOptionalFeatures) {
            $state = Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue
            if ($null -eq $state) {
                continue
            }
            if ($state.State -eq 'Enabled') {
                continue
            }

            Write-Host "Enabling Windows optional feature $feature ..."
            $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart -ErrorAction Stop
            if ($result.RestartNeeded) {
                $restartNeeded = $true
            }
        }
    }

    if ($restartNeeded) {
        Write-Warning 'One or more IIS/.NET features requested a restart.'
    }

    return $restartNeeded
}

Assert-Admin

$restartNeeded = $false
if (-not $SkipIisPrereqs) {
    Write-Host 'Ensuring IIS/.NET prerequisites are installed ...'
    $restartNeeded = Ensure-IisPrerequisites
}

try {
    Import-Module WebAdministration -ErrorAction Stop
}
catch {
    if ($restartNeeded) {
        Write-Warning 'WebAdministration is not available yet because Windows still needs a reboot to finish IIS/.NET enablement.'
        Write-Warning 'Reboot this machine, then rerun install-weather-xoap-shim.ps1 (or smoke-test-weather-xoap-shim.ps1).'
        Write-Host ''
        Write-Host 'Install complete (pending restart).'
        return
    }

    throw
}

$repoSitePath = (Resolve-Path (Join-Path $PSScriptRoot '..\site')).Path
$destinationSitePath = Join-Path $InstallRoot 'site'

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $destinationSitePath | Out-Null

Write-Host "Copying shim files to $destinationSitePath ..."
$null = robocopy $repoSitePath $destinationSitePath /MIR /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

$siteBindingInfo = "*:80:$HostName"
$conflictingBinding = Get-WebBinding -Protocol http |
    Where-Object { $_.bindingInformation -eq $siteBindingInfo -and $_.ItemXPath -notmatch "name='$([regex]::Escape($SiteName))'" }
if ($conflictingBinding) {
    throw "An existing IIS site already owns host binding '$siteBindingInfo'. Resolve that conflict before installing."
}

if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
    Write-Host "Creating app pool $SiteName ..."
    New-WebAppPool -Name $SiteName | Out-Null
}

Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value 'v4.0'
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedPipelineMode -Value 'Integrated'

$existingSite = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
if ($null -eq $existingSite) {
    Write-Host "Creating IIS site $SiteName ..."
    New-Website -Name $SiteName -Port 80 -HostHeader $HostName -PhysicalPath $destinationSitePath -ApplicationPool $SiteName | Out-Null
} else {
    Write-Host "Updating IIS site $SiteName ..."
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $destinationSitePath
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationPool -Value $SiteName

    $hasHostBinding = Get-WebBinding -Name $SiteName -Protocol http |
        Where-Object { $_.bindingInformation -eq $siteBindingInfo }
    if (-not $hasHostBinding) {
        New-WebBinding -Name $SiteName -Protocol http -Port 80 -HostHeader $HostName | Out-Null
    }
}

Start-Website -Name $SiteName

if (-not $SkipHostsEntry) {
    $hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
    Write-Host "Updating hosts file entry for $HostName ..."
    Update-HostsEntry -HostsPath $hostsPath -HostName $HostName
}

if ($restartNeeded) {
    Write-Warning 'A reboot is required before smoke checks are reliable. Reboot, then run smoke-test-weather-xoap-shim.ps1.'
} else {
    Write-Host 'Running smoke checks ...'
    $searchUrl = 'http://127.0.0.1/search/search?where=60515'
    $weatherUrl = 'http://127.0.0.1/weather/local/60515?cc=*&dayf=5&prod=xoap&par=test&key=test'

    try {
        $searchResponse = Invoke-WebRequest -Uri $searchUrl -Headers @{ Host = $HostName } -UseBasicParsing -TimeoutSec 20
        $weatherResponse = Invoke-WebRequest -Uri $weatherUrl -Headers @{ Host = $HostName } -UseBasicParsing -TimeoutSec 20

        if ($searchResponse.StatusCode -ne 200 -or $weatherResponse.StatusCode -ne 200) {
            throw 'Expected HTTP 200 from both shim endpoints.'
        }
    }
    catch {
        Write-Warning "Smoke checks failed but IIS install completed: $($_.Exception.Message)"
        Write-Warning 'Verify internet connectivity and run smoke-test-weather-xoap-shim.ps1 to recheck the shim.'
    }
}

Write-Host ''
Write-Host 'Install complete.'
Write-Host "IIS Site: $SiteName"
Write-Host "Host binding: $siteBindingInfo"
Write-Host "Path: $destinationSitePath"
Write-Host ''
Write-Host 'Validation examples:'
Write-Host "  Invoke-WebRequest 'http://$HostName/search/search?where=lisle,il'"
Write-Host "  Invoke-WebRequest 'http://$HostName/weather/local/60515?cc=*&dayf=5&prod=xoap&par=test&key=test'"
