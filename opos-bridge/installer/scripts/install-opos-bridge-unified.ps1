[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\FTDTools\OposBridgeService',
    [string]$ServiceName = 'FTD.OposBridge.Service',
    [string]$TaskName = 'FTD OPOS Bridge EXE',
    [string]$TrayTaskName = 'FTD OPOS Bridge Tray',
    [string]$LogicalName = 'ZEBRA_SCANNER',
    [ValidateRange(1024, 65535)]
    [int]$Port = 17331,
    [ValidateSet('opos', 'mock')]
    [string]$ScannerMode = 'opos',
    [ValidateSet('trace', 'debug', 'information', 'warning', 'error', 'critical', 'none')]
    [string]$LogLevel = 'information',
    [ValidateSet('localservice', 'networkservice', 'localsystem', 'current-user', 'custom')]
    [string]$ServiceAccount = 'localsystem',
    [string]$ServiceUser = '',
    [ValidateSet('auto', 'demand', 'disabled')]
    [string]$ServiceStartMode = 'auto',
    [ValidateRange(1000, 600000)]
    [int]$ServiceRestartDelayMs = 60000,
    [object]$UseAgentRelayHost = $true,
    [object]$NoTrayCompanion = $false,
    [object]$EnableTaskFallback = $false,
    [object]$KeepLegacyTask = $false,
    [object]$TrayOnLogin = $true
)

Set-StrictMode -Version Latest
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

$UseAgentRelayHost = ConvertTo-BooleanValue -Value $UseAgentRelayHost -DefaultValue $true -Name 'UseAgentRelayHost'
$NoTrayCompanion = ConvertTo-BooleanValue -Value $NoTrayCompanion -DefaultValue $false -Name 'NoTrayCompanion'
$EnableTaskFallback = ConvertTo-BooleanValue -Value $EnableTaskFallback -DefaultValue $false -Name 'EnableTaskFallback'
$KeepLegacyTask = ConvertTo-BooleanValue -Value $KeepLegacyTask -DefaultValue $false -Name 'KeepLegacyTask'
$TrayOnLogin = ConvertTo-BooleanValue -Value $TrayOnLogin -DefaultValue $true -Name 'TrayOnLogin'
$effectiveServiceStartMode = $ServiceStartMode
if ($TrayOnLogin -and -not $NoTrayCompanion -and $effectiveServiceStartMode -eq 'auto') {
    $effectiveServiceStartMode = 'demand'
}
if (-not $TrayOnLogin -and $effectiveServiceStartMode -eq 'auto') {
    $effectiveServiceStartMode = 'demand'
}

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an elevated PowerShell session (Run as Administrator).'
    }
}

function Invoke-Robocopy {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $null = robocopy $Source $Destination /MIR /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed copying '$Source' to '$Destination' (exit code $LASTEXITCODE)."
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
            # Best-effort stop only.
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
            # Best-effort cleanup only.
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

function Remove-OposBridgeServices {
    param([Parameter(Mandatory = $true)][string]$PrimaryServiceName)

    $pattern = '^FTD\.OposBridge\..*'
    $services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq $PrimaryServiceName -or
        $_.Name -match $pattern -or
        ($_.PathName -match 'FTD\.OposBridge\.Service\.exe')
    })

    if ($services.Count -eq 0) {
        Write-Host "No existing OPOS Bridge Windows service entries found to remove."
        return
    }

    $unique = @{}
    foreach ($svc in $services) {
        if ($null -ne $svc -and -not [string]::IsNullOrWhiteSpace($svc.Name)) {
            $unique[$svc.Name] = $svc
        }
    }

    $orderedNames = @($unique.Keys | Sort-Object)
    if ($orderedNames -contains $PrimaryServiceName) {
        $orderedNames = @($PrimaryServiceName) + @($orderedNames | Where-Object { $_ -ne $PrimaryServiceName })
    }

    foreach ($svcName in $orderedNames) {
        $svc = $unique[$svcName]
        if ($null -eq $svc) { continue }
        Write-Host "Stopping and removing OPOS Bridge service: $($svc.Name) ..."
        try {
            Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline) {
                $current = Get-Service -Name $svc.Name -ErrorAction SilentlyContinue
                if ($null -eq $current -or $current.Status -ne 'Running') {
                    break
                }
                Start-Sleep -Milliseconds 250
            }
            sc.exe delete $svc.Name | Out-Null
        } catch {
            Write-Warning "Failed to remove service '$($svc.Name)': $($_.Exception.Message)"
        }
    }
}

