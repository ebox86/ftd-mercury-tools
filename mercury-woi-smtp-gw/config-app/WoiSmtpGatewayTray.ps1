param(
  [switch]$Tray,
  [switch]$ExitExisting
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$script:ProductName = "FTD Mercury Mail Gateway"
$script:PrimaryServiceName = "FTD Mercury Mail Gateway"
$script:LegacyServiceNames = @("FTD WOI SMTP Gateway")
$script:ServiceName = $script:PrimaryServiceName
$script:MutexName = "FTD.WoiSmtpGateway.ConfigTray"
$script:ShowEventName = "FTD.WoiSmtpGateway.ConfigTray.Show"
$script:ExitEventName = "FTD.WoiSmtpGateway.ConfigTray.Exit"

function New-NamedEventHandle([string]$name) {
  return New-Object System.Threading.EventWaitHandle(
    $false,
    [System.Threading.EventResetMode]::AutoReset,
    $name
  )
}

if ($ExitExisting) {
  $createdForExit = $false
  $probeMutex = New-Object System.Threading.Mutex($true, $script:MutexName, ([ref]$createdForExit))
  if ($createdForExit) {
    $probeMutex.ReleaseMutex()
    $probeMutex.Dispose()
    return
  }

  $exitEvent = New-NamedEventHandle $script:ExitEventName
  [void]$exitEvent.Set()
  $exitEvent.Dispose()
  return
}

$createdNew = $false
$script:SingleInstanceMutex = New-Object System.Threading.Mutex($true, $script:MutexName, ([ref]$createdNew))
$script:ShowEvent = New-NamedEventHandle $script:ShowEventName
$script:ExitEvent = New-NamedEventHandle $script:ExitEventName

if (-not $createdNew) {
  [void]$script:ShowEvent.Set()
  $script:ShowEvent.Dispose()
  $script:ExitEvent.Dispose()
  return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:Ui = @{}
$script:Menu = @{}
$script:MainForm = $null
$script:NotifyIcon = $null
$script:AppIcon = $null
$script:Exiting = $false
$script:ShownTrayHint = $false

function New-GatewayIcon {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, 32, 32)),
    [System.Drawing.Color]::FromArgb(26, 89, 140),
    [System.Drawing.Color]::FromArgb(30, 132, 86),
    45
  )
  $graphics.FillEllipse($background, 2, 2, 28, 28)

  $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2)
  $graphics.DrawRectangle($whitePen, 8, 11, 16, 11)
  $graphics.DrawLine($whitePen, 8, 11, 16, 17)
  $graphics.DrawLine($whitePen, 24, 11, 16, 17)

  $background.Dispose()
  $whitePen.Dispose()
  $graphics.Dispose()

  return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
}

function Get-AppIcon {
  if ($script:AppIcon -ne $null) {
    return $script:AppIcon
  }

  $iconPath = Join-Path $PSScriptRoot "app-icon.ico"
  if (Test-Path $iconPath) {
    try {
      $script:AppIcon = New-Object System.Drawing.Icon($iconPath)
      return $script:AppIcon
    }
    catch { }
  }

  $script:AppIcon = New-GatewayIcon
  return $script:AppIcon
}

function Get-ConfigDir {
  if (-not [string]::IsNullOrWhiteSpace($env:WOI_GATEWAY_CONFIG_DIR)) {
    return $env:WOI_GATEWAY_CONFIG_DIR
  }

  $programData = $env:ProgramData
  if ([string]::IsNullOrWhiteSpace($programData)) {
    $programData = "C:\ProgramData"
  }

  return (Join-Path $programData "FTD\WoiSmtpGateway")
}

function Get-ConfigPath {
  return (Join-Path (Get-ConfigDir) "gateway-config.json")
}

function Get-QueueDir {
  return (Join-Path (Get-ConfigDir) "mailqueue")
}

function Get-LogDir {
  return (Join-Path (Get-ConfigDir) "logs")
}

function New-DefaultConfig {
  $gateway = [ordered]@{
    bindAddress = "127.0.0.1"
    smtpPort = 2525
    pop3Port = 1110
    forwardEnabled = $false
    forwardToAddress = "orders@example.com"
    forwardSmtpHost = "smtp.example.com"
    forwardSmtpPort = 587
    forwardUsername = "orders@example.com"
    forwardPassword = ""
  }

  return [ordered]@{
    gateway = $gateway
  }
}

function Get-PropertyValue($source, [string]$name, $defaultValue) {
  if ($null -eq $source) {
    return $defaultValue
  }

  if ($source -is [System.Collections.IDictionary]) {
    if ($source.Contains($name)) {
      return $source[$name]
    }
    return $defaultValue
  }

  $property = $source.PSObject.Properties[$name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $defaultValue
  }

  return $property.Value
}

function ConvertTo-ConfigString($value, [string]$defaultValue) {
  if ($null -eq $value) {
    return $defaultValue
  }
  return [string]$value
}

