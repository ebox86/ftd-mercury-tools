# Pi Kiosk Dashboard Starter (Live Mercury)

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
