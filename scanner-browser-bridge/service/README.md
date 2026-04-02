# OPOS Bridge Service (Phase 1)

This folder contains **Phase 1** of the migration from PowerShell bridge scripts to a traditional `.exe` implementation.

Scope in this prototype:

1. API-compatible local HTTP bridge endpoints
2. Lease/owner scan delivery model compatible with current userscript contract
3. OPOS scanner spike path (`--scanner-spike`) for open/claim/read validation
4. Mock scanner mode for development (`--scanner-mode=mock`)

## Project

- `FTD.OposBridge.Service/FTD.OposBridge.Service.csproj`
- Target: `net8.0-windows`
- Platform: `x86` (important for common OPOS x86 service objects)

## Endpoints (contract-compatible)

- `GET /`
- `GET /health`
- `GET /diagnostics/startup`
- `GET /scan/latest`
- `GET /scan/next?owner=...`
- `GET /scan/clear`
- `GET /scanner/lease?owner=...&ms=...`
- `GET /scanner/release?owner=...&force=1`
- `GET /scanner/rearm`
- `GET /agent/control?agentId=...&knownCommandId=...&claimed=...`
- `GET /agent/ack?agentId=...&commandId=...&claimed=...`

Prototype-only helper:

- `GET /debug/inject?value=OR369999/1` (only meaningful in `mock` mode)

In split-host mode, agent relay uses strict lease-bound injection (owner + lease token + command id) so stale/off-context scans are rejected.

## Run (development)

Recommended (no machine runtime dependency):

```powershell
cd .\scanner-browser-bridge\service\FTD.OposBridge.Service
dotnet publish -c Release -r win-x86 --self-contained true -o ..\artifacts\win-x86-self-contained
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --scanner-mode=mock --port=17331
```

`dotnet run` is also supported, but requires x86 .NET runtime installed on the workstation:

```powershell
cd .\scanner-browser-bridge\service\FTD.OposBridge.Service
dotnet run -- --scanner-mode=mock --port=17331
```

Then inject a scan for contract smoke testing:

```powershell
Invoke-RestMethod "http://127.0.0.1:17331/debug/inject?value=OR369999/1"
Invoke-RestMethod "http://127.0.0.1:17331/scanner/lease?owner=dev-modal&ms=6000"
Invoke-RestMethod "http://127.0.0.1:17331/scan/next?owner=dev-modal"
```

## OPOS scanner spike

Use this mode to validate claim/read behavior without running full HTTP host loop:

```powershell
cd .\scanner-browser-bridge\service\FTD.OposBridge.Service
dotnet run -- --scanner-spike --scanner-mode=opos --logical-name=ZEBRA_SCANNER
```

Optional args:

- `--interop-dll-path=C:\Wings\Interop.OposScanner_1_9_Lib.dll`
- `--claim-timeout-ms=3000`
- `--log-level=information` (`trace|debug|information|warning|error|critical|none`)
- `--spike-timeout-seconds=20`
- `--log-directory=C:\ProgramData\FTD\OposBridge\Logs`
- `--disable-event-log`

## Windows Service mode (prototype)

Windows Service hosting is enabled in this prototype (`UseWindowsService`); the same `.exe` can run interactively or as a service.

Direct `.exe` service registration (Admin PowerShell):

```powershell
cd .\scanner-browser-bridge\service\FTD.OposBridge.Service
dotnet publish -c Release -r win-x86 --self-contained true -o ..\artifacts\win-x86-self-contained
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-install --service-name=FTD.OposBridge.Service --port=17331 --logical-name=ZEBRA_SCANNER --scanner-mode=opos
```

Optional service install args:

- `--service-account=localservice|networkservice|localsystem|current-user|<domain\user>`
- `--service-password=<password>` (required for `current-user` or named user)
- `--service-restart-delay-ms=60000` (restart-on-failure delay, default 60s)

Direct service control:

```powershell
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-status --service-name=FTD.OposBridge.Service --port=17331
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-restart --service-name=FTD.OposBridge.Service
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-uninstall --service-name=FTD.OposBridge.Service
```

Optional convenience wrapper script:

```powershell
cd .\scanner-browser-bridge\service
.\install-opos-bridge-service.ps1 -Action install -LogicalName ZEBRA_SCANNER -Port 17331 -LogLevel warning
```

One-shot migration from script bridge to EXE service:

```powershell
cd .\scanner-browser-bridge\service
.\migrate-script-bridge-to-service.ps1 -LogicalName ZEBRA_SCANNER -Port 17331 -LogLevel warning
```

If OPOS vendor COM is unstable in Windows Service/session-0 context on a workstation, enable automatic fallback to an EXE interactive scheduled task host:

