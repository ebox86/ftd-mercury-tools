# Workflow Bridge (Live Mercury)

Live Node bridge exposing JSON endpoints for the kiosk dashboard while sourcing data from Mercury SOAP services.

## Required Environment

```bash
MERCURY_BASE_URL=http://127.0.0.1/WsMercuryWebAPI
MERCURY_SOAP_NAMESPACE=http://localhost/webservices/
MERCURY_TIMEOUT_MS=12000
```

## Run

```bash
cd pi-kiosk-dashboard-starter/workflow-bridge
npm start
```

Default port: `17344`

## Workflow JSON Endpoints

- `GET /health`
- `GET /api/workflow/focus`
- `GET /api/workflow/dashboard/enabled`
- `GET /api/workflow/framework/server-time`
- `GET /api/workflow/events-now`
- `GET /api/workflow/undelivered-orders`
- `GET /api/workflow/tickets/search?fromDate=&toDate=&notDelivered=&includeDelivered=&recipientName=&customerName=&city=&zone=&orderNumber=`
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
