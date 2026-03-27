<style>
td, th {
   border: none!important;
}
</style>

| | |
| --- | --- |
| <img src="./about-scanner.png" alt="OPOS Browser Bridge icon" width="100" height="100" /> | <h2>OPOS Browser Bridge</h2><p>MercuryHQ Modal</p> |


This folder adds **true OPOS scanner input** to the MercuryHQ Tampermonkey scan modal by running a local bridge on each workstation.

## Why this is needed

The userscript modal is a browser input field. In OPOS-only mode, scan events go to the OPOS service object, not directly to browser keyboard input.  
So we add:

1. A local OPOS bridge process:
   - reads OPOS `DataEvent` from logical device (for example `ZEBRA_SCANNER`)
   - exposes latest scan at `http://127.0.0.1:17331/scan/latest`
2. A userscript update:
   - polls that local endpoint while the modal is open
   - auto-fills and looks up when a new OPOS scan arrives

## Files

- `opos-scanner-bridge.ps1` - local bridge service
- `install-opos-bridge-task.ps1` - creates a startup scheduled task
- `uninstall-opos-bridge-task.ps1` - removes scheduled task and running bridge process
- `bootstrap-opos-bridge.ps1` - one-command deploy helper (create folder, copy files, install task, verify health)
- `install-opos-bridge.cmd` - one-click launcher that runs bootstrap with `ExecutionPolicy Bypass`

## Workstation Install (repeat on every terminal/workstation)

1. Easiest: one-click install from this folder:
   - Double-click `install-opos-bridge.cmd`
   - Or run:
   ```powershell
   .\install-opos-bridge.cmd
   ```

2. Preferred PowerShell install from this folder:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   cd <path-to-this-folder>
   .\bootstrap-opos-bridge.ps1 -InstallRoot "C:\FTDTools\OposBridge" -LogicalName "ZEBRA_SCANNER" -Port 17331
   ```
   This does all of the following:
   - creates `C:\FTDTools\OposBridge\`
   - copies `opos-scanner-bridge.ps1`, `install-opos-bridge-task.ps1`, and `uninstall-opos-bridge-task.ps1`
   - installs/starts the scheduled task
   - checks `http://127.0.0.1:17331/health`

3. Manual install (if you do not want the bootstrap helper):
   - Create folder: `C:\FTDTools\OposBridge\`
   - Copy:
     - `opos-scanner-bridge.ps1`
     - `install-opos-bridge-task.ps1`

4. Confirm OPOS components exist:
   - `C:\Wings\Interop.OposScanner_1_9_Lib.dll`
   - OPOS logical name (typically `ZEBRA_SCANNER`) registered in:
     - `HKLM\SOFTWARE\WOW6432Node\OLEforRetail\ServiceOPOS\SCANNER\ZEBRA_SCANNER`

5. Install/start the bridge task (manual path only; skip if bootstrap used):
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   cd C:\FTDTools\OposBridge
   .\install-opos-bridge-task.ps1 -BridgeScriptPath "C:\FTDTools\OposBridge\opos-scanner-bridge.ps1" -LogicalName "ZEBRA_SCANNER" -Port 17331
   ```

6. Verify bridge health:
   - Open in browser: `http://127.0.0.1:17331/health`
   - Expected JSON includes:
     - `"ok": true`
     - `"scannerStatus": "open"` (idle/unclaimed) or `"ready"` (claimed by active modal)

7. Update Tampermonkey script on that workstation:
   - Use updated script:
     - `mercury-hq-delivery-barcode-lookup\mercury-hq-single-request-barcode.js`
   - Ensure in script config:
     - `oposBridge.enabled: true`
     - `oposBridge.url: 'http://127.0.0.1:17331'`

8. Test end-to-end:
   - Open MercuryHQ page
   - Click `Single Request - Autocomplete`
   - Keep scan modal open
   - Scan with scanner in OPOS mode
   - Modal should auto-populate and trigger lookup

## Operational Notes

- The bridge binds only to `127.0.0.1` (local machine only).
- Scanner ownership is lease-based:
  - bridge opens the OPOS device at startup, but does not hold claim forever
  - Mercury modal acquires a short lease while open, then releases on close/submit/tab change
  - this prevents permanent context theft from other OPOS consumers (for example the fat client)
