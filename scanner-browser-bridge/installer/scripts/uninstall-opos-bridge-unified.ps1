[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FTDTools\OposBridgeService',
    [string]$ServiceName = 'FTD.OposBridge.Service',
    [string]$TaskName = 'FTD OPOS Bridge EXE',
    [string]$TrayTaskName = 'FTD OPOS Bridge Tray',
    [bool]$RemoveInstallRoot = $false
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this uninstaller from an elevated PowerShell session (Run as Administrator).'
    }
}

function Resolve-ServiceScript {
    param(
        [string]$FileName,
        [string]$InstallRoot
    )

    $candidatePaths = @(
        (Join-Path (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'payload\service-scripts') $FileName),
        (Join-Path (Join-Path $InstallRoot 'scripts') $FileName)
    )

    foreach ($candidate in $candidatePaths) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

Assert-Admin

$taskScript = Resolve-ServiceScript -FileName 'install-opos-bridge-task.ps1' -InstallRoot $InstallRoot
$serviceScript = Resolve-ServiceScript -FileName 'install-opos-bridge-service.ps1' -InstallRoot $InstallRoot

if ($taskScript) {
    Write-Host "Removing agent relay task '$TaskName' ..."
    try {
        & $taskScript -Action uninstall -TaskName $TaskName -InstallRoot $InstallRoot | Out-Null
    }
    catch {
        Write-Warning "Task uninstall for '$TaskName' reported: $($_.Exception.Message)"
    }

    if (-not [string]::IsNullOrWhiteSpace($TrayTaskName)) {
        Write-Host "Removing tray task '$TrayTaskName' ..."
        try {
            & $taskScript -Action uninstall -TaskName $TrayTaskName -InstallRoot $InstallRoot | Out-Null
        }
        catch {
            Write-Warning "Task uninstall for '$TrayTaskName' reported: $($_.Exception.Message)"
        }
    }
} else {
    Write-Warning 'Task management script was not found. Scheduled tasks may need manual cleanup.'
}

if ($serviceScript) {
    Write-Host "Removing service '$ServiceName' ..."
    $serviceArgs = @{
        Action = 'uninstall'
        ServiceName = $ServiceName
        InstallRoot = $InstallRoot
    }
    if ($RemoveInstallRoot) {
        $serviceArgs['RemoveInstallRoot'] = $true
    }

    & $serviceScript @serviceArgs
} else {
    Write-Warning 'Service management script was not found. Service may need manual cleanup.'
}

Write-Host ''
Write-Host 'OPOS bridge unified uninstall complete.'
