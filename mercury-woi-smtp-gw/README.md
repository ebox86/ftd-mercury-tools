# Mercury WOI SMTP Gateway

Standalone service that provides a local SMTP/POP3 gateway for Mercury's Web Order Interface (WOI). This gateway:

- **Accepts WOI emails over SMTP** on a configurable local port (default 2525)
- **Queues messages locally** in an `.eml` file queue
- **Serves messages via POP3** on a configurable port (default 1110) for Mercury to collect
- **Optionally forwards messages** to an external mailbox (e.g., Gmail, Brevo, etc.)

## Use Case

This gateway decouples WOI email submission from Mercury's polling mechanism:

1. Fax parser (or other system) sends WOI email to localhost:2525 (SMTP)
2. Gateway queues the message and optionally forwards it to an external mailbox
3. Mercury polls localhost:1110 (POP3) at its configured interval and retrieves queued messages
4. Mercury processes and imports the WOI orders

## Configuration

Configuration is stored at `C:\ProgramData\FTD\WoiSmtpGateway\gateway-config.json` (or override via `WOI_GATEWAY_CONFIG_DIR`).

### Example Config

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

### Configuration Fields

| Field | Default | Description |
|---|---|---|
| `bindAddress` | `127.0.0.1` | IP address to bind SMTP/POP3 servers to |
| `smtpPort` | `2525` | Port for SMTP intake (where WOI emails arrive) |
| `pop3Port` | `1110` | Port for POP3 service (where Mercury retrieves messages) |
| `forwardEnabled` | `false` | Enable external mailbox forwarding |
| `forwardToAddress` | `woi-inbox@example.com` | External mailbox to forward messages to |
| `forwardSmtpHost` | `smtp.example.com` | SMTP host for the external mailbox provider |
| `forwardSmtpPort` | `587` | SMTP port (typically 587 for TLS, 465 for SSL) |
| `forwardUsername` | `woi-user@example.com` | SMTP username (app password for Gmail/Brevo) |
| `forwardPassword` | `` | SMTP password or app password |

## Running

### Development

```bash
npm install
npm run dev
```

### Production Build

```bash
npm install
npm run build
npm start
```

## Mercury Configuration

Configure Mercury Administration → Web Order Interface to poll this gateway:

| Mercury Setting | Value |
|---|---|
| Server (POP3 host) | `127.0.0.1` |
| Port | `1110` (or your configured `pop3Port`) |
| Use SSL | No |
| Username | Any non-empty value (e.g., `mercury-woi`) |
| Password | Any non-empty value |
| Subject line filter | `Online Order` |

## Logs

Console output shows:

- SMTP server startup and email intake
- Message queueing
- POP3 session activity
- Forwarding attempts (if enabled)
- Error details

## Port Notes

- **IPv4 loopback only**: Uses `127.0.0.1` explicitly, not `localhost`, to ensure IPv4 binding
- **Port conflict**: Ensure ports 2525 and 1110 are not in use by other services

## Troubleshooting

**Messages not appearing in Mercury:**
- Check Mercury WOI settings point to the correct host/port
- Verify `smtpPort` and `pop3Port` in the config
- Check service logs for SMTP/POP3 connection errors

**Forwarding failures:**
- Verify SMTP host, port, and credentials are correct
- Check firewall rules allow outbound SMTP
- Enable `forwardEnabled` in config

**Queue location:**
- Queue is stored at `C:\ProgramData\FTD\WoiSmtpGateway\mailqueue`
- Each message is a `.eml` file named `msg_<timestamp>_<random>.eml`

## Building & Installation

### Prerequisites

- **Node.js 20+** with npm
- **PowerShell 5.1+** (Windows native)
- **Inno Setup 6** (for building the installer)
  - Download: https://jrsoftware.org/isdl.php
  - Install to default location (e.g., `C:\Program Files (x86)\Inno Setup 6\`)

### Build Installer

Use the PowerShell build script to package the gateway with a bundled Node.js runtime:

```powershell
# From the mercury-woi-smtp-gw directory
$nodePath = "C:\path\to\node" # Path to Node.js bin/ folder containing node.exe
& .\tools\build-installer.ps1 -Version "1.0.0" -NodeRuntimeDir $nodePath
```

The script will:
1. Copy the Node.js runtime to the staging area
2. Run `npm install` and `npm run build` to compile TypeScript
3. Stage all files (runtime, compiled service, scripts)
4. Invoke Inno Setup to create the Windows installer

Output: `dist/FTD.WoiSmtpGateway.Setup.1.0.0.exe`

### Install from Installer

Run the generated `.exe` as Administrator:

```powershell
& ".\dist\FTD.WoiSmtpGateway.Setup.1.0.0.exe"
```

The installer will:
1. Extract files to `C:\FTDTools\WoiSmtpGateway\`
2. Register the Windows service (FTD WOI SMTP Gateway)
3. Start the service automatically
4. Configure it to auto-start on system reboot

### Manual Service Management

If you need to manage the service manually:

```powershell
# Install service (run as Administrator)
& "C:\FTDTools\WoiSmtpGateway\service\install-woi-smtp-gateway.ps1"

# Uninstall service (run as Administrator)
& "C:\FTDTools\WoiSmtpGateway\service\uninstall-woi-smtp-gateway.ps1"

# Check service status
Get-Service "FTD WOI SMTP Gateway"

# Start/stop service
Start-Service "FTD WOI SMTP Gateway"
Stop-Service "FTD WOI SMTP Gateway"
```

### Service Details

- **Service Name**: FTD WOI SMTP Gateway
- **Install Location**: `C:\FTDTools\WoiSmtpGateway\`
- **Config Location**: `C:\ProgramData\FTD\WoiSmtpGateway\gateway-config.json`
- **Log Location**: `C:\ProgramData\FTD\WoiSmtpGateway\logs\`
- **Queue Location**: `C:\ProgramData\FTD\WoiSmtpGateway\mailqueue\`
