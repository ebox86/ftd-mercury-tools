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
| `email.senderAddress` | — | From address used on outgoing WOI emails |
| `email.senderPassword` | _(empty)_ | SMTP password — leave blank for unauthenticated local relay |
| `email.smtpUsername` | _(empty)_ | SMTP login if different from sender address |
| `email.recipientAddress` | — | The mailbox Mercury polls for WOI orders |
| `email.subjectLine` | `Online Order` | Must match the subject configured in Mercury Administration → WOI |
| `email.smtpHost` | `smtp.gmail.com` | SMTP host — use `127.0.0.1` for local relay |
| `email.smtpPort` | `587` | SMTP port — use `25` for local relay |
| `email.encryptionPassword` | _(empty)_ | Optional WOI body encryption password |
| `email.encryptionAlgorithm` | `TripleDES` | `TripleDES`, `DES`, `RC2`, or `Rijndael` (CBC/PKCS7) |
| `fieldBounds` | _(empty)_ | Per-field bounding boxes (normalized 0–1 fractions) for guided OCR |

---

## Mercury Administration — WOI Setup

FTD Mercury must be configured to poll the mailbox the fax parser sends to. These are the settings used in production.

**In Mercury Administration → Web Order Interface, add a WOI row with:**

| Mercury Setting | Value |
|---|---|
| Server (POP3 host) | `127.0.0.1` |
| Port | `110` |
| Use SSL | No / unchecked |
| Username | `order@localhost.local` |
| Password | _(the password set for that mailbox in hMailServer)_ |
| Subject line filter | `Online Order` _(must match `email.subjectLine` in config.json)_ |
| Rejected orders mailbox | `rejected@localhost.local` _(optional — Mercury deposits unreadable orders here)_ |

Mercury polls this POP3 mailbox on its own schedule (typically every few minutes). Each email that matches the subject filter is parsed as a WOI order and imported into the system automatically.

> **Domain note:** Mercury's WOI processor requires email addresses to contain a dot in the domain portion. Plain `@localhost` addresses are rejected. Using `@localhost.local` satisfies this requirement while keeping everything local.

---

## Local SMTP Relay — hMailServer Setup

For the fax parser to deliver WOI emails to Mercury without routing through an external mail provider, a local SMTP/POP3 server is required. **hMailServer** (free, open-source, Windows) was used in production.

### Why a local relay?

Mercury polls a POP3 mailbox directly. The fax parser submits emails over SMTP. A local mail server sits between them, accepting the SMTP submission from the parser and holding messages in a POP3 mailbox for Mercury to collect. This keeps everything on the local Windows machine with no internet dependency.

### hMailServer configuration