function ConvertTo-ConfigPort($value, [int]$defaultValue) {
  $parsed = 0
  if ([int]::TryParse([string]$value, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) {
    return $parsed
  }
  return $defaultValue
}

function ConvertTo-ConfigBool($value, [bool]$defaultValue) {
  if ($null -eq $value) {
    return $defaultValue
  }
  if ($value -is [bool]) {
    return $value
  }

  $parsed = $false
  if ([bool]::TryParse([string]$value, [ref]$parsed)) {
    return $parsed
  }
  return $defaultValue
}

function Load-GatewayConfig {
  $defaults = New-DefaultConfig
  $defaultGateway = $defaults["gateway"]
  $configPath = Get-ConfigPath

  if (-not (Test-Path $configPath)) {
    return $defaults
  }

  try {
    $parsed = Get-Content -Raw -Path $configPath | ConvertFrom-Json
    $gatewaySource = Get-PropertyValue $parsed "gateway" $null
    if ($null -eq $gatewaySource) {
      return $defaults
    }

    $gateway = [ordered]@{
      bindAddress = ConvertTo-ConfigString (Get-PropertyValue $gatewaySource "bindAddress" $defaultGateway["bindAddress"]) $defaultGateway["bindAddress"]
      smtpPort = ConvertTo-ConfigPort (Get-PropertyValue $gatewaySource "smtpPort" $defaultGateway["smtpPort"]) $defaultGateway["smtpPort"]
      pop3Port = ConvertTo-ConfigPort (Get-PropertyValue $gatewaySource "pop3Port" $defaultGateway["pop3Port"]) $defaultGateway["pop3Port"]
      forwardEnabled = ConvertTo-ConfigBool (Get-PropertyValue $gatewaySource "forwardEnabled" $defaultGateway["forwardEnabled"]) $defaultGateway["forwardEnabled"]
      forwardToAddress = ConvertTo-ConfigString (Get-PropertyValue $gatewaySource "forwardToAddress" $defaultGateway["forwardToAddress"]) $defaultGateway["forwardToAddress"]
      forwardSmtpHost = ConvertTo-ConfigString (Get-PropertyValue $gatewaySource "forwardSmtpHost" $defaultGateway["forwardSmtpHost"]) $defaultGateway["forwardSmtpHost"]
      forwardSmtpPort = ConvertTo-ConfigPort (Get-PropertyValue $gatewaySource "forwardSmtpPort" $defaultGateway["forwardSmtpPort"]) $defaultGateway["forwardSmtpPort"]
      forwardUsername = ConvertTo-ConfigString (Get-PropertyValue $gatewaySource "forwardUsername" $defaultGateway["forwardUsername"]) $defaultGateway["forwardUsername"]
      forwardPassword = ConvertTo-ConfigString (Get-PropertyValue $gatewaySource "forwardPassword" $defaultGateway["forwardPassword"]) $defaultGateway["forwardPassword"]
    }

    return [ordered]@{
      gateway = $gateway
    }
  }
  catch {
    return $defaults
  }
}

function Save-GatewayConfig($config) {
  $configDir = Get-ConfigDir
  if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  }

  if (-not (Test-Path (Get-QueueDir))) {
    New-Item -ItemType Directory -Path (Get-QueueDir) -Force | Out-Null
  }
  if (-not (Test-Path (Get-LogDir))) {
    New-Item -ItemType Directory -Path (Get-LogDir) -Force | Out-Null
  }

  $json = $config | ConvertTo-Json -Depth 8
  Set-Content -Path (Get-ConfigPath) -Value $json -Encoding UTF8
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-GatewayServiceInfo {
  $names = @($script:PrimaryServiceName) + $script:LegacyServiceNames
  foreach ($name in $names) {
    if ([string]::IsNullOrWhiteSpace($name)) {
      continue
    }

    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $service) {
      $script:ServiceName = $name
      return [pscustomobject]@{
        Name = $name
        Status = [string]$service.Status
        IsLegacy = ($name -ne $script:PrimaryServiceName)
      }
    }
  }

  $script:ServiceName = $script:PrimaryServiceName
  return $null
}

function Get-ServiceStateText {
  $info = Get-GatewayServiceInfo
  if ($null -eq $info) {
    return "Not installed"
  }
  return [string]$info.Status
}

function Set-FooterStatus([string]$message, [bool]$isError) {
  if (-not $script:Ui.ContainsKey("FooterStatus")) {
    return
  }

  $label = $script:Ui["FooterStatus"]
  $label.Text = $message
  if ($isError) {
    $label.ForeColor = [System.Drawing.Color]::Firebrick
  }
  else {
    $label.ForeColor = [System.Drawing.Color]::FromArgb(28, 112, 68)
  }
}

