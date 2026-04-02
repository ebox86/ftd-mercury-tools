[CmdletBinding()]
param(
  [Parameter()]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'install',

  [Parameter()]
  [string]$ServiceName = 'FTD.OposBridge.Service',

  [Parameter()]
  [string]$InstallRoot = 'C:\FTDTools\OposBridgeService',

  [Parameter()]
  [string]$ProjectPath = '',

  [Parameter()]
  [string]$ExePath = '',

  [Parameter()]
  [ValidateRange(1024, 65535)]
  [int]$Port = 17331,

  [Parameter()]
  [string]$LogicalName = 'ZEBRA_SCANNER',

  [Parameter()]
  [ValidateSet('opos', 'mock')]
  [string]$ScannerMode = 'opos',

  [Parameter()]
  [ValidateRange(100, 60000)]
  [int]$ClaimTimeoutMs = 3000,

  [Parameter()]
  [ValidateSet('trace', 'debug', 'information', 'warning', 'error', 'critical', 'none')]
  [string]$LogLevel = 'information',

  [Parameter()]
  [ValidateSet('auto', 'demand', 'disabled')]
  [string]$StartMode = 'auto',

  [Parameter()]
  [ValidateSet('localservice', 'networkservice', 'localsystem', 'current-user', 'custom')]
  [string]$ServiceAccount = 'localservice',

  [Parameter()]
  [string]$ServiceUser = '',

  [Parameter()]
  [PSCredential]$Credential,

  [Parameter()]
  [switch]$PromptForCredential,

  [Parameter()]
  [ValidateRange(1000, 600000)]
  [int]$ServiceRestartDelayMs = 60000,

  [Parameter()]
  [switch]$SkipPublish,

  [Parameter()]
  [switch]$RemoveInstallRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Admin {
  if (-not (Test-IsAdmin)) {
    throw "This script must be run from an elevated (Administrator) PowerShell session."
  }
}

function Get-ServiceWmi([string]$name) {
  return Get-CimInstance Win32_Service -Filter ("Name='{0}'" -f $name) -ErrorAction SilentlyContinue
}

function Invoke-Sc {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$ScArgs
  )

  $output = & sc.exe @ScArgs 2>&1
  if ($output) {
    $output | ForEach-Object { Write-Host $_ }
  }

  if ($LASTEXITCODE -ne 0) {
    throw ("sc.exe failed (exit={0}) with args: {1}" -f $LASTEXITCODE, ($ScArgs -join ' '))
  }
}

function Wait-ServiceState([string]$name, [string]$desiredState, [int]$timeoutSeconds = 20) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
      if ($desiredState -eq 'Deleted') {
        return $true
      }

      return $false
    }

    if ($svc.Status.ToString().Equals($desiredState, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }

    Start-Sleep -Milliseconds 300
  }

  return $false
}

function Resolve-ProjectPath([string]$pathArg) {
  if (-not [string]::IsNullOrWhiteSpace($pathArg)) {
    return (Resolve-Path -LiteralPath $pathArg).Path
  }

  $default = Join-Path $PSScriptRoot 'FTD.OposBridge.Service\FTD.OposBridge.Service.csproj'
  return (Resolve-Path -LiteralPath $default).Path
}

function Resolve-ExePath([string]$pathArg, [string]$root) {
  if (-not [string]::IsNullOrWhiteSpace($pathArg)) {
    return (Resolve-Path -LiteralPath $pathArg).Path
  }

  return (Join-Path $root 'FTD.OposBridge.Service.exe')
}

function Publish-ServiceBinary([string]$projectFile, [string]$outputDir) {
  if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "dotnet CLI is required to publish the service."
  }

  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
  Write-Host "Publishing win-x86 self-contained service to $outputDir ..."
  & dotnet publish $projectFile -c Release -r win-x86 --self-contained true -o $outputDir
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE."
  }
}

