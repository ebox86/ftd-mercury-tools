param(
  [string]$ConfigDir   = (Join-Path $env:ProgramData "FTD\FaxOrderParser"),
  [string]$WatchFolder = "C:\received_faxes",
  [int]$SmtpPort       = 2525,
  [int]$Pop3Port       = 1110
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function New-EmptyObject {
  return [pscustomobject]@{}
}

function Get-PropertyValue {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string]$Name
  )

  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Set-PropertyValue {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string]$Name,
    $Value
  )

  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) {
    Add-Member -InputObject $Object -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $prop.Value = $Value
  }
}

function Ensure-ObjectProperty {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string]$Name
  )

  $value = Get-PropertyValue -Object $Object -Name $Name
  if ($null -eq $value -or $value -isnot [psobject]) {
    $value = New-EmptyObject
    Set-PropertyValue -Object $Object -Name $Name -Value $value
  }
  return $value
}

function Set-DefaultProperty {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string]$Name,
    $Value
  )

  if ($null -eq (Get-PropertyValue -Object $Object -Name $Name)) {
    Set-PropertyValue -Object $Object -Name $Name -Value $Value
  }
}

function Get-IntPropertyOrDefault {
  param(
    [Parameter(Mandatory = $true)] $Object,
    [Parameter(Mandatory = $true)] [string]$Name,
    [Parameter(Mandatory = $true)] [int]$DefaultValue
  )

  $value = Get-PropertyValue -Object $Object -Name $Name
  if ($null -eq $value) { return $DefaultValue }

  try {
    $intValue = [int]$value
    if ($intValue -lt 1 -or $intValue -gt 65535) { return $DefaultValue }
    return $intValue
  } catch {
    return $DefaultValue
  }
}

New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $WatchFolder -Force | Out-Null

$configPath = Join-Path $ConfigDir "config.json"
$config = New-EmptyObject

if (Test-Path $configPath) {
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      $config = $raw | ConvertFrom-Json
    }
  } catch {
    $backupPath = Join-Path $ConfigDir ("config.invalid.{0}.bak" -f (Get-Date -Format "yyyyMMddHHmmss"))
    Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
    $config = New-EmptyObject
  }
}

Set-DefaultProperty -Object $config -Name "watchFolder" -Value $WatchFolder
Set-DefaultProperty -Object $config -Name "pollIntervalSeconds" -Value 10
Set-DefaultProperty -Object $config -Name "fileFormat" -Value "PDF"
Set-DefaultProperty -Object $config -Name "processedSubfolder" -Value "processed"

$processing = Ensure-ObjectProperty -Object $config -Name "processing"
Set-DefaultProperty -Object $processing -Name "useOrderPlacedDateWhenDeliveryDateMissing" -Value $true

$localRelay = Ensure-ObjectProperty -Object $config -Name "localRelay"
$effectiveSmtpPort = Get-IntPropertyOrDefault -Object $localRelay -Name "smtpPort" -DefaultValue $SmtpPort
$effectivePop3Port = Get-IntPropertyOrDefault -Object $localRelay -Name "pop3Port" -DefaultValue $Pop3Port

Set-PropertyValue -Object $localRelay -Name "enabled" -Value $true
Set-PropertyValue -Object $localRelay -Name "smtpPort" -Value $effectiveSmtpPort
Set-PropertyValue -Object $localRelay -Name "pop3Port" -Value $effectivePop3Port

$mailGateway = Ensure-ObjectProperty -Object $config -Name "mailGateway"
Set-PropertyValue -Object $mailGateway -Name "enabled" -Value $true
Set-PropertyValue -Object $mailGateway -Name "mode" -Value "built-in-relay"
Set-PropertyValue -Object $mailGateway -Name "bindAddress" -Value "127.0.0.1"
Set-PropertyValue -Object $mailGateway -Name "smtpPort" -Value $effectiveSmtpPort
Set-PropertyValue -Object $mailGateway -Name "pop3Port" -Value $effectivePop3Port
Set-PropertyValue -Object $mailGateway -Name "forwardEnabled" -Value $true
Set-PropertyValue -Object $mailGateway -Name "forwardToAddress" -Value "your-gmail-address@gmail.com"
Set-PropertyValue -Object $mailGateway -Name "forwardSmtpHost" -Value "smtp.gmail.com"
Set-PropertyValue -Object $mailGateway -Name "forwardSmtpPort" -Value 587
Set-PropertyValue -Object $mailGateway -Name "forwardUsername" -Value "your-gmail-address@gmail.com"
Set-PropertyValue -Object $mailGateway -Name "forwardPassword" -Value ""

$email = Ensure-ObjectProperty -Object $config -Name "email"
Set-PropertyValue -Object $email -Name "senderAddress" -Value "your-gmail-address@gmail.com"
Set-PropertyValue -Object $email -Name "senderPassword" -Value ""
Set-PropertyValue -Object $email -Name "smtpUsername" -Value "your-gmail-address@gmail.com"
Set-PropertyValue -Object $email -Name "recipientAddress" -Value "your-gmail-address@gmail.com"
Set-PropertyValue -Object $email -Name "errorRecipientAddress" -Value "your-gmail-address@gmail.com"
Set-DefaultProperty -Object $email -Name "subjectLine" -Value "Online Order"
Set-PropertyValue -Object $email -Name "smtpHost" -Value "smtp.gmail.com"
Set-PropertyValue -Object $email -Name "smtpPort" -Value 587
Set-PropertyValue -Object $email -Name "encryptionPassword" -Value ""
Set-PropertyValue -Object $email -Name "encryptionAlgorithm" -Value "None"

$json = $config | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $configPath -Value $json -Encoding UTF8

Write-Host "Local relay config written: $configPath"
