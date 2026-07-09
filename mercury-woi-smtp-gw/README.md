# Mercury WOI SMTP Gateway

This project provides a lightweight local SMTP/POP3 gateway for Mercury's Web Order Interface (WOI). It is designed for environments where WOI email submissions need to be accepted locally, queued, and later retrieved by Mercury over POP3.

## What it does

- Accepts WOI emails over SMTP on a configurable local port (default `2525`)
- Stores each message as an `.eml` file in a local queue
- Serves queued messages to Mercury over POP3 on a configurable port (default `1110`)
- Optionally forwards accepted messages to an external mailbox using SMTP

## How the flow works

1. A sender such as the fax parser or another workflow submits a WOI email to `127.0.0.1:2525`.
2. The gateway stores the message locally and optionally forwards it to an external mailbox.
3. Mercury polls `127.0.0.1:1110` at its configured interval and retrieves the queued message.
4. Mercury processes and imports the WOI order.

## Quick start

### Prerequisites

- Node.js 20 or newer
- npm
- Windows PowerShell 5.1+ for service installation

### Run locally

```powershell
npm install
npm run build
npm start
```

The service starts on `127.0.0.1:2525` for SMTP intake and `127.0.0.1:1110` for POP3 polling by default.

### Run in development mode

```powershell
npm install
npm run dev
```

## Configuration

Configuration is stored at `C:\ProgramData\FTD\WoiSmtpGateway\gateway-config.json` unless you override it with `WOI_GATEWAY_CONFIG_DIR`.

### Example configuration

```json
{
  "gateway": {
    "bindAddress": "127.0.0.1",
    "smtpPort": 2525,
    "pop3Port": 1110,
    "forwardEnabled": true,
    "forwardToAddress": "woi-inbox@example.com",
    "forwardSmtpHost": "smtp.example.com",
    "forwardSmtpPort": 587,
    "forwardUsername": "woi-user@example.com",
    "forwardPassword": "your-app-password-here"
  }
}
```

### Configuration fields

| Field | Default | Description |
|---|---|---|
| `bindAddress` | `127.0.0.1` | IP address to bind the SMTP and POP3 servers to |
| `smtpPort` | `2525` | Port for SMTP intake |
| `pop3Port` | `1110` | Port for POP3 delivery to Mercury |
| `forwardEnabled` | `false` | Enables forwarding to an external mailbox |
| `forwardToAddress` | `woi-inbox@example.com` | Destination mailbox for forwarded messages |
| `forwardSmtpHost` | `smtp.example.com` | SMTP host for the external provider |
| `forwardSmtpPort` | `587` | SMTP port for the external provider |
| `forwardUsername` | `woi-user@example.com` | SMTP username or app password |
| `forwardPassword` | empty | SMTP password or app password |

## Mercury configuration

Configure Mercury Administration → Web Order Interface to poll this gateway with the following values:

| Mercury setting | Value |
|---|---|
| POP3 host | `127.0.0.1` |
| Port | `1110` (or your configured `pop3Port`) |
| Use SSL | No |
| Username | Any non-empty value, for example `mercury-woi` |
| Password | Any non-empty value |
| Subject line filter | `Online Order` |

> The POP3 implementation accepts any non-empty `USER`/`PASS` pair, so the values above can be simple placeholders.

## Logs and queue location

The service writes startup, queueing, POP3, and forwarding activity to the console. The queue is stored at `C:\ProgramData\FTD\WoiSmtpGateway\mailqueue`, with each message saved as an `.eml` file named like `msg_<timestamp>_<random>.eml`.

## Troubleshooting

- Messages do not appear in Mercury: verify the POP3 host/port and that the service is still running.
- Forwarding fails: verify the SMTP host, port, username, and password in the config.
- Port conflicts: make sure `2525` and `1110` are not already in use by another application.

## Building and installing

### Prerequisites

- Node.js 20+ with npm
- PowerShell 5.1+ (Windows native)
- Inno Setup 6 for building the installer

### Build the installer

Use the PowerShell build script to package the gateway with a bundled Node.js runtime:

```powershell
# From the mercury-woi-smtp-gw directory
$nodePath = "C:\path\to\node" # Path to the folder that contains node.exe
& .\tools\build-installer.ps1 -Version "1.0.0" -NodeRuntimeDir $nodePath
```

The script will:
1. Copy the Node.js runtime into the staging folder.
2. Run `npm install` and `npm run build`.
3. Stage the compiled service, scripts, and runtime files.
4. Invoke Inno Setup to create the Windows installer.

Output: `dist/FTD.WoiSmtpGateway.Setup.1.0.0.exe`

### Install from the installer

Run the generated `.exe` as Administrator:

```powershell
& .\dist\FTD.WoiSmtpGateway.Setup.1.0.0.exe
```

The installer will:
1. Extract files to `C:\FTDTools\WoiSmtpGateway\`
2. Register the Windows service named `FTD WOI SMTP Gateway`
3. Start the service automatically
4. Configure it to start automatically on reboot

### Manual service management

```powershell
# Install the service (run as Administrator)
& "C:\FTDTools\WoiSmtpGateway\service\install-woi-smtp-gateway.ps1"

# Uninstall the service (run as Administrator)
& "C:\FTDTools\WoiSmtpGateway\service\uninstall-woi-smtp-gateway.ps1"

# Check service status
Get-Service "FTD WOI SMTP Gateway"

# Start or stop the service
Start-Service "FTD WOI SMTP Gateway"
Stop-Service "FTD WOI SMTP Gateway"
```

### Service details

- Service name: `FTD WOI SMTP Gateway`
- Install location: `C:\FTDTools\WoiSmtpGateway\`
- Config location: `C:\ProgramData\FTD\WoiSmtpGateway\gateway-config.json`
- Log location: `C:\ProgramData\FTD\WoiSmtpGateway\logs\`
- Queue location: `C:\ProgramData\FTD\WoiSmtpGateway\mailqueue\`