- Bridge task is configured for reliability:
  - logon trigger
  - restart on failure (1 minute interval, high retry count)
  - ignore new instance if one is already running
  - no execution time limit
  - start-when-available and battery-safe settings
- Bridge runtime hardening:
  - single-instance mutex per port
  - rotating file logs under `C:\ProgramData\FTD\OposBridge\Logs\`
  - Event Viewer logging to `Application` log (source `FTD.OposBridge` when available, safe fallback otherwise)
- If bridge fails but modal is open, manual typing still works.
- If your logical device name differs, pass it during install:
  - `-LogicalName "MOTOROLA_SCANNER"` (or whichever is used locally)
- Why `ExecutionPolicy Bypass` is needed externally:
  - If the machine blocks `.ps1`, PowerShell may refuse to start the script before any internal line runs.
  - A `.cmd` launcher can start PowerShell with `-ExecutionPolicy Bypass`, which avoids that blocker.

## Quick Troubleshooting

1. `scannerStatus` is `error`:
   - Check logical name (`ZEBRA_SCANNER` vs other)
   - Confirm OPOS scanner is installed/registered
   - Confirm scanner is connected in a mode allowed by your OPOS logical device profile
   - Check logs:
     - file log: `C:\ProgramData\FTD\OposBridge\Logs\opos-scanner-bridge.log`
     - Event Viewer: `Applications and Services Logs` / `Windows Logs > Application` (source `FTD.OposBridge` when present)

2. Health works but scans do not arrive:
   - Verify scanner events reach OPOS by testing in OPOS-aware tool
   - Confirm scanner can be claimed by bridge while Mercury modal is open (lease endpoint)
   - If another app currently owns OPOS claim, bridge lease calls will report `claimed: false` until ownership is released

3. Bridge works but modal still does not react:
   - Confirm userscript is latest
   - Confirm `oposBridge.enabled` remains `true`
   - Check browser console logs prefixed with `[MHQ Barcode]`

## Private Winget Packaging

This folder now includes installer packaging for private winget distribution:

- `installer\FTD.OposBridge.iss` (Inno Setup project)
- `uninstall-opos-bridge-task.ps1` (cleanup called during uninstall)
- `tools\build-installer.ps1` (local/CI build helper)
- `tools\new-winget-manifests.ps1` (manifest generator)
- `.github\workflows\opos-bridge-release.yml` (build + release artifacts)

### Local Build

```powershell
cd .\opos-browser-bridge
.\tools\build-installer.ps1 -Version "1.0.0" -Publisher "FTD" -PublisherUrl "https://github.com/<org>/ftd-mercury-tools"
```

Installer output:
- `opos-browser-bridge\dist\FTD.OposBridge.Setup.1.0.0.exe`

### Silent Install / Uninstall

Silent install example:

```powershell
FTD.OposBridge.Setup.1.0.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOGICALNAME=ZEBRA_SCANNER /PORT=17331 /TASKNAME="FTD OPOS Scanner Bridge"
```

Recommended uninstall command:

```powershell
winget uninstall --id FTD.OposBridge -s ftd-mercury-tools -e
```

### GitHub Workflow

Workflow file:
- `.github\workflows\opos-bridge-release.yml`

What it does:
1. Builds versioned installer on tag `opos-bridge-v*` (or manual dispatch)
2. Computes SHA256
3. Generates winget manifests
4. Creates/updates a GitHub release with installer and manifest zip

No extra secrets or repo variables are required for this workflow.

## Service Migration (Phase 1)

A .NET service prototype now exists under:

- `opos-browser-bridge\service\FTD.OposBridge.Service\`

It includes:

1. API-compatible endpoints used by the userscript
2. Lease/owner scan-delivery logic matching current bridge semantics
3. OPOS scanner spike mode (`--scanner-spike`) for open/claim/read validation
4. Mock scanner mode (`--scanner-mode=mock`) for local contract testing

See:

- `opos-browser-bridge\service\README.md`
- `opos-browser-bridge\service\install-opos-bridge-service.ps1`
- `.github\workflows\opos-bridge-service.yml`
