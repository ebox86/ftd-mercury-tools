# FTD Fax Order Parser

Monitors a folder for incoming fax files (PDF, TIFF, or JPG), OCR-extracts order data, and dispatches a **WOI-formatted email** to FTD Mercury for automatic order entry.

## Features

- **PDF, TIFF, and JPG support** — PDFs are rendered page-by-page via MuPDF (WASM, no native deps) before OCR; TIFF/JPG processed directly
- **Tesseract.js OCR** — extracts structured order fields from scanned images
- **WOI email dispatch** — formats and sends plain-text emails matching the [FTD Mercury Web Order Interface spec](https://floristwiki.ftdi.com/index.php/Web_Order_Interface_Web_Site_Requirements)
- **Windows background service** — runs as a Windows service via `FTD.FaxParser.ServiceHost.exe` (C# .NET 8)
- **GUI configuration app** — WinForms desktop app with three tabs: Monitor settings, Email settings, and Order Log
- **Visual field editor** — draw bounding boxes over the scanned image to tune where each WOI field is OCR'd
- **Order log with detail view** — double-click any processed order to see all parsed fields and reprocess if needed
- **Hold / quarantine** — files missing required WOI fields are held for manual review rather than silently discarded
- **InnoSetup installer** — installs everything, registers and starts the service, adds Start Menu / desktop shortcut
- **Full uninstaller** — stops/removes the service and deletes all installed files

---

## Project Structure

```
fax-order-parser/
  src/
    index.ts          – OCR entry point (runOcr, runOcrFull, parseOrderFields, detectFieldBboxes)
    config.ts         – Read/write config from C:\ProgramData\FTD\FaxOrderParser\config.json
    logger.ts         – Append/read orders-log.json
    email-sender.ts   – WOI email body formatter + nodemailer sender
    service.ts        – Folder-watcher service (chokidar) — main service entry point
  config-app/
    FTD.FaxParser.ConfigApp/   – WinForms C# .NET 8 configuration GUI
  service-host/
    FTD.FaxParser.ServiceHost/ – C# .NET 8 Windows service host (manages the Node.js process)
  service/
    install-fax-parser-service.ps1    – Register the service via the service host
    uninstall-fax-parser-service.ps1  – Stop and remove the service
  installer/
    FTD.FaxOrderParser.iss  – InnoSetup installer script
  tools/
    build-installer.ps1     – Full build pipeline (TS → C# → InnoSetup)
```

---

## Configuration

Settings are stored at `C:\ProgramData\FTD\FaxOrderParser\config.json` and managed through the GUI config app.

| Setting | Default | Description |
|---|---|---|
| `watchFolder` | `C:\received_faxes` | Folder to monitor for new fax files |
| `pollIntervalSeconds` | `10` | How often to check the folder |
| `fileFormat` | `PDF` | `PDF` or `TIF` (TIF mode also picks up `.jpg`/`.jpeg`) |
| `processedSubfolder` | `processed` | Subfolder where processed files are moved |
| `email.senderAddress` | `faxparser@localhost.local` | From address used on outgoing WOI emails |
| `email.senderPassword` | _(empty)_ | SMTP password — leave blank for unauthenticated local relay |
| `email.smtpUsername` | _(empty)_ | SMTP login if different from sender address |
| `email.recipientAddress` | `order@localhost.local` | The local WOI mailbox address |
| `email.subjectLine` | `Online Order` | Must match the subject configured in Mercury Administration → WOI |
| `email.smtpHost` | `127.0.0.1` | SMTP host for the built-in local relay |
| `email.smtpPort` | `2525` | SMTP port for the built-in local relay |
| `email.encryptionPassword` | _(empty)_ | Optional WOI body encryption password |
| `email.encryptionAlgorithm` | `None` | `None`, `TripleDES`, `DES`, `RC2`, or `Rijndael` (CBC/PKCS7) |
| `localRelay.enabled` | `true` | Starts the bundled localhost SMTP/POP3 relay with the service |
| `localRelay.smtpPort` | `2525` | SMTP intake port used by the fax parser |
| `localRelay.pop3Port` | `1110` | POP3 port Mercury polls for WOI orders |
| `processing.useOrderPlacedDateWhenDeliveryDateMissing` | `true` | Uses the order's `Placed` date as the delivery date when the fax has no delivery date line |
| `fieldBounds` | _(empty)_ | Per-field bounding boxes (normalized 0–1 fractions) for guided OCR |

---

## Mercury Administration — WOI Setup

FTD Mercury must be configured to poll the built-in local relay. These are the shipping defaults.

**In Mercury Administration → Web Order Interface, add a WOI row with:**

| Mercury Setting | Value |
|---|---|
| Server (POP3 host) | `127.0.0.1` |
| Port | `1110` |
| Use SSL | No / unchecked |
| Username | `order@localhost.local` |
| Password | Any non-empty value is fine; the local relay accepts loopback POP3 logins |
| Subject line filter | `Online Order` _(must match `email.subjectLine` in config.json)_ |
| Rejected orders mailbox | Leave blank unless you are using a separate real mailbox |

Mercury polls this POP3 mailbox on its own schedule (typically every few minutes). Each email that matches the subject filter is parsed as a WOI order and imported into the system automatically.

> **Domain note:** Mercury's WOI processor requires email addresses to contain a dot in the domain portion. Plain `@localhost` addresses are rejected. Using `@localhost.local` satisfies this requirement while keeping everything local.

---

## Built-in Local Mail Relay

The fax parser ships with a localhost-only SMTP/POP3 relay, so hMailServer is no longer required. The service accepts WOI email from Nodemailer on SMTP port `2525`, stores it under `C:\ProgramData\FTD\FaxOrderParser\mailqueue`, and serves the queue to Mercury over POP3 port `1110`.

### Why a local relay?

Mercury polls a POP3 mailbox directly. The fax parser submits emails over SMTP. A local mail server sits between them, accepting the SMTP submission from the parser and holding messages in a POP3 mailbox for Mercury to collect. This keeps everything on the local Windows machine with no internet dependency.

Default relay config:

```json
{
  "email": {
    "senderAddress":   "faxparser@localhost.local",
    "senderPassword":  "",
    "smtpUsername":    "",
    "recipientAddress":"order@localhost.local",
    "subjectLine":     "Online Order",
    "smtpHost":        "127.0.0.1",
    "smtpPort":        2525,
    "encryptionPassword":  "",
    "encryptionAlgorithm": "None"
  },
  "localRelay": {
    "enabled": true,
    "smtpPort": 2525,
    "pop3Port": 1110
  }
}
```

When local relay is enabled, the service normalizes the SMTP settings above at runtime. If you change relay ports in the config app, restart the Windows service so the listening sockets are recreated.

> **IPv6 note:** Use `127.0.0.1` explicitly, not `localhost`. The built-in relay binds to IPv4 loopback only.

### Verifying the setup

1. Confirm the Windows service log contains `Local relay enabled` and listeners for SMTP `2525` and POP3 `1110`.
2. Use the fax parser's **Preview Fields** → **Process with These Values** button to send a test order.
3. Confirm a `.eml` file appears briefly in `C:\ProgramData\FTD\FaxOrderParser\mailqueue`.
4. Open Mercury Administration → Web Order Interface and check the activity log to confirm Mercury collected and parsed it.

---

## WOI Email Encryption

If `email.encryptionPassword` is configured, the WOI body is encrypted and Base64-encoded before sending. Supported algorithms: `TripleDES`, `DES`, `RC2`, `Rijndael` (AES-256), all using CBC mode with PKCS7 padding. Keys are normalized to the required length by truncating or right-padding with `*`.

Leave the password blank and algorithm `None` when using the trusted local relay. Encryption is unnecessary when traffic never leaves the machine.

---

## Building the Installer

**Prerequisites:**

- .NET 8 SDK
- Node.js 20+
- Inno Setup 6 (`ISCC.exe`)

```powershell
.\tools\build-installer.ps1 -Version "1.0.0" -NodeRuntimeDir "C:\path\to\node-runtime"
```

The installer is written to `dist\FTD.FaxOrderParser.Setup.1.0.0.exe`.

---

## Gmail App Password Setup

If sending via Gmail instead of a local relay:

1. Enable 2-Step Verification on the sender Gmail account
2. Google Account → Security → App passwords
3. Generate a password for "Mail" / "Windows Computer"
4. Paste the 16-character password into the config app's **Email** tab

---

## Manual Service Management

```powershell
# Install / start
.\service\install-fax-parser-service.ps1

# Remove / stop
.\service\uninstall-fax-parser-service.ps1

# Run directly without the installer (Ctrl+C to stop)
npm install
npm run build
node dist/service.js
```
