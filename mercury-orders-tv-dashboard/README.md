# Talaria

A live Mercury order dashboard for TV/kiosk operations (design + delivery tracking).

![Talaria Dashboard Screenshot](../public/dashboard.png)

## Key Components

- `kiosk-app/` React dashboard UI
- `workflow-bridge/server.mjs` live SOAP-to-JSON bridge
- `reference/` Mercury API maps and schema notes
- `start-live-mvp.*` launchers for direct API mode or SOAP bridge mode
- `start-mvp.*` launchers for local SOAP bridge + kiosk app

## Local Dev / Poking Around (isolated from any live install)

```powershell
npm run dev
```

Runs `tools/dev.mjs`, which starts a throwaway bridge + kiosk app on their own ports (`18344`/`5180` by default, override with `DEV_BRIDGE_PORT`/`DEV_KIOSK_PORT`) against a separate `.dev-data/` directory — so any test devices or admin password changes you make while poking around never touch a real install's `artifacts/tooling-local/` (device-tokens.json, admin-auth.json, dashboard config), even when run from the same checkout as one. Ctrl+C stops both. Prints the URLs (including `/admin`) on startup.

This never starts, stops, or otherwise touches an installed/live `Talaria Bridge` or `Talaria Web` service — those only change via a proper release + reinstall.

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

## Device Pairing

Every TV/kiosk can carry its own pairing token instead of every browser on the network being able to hit the bridge with equal access — useful when the volume of polling from the live dashboard would otherwise let a stray browser tab overload the API.

**How it works:**

- The bridge keeps a device registry at `mercury-orders-tv-dashboard/artifacts/tooling-local/device-tokens.json` (gitignored). It starts empty, and the bridge is fully open — exactly like before this feature existed — until you create the first device.
- The moment a device exists, every request (dashboard data, Settings save, everything) requires a valid `X-Device-Token` header or `?deviceToken=` query param matching an *enabled* device. This stays true even if every device is later revoked — revoking your last screen locks the bridge down rather than reopening it. The only way back to a fully open bridge is deleting every device record (via the trash icon, or by wiping `device-tokens.json` and restarting the service).
- Each device's pairing code is a 4-digit number (e.g. `4821`), chosen to be easy to type on a TV or kiosk. Wrong-code attempts are rate-limited per IP (30 per 5 minutes) specifically because a 4-digit space is small enough to brute-force otherwise — combined with the LAN-only restriction below, that keeps guessing impractical without making it a real security boundary. Don't expose this bridge to the open internet.
- Manage devices either from **Settings → Paired Devices** in the dashboard itself, or from the standalone admin page at `/admin` (see below) — both talk to the same registry. Adding a device shows its one-time pairing code once; copy it before dismissing the banner.
- On a new/unpaired screen, the dashboard shows a "Pair this TV" lock screen instead of the normal UI. Enter the code there; it's stored in that browser's `localStorage` and sent on every request from then on. You can also pre-seed it via `?deviceToken=4821` in the URL on first load (handy for kiosk provisioning scripts/shortcuts, since it means never typing a code on the TV itself).
- Revoking a device (toggle in the table) immediately kicks that screen back to the lock screen on its next request/poll. Deleting removes the record entirely; re-adding a device with the same label issues a brand-new code.
- `MERCURY_API_KEY` — an optional shared master key (checked via `X-Mercury-Key`/`X-API-Key` header or `?key=`) that bypasses per-device checks entirely, handy for curl/admin scripts. Takes priority over device tokens if both are configured.

**Recovery note:** the registry is cached in memory for performance, so hand-editing `device-tokens.json` directly (e.g. to recover from a full lockout) requires restarting the `Talaria Bridge` service before the change takes effect. Changes made through the Settings UI or `/admin` take effect immediately — and since `/admin` login works independently of device pairing, it's also the easiest way to recover from a full device lockout without touching the filesystem.

## Admin UI (`/admin`)

A minimal, dependency-free login page served directly by the bridge (no build step) at `http://<server-name-or-ip>:17344/admin` (or through the web service's proxy, if you have one). It's for managing paired devices without needing access to a TV's Settings panel.

- **Default login:** username `admin`, password `flowers`. You're forced to set a new password the first time you log in — there's no way to skip this.
- Credentials are stored (scrypt-hashed, never plaintext) at `artifacts/tooling-local/admin-auth.json`. Sessions are in-memory cookies (12-hour expiry) and don't survive a service restart.
- Login attempts are rate-limited per IP (10 per 5 minutes).
- Once logged in, it shows the same paired-device list, add/revoke/rename/delete controls as the in-dashboard Settings panel, plus a "Change password" link.
- If you ever get fully locked out (e.g. forgot the password after changing it), delete `artifacts/tooling-local/admin-auth.json` and restart the service — it regenerates the default `admin` / `flowers` account on next boot.

## Windows Installer + Service

The repository includes a release workflow that builds a Windows installer and configures auto-start services using a compiled `.NET` Windows service host executable (no PowerShell required for installer setup):

- Workflow: `.github/workflows/mercury-dashboard-release.yml`
- Installer output: `mercury-orders-tv-dashboard/dist/Talaria.Setup.<version>.exe`
- Services created by installer:
  - `Talaria Bridge` (default port `17344`)
  - `Talaria Web` (default port `5173`)
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
