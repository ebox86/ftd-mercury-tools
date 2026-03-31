# Mercury Job Workflow API Cheatsheet

Use this as the operational contract for a live job workflow dashboard (incoming -> designed -> routed -> delivered/exception).

## Core APIs

1. `Dashboard.GetDashboardEventsNow`
2. `OrderEntry.TicketSearch`
3. `OrderEntry.GetTicketStatus(ticketID)`
4. `Delivery.LoadOrderDetails(ticketID)`
5. `OrderLifeCycle.OLCGetByTicket(TicketID)`
6. `Delivery.LoadOrderByZonesAndRoutes(...)`

## Additional APIs

1. `Dashboard.GetDashboardEnabled`
2. `Framework.GetServerTime`
3. `Delivery.LoadZoneSummary(date, thrudate, priorityIDList, designedOnly)`
4. `Delivery.LoadInProgressRouteSummary(date, thrudate)`
5. `Delivery.LoadFailedDelivery()`
6. `Delivery.LoadOrderByZone(deliveryDate, deliveryThruDate, designedOrders, priorityIDList)`
7. `Delivery.LoadOrderByRoutes(deliveryDate, deliveryThruDate)`
8. `Message.GetMessageList(...)`
9. `OrderLifeCycle.OLCGetBySERVICE_MSG_NUM(SERVICE_MSG_NUM)`

## Live JSON Bridge Endpoints

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

## Example Calls

```powershell
Invoke-WebRequest 'http://127.0.0.1:17344/api/workflow/tickets/search?fromDate=2026-03-31T00:00:00&toDate=2026-04-01T00:00:00&notDelivered=true'
Invoke-WebRequest 'http://127.0.0.1:17344/api/workflow/delivery/orders-by-zone?deliveryDate=2026-03-31T00:00:00&deliveryThruDate=2026-04-01T00:00:00'
Invoke-WebRequest 'http://127.0.0.1:17344/api/workflow/messages/list?wireService=1&storeID=1&maxRows=25'
```

## Reference Files

- `reference/job-workflow-api-focus.json`
- `reference/frontend-types.ts`
- `reference/dashboard-service-contract.json`