function Update-ServiceStatus {
  $serviceInfo = Get-GatewayServiceInfo
  $status = if ($null -eq $serviceInfo) { "Not installed" } else { [string]$serviceInfo.Status }

  if ($script:Ui.ContainsKey("ServiceBadge")) {
    $badge = $script:Ui["ServiceBadge"]
    $badge.Text = "Service: $status"
    switch ($status) {
      "Running" {
        $badge.BackColor = [System.Drawing.Color]::FromArgb(220, 244, 230)
        $badge.ForeColor = [System.Drawing.Color]::FromArgb(28, 112, 68)
      }
      "Stopped" {
        $badge.BackColor = [System.Drawing.Color]::FromArgb(255, 235, 225)
        $badge.ForeColor = [System.Drawing.Color]::FromArgb(180, 64, 38)
      }
      default {
        $badge.BackColor = [System.Drawing.Color]::FromArgb(235, 238, 242)
        $badge.ForeColor = [System.Drawing.Color]::FromArgb(86, 96, 108)
      }
    }
  }

  if ($script:Ui.ContainsKey("ServiceStatusValue")) {
    $script:Ui["ServiceStatusValue"].Text = $status
  }

  if ($script:Ui.ContainsKey("ServiceNameValue")) {
    $script:Ui["ServiceNameValue"].Text = if ($null -eq $serviceInfo) {
      $script:PrimaryServiceName
    }
    elseif ($serviceInfo.IsLegacy) {
      "$($serviceInfo.Name) (legacy)"
    }
    else {
      $serviceInfo.Name
    }
  }

  if ($script:Menu.ContainsKey("Status")) {
    $script:Menu["Status"].Text = "Service: $status"
  }

  if ($script:NotifyIcon -ne $null) {
    $script:NotifyIcon.Text = "$script:ProductName - $status"
  }
}

function Invoke-ElevatedServiceCommand([string]$command) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  Start-Process -FilePath $powerShell -Verb RunAs -Wait -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    $encoded
  )
}

function Invoke-ServiceAction([string]$action) {
  $serviceInfo = Get-GatewayServiceInfo
  if ($null -eq $serviceInfo) {
    Set-FooterStatus "Service is not installed." $true
    Update-ServiceStatus
    return
  }

  $escapedName = $serviceInfo.Name.Replace("'", "''")
  switch ($action) {
    "Start" {
      $command = "Start-Service -Name '$escapedName'"
      $statusText = "Starting service..."
    }
    "Stop" {
      $command = "Stop-Service -Name '$escapedName' -Force"
      $statusText = "Stopping service..."
    }
    default {
      $command = "`$svc = Get-Service -Name '$escapedName'; if (`$svc.Status -eq 'Running') { Restart-Service -Name '$escapedName' -Force } else { Start-Service -Name '$escapedName' }"
      $statusText = "Restarting service..."
    }
  }

  try {
    Set-FooterStatus $statusText $false
    if (Test-IsAdministrator) {
      Invoke-Expression $command
    }
    else {
      Invoke-ElevatedServiceCommand $command
    }
    Start-Sleep -Milliseconds 700
    Update-ServiceStatus
    Set-FooterStatus "Service command completed." $false
  }
  catch {
    Set-FooterStatus ("Service command failed: " + $_.Exception.Message) $true
    Update-ServiceStatus
  }
}

function Open-Folder([string]$path) {
  try {
    if (-not (Test-Path $path)) {
      New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
    Start-Process -FilePath "explorer.exe" -ArgumentList @($path)
  }
  catch {
    Set-FooterStatus ("Could not open folder: " + $_.Exception.Message) $true
  }
}

function Open-ConfigFile {
  try {
    if (-not (Test-Path (Get-ConfigPath))) {
      Save-GatewayConfig (Load-GatewayConfig)
    }
    Start-Process -FilePath "notepad.exe" -ArgumentList @((Get-ConfigPath))
  }
  catch {
    Set-FooterStatus ("Could not open config file: " + $_.Exception.Message) $true
  }
}

function New-Label([string]$text) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.AutoSize = $true
  $label.Anchor = [System.Windows.Forms.AnchorStyles]::Left
  $label.Margin = New-Object System.Windows.Forms.Padding(3, 7, 10, 3)
  return $label
}

function New-TextBox([int]$width, [bool]$usePasswordChar) {
  $box = New-Object System.Windows.Forms.TextBox
  $box.Width = $width
  $box.Anchor = [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
  $box.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
  if ($usePasswordChar) {
    $box.UseSystemPasswordChar = $true
  }
  return $box
}

function New-PortSpinner {
  $spinner = New-Object System.Windows.Forms.NumericUpDown
  $spinner.Minimum = 1
  $spinner.Maximum = 65535
  $spinner.Width = 120
  $spinner.Anchor = [System.Windows.Forms.AnchorStyles]::Left
  $spinner.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
  return $spinner
}

function New-ConfigTable {
  $table = New-Object System.Windows.Forms.TableLayoutPanel
  $table.Dock = [System.Windows.Forms.DockStyle]::Top
  $table.AutoSize = $true
  $table.ColumnCount = 2
  $table.RowCount = 0
  $table.Padding = New-Object System.Windows.Forms.Padding(16, 12, 16, 10)
  [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 190)))
  [void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  return $table
}