function Stop-BridgeProcesses {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = ''
    if (Test-Path -LiteralPath $Root) {
        $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    }

    $procs = @(Get-CimInstance Win32_Process -Filter "Name='FTD.OposBridge.Service.exe'" -ErrorAction SilentlyContinue)
    foreach ($proc in $procs) {
        $matchesRoot = $false
        $matchesCompanionMode = $false
        if (-not [string]::IsNullOrWhiteSpace($resolvedRoot)) {
            $escapedRoot = [Regex]::Escape($resolvedRoot)
            $matchesRoot = ($proc.ExecutablePath -match $escapedRoot) -or ($proc.CommandLine -match $escapedRoot)
        }
        $matchesCompanionMode = ($proc.CommandLine -match '--tray-companion') -or ($proc.CommandLine -match '--agent-relay')

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

function Get-TrayCompanionProcesses {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = ''
    if (Test-Path -LiteralPath $Root) {
        $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    }

    $procs = @(Get-CimInstance Win32_Process -Filter "Name='FTD.OposBridge.Service.exe'" -ErrorAction SilentlyContinue)
    if ([string]::IsNullOrWhiteSpace($resolvedRoot)) {
        return @($procs | Where-Object { $_.CommandLine -match '--tray-companion' })
    }

    $escapedRoot = [Regex]::Escape($resolvedRoot)
    return @($procs | Where-Object {
        ($_.CommandLine -match '--tray-companion') -and
        (($_.ExecutablePath -match $escapedRoot) -or ($_.CommandLine -match $escapedRoot))
    })
}

function Ensure-SingleTrayCompanionProcess {
    param([Parameter(Mandatory = $true)][string]$Root)

    $trayProcs = @(Get-TrayCompanionProcesses -Root $Root)
    if ($trayProcs.Count -le 1) {
        $pids = @($trayProcs | ForEach-Object { $_.ProcessId } | Sort-Object)
        return @{
            Running = $trayProcs.Count -gt 0
            Pids = $pids
            Deduped = $false
        }
    }

    $keepPid = [int](($trayProcs | Sort-Object ProcessId | Select-Object -First 1).ProcessId)
    foreach ($proc in $trayProcs) {
        if ([int]$proc.ProcessId -eq $keepPid) {
            continue
        }

        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped duplicate tray process id $($proc.ProcessId)."
        } catch {
            Write-Warning "Unable to stop duplicate tray process id $($proc.ProcessId): $($_.Exception.Message)"
        }
    }

    Start-Sleep -Milliseconds 600
    $remaining = @(Get-TrayCompanionProcesses -Root $Root)
    $remainingPids = @($remaining | ForEach-Object { $_.ProcessId } | Sort-Object)
    return @{
        Running = $remaining.Count -gt 0
        Pids = $remainingPids
        Deduped = $true
    }
}

function Wait-ForTrayCompanionStable {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [int]$RequiredSeconds = 15,
        [int]$PollMs = 500
    )

    $deadline = (Get-Date).AddSeconds([Math]::Max(4, $RequiredSeconds))
    $firstSeenAt = $null
    $stablePids = @()
    $lastPidSignature = ''
    while ((Get-Date) -lt $deadline) {
        $trayProcs = @(Get-TrayCompanionProcesses -Root $Root)
        if ($trayProcs.Count -gt 0) {
            $orderedPids = @($trayProcs | ForEach-Object { $_.ProcessId } | Sort-Object)
            $pidSignature = $orderedPids -join ','
            if ($null -eq $firstSeenAt -or $pidSignature -ne $lastPidSignature) {
                $firstSeenAt = Get-Date
                $lastPidSignature = $pidSignature
            }

            $stablePids = $orderedPids
            $elapsed = ((Get-Date) - $firstSeenAt).TotalSeconds
            if ($elapsed -ge [Math]::Max(3, $RequiredSeconds - 2)) {
                return @{
                    Stable = $true
                    Pids = $stablePids
                }
            }
        } else {
            $firstSeenAt = $null
            $stablePids = @()
            $lastPidSignature = ''
        }

        Start-Sleep -Milliseconds ([Math]::Max(250, $PollMs))
    }

    return @{
        Stable = $false
        Pids = $stablePids
    }
}

