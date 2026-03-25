# OPOS Bridge Service Prototype (Phase 1)

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
- `GET /scan/latest`
- `GET /scan/next?owner=...`
- `GET /scan/clear`
- `GET /scanner/lease?owner=...&ms=...`
- `GET /scanner/release?owner=...&force=1`
- `GET /scanner/rearm`

Prototype-only helper:

- `GET /debug/inject?value=OR369999/1` (only meaningful in `mock` mode)

## Run (development)

Recommended (no machine runtime dependency):

```powershell
cd .\opos-browser-bridge\service-prototype\FTD.OposBridge.Service
dotnet publish -c Release -r win-x86 --self-contained true -o ..\artifacts\win-x86-self-contained
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --scanner-mode=mock --port=17331
```

`dotnet run` is also supported, but requires x86 .NET runtime installed on the workstation:

```powershell
cd .\opos-browser-bridge\service-prototype\FTD.OposBridge.Service
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
cd .\opos-browser-bridge\service-prototype\FTD.OposBridge.Service
dotnet run -- --scanner-spike --scanner-mode=opos --logical-name=ZEBRA_SCANNER
```

Optional args:

- `--interop-dll-path=C:\Wings\Interop.OposScanner_1_9_Lib.dll`
- `--claim-timeout-ms=3000`
- `--spike-timeout-seconds=20`
- `--log-directory=C:\ProgramData\FTD\OposBridge\Logs`
- `--disable-event-log`

## Windows Service mode (prototype)

Windows Service hosting is enabled in this prototype (`UseWindowsService`); the same `.exe` can run interactively or as a service.

Direct `.exe` service registration (Admin PowerShell):

```powershell
cd .\opos-browser-bridge\service-prototype\FTD.OposBridge.Service
dotnet publish -c Release -r win-x86 --self-contained true -o ..\artifacts\win-x86-self-contained
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-install --service-name=FTD.OposBridge.Prototype --port=17331 --logical-name=ZEBRA_SCANNER --scanner-mode=opos
```

Direct service control:

```powershell
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-status --service-name=FTD.OposBridge.Prototype --port=17331
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-restart --service-name=FTD.OposBridge.Prototype
..\artifacts\win-x86-self-contained\FTD.OposBridge.Service.exe --service-uninstall --service-name=FTD.OposBridge.Prototype
```

Optional convenience wrapper script:

```powershell
cd .\opos-browser-bridge\service-prototype
.\install-opos-bridge-prototype-service.ps1 -Action install -LogicalName ZEBRA_SCANNER -Port 17331
```

The wrapper script will:

1. publish win-x86 self-contained binaries to `C:\FTDTools\OposBridgePrototype` (unless `-SkipPublish`)
2. create or update service `FTD.OposBridge.Prototype` (equivalent to `--service-install`)
3. start service and verify `http://127.0.0.1:<port>/health`

Manual `sc.exe` example (if needed):

```powershell
$svcName = "FTD.OposBridge.Prototype"
$exe = "C:\FTDTools\OposBridgePrototype\FTD.OposBridge.Service.exe"
sc.exe create $svcName binPath= "\"$exe\" --port=17331 --logical-name=ZEBRA_SCANNER" start= auto
sc.exe start $svcName
```

Update/cleanup:

```powershell
cd .\opos-browser-bridge\service-prototype
.\install-opos-bridge-prototype-service.ps1 -Action status -Port 17331
.\install-opos-bridge-prototype-service.ps1 -Action uninstall -RemoveInstallRoot
```

## GitHub Actions (prototype CI)

Workflow:

- `.github/workflows/opos-bridge-service-prototype.yml`

It runs on changes to `opos-browser-bridge/service-prototype/**` and does:

1. restore + build (`Release`)
2. publish `win-x86` self-contained artifact
3. run mock API smoke test (`lease -> inject -> next -> clear -> release`)
4. upload artifact `ftd-opos-bridge-service-prototype-win-x86-self-contained`
5. pack NuGet package (`FTD.OposBridge.Service`) with CI version
6. publish package to GitHub Packages NuGet feed (`https://nuget.pkg.github.com/<owner>/index.json`) on non-PR events

## Notes

1. This prototype intentionally does not replace the production PowerShell bridge yet.
2. It uses an STA dispatcher thread for COM calls, which is required for many OPOS stacks.
3. `DataEvent` and `ErrorEvent` COM callbacks are wired in the service; polling remains as fallback hardening.