function ConvertTo-PlainText([Security.SecureString]$secure) {
  if ($null -eq $secure) { return '' }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Resolve-ServiceIdentity {
  $resolvedAccount = [string]$ServiceAccount
  $resolvedUser = ''
  $resolvedPassword = $null

  switch ($resolvedAccount) {
    'localservice' { return @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' } }
    'networkservice' { return @{ StartName = 'NT AUTHORITY\NetworkService'; StartPassword = '' } }
    'localsystem' { return @{ StartName = 'LocalSystem'; StartPassword = $null } }
    'current-user' {
      $resolvedUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    }
    'custom' {
      $resolvedUser = [string]$ServiceUser
      if ([string]::IsNullOrWhiteSpace($resolvedUser)) {
        throw "ServiceUser is required when ServiceAccount=custom."
      }
    }
    default {
      throw "Unsupported ServiceAccount value: $resolvedAccount"
    }
  }

  $cred = $Credential
  if ($null -eq $cred -and $PromptForCredential.IsPresent) {
    $promptUser = if ([string]::IsNullOrWhiteSpace($resolvedUser)) { $null } else { $resolvedUser }
    $cred = Get-Credential -UserName $promptUser -Message "Enter service credential for $resolvedUser"
  }
  if ($null -eq $cred) {
    throw "Credential is required for ServiceAccount=$resolvedAccount. Pass -Credential or -PromptForCredential."
  }

  $resolvedPassword = ConvertTo-PlainText $cred.Password
  if ([string]::IsNullOrWhiteSpace($resolvedPassword)) {
    throw "Credential password cannot be empty for ServiceAccount=$resolvedAccount."
  }

  if (-not [string]::IsNullOrWhiteSpace($resolvedUser) -and $cred.UserName -and ($cred.UserName -ne $resolvedUser)) {
    Write-Warning "Credential username '$($cred.UserName)' does not match requested '$resolvedUser'. Using credential username."
    $resolvedUser = $cred.UserName
  } elseif ([string]::IsNullOrWhiteSpace($resolvedUser)) {
    $resolvedUser = $cred.UserName
  }

  return @{ StartName = $resolvedUser; StartPassword = $resolvedPassword }
}

function Apply-ServiceIdentity([string]$name, [hashtable]$identity) {
  $service = Get-ServiceWmi -name $name
  if ($null -eq $service) {
    throw "Service '$name' not found while applying identity."
  }

  $args = @{
    StartName = $identity.StartName
  }
  if ($identity.ContainsKey('StartPassword')) {
    $args.StartPassword = $identity.StartPassword
  }

  $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments $args
  if ($null -eq $result -or $result.ReturnValue -ne 0) {
    $rv = if ($null -ne $result) { $result.ReturnValue } else { '<null>' }
    throw "Failed to set service account identity. Win32_Service.Change ReturnValue=$rv"
  }
}

function Configure-ServiceRecovery([string]$name, [int]$restartDelayMs) {
  $delay = [Math]::Max(1000, [Math]::Min(600000, $restartDelayMs))
  Invoke-Sc -ScArgs @('failure', $name, 'reset=', '86400', 'actions=', "restart/$delay/restart/$delay/restart/$delay")
  Invoke-Sc -ScArgs @('failureflag', $name, '1')
}

function Start-ServiceAndVerify([string]$name, [int]$port) {
  Invoke-Sc -ScArgs @('start', $name)
  if (-not (Wait-ServiceState -name $name -desiredState 'Running' -timeoutSeconds 25)) {
    throw "Service '$name' did not enter Running state."
  }

  $healthUrl = "http://127.0.0.1:$port/health"
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
      if ($health.ok) {
        $ok = $true
        Write-Host ("Health check passed: status={0}, claimed={1}, logicalName={2}" -f $health.scannerStatus, $health.scannerClaimed, $health.scannerLogicalName)
        break
      }
    }
    catch {
      # Ignore retries while service endpoint warms up.
    }
  }

  if (-not $ok) {
    throw "Service started but health endpoint did not respond successfully at $healthUrl."
  }
}

