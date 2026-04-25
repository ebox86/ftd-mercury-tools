# FTD Fax Order Parser

Monitors a folder for incoming fax files (PDF or TIFF), OCR-extracts order data, and dispatches a **WOI-formatted email** to FTD Mercury for automatic order entry.

## Features

- **PDF and TIFF support** — PDFs are rendered page-by-page via MuPDF (WASM, no native deps) before OCR
- **Tesseract.js OCR** — extracts structured order fields from scanned images
- **WOI email dispatch** — formats and sends plain-text emails matching the [FTD Mercury Web Order Interface spec](https://floristwiki.ftdi.com/index.php/Web_Order_Interface_Web_Site_Requirements)
- **Windows background service** — runs as a Windows service via `FTD.FaxParser.ServiceHost.exe` (C# .NET 8)
- **GUI configuration app** — Electron desktop app with three tabs: Monitor settings, Email settings, and Order Log
- **InnoSetup installer** — installs everything, registers and starts the service, adds Start Menu / desktop shortcut
- **Full uninstaller** — stops/removes the service and deletes all installed files

## Project Structure

```
fax-order-parser/
  src/
    index.ts          – OCR entry point (runOcr, parseOrderFields) — PDF + TIF support
    config.ts         – Read/write config from C:\ProgramData\FTD\FaxOrderParser\config.json
    logger.ts         – Append/read orders-log.json
    email-sender.ts   – WOI email body formatter + nodemailer sender
    service.ts        – Folder-watcher service (chokidar) — main service entry point
  config-app/
    src/main.ts       – Electron main process (IPC handlers, window creation)
    src/preload.ts    – Electron preload / context bridge
    renderer/         – HTML + CSS + JS for the config UI
  service-host/
    FTD.FaxParser.ServiceHost/  – C# .NET 8 Windows service host (manages the Node.js process)
  service/
    install-fax-parser-service.ps1    – Register the service via the service host
    uninstall-fax-parser-service.ps1  – Stop and remove the service
  installer/
    FTD.FaxOrderParser.iss  – InnoSetup installer script
    assets/README.md        – Icon placeholder instructions
  tools/
    build-installer.ps1     – Full build pipeline (TS → C# → Electron → InnoSetup)
```

## Configuration

Settings are stored in `C:\ProgramData\FTD\FaxOrderParser\config.json`.

| Setting | Default | Description |
|---|---|---|
| `watchFolder` | `C:\received_faxes` | Folder to monitor for new fax files |
| `pollIntervalSeconds` | `10` | How often to check the folder |
| `fileFormat` | `PDF` | `PDF` or `TIF` |
| `processedSubfolder` | `processed` | Subfolder where processed files are moved |
| `email.senderAddress` | `oliverflowershop71440@gmail.com` | Gmail sender |
| `email.senderPassword` | _(empty — must be set in config app)_ | Gmail App Password |
| `email.recipientAddress` | `ftdpos71440@oliverflowers.com` | WOI inbox |
| `email.subjectLine` | `Online Order` | Must match Mercury Administration → WOI subject |
| `email.smtpHost` | `smtp.gmail.com` | SMTP host |
| `email.smtpPort` | `587` | SMTP port |

## Building the Installer

**Prerequisites:**
- .NET 8 SDK
- Node.js 20+
- Inno Setup 6 (ISCC.exe)

```powershell
.\tools\build-installer.ps1 -Version "1.0.0" -NodeRuntimeDir "C:\path\to\node-runtime"
```

The installer will be written to `dist\FTD.FaxOrderParser.Setup.1.0.0.exe`.

## Gmail App Password Setup

1. Enable 2-Step Verification on the sender Gmail account
2. Go to Google Account → Security → App passwords
3. Generate a new app password for "Mail" / "Windows Computer"
4. Enter that 16-character password in the config app's **Email** tab

## Manual Service Management

```powershell
# Install / start
.\service\install-fax-parser-service.ps1

# Remove / stop
.\service\uninstall-fax-parser-service.ps1

# Quick CLI (from repo, without installer)
npm install
npm run build
node dist/service.js          # run directly (Ctrl+C to stop)
```
- Designed to run on Windows (and cross-platform)
- Handles .TIF files from fax machines

---

**Next steps:**
- Implement OCR and stub field extraction
- Refine field list based on your input