function Ensure-TrayCompanionStartedOnce {
    param(
        [Parameter(Mandatory = $true)][string]$TaskScript,
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ServiceName,
        [Parameter(Mandatory = $true)][int]$ServicePort,
        [Parameter(Mandatory = $true)][string]$LogicalName,
        [Parameter(Mandatory = $true)][string]$ScannerMode,
        [Parameter(Mandatory = $true)][string]$LogLevel
    )

    $trayProbe = @{
        Stable = $false
        Pids = @()
    }
    $startErrors = New-Object System.Collections.Generic.List[string]

    try {
        & $TaskScript `
            -Action install `
            -HostMode tray-companion `
            -InstallRoot $Root `
            -TaskName $TaskName `
            -ServiceName $ServiceName `
            -Port $ServicePort `
            -LogicalName $LogicalName `
            -ScannerMode $ScannerMode `
            -LogLevel $LogLevel `
            -BridgeBaseUrl ("http://127.0.0.1:{0}" -f $ServicePort) `
            -HideWindow $true `
            -ErrorAction Stop | Out-Null
    } catch {
        $startErrors.Add("task-install: $($_.Exception.Message)")
    }

    Start-Sleep -Seconds 2
    $trayProbe = Wait-ForTrayCompanionStable -Root $Root -RequiredSeconds 12
    if (-not $trayProbe.Stable) {
        try {
            & $TaskScript `
                -Action start `
                -TaskName $TaskName `
                -InstallRoot $Root `
                -ServiceName $ServiceName `
                -ErrorAction Stop | Out-Null
        } catch {
            $startErrors.Add("task-start: $($_.Exception.Message)")
        }

        Start-Sleep -Seconds 2
        $trayProbe = Wait-ForTrayCompanionStable -Root $Root -RequiredSeconds 12
    }

    $singleProbe = Ensure-SingleTrayCompanionProcess -Root $Root
    if (-not $singleProbe.Running) {
        $trayExe = Join-Path $Root 'FTD.OposBridge.Service.exe'
        if (Test-Path -LiteralPath $trayExe) {
            try {
                Start-Process -FilePath $trayExe -ArgumentList "--tray-companion --service-name=$ServiceName --port=$ServicePort --bridge-base-url=http://127.0.0.1:$ServicePort --logical-name=$LogicalName --scanner-mode=$ScannerMode --log-level=$LogLevel --hide-console=true" -WorkingDirectory $Root -WindowStyle Minimized | Out-Null
                Write-Host "Started tray companion directly from '$trayExe' because scheduled task launch did not stabilize."
            } catch {
                $startErrors.Add("direct-start: $($_.Exception.Message)")
            }
        } else {
            $startErrors.Add("direct-start: tray executable missing at '$trayExe'")
        }

        Start-Sleep -Seconds 2
        $trayProbe = Wait-ForTrayCompanionStable -Root $Root -RequiredSeconds 10
        $singleProbe = Ensure-SingleTrayCompanionProcess -Root $Root
    }

    if (-not $singleProbe.Running) {
        $details = ''
        if ($startErrors.Count -gt 0) {
            $details = " Details: " + ($startErrors -join ' | ')
        }
        throw "Tray companion did not reach a running state.${details}"
    }

    return @($singleProbe.Pids)
}

function Assert-ServiceRunningAndHealthy {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$ServicePort
    )

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        throw "Expected service '$Name' was not installed."
    }

    if ($svc.Status -ne 'Running') {
        Start-Service -Name $Name -ErrorAction Stop
    }

    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        $svc.Refresh()
        if ($svc.Status -eq 'Running') {
            break
        }
        Start-Sleep -Milliseconds 250
    }

    if ($svc.Status -ne 'Running') {
        throw "Service '$Name' did not reach Running state."
    }

    $healthUrl = "http://127.0.0.1:$ServicePort/health"
    $healthy = $false
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            if ($null -ne $health -and $health.ok) {
                $healthy = $true
                break
            }
        } catch {
            # Retry until timeout.
        }
        Start-Sleep -Milliseconds 300
    }

    if (-not $healthy) {
        throw "Service '$Name' is running but health endpoint is not responding: $healthUrl"
    }
}

Assert-Admin

$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$payloadRoot = Join-Path $packageRoot 'payload'
$runtimeSource = Join-Path $payloadRoot 'service-runtime'
$serviceScriptsSource = Join-Path $payloadRoot 'service-scripts'
$migrationScript = Join-Path $serviceScriptsSource 'migrate-script-bridge-to-service.ps1'

if (-not (Test-Path -LiteralPath $runtimeSource)) {
    throw "Runtime payload was not found: $runtimeSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource 'FTD.OposBridge.Service.exe'))) {
    throw "Runtime payload is missing FTD.OposBridge.Service.exe under $runtimeSource"
}
if (-not (Test-Path -LiteralPath $serviceScriptsSource)) {
    throw "Service scripts payload was not found: $serviceScriptsSource"
}
if (-not (Test-Path -LiteralPath $migrationScript)) {
    throw "Migration script payload was not found: $migrationScript"
}

Write-Host "Stopping prior OPOS Bridge tasks/services and cleanup processes ..."
Stop-ScheduledTaskIfExists -Name $TaskName
Remove-ScheduledTaskIfExists -Name $TaskName
if (-not [string]::IsNullOrWhiteSpace($TrayTaskName)) {
    Stop-ScheduledTaskIfExists -Name $TrayTaskName
    Remove-ScheduledTaskIfExists -Name $TrayTaskName
}
Remove-ObsoleteBridgeTasks -PrimaryTaskName $TaskName -PrimaryTrayTaskName $TrayTaskName
Stop-BridgeProcesses -Root $InstallRoot
Remove-OposBridgeServices -PrimaryServiceName $ServiceName

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

Write-Host "Copying service runtime to $InstallRoot ..."
Invoke-Robocopy -Source $runtimeSource -Destination $InstallRoot

$supportScriptsRoot = Join-Path $InstallRoot 'scripts'
New-Item -ItemType Directory -Path $supportScriptsRoot -Force | Out-Null
Write-Host "Copying support scripts to $supportScriptsRoot ..."
Invoke-Robocopy -Source $serviceScriptsSource -Destination $supportScriptsRoot

$migrationArgs = @{
    InstallRoot = $InstallRoot
    ServiceName = $ServiceName
    TaskName = $TaskName
    TrayTaskName = $TrayTaskName
    LogicalName = $LogicalName
    Port = $Port
    ScannerMode = $ScannerMode
    LogLevel = $LogLevel
    ServiceAccount = $ServiceAccount
    ServiceStartMode = $effectiveServiceStartMode
    ServiceRestartDelayMs = $ServiceRestartDelayMs
    SkipPublish = $true
    TrayOnLogin = $TrayOnLogin
    NoTrayCompanion = $true
}

if (-not [string]::IsNullOrWhiteSpace($ServiceUser)) {
    $migrationArgs['ServiceUser'] = $ServiceUser
}
if ($UseAgentRelayHost) {
    $migrationArgs['UseAgentRelayHost'] = $true
}
if ($NoTrayCompanion) {
    $migrationArgs['NoTrayCompanion'] = $true
}
if ($EnableTaskFallback) {
    $migrationArgs['EnableTaskFallback'] = $true
}
if ($KeepLegacyTask) {
    $migrationArgs['KeepLegacyTask'] = $true
}

Write-Host 'Installing service and task host components ...'
& $migrationScript @migrationArgs

if ($effectiveServiceStartMode -eq 'disabled') {
    Write-Host "Service '$ServiceName' is configured as disabled; skipping startup health check."
} elseif ($TrayOnLogin) {
    Write-Host "Ensuring service '$ServiceName' is running and healthy ..."
    try {
        Assert-ServiceRunningAndHealthy -Name $ServiceName -ServicePort $Port
        Write-Host "Service '$ServiceName' is running and healthy."
    } catch {
        Write-Warning "Initial service health validation failed before tray setup: $($_.Exception.Message)"
    }
} else {
    Write-Host "Bridge login start is disabled; stopping service '$ServiceName' to keep tray/service startup behavior in lockstep."
    try {
        Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    } catch {
        Write-Warning "Unable to stop service '$ServiceName' after install: $($_.Exception.Message)"
    }
}

if ($NoTrayCompanion) {
    Write-Host 'Tray companion install was disabled by NOTRAYCOMPANION.'
} else {
    $taskScript = Join-Path $supportScriptsRoot 'install-opos-bridge-task.ps1'
    $trayLaunched = $false
    if ($TrayOnLogin -and (Test-Path -LiteralPath $taskScript)) {
        try {
            Write-Host "Starting tray companion at final install phase and enforcing single-instance state ..."
            $trayPids = @(Ensure-TrayCompanionStartedOnce `
                -TaskScript $taskScript `
                -TaskName $TrayTaskName `
                -Root $InstallRoot `
                -ServiceName $ServiceName `
                -ServicePort $Port `
                -LogicalName $LogicalName `
                -ScannerMode $ScannerMode `
                -LogLevel $LogLevel)

            Write-Host "Tray companion is running with exactly one process (PID: $($trayPids -join ', '))."
            $trayLaunched = $true
        } catch {
            Write-Warning "Failed to start tray companion '$TrayTaskName' in final phase: $($_.Exception.Message)"
        }
    } elseif ($TrayOnLogin -and -not (Test-Path -LiteralPath $taskScript)) {
        Write-Warning "Task script not found at '$taskScript'; tray scheduled task was not configured."
    } else {
        Write-Host 'TrayOnLogin is false; tray companion scheduled task will not be installed.'
        if (Test-Path -LiteralPath $taskScript) {
            try {
                & $taskScript -Action uninstall -TaskName $TrayTaskName -InstallRoot $InstallRoot -ServiceName $ServiceName | Out-Null
            } catch {
                Write-Warning "Could not remove tray scheduled task '$TrayTaskName': $($_.Exception.Message)"
            }
        }
    }

    if ($TrayOnLogin -and -not $trayLaunched) {
        throw "Tray companion failed to launch during final install phase."
    }

    if ($TrayOnLogin -and $trayLaunched) {
        Write-Host "Re-validating service health after tray launch ..."
        Assert-ServiceRunningAndHealthy -Name $ServiceName -ServicePort $Port
        Write-Host "Service '$ServiceName' is healthy after tray launch."
    }
}

Write-Host ''
Write-Host 'OPOS bridge unified install complete.'
Write-Host "Service: $ServiceName"
Write-Host "InstallRoot: $InstallRoot"
Write-Host "Bridge URL: http://127.0.0.1:$Port"
if ($UseAgentRelayHost) {
    Write-Host "Agent relay task: $TaskName"
}
if (-not $NoTrayCompanion) {
    Write-Host "Tray task: $TrayTaskName"
}
