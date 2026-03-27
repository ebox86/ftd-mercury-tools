# Mercury Job Workflow API Cheatsheet

Use this as the minimum contract for a job workflow dashboard (incoming -> designed -> routed -> delivered/exception).

## Core APIs (Build Around These)

1. `Dashboard.GetDashboardEventsNow`
   - Path: `/WsMercuryWebAPI/dashboard.asmx/GetDashboardEventsNow`
   - Params: none
   - Use: board-level counters + `OrderItems` + `DeliveryZones`
2. `Dashboard.GetUndeliveredOrders`
   - Path: `/WsMercuryWebAPI/dashboard.asmx/GetUndeliveredOrders`
   - Params: none
   - Use: exception queue
3. `OrderEntry.GetTicketStatus`
   - Path: `/WsMercuryWebAPI/orderentry.asmx/GetTicketStatus`
   - Params: `ticketID`
   - Use: ticket stage + designer/driver/route fields
4. `Delivery.LoadOrderDetails`
   - Path: `/WsMercuryWebAPI/delivery.asmx/LoadOrderDetails`
   - Params: `ticketID`
   - Use: job details panel
5. `OrderLifeCycle.OLCGetByTicket`
   - Path: `/WsMercuryWebAPI/orderlifecycle.asmx/OLCGetByTicket`
   - Params: `TicketID`
   - Use: full timeline/event history for one job

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

## Stage Mapping Guidance

- `incoming`: `MessageItems` and early lifecycle entries (`STATUS_CD=NEW`)
- `queued_not_designed`: `DesignerStatus=Not Assigned` or `DeliveryZones.NOT_DESIGNED`
- `designed`: `DesignerStatus=Designed` or `DeliveryZones.DESIGNED`
- `saved_or_staged`: `DeliveryZones.SAVED`
- `on_truck`: `DeliveryRoute` present or `DeliveryZones.ON_TRUCK`
- `delivered_or_exception`: delivered lifecycle/status or undelivered order bucket

## JSON Mock Endpoints (for frontend dev)

- `GET /api/workflow/events-now`
- `GET /api/workflow/undelivered-orders`
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

## Example Calls

```powershell
Invoke-WebRequest 'http://127.0.0.1:17344/api/workflow/events-now'
Invoke-WebRequest 'http://127.0.0.1:17344/api/workflow/delivery/zone-summary?date=2026-03-27T00:00:00&thrudate=2026-03-28T00:00:00&priorityIDList=1,2&designedOnly=true'
Invoke-WebRequest 'http://127.0.0.1:17344/api/workflow/messages/list?wireService=1&storeID=1&maxRows=25'
Invoke-WebRequest 'http://127.0.0.1:17344/WsMercuryWebAPI/orderlifecycle.asmx/OLCGetBySERVICE_MSG_NUM?SERVICE_MSG_NUM=MSG-470002'
```

## Data Files Backing These Endpoints

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
- `reference/job-workflow-api-focus.json`
- `reference/frontend-types.ts`
