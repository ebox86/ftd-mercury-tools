# OPOS Browser Bridge (MercuryHQ Modal)

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
   - copies `opos-scanner-bridge.ps1` and `install-opos-bridge-task.ps1`
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
     - `"scannerStatus": "ready"`

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

2. Health works but scans do not arrive:
   - Verify scanner events reach OPOS by testing in OPOS-aware tool
   - Confirm scanner can still be claimed by bridge and not blocked by another app policy

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