function Add-Row($table, [string]$labelText, [System.Windows.Forms.Control]$control) {
  $row = $table.RowCount
  $table.RowCount = $row + 1
  $rowStyle = New-Object System.Windows.Forms.RowStyle
  $rowStyle.SizeType = [System.Windows.Forms.SizeType]::AutoSize
  [void]$table.RowStyles.Add($rowStyle)
  $table.Controls.Add((New-Label $labelText), 0, $row)
  $table.Controls.Add($control, 1, $row)
}

function Add-SectionHeader($table, [string]$text) {
  $row = $table.RowCount
  $table.RowCount = $row + 1
  $rowStyle = New-Object System.Windows.Forms.RowStyle
  $rowStyle.SizeType = [System.Windows.Forms.SizeType]::AutoSize
  [void]$table.RowStyles.Add($rowStyle)

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.AutoSize = $true
  $label.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
  $label.ForeColor = [System.Drawing.Color]::FromArgb(35, 58, 84)
  $label.Margin = New-Object System.Windows.Forms.Padding(3, 6, 3, 8)
  $table.Controls.Add($label, 0, $row)
  $table.SetColumnSpan($label, 2)
}

function Set-NumericValue($spinner, [int]$value) {
  if ($value -lt [int]$spinner.Minimum) {
    $value = [int]$spinner.Minimum
  }
  if ($value -gt [int]$spinner.Maximum) {
    $value = [int]$spinner.Maximum
  }
  $spinner.Value = [decimal]$value
}

function Populate-UiFromConfig {
  $config = Load-GatewayConfig
  $gateway = $config["gateway"]

  $script:Ui["BindAddress"].Text = [string]$gateway["bindAddress"]
  Set-NumericValue $script:Ui["SmtpPort"] ([int]$gateway["smtpPort"])
  Set-NumericValue $script:Ui["Pop3Port"] ([int]$gateway["pop3Port"])
  $script:Ui["ForwardEnabled"].Checked = [bool]$gateway["forwardEnabled"]
  $script:Ui["ForwardToAddress"].Text = [string]$gateway["forwardToAddress"]
  $script:Ui["ForwardSmtpHost"].Text = [string]$gateway["forwardSmtpHost"]
  Set-NumericValue $script:Ui["ForwardSmtpPort"] ([int]$gateway["forwardSmtpPort"])
  $script:Ui["ForwardUsername"].Text = [string]$gateway["forwardUsername"]
  $script:Ui["ForwardPassword"].Text = [string]$gateway["forwardPassword"]
  $script:Ui["ConfigPath"].Text = Get-ConfigPath
  Update-MercuryGuide
}

function Read-ConfigFromUi {
  $gateway = [ordered]@{
    bindAddress = $script:Ui["BindAddress"].Text.Trim()
    smtpPort = [int]$script:Ui["SmtpPort"].Value
    pop3Port = [int]$script:Ui["Pop3Port"].Value
    forwardEnabled = [bool]$script:Ui["ForwardEnabled"].Checked
    forwardToAddress = $script:Ui["ForwardToAddress"].Text.Trim()
    forwardSmtpHost = $script:Ui["ForwardSmtpHost"].Text.Trim()
    forwardSmtpPort = [int]$script:Ui["ForwardSmtpPort"].Value
    forwardUsername = $script:Ui["ForwardUsername"].Text.Trim()
    forwardPassword = $script:Ui["ForwardPassword"].Text
  }

  if ([string]::IsNullOrWhiteSpace($gateway["bindAddress"])) {
    throw "Bind address is required."
  }

  if ($gateway["forwardEnabled"]) {
    if ([string]::IsNullOrWhiteSpace($gateway["forwardToAddress"])) {
      throw "Forward-to address is required when forwarding is enabled."
    }
    if ([string]::IsNullOrWhiteSpace($gateway["forwardSmtpHost"])) {
      throw "Forwarding SMTP host is required when forwarding is enabled."
    }
  }

  return [ordered]@{
    gateway = $gateway
  }
}

function Save-FromUi([bool]$restartService) {
  try {
    $config = Read-ConfigFromUi
    Save-GatewayConfig $config
    Set-FooterStatus "Settings saved." $false
    if ($restartService) {
      Invoke-ServiceAction "Restart"
    }
  }
  catch {
    Set-FooterStatus ("Save failed: " + $_.Exception.Message) $true
  }
}

function Build-GatewayPage {
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = "Gateway"
  $page.BackColor = [System.Drawing.Color]::White

  $table = New-ConfigTable
  Add-SectionHeader $table "Local mail gateway"

  $script:Ui["BindAddress"] = New-TextBox 360 $false
  $script:Ui["BindAddress"].Add_TextChanged({ Update-MercuryGuide })
  Add-Row $table "Bind address" $script:Ui["BindAddress"]

  $script:Ui["SmtpPort"] = New-PortSpinner
  Add-Row $table "SMTP intake port" $script:Ui["SmtpPort"]

  $script:Ui["Pop3Port"] = New-PortSpinner
  $script:Ui["Pop3Port"].Add_ValueChanged({ Update-MercuryGuide })
  Add-Row $table "POP3 port for Mercury" $script:Ui["Pop3Port"]

  $note = New-Object System.Windows.Forms.Label
  $note.Text = "Port and bind changes take effect after the Windows service restarts."
  $note.AutoSize = $true
  $note.ForeColor = [System.Drawing.Color]::FromArgb(94, 104, 116)
  $note.Margin = New-Object System.Windows.Forms.Padding(3, 7, 3, 3)
  Add-Row $table "" $note

  $page.Controls.Add($table)
  return $page
}

