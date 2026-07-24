# Mercury Orders TV Dashboard

This folder contains a live Mercury dashboard setup for kiosk operations (design + delivery tracking).

![Mercury Kiosk Dashboard Screenshot](../public/dashboard.png)

## Key Components

- `kiosk-app/` React dashboard UI
- `workflow-bridge/server.mjs` live SOAP-to-JSON bridge
- `reference/` Mercury API maps and schema notes
- `start-live-mvp.*` launchers for direct API mode or SOAP bridge mode
- `start-mvp.*` launchers for local SOAP bridge + kiosk app

## Start (Preferred)

Use one of these inputs:

1. `WORKFLOW_API_BASE_URL` if you already have a JSON `/api/workflow/*` host
2. `MERCURY_BASE_URL` if you want the local bridge to call Mercury SOAP directly

```powershell
$env:MERCURY_BASE_URL='http://localhost/WsMercuryWebAPI'
.\start-live-mvp.ps1
```

## Workflow JSON Endpoints

- `GET /health`
- `GET /api/workflow/focus`
- `GET /api/workflow/dashboard/enabled`
- `GET /api/workflow/framework/server-time`
- `GET /api/workflow/events-now`
- `GET /api/workflow/undelivered-orders`
- `GET /api/workflow/tickets/search`
- `GET /api/workflow/ticket-status/:ticketId`
- `GET /api/workflow/order-details/:ticketId`
- `GET /api/workflow/order-lifecycle/:ticketId`
- `GET /api/workflow/order-lifecycle/by-service-msg/:serviceMsgNum`
- `GET /api/workflow/delivery/zone-summary`
- `GET /api/workflow/delivery/in-progress-route-summary`
- `GET /api/workflow/delivery/failed-delivery`
- `GET /api/workflow/delivery/orders-by-zone`
- `GET /api/workflow/delivery/orders-by-routes`
- `GET /api/workflow/messages/list`

## Notes

- The bridge is live-only and intended for real Mercury data.
- Avoid committing raw payloads that contain sensitive customer information.
- On a Mercury SOAP fault, cached endpoints (`events-now`, `undelivered-orders`, etc.) fall back to the last known-good response instead of erroring, so the dashboard doesn't blank out. Check the `X-Mercury-Cache` response header (`STALE-ERROR` means it's serving a fallback) if data looks out of date.

## Ticket Text Guard

Mercury's `GetDashboardEventsNow` throws a SQL truncation fault (breaking this bridge's `events-now`/`events` endpoints *and* Mercury's own mobile app sync) when an active ticket's `DELIVERY_INST` or `SPECIAL_INST` grows past whatever fixed-width buffer its internal dashboard proc uses, even though the underlying columns are unbounded. See incident 2026-07-23 (ticket 386446 / order 380186, `SPECIAL_INST` at 1054 chars).

The bridge now runs a periodic guard (via `sqlcmd.exe`, Windows-authenticated) that finds active tickets crossing a safe length, logs the original text to `%PROGRAMDATA%\FTD\MercuryDashboardBridge\ticket-text-guard-audit.log`, then trims the field before it can trip the dashboard query.

Environment variables:

- `MERCURY_TICKET_GUARD_ENABLED` — set to `0` to disable (default on)
- `MERCURY_TICKET_GUARD_INTERVAL_MS` — check interval, default `300000` (5 min)
- `MERCURY_TICKET_TEXT_MAX_LEN` — trigger threshold, default `850`
- `MERCURY_TICKET_TEXT_TRUNCATE_LEN` — length to trim to, default `700`
- `MERCURY_SQL_SERVER` / `MERCURY_SQL_DATABASE` — default `localhost` / `store`
- `MERCURY_SQLCMD_PATH` — override if `sqlcmd.exe` isn't in one of the default SQL Server Client SDK locations

## Windows Installer + Service

The repository includes a release workflow that builds a Windows installer and configures auto-start services using a compiled `.NET` Windows service host executable (no PowerShell required for installer setup):

- Workflow: `.github/workflows/mercury-dashboard-release.yml`
- Installer output: `mercury-orders-tv-dashboard/dist/FTD.MercuryDashboard.Setup.<version>.exe`
- Services created by installer:
  - `FTD Mercury Workflow Bridge` (default port `17344`)
  - `FTD Mercury Dashboard Web` (default port `5173`)
- Service host executable installed at: `service-runtime/FTD.Mercury.Dashboard.ServiceHost.exe`

Optional installer switches:

- `/MERCURYBASE=http://127.0.0.1/WsMercuryWebAPI`
- `/SOAPNAMESPACE=http://localhost/webservices/`
- `/BRIDGEPORT=17344`
- `/WEBPORT=5173`
- `/BRIDGEHOST=0.0.0.0`
- `/WEBHOST=0.0.0.0`
- `/LOCALNETWORKONLY=true`
- `/MAPBOXTOKEN=<mapbox-token>`

`/MAPBOXTOKEN` is optional and only used by the workflow-bridge service.  
During service installation, the token is protected and persisted as encrypted service configuration (not plain text).

Release builds read Mapbox from `MAPBOX_TOKEN` first, then `MAPBOX_ACCESS_TOKEN`, using either GitHub secrets or repository/environment variables. The release workflow and local `tools/build-installer.ps1` validate that the token can use Mapbox v6 forward geocoding and Static Images before compiling the setup exe.

When the generated installer installs the web service on `0.0.0.0`, it creates a Windows Firewall inbound TCP rule for the web port. Other machines should open `http://<server-name-or-ip>:5173`; the web service proxies `/api/*` to the local workflow bridge on the server. To verify Mapbox after install, open `http://<server-name-or-ip>:5173/api/workflow/mapbox/diagnostics` and confirm `geocoding.ok` and `staticMap.ok` are both `true`.

Optional PowerShell wrappers are still available under `service/` for manual admin tooling, but they now call the same compiled service host executable.
