# Pi Kiosk Dashboard Starter (Workflow API Focus)

This folder is a workflow-focused starter pack for building a Raspberry Pi kiosk dashboard that tracks Mercury jobs from incoming to delivered/exception.

## Workflow API Scope (MVP)

1. `Dashboard.GetDashboardEventsNow`
2. `Dashboard.GetUndeliveredOrders`
3. `OrderEntry.GetTicketStatus(ticketID)`
4. `Delivery.LoadOrderDetails(ticketID)`
5. `OrderLifeCycle.OLCGetByTicket(TicketID)`

## Nice-To-Have APIs (Scaffolded)

1. `Dashboard.GetDashboardEnabled`
2. `Framework.GetServerTime`
3. `Delivery.LoadZoneSummary(date, thrudate, priorityIDList, designedOnly)`
4. `Delivery.LoadInProgressRouteSummary(date, thrudate)`
5. `Delivery.LoadFailedDelivery()`
6. `Delivery.LoadOrderByZone(deliveryDate, deliveryThruDate, designedOrders, priorityIDList)`
7. `Delivery.LoadOrderByRoutes(deliveryDate, deliveryThruDate)`
8. `Message.GetMessageList(...)`
9. `OrderLifeCycle.OLCGetBySERVICE_MSG_NUM(SERVICE_MSG_NUM)`

## Key Files

- `reference/job-workflow-api-focus.json`
- `reference/job-workflow-api-cheatsheet.md`
- `reference/frontend-types.ts`
- `mock-data/dashboard-events-bogus.json`
- `mock-data/ticket-status-bogus.json`
- `mock-data/order-details-bogus.json`
- `mock-data/order-lifecycle-bogus.json`
- `mock-data/delivery-zone-summary-bogus.json`
- `mock-data/delivery-in-progress-route-summary-bogus.json`
- `mock-data/delivery-failed-delivery-bogus.json`
- `mock-data/delivery-orders-by-zone-bogus.json`
- `mock-data/delivery-orders-by-routes-bogus.json`
- `mock-data/message-list-bogus.json`
- `mock-server/server.mjs`

## Run The Local Mock Server

```bash
cd pi-kiosk-dashboard-starter/mock-server
npm start
```

Default port: `17344`

## Workflow JSON Endpoints

1. `GET /api/workflow/focus`
2. `GET /api/workflow/dashboard/enabled`
3. `GET /api/workflow/framework/server-time`
4. `GET /api/workflow/events-now`
5. `GET /api/workflow/undelivered-orders`
6. `GET /api/workflow/ticket-status/:ticketId`
7. `GET /api/workflow/order-details/:ticketId`
8. `GET /api/workflow/order-lifecycle/:ticketId`
9. `GET /api/workflow/order-lifecycle/by-service-msg/:serviceMsgNum`
10. `GET /api/workflow/delivery/zone-summary`
11. `GET /api/workflow/delivery/in-progress-route-summary`
12. `GET /api/workflow/delivery/failed-delivery`
13. `GET /api/workflow/delivery/orders-by-zone`
14. `GET /api/workflow/delivery/orders-by-routes`
15. `GET /api/workflow/messages/list`

## Mercury-like XML Endpoints

1. `POST /WsMercuryWebAPI/dashboard.asmx/GetDashboardEventsNow`
2. `POST /WsMercuryWebAPI/dashboard.asmx/GetUndeliveredOrders`
3. `POST /WsMercuryWebAPI/dashboard.asmx/GetDashboardEnabled`
4. `POST /WsMercuryWebAPI/framework.asmx/GetServerTime`
5. `POST /WsMercuryWebAPI/orderentry.asmx/GetTicketStatus`
6. `POST /WsMercuryWebAPI/delivery.asmx/LoadOrderDetails`
7. `POST /WsMercuryWebAPI/delivery.asmx/LoadZoneSummary`
8. `POST /WsMercuryWebAPI/delivery.asmx/LoadInProgressRouteSummary`
9. `POST /WsMercuryWebAPI/delivery.asmx/LoadFailedDelivery`
10. `POST /WsMercuryWebAPI/delivery.asmx/LoadOrderByZone`
11. `POST /WsMercuryWebAPI/delivery.asmx/LoadOrderByRoutes`
12. `POST /WsMercuryWebAPI/message.asmx/GetMessageList`
13. `POST /WsMercuryWebAPI/orderlifecycle.asmx/OLCGetByTicket`
14. `POST /WsMercuryWebAPI/orderlifecycle.asmx/OLCGetBySERVICE_MSG_NUM`

## Suggested Frontend Scaffold (Home)

```bash
npm create vite@latest mercury-kiosk -- --template react-ts
cd mercury-kiosk
npm install
npm run dev -- --host
```

Use the mock files above to seed frontend state, cards, route boards, and timeline views.

## Optional Contract Refresh

If you want to re-snapshot local Mercury service metadata later:

```powershell
cd .\pi-kiosk-dashboard-starter\tools
.\export-wsmercury-dashboard-reference.ps1
```

This regenerates:

- `reference/wsmercury-service-operations.json`
- `reference/dashboard-service-contract.json`

## Notes

- Mock payloads are intentionally bogus/synthetic for safe UI prototyping.
- Live Mercury responses can include sensitive fields; avoid committing raw payload exports.