```powershell
cd .\scanner-browser-bridge\service
.\migrate-script-bridge-to-service.ps1 -LogicalName ZEBRA_SCANNER -Port 17331 -EnableTaskFallback -LogLevel warning
```

Recommended split-host architecture (future-product path):

1. Windows Service runs API coordinator in `mock` mode (stable in session-0).
2. User-session EXE runs OPOS `--agent-relay` mode and relays scans into the API.

One-shot migration for split-host:

```powershell
cd .\scanner-browser-bridge\service
.\migrate-script-bridge-to-service.ps1 -LogicalName ZEBRA_SCANNER -Port 17331 -UseAgentRelayHost -LogLevel warning
```

What migration does:

1. stops legacy scheduled task (`FTD OPOS Scanner Bridge`)
2. removes legacy scheduled task (unless `-KeepLegacyTask`)
3. stops any running `opos-scanner-bridge.ps1` process
4. installs/starts EXE service via `install-opos-bridge-service.ps1`
5. optional: if service mode fails and `-EnableTaskFallback` is set, installs/starts EXE scheduled task host via `install-opos-bridge-task.ps1`
6. optional: if `-UseAgentRelayHost` is set, service installs in `mock` mode and an EXE user-session `agent-relay` task is installed for OPOS ownership

## Agent Relay Mode

Run manually for validation:

```powershell
C:\FTDTools\OposBridgeService\FTD.OposBridge.Service.exe --agent-relay --logical-name=ZEBRA_SCANNER --bridge-base-url=http://127.0.0.1:17331 --scanner-mode=opos
```

The wrapper script will:

1. publish win-x86 self-contained binaries to `C:\FTDTools\OposBridgeService` (unless `-SkipPublish`)
2. create or update service `FTD.OposBridge.Service` (equivalent to `--service-install`)
3. set service identity and recovery policy
4. start service and verify `http://127.0.0.1:<port>/health`

Secure account selection in wrapper script:

```powershell
cd .\scanner-browser-bridge\service
.\install-opos-bridge-service.ps1 `
  -Action install `
  -ServiceAccount current-user `
  -PromptForCredential `
  -LogicalName ZEBRA_SCANNER `
  -Port 17331
```

Manual `sc.exe` example (if needed):

```powershell
$svcName = "FTD.OposBridge.Service"
$exe = "C:\FTDTools\OposBridgeService\FTD.OposBridge.Service.exe"
sc.exe create $svcName binPath= "\"$exe\" --port=17331 --logical-name=ZEBRA_SCANNER" start= auto
sc.exe start $svcName
```

Update/cleanup:

```powershell
cd .\scanner-browser-bridge\service
.\install-opos-bridge-service.ps1 -Action status -Port 17331
.\install-opos-bridge-service.ps1 -Action uninstall -RemoveInstallRoot
```

## GitHub Actions (service CI)

Workflow:

- `.github/workflows/scanner-browser-bridge-service.yml`

It runs on changes to `scanner-browser-bridge/service/**` and does:

1. restore + build (`Release`)
2. publish `win-x86` self-contained artifact
3. run mock API smoke test (`lease -> inject -> next -> clear -> release`)
4. upload artifact `scanner-browser-bridge-service-win-x86-self-contained`
5. pack NuGet package (`FTD.OposBridge.Service`) with CI version
6. publish package to GitHub Packages NuGet feed (`https://nuget.pkg.github.com/<owner>/index.json`) on non-PR events

## Live Hardware Regression

Manual hardware acceptance runner:

```powershell
cd .\scanner-browser-bridge\service
.\run-live-hardware-regression.ps1 -BaseUrl "http://127.0.0.1:17331" -Owner "regression-modal" -ScanCount 10
```

What it verifies:

1. 10 sequential browser-modal scans are delivered with timing capture
2. Mercury fat-client context scan does not leak into modal owner stream
3. return-from-context browser scan is accepted without requiring a second scan

## Notes

1. This prototype intentionally does not replace the production PowerShell bridge yet.
2. It uses an STA dispatcher thread for COM calls, which is required for many OPOS stacks.
3. `DataEvent` and `ErrorEvent` COM callbacks are wired in the service; polling remains as fallback hardening.
4. Single-instance lock parity is enforced using mutex name `Global\FTD.OposBridge.Port<port>` (with `Local\` fallback).
5. HTTP CORS parity is enabled (`Access-Control-Allow-Origin: *`) to match browser fallback behavior.
6. Structured JSON log events include `owner`, `seq`, `source`, and delivery `latencyMs` fields for troubleshooting.

