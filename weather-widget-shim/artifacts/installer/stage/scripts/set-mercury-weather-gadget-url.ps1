[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$HostName = '192.168.1.50',
    [string]$MercuryXmlPath
)

$ErrorActionPreference = 'Stop'

function Resolve-MercuryXmlPath {
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "Mercury.xml not found at explicit path: $ExplicitPath"
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    $candidates = @(
        'C:\Program Files (x86)\Wings\Mercury.xml',
        'C:\Wings\Mercury.xml'
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw 'Could not find Mercury.xml in default locations.'
}

function Get-CurrentDashboardWeatherUrl {
    param([string]$Content)

    $pattern = '<setting\s+name="DashboardWeatherGadgetURL"\s*>\s*<!\[CDATA\[(?<url>.*?)\]\]>\s*</setting>'
    $match = [regex]::Match($Content, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
        return $null
    }

    return $match.Groups['url'].Value
}

$resolvedPath = Resolve-MercuryXmlPath -ExplicitPath $MercuryXmlPath
$targetUrl = "http://$HostName/WaFTDDashboard/WeatherGadget.aspx"

$originalContent = [System.IO.File]::ReadAllText($resolvedPath, [System.Text.Encoding]::UTF8)
$currentUrl = Get-CurrentDashboardWeatherUrl -Content $originalContent

if ($null -eq $currentUrl) {
    throw "Could not find setting 'DashboardWeatherGadgetURL' in $resolvedPath"
}

if ($currentUrl -eq $targetUrl) {
    Write-Host "No change needed. DashboardWeatherGadgetURL already set to: $targetUrl"
    return
}

$updatedContent = [regex]::Replace(
    $originalContent,
    '<setting\s+name="DashboardWeatherGadgetURL"\s*>\s*<!\[CDATA\[.*?\]\]>\s*</setting>',
    ('<setting name="DashboardWeatherGadgetURL"><![CDATA[' + $targetUrl + ']]></setting>'),
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

if ($updatedContent -eq $originalContent) {
    throw 'Replacement did not change file content. Aborting.'
}

$backupPath = "$resolvedPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$didWrite = $false

if ($PSCmdlet.ShouldProcess($resolvedPath, "Update DashboardWeatherGadgetURL to $targetUrl")) {
    Copy-Item -LiteralPath $resolvedPath -Destination $backupPath -Force
    [System.IO.File]::WriteAllText($resolvedPath, $updatedContent, [System.Text.UTF8Encoding]::new($false))
    $didWrite = $true
}

if (-not $didWrite) {
    Write-Host "WhatIf: would update DashboardWeatherGadgetURL from '$currentUrl' to '$targetUrl' in $resolvedPath"
    return
}

 $verifyContent = [System.IO.File]::ReadAllText($resolvedPath, [System.Text.Encoding]::UTF8)
 $verifyUrl = Get-CurrentDashboardWeatherUrl -Content $verifyContent
 
 if ($verifyUrl -ne $targetUrl) {
     throw "Verification failed. Expected '$targetUrl' but found '$verifyUrl'."
 }

Write-Host 'Mercury.xml updated successfully.'
Write-Host "File: $resolvedPath"
Write-Host "Old URL: $currentUrl"
Write-Host "New URL: $verifyUrl"
Write-Host "Backup: $backupPath"