function Update-MercuryGuide {
  if (-not $script:Ui.ContainsKey("MercuryGrid")) {
    return
  }

  $server = "127.0.0.1"
  if ($script:Ui.ContainsKey("BindAddress")) {
    $configured = $script:Ui["BindAddress"].Text.Trim()
    if (-not [string]::IsNullOrWhiteSpace($configured) -and $configured -ne "0.0.0.0") {
      $server = $configured
    }
  }

  $port = 1110
  if ($script:Ui.ContainsKey("Pop3Port")) {
    $port = [int]$script:Ui["Pop3Port"].Value
  }

  $grid = $script:Ui["MercuryGrid"]
  $grid.Rows.Clear()
  [void]$grid.Rows.Add(
    $server,
    "Your Store Name",
    "POP3",
    [string]$port,
    "order@localhost",
    "password",
    "Online Order",
    "None",
    "",
    "",
    ""
  )

  if ($script:Ui.ContainsKey("MercuryPolling")) {
    $script:Ui["MercuryPolling"].Text = "Polling Interval: 3 minutes"
  }
}

function Copy-MercuryGuide {
  if (-not $script:Ui.ContainsKey("MercuryGrid")) {
    return
  }

  $grid = $script:Ui["MercuryGrid"]
  if ($grid.Rows.Count -eq 0) {
    Update-MercuryGuide
  }

  $headers = @()
  foreach ($column in $grid.Columns) {
    $headers += $column.HeaderText
  }

  $values = @()
  foreach ($cell in $grid.Rows[0].Cells) {
    $values += [string]$cell.Value
  }

  [System.Windows.Forms.Clipboard]::SetText(($headers -join "`t") + [Environment]::NewLine + ($values -join "`t"))
  Set-FooterStatus "Mercury settings copied." $false
}

function Build-MercuryPage {
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = "Mercury"
  $page.BackColor = [System.Drawing.Color]::White

  $panel = New-Object System.Windows.Forms.Panel
  $panel.Dock = [System.Windows.Forms.DockStyle]::Fill
  $panel.Padding = New-Object System.Windows.Forms.Padding(16, 14, 16, 12)
  $panel.BackColor = [System.Drawing.Color]::White

  $title = New-Object System.Windows.Forms.Label
  $title.Text = "Incoming Mail Server entry"
  $title.AutoSize = $true
  $title.Font = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(35, 58, 84)
  $title.Location = New-Object System.Drawing.Point(16, 14)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = "Use these values in Mercury's Incoming Mail Server grid. The account and password can be any non-empty values."
  $hint.AutoSize = $true
  $hint.ForeColor = [System.Drawing.Color]::FromArgb(94, 104, 116)
  $hint.Location = New-Object System.Drawing.Point(16, 38)

  $grid = New-Object System.Windows.Forms.DataGridView
  $grid.Location = New-Object System.Drawing.Point(16, 68)
  $grid.Size = New-Object System.Drawing.Size(660, 118)
  $grid.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
  $grid.AllowUserToAddRows = $false
  $grid.AllowUserToDeleteRows = $false
  $grid.AllowUserToResizeRows = $false
  $grid.RowHeadersVisible = $false
  $grid.ReadOnly = $true
  $grid.BackgroundColor = [System.Drawing.Color]::White
  $grid.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $grid.SelectionMode = [System.Windows.Forms.DataGridViewSelectionMode]::FullRowSelect
  $grid.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
  $grid.AutoSizeColumnsMode = [System.Windows.Forms.DataGridViewAutoSizeColumnsMode]::DisplayedCells
  $grid.ColumnHeadersHeightSizeMode = [System.Windows.Forms.DataGridViewColumnHeadersHeightSizeMode]::AutoSize

  foreach ($name in @(
    "Server",
    "Store",
    "Protocol",
    "Port",
    "Account",
    "Password",
    "Subject",
    "Encryption",
    "Encryption PW",
    "Referral Code",
    "Send Errors To"
  )) {
    [void]$grid.Columns.Add($name.Replace(" ", ""), $name)
  }

  $script:Ui["MercuryGrid"] = $grid

  $script:Ui["MercuryPolling"] = New-Object System.Windows.Forms.Label
  $script:Ui["MercuryPolling"].AutoSize = $true
  $script:Ui["MercuryPolling"].Location = New-Object System.Drawing.Point(16, 202)
  $script:Ui["MercuryPolling"].ForeColor = [System.Drawing.Color]::FromArgb(31, 45, 61)

  $copyButton = New-Object System.Windows.Forms.Button
  $copyButton.Text = "Copy Table"
  $copyButton.Width = 94
  $copyButton.Height = 28
  $copyButton.Location = New-Object System.Drawing.Point(16, 232)
  $copyButton.Add_Click({ Copy-MercuryGuide })

  $note = New-Object System.Windows.Forms.Label
  $note.Text = "If you change the POP3 port on the Gateway tab, save and restart this service, then update the Port value in Mercury to match."
  $note.AutoSize = $true
  $note.ForeColor = [System.Drawing.Color]::FromArgb(94, 104, 116)
  $note.Location = New-Object System.Drawing.Point(16, 274)

  $panel.Controls.AddRange(@($title, $hint, $grid, $script:Ui["MercuryPolling"], $copyButton, $note))
  $page.Controls.Add($panel)
  Update-MercuryGuide
  return $page
}