**Download:** [hMailServer.com](https://www.hmailserver.com/) — free, runs as a Windows service.

**Step 1 — Create the domain**

In hMailServer Administrator:
- Domains → Add domain
- Domain name: `localhost.local`
- Save

**Step 2 — Create mailboxes**

Under the `localhost.local` domain, add two accounts:

| Account | Address | Notes |
|---|---|---|
| `order` | `order@localhost.local` | The WOI inbox Mercury polls |
| `rejected` | `rejected@localhost.local` | Optional — receives orders Mercury could not parse |

Set a password for each (any password works; record it for the Mercury WOI row above).

**Step 3 — Allow unauthenticated SMTP from localhost**

By default hMailServer requires SMTP authentication even from local connections. Disable that for the loopback address:

- Settings → Advanced → IP Ranges → Add
- Name: `Localhost`
- IP address / range: `127.0.0.1`
- Lower / upper: `127.0.0.1`
- Under "Allow" tab: check **SMTP**, **POP3**, **IMAP**
- Under "Require" tab: **uncheck** "Require SMTP authentication"
- Save

**Step 4 — Update config.json**

Set the fax parser to use the local relay:

```json
{
  "email": {
    "senderAddress":   "faxparser@localhost.local",
    "senderPassword":  "",
    "smtpUsername":    "",
    "recipientAddress":"order@localhost.local",
    "subjectLine":     "Online Order",
    "smtpHost":        "127.0.0.1",
    "smtpPort":        25,
    "encryptionPassword":  "",
    "encryptionAlgorithm": "None"
  }
}
```

> **IPv6 note:** Use `127.0.0.1` explicitly, not `localhost`. On Windows, `localhost` may resolve to `::1` (IPv6 loopback), which hMailServer may not listen on by default, causing `ECONNREFUSED` errors.

### Verifying the setup

1. In hMailServer Administrator → Utilities → Diagnostics — run "Check all" to confirm the service is healthy.
2. Use the fax parser's **Preview Fields** → **Process with These Values** button to send a test order.
3. In hMailServer → Accounts → `order@localhost.local` → Messages — confirm the email arrived.
4. Open Mercury Administration → Web Order Interface → check the activity log to confirm Mercury collected and parsed it.

---

## WOI Email Encryption

If `email.encryptionPassword` is configured, the WOI body is encrypted and Base64-encoded before sending. Supported algorithms: `TripleDES`, `DES`, `RC2`, `Rijndael` (AES-256), all using CBC mode with PKCS7 padding. Keys are normalized to the required length by truncating or right-padding with `*`.

Leave the password blank (and algorithm `None`) when using a trusted local relay — encryption is unnecessary when traffic never leaves the machine.

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

---

## Future Work — Replacing hMailServer with a Bundled Node.js Relay

hMailServer works well and is genuinely reliable, but it is a separate Windows application that the user must download, install, and configure manually. For non-technical users this is the hardest part of the setup. The ideal end state is a self-contained installer — one `.exe` that puts everything in place with no external dependencies.

### What hMailServer is doing

Two things:

1. **SMTP receiver** — accepts the email from the fax parser on port 25 and stores it locally
2. **POP3 server** — serves those stored messages to Mercury when Mercury polls

Both are straightforward protocols. SMTP is line-based text; POP3 is even simpler (a handful of commands: `USER`, `PASS`, `STAT`, `LIST`, `RETR`, `DELE`, `QUIT`). Both are entirely implementable in Node.js.

### Option A — Embed a minimal Node.js SMTP + POP3 server

The fax parser service could spawn (or incorporate directly) two lightweight TCP servers running on localhost-only ports.

**SMTP side — `smtp-server` (npm)**

The [`smtp-server`](https://www.npmjs.com/package/smtp-server) package (maintained by the Nodemailer team, same authors as the mailer we already use) implements a full RFC-compliant SMTP server in Node.js. It can be configured to accept connections on `127.0.0.1:25` with no authentication required and write each received message to a local queue directory.

```
npm install smtp-server mailparser
```

**POP3 side — hand-rolled or a thin library**

There is no widely-adopted POP3 *server* npm package. However, POP3 is short enough that a minimal implementation is around 200 lines of Node.js using the built-in `net` module. The server only needs to support the commands Mercury actually issues (`USER`, `PASS`, `STAT`, `LIST`, `RETR`, `DELE`, `QUIT`) — no UIDL, no APOP, no TLS needed for loopback.

The message store would be a simple directory of `.eml` files written by the SMTP receiver and deleted (or archived) when Mercury issues `DELE` after a successful `RETR`.

**Architecture sketch:**

```
┌─────────────────────────────────────────────┐
│  fax-parser service process (Node.js)       │
│                                             │
│  ┌──────────────┐   writes   ┌──────────┐  │
│  │  smtp-server │ ─────────► │ mail/    │  │
│  │  :25         │            │ queue/   │  │
│  └──────────────┘            └────┬─────┘  │
│                                   │ reads  │
│  ┌──────────────┐                 │        │
│  │  pop3-server │ ◄───────────────┘        │
│  │  :110        │                          │
└──┴──────────────┴──────────────────────────┘
         ▲                    ▲
         │ SMTP submit        │ POP3 poll
    fax parser           FTD Mercury
    (sendMail)         (WOI collector)
```

Both servers bind to `127.0.0.1` only, so they are never exposed on the network.

**What needs to change in the codebase:**

- A new `local-relay.ts` module that starts the SMTP and POP3 servers as part of the service process
- The SMTP receiver stores incoming messages as `.eml` files in `C:\ProgramData\FTD\FaxOrderParser\mailqueue\`
- The POP3 server reads from the same directory
- `service.ts` starts the relay servers before the folder watcher
- The installer configures ports 25 and 110 in the Windows Firewall rule (loopback-only) and writes the correct `config.json` automatically — no manual hMailServer steps

**Potential complications:**

- Port 25 may already be in use or blocked by Windows Defender / another mail service. The service could use a non-standard port (e.g., `2525`) and configure Mercury to poll that port instead — Mercury's WOI row has a configurable POP3 port field
- Windows may require elevated privileges to bind port 25. Using a port above 1024 avoids this
- The SMTP server must handle chunked / multi-part MIME correctly. `smtp-server` + `mailparser` handle this; a hand-rolled implementation would not

### Option B — Bundle a pre-built mail server binary

[**MailHog**](https://github.com/mailhog/MailHog) (Go, single binary, ~10 MB) or [**Mailtutan**](https://github.com/mailtutan/mailtutan) (Rust) are self-contained SMTP capture servers with a web UI. They accept SMTP but expose an HTTP API rather than POP3, so they do not directly satisfy Mercury's POP3 requirement without an adapter layer.

This path would require writing a small POP3 adapter that proxies Mercury's POP3 requests to the capture server's HTTP API — more moving parts than Option A.

### Option C — Skip the local server; use a real mailbox

If the machine has internet access and a dedicated Gmail (or other) account is acceptable, the fax parser can send WOI emails directly to that cloud inbox and Mercury can be configured to poll it via POP3 (Gmail supports POP3 access). This eliminates the local relay entirely and is the simplest path for sites that are comfortable with a cloud mailbox.

The downside: latency, internet dependency, and the Gmail app-password setup step — which is roughly as complex as hMailServer for a non-technical user.

### Recommended path

**Option A with a non-privileged port** is the cleanest long-term solution. Using port `2525` for SMTP (fax parser → local relay) and `1110` for POP3 (Mercury → local relay) avoids Windows permission issues entirely, keeps everything inside a single Node.js process, and makes the installer fully self-contained. The Mercury WOI row would point to `127.0.0.1:1110` instead of the standard `110`.

The primary implementation effort is the minimal POP3 server (~200 lines) and wiring it into the service startup. The SMTP side is essentially a one-import change using the existing Nodemailer ecosystem.
