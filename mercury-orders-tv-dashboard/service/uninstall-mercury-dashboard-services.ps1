param(
  [string]$NssmExePath = "",
  [string]$BridgeServiceName = "FTD Mercury Workflow Bridge",
  [string]$WebServiceName = "FTD Mercury Dashboard Web"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Test-ServiceExists {
  param([string]$Name)
  return $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

$appRoot = Split-Path -Parent $PSScriptRoot
if (-not $NssmExePath) {
  $NssmExePath = Join-Path $appRoot "bin\nssm.exe"
}
$NssmExePath = [System.IO.Path]::GetFullPath($NssmExePath)
$hasNssm = Test-Path $NssmExePath

function Stop-And-RemoveService {
  param([string]$Name)
  if (-not (Test-ServiceExists -Name $Name)) {
    return
  }

  if ($hasNssm) {
    try { & $NssmExePath stop $Name | Out-Null } catch {}
    Start-Sleep -Milliseconds 200
    try {
      & $NssmExePath remove $Name confirm | Out-Null
      return
    } catch {
      # Fall through to sc.exe delete
    }
  } else {
    try { & sc.exe stop $Name | Out-Null } catch {}
    Start-Sleep -Milliseconds 200
  }

  & sc.exe delete $Name | Out-Null
}

Write-Host "Removing Mercury dashboard services..."
Stop-And-RemoveService -Name $WebServiceName
Stop-And-RemoveService -Name $BridgeServiceName
Write-Host "Service removal completed."