function Build-ForwardingPage {
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = "Forwarding"
  $page.BackColor = [System.Drawing.Color]::White

  $table = New-ConfigTable
  Add-SectionHeader $table "External SMTP forwarding"

  $script:Ui["ForwardEnabled"] = New-Object System.Windows.Forms.CheckBox
  $script:Ui["ForwardEnabled"].Text = "Forward accepted mail"
  $script:Ui["ForwardEnabled"].AutoSize = $true
  $script:Ui["ForwardEnabled"].Margin = New-Object System.Windows.Forms.Padding(3, 5, 3, 8)
  Add-Row $table "Forwarding" $script:Ui["ForwardEnabled"]

  $script:Ui["ForwardToAddress"] = New-TextBox 360 $false
  Add-Row $table "Forward to" $script:Ui["ForwardToAddress"]

  $script:Ui["ForwardSmtpHost"] = New-TextBox 360 $false
  Add-Row $table "SMTP host" $script:Ui["ForwardSmtpHost"]

  $script:Ui["ForwardSmtpPort"] = New-PortSpinner
  Add-Row $table "SMTP port" $script:Ui["ForwardSmtpPort"]

  $script:Ui["ForwardUsername"] = New-TextBox 360 $false
  Add-Row $table "Username" $script:Ui["ForwardUsername"]

  $script:Ui["ForwardPassword"] = New-TextBox 360 $true
  Add-Row $table "Password" $script:Ui["ForwardPassword"]

  $showPassword = New-Object System.Windows.Forms.CheckBox
  $showPassword.Text = "Show password"
  $showPassword.AutoSize = $true
  $showPassword.Margin = New-Object System.Windows.Forms.Padding(3, 5, 3, 8)
  $showPassword.Add_CheckedChanged({
    param($sender, $eventArgs)
    $script:Ui["ForwardPassword"].UseSystemPasswordChar = -not $sender.Checked
  })
  Add-Row $table "" $showPassword

  $page.Controls.Add($table)
  return $page
}

function Build-ServicePage {
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = "Service"
  $page.BackColor = [System.Drawing.Color]::White

  $table = New-ConfigTable
  Add-SectionHeader $table "Windows service"

  $script:Ui["ServiceStatusValue"] = New-Object System.Windows.Forms.Label
  $script:Ui["ServiceStatusValue"].AutoSize = $true
  $script:Ui["ServiceStatusValue"].Margin = New-Object System.Windows.Forms.Padding(3, 7, 3, 8)
  Add-Row $table "Status" $script:Ui["ServiceStatusValue"]

  $script:Ui["ServiceNameValue"] = New-Object System.Windows.Forms.Label
  $script:Ui["ServiceNameValue"].AutoSize = $true
  $script:Ui["ServiceNameValue"].Margin = New-Object System.Windows.Forms.Padding(3, 7, 3, 8)
  Add-Row $table "Service name" $script:Ui["ServiceNameValue"]

  $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
  $buttons.AutoSize = $true
  $buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $buttons.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 6)

  $startButton = New-Object System.Windows.Forms.Button
  $startButton.Text = "Start"
  $startButton.Width = 86
  $startButton.Add_Click({ Invoke-ServiceAction "Start" })

  $stopButton = New-Object System.Windows.Forms.Button
  $stopButton.Text = "Stop"
  $stopButton.Width = 86
  $stopButton.Add_Click({ Invoke-ServiceAction "Stop" })

  $restartButton = New-Object System.Windows.Forms.Button
  $restartButton.Text = "Restart"
  $restartButton.Width = 86
  $restartButton.Add_Click({ Invoke-ServiceAction "Restart" })

  $refreshButton = New-Object System.Windows.Forms.Button
  $refreshButton.Text = "Refresh"
  $refreshButton.Width = 86
  $refreshButton.Add_Click({ Update-ServiceStatus })

  $buttons.Controls.AddRange(@($startButton, $stopButton, $restartButton, $refreshButton))
  Add-Row $table "Controls" $buttons

  Add-SectionHeader $table "Files"

  $script:Ui["ConfigPath"] = New-TextBox 420 $false
  $script:Ui["ConfigPath"].ReadOnly = $true
  Add-Row $table "Config file" $script:Ui["ConfigPath"]

  $fileButtons = New-Object System.Windows.Forms.FlowLayoutPanel
  $fileButtons.AutoSize = $true
  $fileButtons.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
  $fileButtons.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 6)

  $openConfigButton = New-Object System.Windows.Forms.Button
  $openConfigButton.Text = "Open Config"
  $openConfigButton.Width = 102
  $openConfigButton.Add_Click({ Open-ConfigFile })

  $openFolderButton = New-Object System.Windows.Forms.Button
  $openFolderButton.Text = "Open Folder"
  $openFolderButton.Width = 102
  $openFolderButton.Add_Click({ Open-Folder (Get-ConfigDir) })

  $openQueueButton = New-Object System.Windows.Forms.Button
  $openQueueButton.Text = "Open Queue"
  $openQueueButton.Width = 102
  $openQueueButton.Add_Click({ Open-Folder (Get-QueueDir) })

  $openLogsButton = New-Object System.Windows.Forms.Button
  $openLogsButton.Text = "Open Logs"
  $openLogsButton.Width = 102
  $openLogsButton.Add_Click({ Open-Folder (Get-LogDir) })

  $fileButtons.Controls.AddRange(@($openConfigButton, $openFolderButton, $openQueueButton, $openLogsButton))
  Add-Row $table "Locations" $fileButtons

  $page.Controls.Add($table)
  return $page
}

