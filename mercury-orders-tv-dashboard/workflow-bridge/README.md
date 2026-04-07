# Workflow Bridge (Live Mercury)

Live Node bridge exposing JSON endpoints for the kiosk dashboard while sourcing data from Mercury SOAP services.

## Required Environment

```bash
MERCURY_BASE_URL=http://127.0.0.1/WsMercuryWebAPI
MERCURY_SOAP_NAMESPACE=http://localhost/webservices/
MERCURY_TIMEOUT_MS=12000
MAPBOX_TOKEN=pk_xxx_or_sk_xxx
```

Optional distance-related settings:

```bash
MAPBOX_DIRECTIONS_PROFILE=driving
MAPBOX_TIMEOUT_MS=8000
MAPBOX_ROUTE_CACHE_TTL_MS=21600000
MAPBOX_ADDRESS_CACHE_TTL_MS=21600000
MAPBOX_FALLBACK_TO_HAVERSINE=true
```

## Run

```bash
cd mercury-orders-tv-dashboard/workflow-bridge
npm start
```

Default port: `17344`

## Local Network Access Policy

By default, the bridge now allows only localhost + private LAN ranges (`10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, and local IPv6 ranges).  
This keeps the board easy to access from other machines on your local network while blocking non-LAN clients.

Optional environment variables:

- `BRIDGE_HOST` (default: `0.0.0.0`)
- `MERCURY_LOCAL_NETWORK_ONLY` (default: `true`)
- `MERCURY_TRUST_PROXY_HEADERS` (default: `false`)
- `MERCURY_API_KEY` (default: empty; when set, send key in `X-Mercury-Key`, `X-API-Key`, or `?key=...`)

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
- `GET /api/workflow/distance/estimate?ticketId=&addressLine1=&city=&state=&postalCode=&country=&latitude=&longitude=`
- `GET /api/workflow/order-lifecycle/:ticketId`
- `GET /api/workflow/order-lifecycle/by-service-msg/:serviceMsgNum`
- `GET /api/workflow/delivery/zone-summary?date=&thrudate=&priorityIDList=&designedOnly=`
- `GET /api/workflow/delivery/in-progress-route-summary?date=&thrudate=`
- `GET /api/workflow/delivery/failed-delivery?date=&thrudate=`
- `GET /api/workflow/delivery/orders-by-zone?deliveryDate=&deliveryThruDate=&designedOrders=&priorityIDList=`
- `GET /api/workflow/delivery/orders-by-routes?deliveryDate=&deliveryThruDate=`
- `GET /api/workflow/messages/list?wireService=&storeID=&msgType=&msgDirection=&delivDate=&msgDate=&memberCode=&ticketNum=&recipientName=&mercuryNum=&maxRows=&msgID=`
