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
    [string]$LogLevel = 'warning',
    [ValidateSet('localservice', 'networkservice', 'localsystem', 'current-user', 'custom')]
    [string]$ServiceAccount = 'localservice',
    [string]$ServiceUser = '',
    [ValidateRange(1000, 600000)]
    [int]$ServiceRestartDelayMs = 60000,
    [bool]$UseAgentRelayHost = $true,
    [bool]$NoTrayCompanion = $false,
    [bool]$EnableTaskFallback = $false,
    [bool]$KeepLegacyTask = $false
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an elevated PowerShell session (Run as Administrator).'
    }
}

Assert-Admin

$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$payloadRoot = Join-Path $packageRoot 'payload'
$runtimeSource = Join-Path $payloadRoot 'service-runtime'
$serviceScriptsSource = Join-Path $payloadRoot 'service-scripts'
$migrationScript = Join-Path $serviceScriptsSource 'migrate-script-bridge-to-service.ps1'

if (-not (Test-Path $runtimeSource)) {
    throw "Runtime payload was not found: $runtimeSource"
}
if (-not (Test-Path (Join-Path $runtimeSource 'FTD.OposBridge.Service.exe'))) {
    throw "Runtime payload is missing FTD.OposBridge.Service.exe under $runtimeSource"
}
if (-not (Test-Path $migrationScript)) {
    throw "Migration script payload was not found: $migrationScript"
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

Write-Host "Copying service runtime to $InstallRoot ..."
$null = robocopy $runtimeSource $InstallRoot /MIR /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
    throw "robocopy runtime copy failed with exit code $LASTEXITCODE"
}

$supportScriptsRoot = Join-Path $InstallRoot 'scripts'
New-Item -ItemType Directory -Path $supportScriptsRoot -Force | Out-Null
Write-Host "Copying support scripts to $supportScriptsRoot ..."
$null = robocopy $serviceScriptsSource $supportScriptsRoot /MIR /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) {
    throw "robocopy script copy failed with exit code $LASTEXITCODE"
}

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
    ServiceRestartDelayMs = $ServiceRestartDelayMs
    SkipPublish = $true
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