function Install-OrUpdateService {
  Ensure-Admin
  $service = Get-ServiceWmi -name $ServiceName

  if (-not $SkipPublish.IsPresent -and [string]::IsNullOrWhiteSpace($ExePath)) {
    if ($null -ne $service -and $service.State -eq 'Running') {
      Write-Host "Stopping service '$ServiceName' before publish to release file locks ..."
      Invoke-Sc -ScArgs @('stop', $ServiceName)
      if (-not (Wait-ServiceState -name $ServiceName -desiredState 'Stopped' -timeoutSeconds 30)) {
        throw "Service '$ServiceName' failed to stop before publish."
      }
      $service = Get-ServiceWmi -name $ServiceName
    }

    $projectFile = Resolve-ProjectPath -pathArg $ProjectPath
    Publish-ServiceBinary -projectFile $projectFile -outputDir $InstallRoot
  }

  $resolvedExe = Resolve-ExePath -pathArg $ExePath -root $InstallRoot
  if (-not (Test-Path -LiteralPath $resolvedExe)) {
    throw "Service executable not found: $resolvedExe"
  }

  $identity = Resolve-ServiceIdentity
  $binPath = ('"{0}" --port={1} --logical-name={2} --scanner-mode={3} --claim-timeout-ms={4} --log-level={5}' -f $resolvedExe, $Port, $LogicalName, $ScannerMode, $ClaimTimeoutMs, $LogLevel)
  $service = Get-ServiceWmi -name $ServiceName

  if ($null -eq $service) {
    Write-Host "Creating service '$ServiceName' ..."
    Invoke-Sc -ScArgs @(
      'create',
      $ServiceName,
      'binPath=',
      $binPath,
      'start=',
      $StartMode,
      'DisplayName=',
      $ServiceName
    )
  }
  else {
    Write-Host "Updating existing service '$ServiceName' ..."
    if ($service.State -eq 'Running') {
      Invoke-Sc -ScArgs @('stop', $ServiceName)
      if (-not (Wait-ServiceState -name $ServiceName -desiredState 'Stopped' -timeoutSeconds 20)) {
        throw "Service '$ServiceName' failed to stop for update."
      }
    }

    Invoke-Sc -ScArgs @(
      'config',
      $ServiceName,
      'binPath=',
      $binPath,
      'start=',
      $StartMode,
      'DisplayName=',
      $ServiceName
    )
  }

  Apply-ServiceIdentity -name $ServiceName -identity $identity
  Configure-ServiceRecovery -name $ServiceName -restartDelayMs $ServiceRestartDelayMs
  Start-ServiceAndVerify -name $ServiceName -port $Port
}

function Uninstall-Service {
  Ensure-Admin
  $service = Get-ServiceWmi -name $ServiceName
  if ($null -eq $service) {
    Write-Host "Service '$ServiceName' does not exist."
  }
  else {
    if ($service.State -eq 'Running') {
      Invoke-Sc -ScArgs @('stop', $ServiceName)
      if (-not (Wait-ServiceState -name $ServiceName -desiredState 'Stopped' -timeoutSeconds 20)) {
        throw "Service '$ServiceName' failed to stop before delete."
      }
    }

    Invoke-Sc -ScArgs @('delete', $ServiceName)
    Start-Sleep -Milliseconds 500
  }

  if ($RemoveInstallRoot.IsPresent -and (Test-Path -LiteralPath $InstallRoot)) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    Write-Host "Removed install root: $InstallRoot"
  }
}

function Show-Status {
  $service = Get-ServiceWmi -name $ServiceName
  if ($null -eq $service) {
    Write-Host "Service '$ServiceName' not found."
    return
  }

  Write-Host ("Name: {0}" -f $service.Name)
  Write-Host ("State: {0}" -f $service.State)
  Write-Host ("StartMode: {0}" -f $service.StartMode)
  Write-Host ("StartName: {0}" -f $service.StartName)
  Write-Host ("PathName: {0}" -f $service.PathName)
  try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 2
    Write-Host ("Health: ok={0}, scannerStatus={1}, claimed={2}" -f $health.ok, $health.scannerStatus, $health.scannerClaimed)
  }
  catch {
    Write-Host "Health: not reachable on configured port."
  }
}

switch ($Action) {
  'install' {
    Install-OrUpdateService
  }
  'uninstall' {
    Uninstall-Service
  }
  'start' {
    Ensure-Admin
    Invoke-Sc -ScArgs @('start', $ServiceName)
  }
  'stop' {
    Ensure-Admin
    Invoke-Sc -ScArgs @('stop', $ServiceName)
  }
  'restart' {
    Ensure-Admin
    Invoke-Sc -ScArgs @('stop', $ServiceName)
    Wait-ServiceState -name $ServiceName -desiredState 'Stopped' -timeoutSeconds 20 | Out-Null
    Invoke-Sc -ScArgs @('start', $ServiceName)
  }
  'status' {
    Show-Status
  }
  default {
    throw "Unsupported action: $Action"
  }
}
