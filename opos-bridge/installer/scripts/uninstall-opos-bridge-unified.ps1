[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FTDTools\OposBridgeService',
    [string]$ServiceName = 'FTD.OposBridge.Service',
    [string]$TaskName = 'FTD OPOS Bridge EXE',
    [string]$TrayTaskName = 'FTD OPOS Bridge Tray',
    [object]$RemoveInstallRoot = $false
)

$ErrorActionPreference = 'Stop'

function ConvertTo-BooleanValue {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [bool]$DefaultValue,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Value) {
        return $DefaultValue
    }

    if ($Value -is [bool]) {
        return [bool]$Value
    }

    if ($Value -is [int] -or $Value -is [long]) {
        return ([int64]$Value) -ne 0
    }

    $raw = "$Value"
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $DefaultValue
    }

    $normalized = $raw.Trim()
    if ($normalized.StartsWith('$')) {
        $normalized = $normalized.Substring(1)
    }
    $normalized = $normalized.Trim().ToLowerInvariant()

    switch ($normalized) {
        'true' { return $true }
        'false' { return $false }
        '1' { return $true }
        '0' { return $false }
        'yes' { return $true }
        'no' { return $false }
        'on' { return $true }
        'off' { return $false }
    }

    throw ("Invalid boolean value for {0}: '{1}'" -f $Name, $raw)
}

$RemoveInstallRoot = ConvertTo-BooleanValue -Value $RemoveInstallRoot -DefaultValue $false -Name 'RemoveInstallRoot'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this uninstaller from an elevated PowerShell session (Run as Administrator).'
    }
}

function Stop-ScheduledTaskIfExists {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    } catch {
        try {
            schtasks.exe /End /TN "$Name" | Out-Null
        } catch {
            # Best-effort only.
        }
    }
}

function Remove-ScheduledTaskIfExists {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    } catch {
        try {
            schtasks.exe /Delete /TN "$Name" /F | Out-Null
        } catch {
            # Best-effort only.
        }
    }
}

function Remove-ObsoleteBridgeTasks {
    param(
        [Parameter(Mandatory = $true)][string]$PrimaryTaskName,
        [Parameter(Mandatory = $true)][string]$PrimaryTrayTaskName
    )

    $obsoleteTaskNames = @(
        'FTD OPOS Bridge Prototype EXE',
        'FTD OPOS Bridge Prototype Tray',
        'FTD OPOS Scanner Bridge'
    )

    foreach ($taskName in $obsoleteTaskNames) {
        if ($taskName -eq $PrimaryTaskName -or $taskName -eq $PrimaryTrayTaskName) {
            continue
        }

        Stop-ScheduledTaskIfExists -Name $taskName
        Remove-ScheduledTaskIfExists -Name $taskName
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

function Stop-BridgeProcesses {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = ''
    if (Test-Path -LiteralPath $Root) {
        $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    }

    $procs = @(Get-CimInstance Win32_Process -Filter "Name='FTD.OposBridge.Service.exe'" -ErrorAction SilentlyContinue)
    foreach ($proc in $procs) {
        $matchesRoot = $false
        $matchesCompanionMode = ($proc.CommandLine -match '--tray-companion') -or ($proc.CommandLine -match '--agent-relay')
        if (-not [string]::IsNullOrWhiteSpace($resolvedRoot)) {
            $escapedRoot = [Regex]::Escape($resolvedRoot)
            $matchesRoot = ($proc.ExecutablePath -match $escapedRoot) -or ($proc.CommandLine -match $escapedRoot)
        }

        if (-not $matchesRoot -and -not $matchesCompanionMode) {
            continue
        }

        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped running bridge process id $($proc.ProcessId)."
        } catch {
            Write-Warning "Failed to stop bridge process id $($proc.ProcessId): $($_.Exception.Message)"
        }
    }
}

Stop-BridgeProcesses -Root $InstallRoot
function Remove-OldOposBridgeServices {
    $pattern = '^FTD\.OposBridge\..*'
    $services = Get-CimInstance Win32_Service | Where-Object { $_.Name -match $pattern }
    foreach ($svc in $services) {
        Write-Host "Stopping and removing OPOS Bridge service: $($svc.Name) ..."
        try {
            if ($svc.State -eq 'Running') {
                Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
            }
            sc.exe delete $svc.Name | Out-Null
        } catch {
            Write-Warning "Failed to remove service $($svc.Name): $($_.Exception.Message)"
        }
    }
}

Remove-OldOposBridgeServices

$taskScript = Resolve-ServiceScript -FileName 'install-opos-bridge-task.ps1' -InstallRoot $InstallRoot
$serviceScript = Resolve-ServiceScript -FileName 'install-opos-bridge-service.ps1' -InstallRoot $InstallRoot

if ($taskScript) {
    Write-Host "Removing agent relay task '$TaskName' ..."
    try {
        & $taskScript -Action uninstall -TaskName $TaskName -InstallRoot $InstallRoot -ServiceName $ServiceName | Out-Null
    }
    catch {
        Write-Warning "Task uninstall for '$TaskName' reported: $($_.Exception.Message)"
    }

    if (-not [string]::IsNullOrWhiteSpace($TrayTaskName)) {
        Write-Host "Removing tray task '$TrayTaskName' ..."
        try {
            & $taskScript -Action uninstall -TaskName $TrayTaskName -InstallRoot $InstallRoot -ServiceName $ServiceName | Out-Null
        }
        catch {
            Write-Warning "Task uninstall for '$TrayTaskName' reported: $($_.Exception.Message)"
        }
    }
} else {
    Write-Warning 'Task management script was not found. Scheduled tasks may need manual cleanup.'
}

Remove-ObsoleteBridgeTasks -PrimaryTaskName $TaskName -PrimaryTrayTaskName $TrayTaskName

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