function Show-MainForm {
  if ($script:MainForm -eq $null) {
    return
  }

  Populate-UiFromConfig
  Update-ServiceStatus

  if ($script:MainForm.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
    $script:MainForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  }

  $script:MainForm.Show()
  $script:MainForm.Activate()
  $script:MainForm.BringToFront()
}

function Exit-Application {
  $script:Exiting = $true
  if ($script:NotifyIcon -ne $null) {
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
  }

  try {
    $script:SingleInstanceMutex.ReleaseMutex()
  }
  catch { }

  $script:SingleInstanceMutex.Dispose()
  $script:ShowEvent.Dispose()
  $script:ExitEvent.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

function Build-MainForm {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "$script:ProductName Configuration"
  $form.Size = New-Object System.Drawing.Size(720, 500)
  $form.MinimumSize = New-Object System.Drawing.Size(650, 460)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
  $form.Icon = Get-AppIcon

  $root = New-Object System.Windows.Forms.TableLayoutPanel
  $root.Dock = [System.Windows.Forms.DockStyle]::Fill
  $root.ColumnCount = 1
  $root.RowCount = 3
  $root.Padding = New-Object System.Windows.Forms.Padding(0)
  [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 46)))
  [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  [void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 54)))

  $header = New-Object System.Windows.Forms.Panel
  $header.Dock = [System.Windows.Forms.DockStyle]::Fill
  $header.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 250)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = $script:ProductName
  $title.AutoSize = $true
  $title.Font = New-Object System.Drawing.Font("Segoe UI", 10.5, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(31, 45, 61)
  $title.Location = New-Object System.Drawing.Point(14, 13)

  $script:Ui["ServiceBadge"] = New-Object System.Windows.Forms.Label
  $script:Ui["ServiceBadge"].AutoSize = $true
  $script:Ui["ServiceBadge"].Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 4)
  $script:Ui["ServiceBadge"].Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
  $script:Ui["ServiceBadge"].Text = "Service: checking"
  $script:Ui["ServiceBadge"].Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right

  $header.Add_Layout({
    param($sender, $eventArgs)
    $badge = $script:Ui["ServiceBadge"]
    $badge.Location = New-Object System.Drawing.Point(
      ($sender.ClientSize.Width - $badge.Width - 14),
      [Math]::Max(8, [int](($sender.ClientSize.Height - $badge.Height) / 2))
    )
  })

  $header.Controls.AddRange(@($title, $script:Ui["ServiceBadge"]))

  $tabs = New-Object System.Windows.Forms.TabControl
  $tabs.Dock = [System.Windows.Forms.DockStyle]::Fill
  $tabs.Controls.Add((Build-GatewayPage))
  $tabs.Controls.Add((Build-MercuryPage))
  $tabs.Controls.Add((Build-ForwardingPage))
  $tabs.Controls.Add((Build-ServicePage))

  $footer = New-Object System.Windows.Forms.Panel
  $footer.Dock = [System.Windows.Forms.DockStyle]::Fill
  $footer.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 250)

  $saveButton = New-Object System.Windows.Forms.Button
  $saveButton.Text = "Save"
  $saveButton.Width = 86
  $saveButton.Height = 28
  $saveButton.Location = New-Object System.Drawing.Point(14, 12)
  $saveButton.Add_Click({ Save-FromUi $false })

  $saveRestartButton = New-Object System.Windows.Forms.Button
  $saveRestartButton.Text = "Save and Restart"
  $saveRestartButton.Width = 122
  $saveRestartButton.Height = 28
  $saveRestartButton.Location = New-Object System.Drawing.Point(108, 12)
  $saveRestartButton.Add_Click({ Save-FromUi $true })

  $reloadButton = New-Object System.Windows.Forms.Button
  $reloadButton.Text = "Reload"
  $reloadButton.Width = 86
  $reloadButton.Height = 28
  $reloadButton.Location = New-Object System.Drawing.Point(238, 12)
  $reloadButton.Add_Click({
    Populate-UiFromConfig
    Set-FooterStatus "Settings reloaded." $false
  })

  $closeButton = New-Object System.Windows.Forms.Button
  $closeButton.Text = "Close to Tray"
  $closeButton.Width = 104
  $closeButton.Height = 28
  $closeButton.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right
  $closeButton.Add_Click({ $script:MainForm.Hide() })
  $script:Ui["CloseButton"] = $closeButton

  $script:Ui["FooterStatus"] = New-Object System.Windows.Forms.Label
  $script:Ui["FooterStatus"].AutoSize = $true
  $script:Ui["FooterStatus"].Location = New-Object System.Drawing.Point(352, 17)
  $script:Ui["FooterStatus"].ForeColor = [System.Drawing.Color]::FromArgb(28, 112, 68)
  $script:Ui["FooterStatus"].Anchor = [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Top

  $footer.Add_Layout({
    param($sender, $eventArgs)
    $button = $script:Ui["CloseButton"]
    $button.Location = New-Object System.Drawing.Point(
      ($sender.ClientSize.Width - $button.Width - 14),
      12
    )
  })

  $footer.Controls.AddRange(@($saveButton, $saveRestartButton, $reloadButton, $script:Ui["FooterStatus"], $closeButton))

  $root.Controls.Add($header, 0, 0)
  $root.Controls.Add($tabs, 0, 1)
  $root.Controls.Add($footer, 0, 2)
  $form.Controls.Add($root)

  $form.Add_Shown({
    Populate-UiFromConfig
    Update-ServiceStatus
  })

  $form.Add_FormClosing({
    param($sender, $eventArgs)
    if (-not $script:Exiting) {
      $eventArgs.Cancel = $true
      $sender.Hide()
      if (-not $script:ShownTrayHint -and $script:NotifyIcon -ne $null) {
        $script:ShownTrayHint = $true
        $script:NotifyIcon.ShowBalloonTip(2500, $script:ProductName, "Configuration is still available from the tray icon.", [System.Windows.Forms.ToolTipIcon]::Info)
      }
    }
  })

  return $form
}

