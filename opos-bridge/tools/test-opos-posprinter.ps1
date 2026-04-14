[CmdletBinding()]
param(
  [string]$LogicalName = "",
  [string]$Text = "*** DIRECT OPOS TEST ***`r`nFTD OPOS Bridge`r`n",
  [ValidateRange(100, 60000)]
  [int]$ClaimTimeoutMs = 3000,
  [switch]$ListOnly,
  [switch]$NoRelaunch32Bit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-OposResultName([int]$code) {
  switch ($code) {
    0 { return "OPOS_SUCCESS" }
    101 { return "OPOS_E_CLOSED" }
    102 { return "OPOS_E_CLAIMED" }
    103 { return "OPOS_E_NOTCLAIMED" }
    104 { return "OPOS_E_NOSERVICE" }
    105 { return "OPOS_E_DISABLED" }
    106 { return "OPOS_E_ILLEGAL" }
    107 { return "OPOS_E_NOHARDWARE" }
    108 { return "OPOS_E_OFFLINE" }
    109 { return "OPOS_E_NOEXIST" }
    110 { return "OPOS_E_EXISTS" }
    111 { return "OPOS_E_FAILURE" }
    112 { return "OPOS_E_TIMEOUT" }
    113 { return "OPOS_E_BUSY" }
    114 { return "OPOS_E_EXTENDED" }
    default { return "OPOS_UNKNOWN" }
  }
}

function Get-OposPrinterLogicalNames {
  $logicalNames = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
  $paths = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\OLEforRetail\ServiceOPOS\POSPrinter",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\OLEforRetail\ServiceOPOS\POSPrinter"
  )

  foreach ($path in $paths) {
    try {
      if (-not (Test-Path -LiteralPath $path)) {
        continue
      }

      $subKeys = Get-ChildItem -LiteralPath $path -ErrorAction Stop
      foreach ($key in $subKeys) {
        if (-not [string]::IsNullOrWhiteSpace($key.PSChildName)) {
          [void]$logicalNames.Add($key.PSChildName.Trim())
        }
      }
    } catch {
      # Best-effort registry scan only.
    }
  }

  return @($logicalNames | Sort-Object)
}

function Ensure-32BitPowerShell {
  if ($NoRelaunch32Bit) {
    return
  }

  if (-not [Environment]::Is64BitProcess) {
    return
  }

  $x86PowerShell = Join-Path $env:WINDIR "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $x86PowerShell)) {
    Write-Warning "32-bit PowerShell was not found at '$x86PowerShell'. Continuing in current process."
    return
  }

  $scriptPath = $PSCommandPath
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    return
  }

  $arguments = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $scriptPath,
    "-NoRelaunch32Bit",
    "-ClaimTimeoutMs", "$ClaimTimeoutMs",
    "-Text", $Text
  )

  if (-not [string]::IsNullOrWhiteSpace($LogicalName)) {
    $arguments += @("-LogicalName", $LogicalName)
  }
  if ($ListOnly) { $arguments += "-ListOnly" }
  if ($NoRelaunch32Bit) { $arguments += "-NoRelaunch32Bit" }

  Write-Host "Relaunching in 32-bit PowerShell for OPOS compatibility..."
  & $x86PowerShell @arguments
  $childExitCode = $LASTEXITCODE
  if ($null -eq $childExitCode) {
    $childExitCode = 0
  }
  exit [int]$childExitCode
}

Ensure-32BitPowerShell

$detectedNames = @(Get-OposPrinterLogicalNames)
Write-Host "Detected OPOS POSPrinter logical names:"
if ($detectedNames.Count -eq 0) {
  Write-Host "  (none found in OLEforRetail registry keys)"
} else {
  foreach ($name in $detectedNames) {
    Write-Host "  - $name"
  }
}

if ($ListOnly) {
  exit 0
}

if ([string]::IsNullOrWhiteSpace($LogicalName)) {
  if ($detectedNames.Count -gt 0) {
    $LogicalName = $detectedNames[0]
    Write-Host "No -LogicalName provided; using first detected value: '$LogicalName'"
  } else {
    Write-Error "No logical names detected. Pass -LogicalName explicitly after installing/registering OPOS printer."
    exit 2
  }
}

$station = 2 # PTR_S_RECEIPT
$opos = $null
try {
  $oposType = [Type]::GetTypeFromProgID("OPOS.POSPrinter")
  if ($null -eq $oposType) {
    throw "OPOS.POSPrinter COM class not found. OPOS printer driver/OCX likely not registered."
  }

  $opos = New-Object -ComObject OPOS.POSPrinter
  if ($null -eq $opos) {
    throw "Failed to create OPOS.POSPrinter COM object."
  }

  Write-Host ""
  Write-Host "Testing logical name: '$LogicalName'"
  Write-Host "Claim timeout: $ClaimTimeoutMs ms"

  $openRc = [int]$opos.Open($LogicalName)
  Write-Host ("Open       => {0} ({1})" -f $openRc, (Get-OposResultName $openRc))
  if ($openRc -ne 0) {
    exit 10
  }

  $claimRc = [int]$opos.ClaimDevice($ClaimTimeoutMs)
  Write-Host ("ClaimDevice=> {0} ({1})" -f $claimRc, (Get-OposResultName $claimRc))
  if ($claimRc -ne 0) {
    exit 11
  }

  $opos.DeviceEnabled = $true
  Start-Sleep -Milliseconds 250
  $enabled = $false
  try {
    $enabled = [bool]$opos.DeviceEnabled
  } catch {
    $enabled = $false
  }
  Write-Host ("DeviceEnabled after set => {0}" -f $enabled)

  if (-not [string]::IsNullOrWhiteSpace($Text) -and -not $Text.EndsWith("`n")) {
    $Text = $Text + "`r`n"
  }

  $printRc = [int]$opos.PrintNormal($station, $Text)
  $resultCode = 0
  $resultCodeExtended = 0
  try { $resultCode = [int]$opos.ResultCode } catch {}
  try { $resultCodeExtended = [int]$opos.ResultCodeExtended } catch {}

  Write-Host ("PrintNormal=> {0} ({1})" -f $printRc, (Get-OposResultName $printRc))
  Write-Host ("ResultCode => {0} ({1})" -f $resultCode, (Get-OposResultName $resultCode))
  Write-Host ("ResultCodeExtended => {0}" -f $resultCodeExtended)

  if ($printRc -ne 0) {
    exit 12
  }

  Write-Host ""
  Write-Host "SUCCESS: OPOS direct print completed."
  exit 0
}
catch {
  Write-Error ("OPOS direct test failed: {0}" -f $_.Exception.Message)
  exit 1
}
finally {
  if ($null -ne $opos) {
    try { $opos.DeviceEnabled = $false } catch {}
    try { $null = $opos.ReleaseDevice() } catch {}
    try { $null = $opos.Close() } catch {}
    try {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($opos)
    } catch {}
  }
}
