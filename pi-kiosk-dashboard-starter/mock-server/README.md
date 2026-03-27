# Mock Server (Workflow APIs)

Dependency-free Node mock server for Mercury job workflow dashboard prototyping.

## Run

```bash
cd pi-kiosk-dashboard-starter/mock-server
npm start
```

Default port: `17344`

Override port:

```bash
PORT=18080 npm start
```

## Workflow JSON Endpoints

- `GET /health`
- `GET /api/workflow/focus`
- `GET /api/workflow/dashboard/enabled`
- `GET /api/workflow/framework/server-time`
- `GET /api/workflow/events-now`
- `GET /api/workflow/events`
- `GET /api/workflow/undelivered-orders`
- `GET /api/workflow/ticket-status/:ticketId`
- `GET /api/workflow/order-details/:ticketId`
- `GET /api/workflow/order-lifecycle/:ticketId`
- `GET /api/workflow/order-lifecycle/by-service-msg/:serviceMsgNum`
- `GET /api/workflow/delivery/zone-summary?date=&thrudate=&priorityIDList=&designedOnly=`
- `GET /api/workflow/delivery/in-progress-route-summary?date=&thrudate=`
- `GET /api/workflow/delivery/failed-delivery?date=&thrudate=`
- `GET /api/workflow/delivery/orders-by-zone?deliveryDate=&deliveryThruDate=&designedOrders=&priorityIDList=`
- `GET /api/workflow/delivery/orders-by-routes?deliveryDate=&deliveryThruDate=`
- `GET /api/workflow/messages/list?wireService=&storeID=&msgType=&msgDirection=&delivDate=&msgDate=&memberCode=&ticketNum=&recipientName=&mercuryNum=&maxRows=&msgID=`

## Mercury-like Endpoints (XML)

- `POST /WsMercuryWebAPI/dashboard.asmx/GetDashboardEventsNow`
- `POST /WsMercuryWebAPI/dashboard.asmx/GetUndeliveredOrders`
- `POST /WsMercuryWebAPI/dashboard.asmx/GetDashboardEnabled`
- `POST /WsMercuryWebAPI/framework.asmx/GetServerTime`
- `POST /WsMercuryWebAPI/orderentry.asmx/GetTicketStatus`
- `POST /WsMercuryWebAPI/delivery.asmx/LoadOrderDetails`
- `POST /WsMercuryWebAPI/delivery.asmx/LoadZoneSummary`
- `POST /WsMercuryWebAPI/delivery.asmx/LoadInProgressRouteSummary`
- `POST /WsMercuryWebAPI/delivery.asmx/LoadFailedDelivery`
- `POST /WsMercuryWebAPI/delivery.asmx/LoadOrderByZone`
- `POST /WsMercuryWebAPI/delivery.asmx/LoadOrderByRoutes`
- `POST /WsMercuryWebAPI/message.asmx/GetMessageList`
- `POST /WsMercuryWebAPI/orderlifecycle.asmx/OLCGetByTicket`
- `POST /WsMercuryWebAPI/orderlifecycle.asmx/OLCGetBySERVICE_MSG_NUM`

For ticket-specific endpoints, pass `ticketID` / `TicketID` in query string or body.

These XML responses are simplified for frontend prototyping and are not full SOAP envelopes.