function Build-TrayIcon {
  $menu = New-Object System.Windows.Forms.ContextMenuStrip

  $openItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $openItem.Text = "Open Configuration"
  $openItem.Add_Click({ Show-MainForm })

  $script:Menu["Status"] = New-Object System.Windows.Forms.ToolStripMenuItem
  $script:Menu["Status"].Text = "Service: checking"
  $script:Menu["Status"].Enabled = $false

  $startItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $startItem.Text = "Start Service"
  $startItem.Add_Click({ Invoke-ServiceAction "Start" })

  $stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $stopItem.Text = "Stop Service"
  $stopItem.Add_Click({ Invoke-ServiceAction "Stop" })

  $restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $restartItem.Text = "Restart Service"
  $restartItem.Add_Click({ Invoke-ServiceAction "Restart" })

  $openFolderItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $openFolderItem.Text = "Open Config Folder"
  $openFolderItem.Add_Click({ Open-Folder (Get-ConfigDir) })

  $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $exitItem.Text = "Exit"
  $exitItem.Add_Click({ Exit-Application })

  [void]$menu.Items.Add($openItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($script:Menu["Status"])
  [void]$menu.Items.Add($startItem)
  [void]$menu.Items.Add($stopItem)
  [void]$menu.Items.Add($restartItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($openFolderItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($exitItem)

  $menu.Add_Opening({ Update-ServiceStatus })

  $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $notifyIcon.Icon = Get-AppIcon
  $notifyIcon.Text = $script:ProductName
  $notifyIcon.ContextMenuStrip = $menu
  $notifyIcon.Visible = $true
  $notifyIcon.Add_DoubleClick({ Show-MainForm })
  return $notifyIcon
}

$script:NotifyIcon = Build-TrayIcon
$script:MainForm = Build-MainForm

$signalTimer = New-Object System.Windows.Forms.Timer
$signalTimer.Interval = 600
$signalTimer.Add_Tick({
  if ($script:ShowEvent.WaitOne(0)) {
    Show-MainForm
  }
  if ($script:ExitEvent.WaitOne(0)) {
    Exit-Application
  }
})
$signalTimer.Start()

$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 10000
$statusTimer.Add_Tick({ Update-ServiceStatus })
$statusTimer.Start()

Update-ServiceStatus
if (-not $Tray) {
  Show-MainForm
}

[System.Windows.Forms.Application]::Run()
