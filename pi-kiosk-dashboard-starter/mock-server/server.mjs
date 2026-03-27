import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', 'mock-data');
const refDir = join(__dirname, '..', 'reference');

const dashboardEvents = JSON.parse(readFileSync(join(dataDir, 'dashboard-events-bogus.json'), 'utf8'));
const ticketStatus = JSON.parse(readFileSync(join(dataDir, 'ticket-status-bogus.json'), 'utf8'));
const orderDetails = JSON.parse(readFileSync(join(dataDir, 'order-details-bogus.json'), 'utf8'));
const orderLifecycle = JSON.parse(readFileSync(join(dataDir, 'order-lifecycle-bogus.json'), 'utf8'));
const workflowFocus = JSON.parse(readFileSync(join(refDir, 'job-workflow-api-focus.json'), 'utf8'));
const primitives = JSON.parse(readFileSync(join(dataDir, 'dashboard-primitives-bogus.json'), 'utf8'));

const zoneSummary = JSON.parse(readFileSync(join(dataDir, 'delivery-zone-summary-bogus.json'), 'utf8'));
const inProgressRouteSummary = JSON.parse(
  readFileSync(join(dataDir, 'delivery-in-progress-route-summary-bogus.json'), 'utf8')
);
const failedDelivery = JSON.parse(readFileSync(join(dataDir, 'delivery-failed-delivery-bogus.json'), 'utf8'));
const ordersByZone = JSON.parse(readFileSync(join(dataDir, 'delivery-orders-by-zone-bogus.json'), 'utf8'));
const ordersByRoutes = JSON.parse(readFileSync(join(dataDir, 'delivery-orders-by-routes-bogus.json'), 'utf8'));
const messageList = JSON.parse(readFileSync(join(dataDir, 'message-list-bogus.json'), 'utf8'));

const port = Number(process.env.PORT || 17344);
const xmlNs = 'http://localhost/webservices/';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function datasetToXml(dataset) {
  const lines = [`<?xml version="1.0" encoding="utf-8"?>`, `<${dataset.dataset} xmlns="${xmlNs}">`];

  for (const [tableName, rows] of Object.entries(dataset.tables)) {
    for (const row of rows) {
      lines.push(`  <${tableName}>`);
      for (const [key, value] of Object.entries(row)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }
        lines.push(`    <${key}>${xmlEscape(value)}</${key}>`);
      }
      lines.push(`  </${tableName}>`);
    }
  }

  lines.push(`</${dataset.dataset}>`);
  return lines.join('\n');
}

function boolXml(value) {
  return `<?xml version="1.0" encoding="utf-8"?><boolean xmlns="${xmlNs}">${value ? 'true' : 'false'}</boolean>`;
}

function stringXml(value) {
  return `<?xml version="1.0" encoding="utf-8"?><string xmlns="${xmlNs}">${xmlEscape(value)}</string>`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendXml(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/xml; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

function toSingleTableDataset(data, rows) {
  return {
    dataset: data.dataset,
    tables: {
      [data.table]: rows
    }
  };
}

function parseXmlParam(body, paramName) {
  const match = body.match(new RegExp(`<${paramName}>([^<]+)</${paramName}>`, 'i'));
  if (match && match[1]) {
    return match[1].trim();
  }
  return '';
}

function resolveParam(url, body, names, defaultValue = '') {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null && value !== undefined && value !== '') {
      return value.trim();
    }
  }

  const bodyParams = new URLSearchParams(body || '');
  for (const name of names) {
    const value = bodyParams.get(name);
    if (value !== null && value !== undefined && value !== '') {
      return value.trim();
    }
  }

  for (const name of names) {
    const value = parseXmlParam(body || '', name);
    if (value) {
      return value;
    }
  }

  return defaultValue;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseNumber(value, defaultValue = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function parsePriorityList(priorityIDList) {
  if (!priorityIDList) {
    return [];
  }
  return String(priorityIDList)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function toEpoch(value) {
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

function filterByDateRange(rows, fieldName, startValue, endValue) {
  const startEpoch = toEpoch(startValue);
  const endEpoch = toEpoch(endValue);
  if (startEpoch === null && endEpoch === null) {
    return rows;
  }

  return rows.filter((row) => {
    const rowEpoch = toEpoch(row[fieldName]);
    if (rowEpoch === null) {
      return false;
    }
    if (startEpoch !== null && rowEpoch < startEpoch) {
      return false;
    }
    if (endEpoch !== null && rowEpoch > endEpoch) {
      return false;
    }
    return true;
  });
}

function sameDate(a, b) {
  const aEpoch = toEpoch(a);
  const bEpoch = toEpoch(b);
  if (aEpoch === null || bEpoch === null) {
    return false;
  }

  const aDate = new Date(aEpoch).toISOString().slice(0, 10);
  const bDate = new Date(bEpoch).toISOString().slice(0, 10);
  return aDate === bDate;
}

function includesIgnoreCase(source, part) {
  if (!part) {
    return true;
  }
  return String(source || '').toLowerCase().includes(String(part).toLowerCase());
}

function getDefaultTicketId() {
  return Object.keys(ticketStatus.byTicketId)[0] || '610002';
}

function getDefaultServiceMsgNum() {
  return orderLifecycle.rows[0]?.SERVICE_MSG_NUM || 'MSG-470002';
}

function buildUndeliveredOrdersDataset() {
  return {
    ...dashboardEvents,
    tables: {
      ...dashboardEvents.tables,
      OrderItems: dashboardEvents.tables.OrderItems.filter((row) => row.CATEGORY === '12')
    }
  };
}

function buildTicketStatusDataset(ticketId) {
  const row = ticketStatus.byTicketId[ticketId];
  return {
    dataset: ticketStatus.dataset,
    tables: {
      [ticketStatus.table]: row ? [row] : []
    }
  };
}

function buildOrderDetailsDataset(ticketId) {
  const rows = orderDetails.rows.filter((row) => row.ID === ticketId);
  return toSingleTableDataset(orderDetails, rows);
}

function buildOrderLifecycleByTicketDataset(ticketId) {
  const rows = orderLifecycle.rows.filter((row) => row.TICKET_ID === ticketId);
  return toSingleTableDataset(orderLifecycle, rows);
}

function buildOrderLifecycleByServiceMsgDataset(serviceMsgNum) {
  const target = String(serviceMsgNum || '').toLowerCase();
  const rows = orderLifecycle.rows.filter((row) => String(row.SERVICE_MSG_NUM || '').toLowerCase() === target);
  return toSingleTableDataset(orderLifecycle, rows);
}

function filterZoneSummaryRows(designedOnlyValue, priorityIDListValue) {
  const designedOnly = parseBoolean(designedOnlyValue, false);
  const priorities = parsePriorityList(priorityIDListValue);

  return zoneSummary.rows.filter((row) => {
    if (priorities.length > 0 && !priorities.includes(String(row.PRIORITY_ID))) {
      return false;
    }

    if (designedOnly) {
      const designed = parseNumber(row.DESIGNED, 0);
      const saved = parseNumber(row.SAVED, 0);
      const onTruck = parseNumber(row.ON_TRUCK, 0);
      const delivered = parseNumber(row.DELIVERED, 0);
      if (designed + saved + onTruck + delivered <= 0) {
        return false;
      }
    }

    return true;
  });
}

function filterOrdersByZoneRows(deliveryDate, deliveryThruDate, designedOrdersValue, priorityIDListValue) {
  const designedOnly = parseBoolean(designedOrdersValue, false);
  const priorities = parsePriorityList(priorityIDListValue);

  let rows = filterByDateRange(ordersByZone.rows, 'DELIVERY_DATE', deliveryDate, deliveryThruDate);

  if (priorities.length > 0) {
    rows = rows.filter((row) => priorities.includes(String(row.PRIORITY_ID)));
  }

  if (designedOnly) {
    rows = rows.filter((row) => row.DESIGNED_IND === '1');
  }

  return rows;
}

function filterOrdersByRoutesRows(deliveryDate, deliveryThruDate) {
  return filterByDateRange(ordersByRoutes.rows, 'DELIVERY_DATE', deliveryDate, deliveryThruDate);
}

function filterMessageListRows(filters) {
  let rows = [...messageList.rows];

  const wireService = parseNumber(filters.wireService, 0);
  const storeID = parseNumber(filters.storeID, 0);
  const msgType = parseNumber(filters.msgType, 0);
  const msgDirection = parseNumber(filters.msgDirection, 0);
  const maxRows = parseNumber(filters.maxRows, 50);
  const msgID = parseNumber(filters.msgID, 0);

  if (wireService > 0) {
    rows = rows.filter((row) => parseNumber(row.WIRE_SERVICE, 0) === wireService);
  }
  if (storeID > 0) {
    rows = rows.filter((row) => parseNumber(row.STORE_ID, 0) === storeID);
  }
  if (msgType > 0) {
    rows = rows.filter((row) => parseNumber(row.MSG_TYPE, 0) === msgType);
  }
  if (msgDirection > 0) {
    rows = rows.filter((row) => parseNumber(row.MSG_DIRECTION, 0) === msgDirection);
  }

  if (filters.memberCode) {
    rows = rows.filter((row) => includesIgnoreCase(row.MEMBER_CODE, filters.memberCode));
  }
  if (filters.ticketNum) {
    rows = rows.filter((row) => includesIgnoreCase(row.TICKET_NUM, filters.ticketNum));
  }
  if (filters.recipientName) {
    rows = rows.filter((row) => includesIgnoreCase(row.RECIPIENT_NAME, filters.recipientName));
  }
  if (filters.mercuryNum) {
    rows = rows.filter((row) => includesIgnoreCase(row.MERCURY_NUM, filters.mercuryNum));
  }

  if (filters.msgDate) {
    rows = rows.filter((row) => sameDate(row.MSG_DATE, filters.msgDate));
  }
  if (filters.delivDate) {
    rows = rows.filter((row) => sameDate(row.DELIVERY_DATE, filters.delivDate));
  }

  if (msgID > 0) {
    rows = rows.filter((row) => parseNumber(row.MSG_ID, 0) >= msgID);
  }

  rows.sort((a, b) => parseNumber(b.MSG_ID, 0) - parseNumber(a.MSG_ID, 0));
  return rows.slice(0, Math.max(1, maxRows));
}

function singleTicketStatusJson(ticketId) {
  const row = ticketStatus.byTicketId[ticketId];
  return {
    ...ticketStatus,
    byTicketId: row ? { [ticketId]: row } : {}
  };
}

function singleOrderDetailsJson(ticketId) {
  return {
    ...orderDetails,
    rows: orderDetails.rows.filter((row) => row.ID === ticketId)
  };
}

function singleOrderLifecycleByTicketJson(ticketId) {
  return {
    ...orderLifecycle,
    rows: orderLifecycle.rows.filter((row) => row.TICKET_ID === ticketId)
  };
}

function singleOrderLifecycleByServiceMsgJson(serviceMsgNum) {
  const target = String(serviceMsgNum || '').toLowerCase();
  return {
    ...orderLifecycle,
    rows: orderLifecycle.rows.filter((row) => String(row.SERVICE_MSG_NUM || '').toLowerCase() === target)
  };
}

function routeJson(res, url, pathname) {
  if (pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'pi-kiosk-mercury-workflow-mock-server' });
  }

  if (pathname === '/api/workflow/focus') {
    return sendJson(res, 200, workflowFocus);
  }

  if (pathname === '/api/workflow/enabled' || pathname === '/api/workflow/dashboard/enabled') {
    return sendJson(res, 200, { enabled: primitives.GetDashboardEnabled });
  }

  if (pathname === '/api/workflow/server-time' || pathname === '/api/workflow/framework/server-time') {
    return sendJson(res, 200, { serverTime: new Date().toISOString() });
  }

  if (pathname === '/api/workflow/events-now' || pathname === '/api/workflow/events') {
    return sendJson(res, 200, dashboardEvents);
  }

  if (pathname === '/api/workflow/undelivered-orders') {
    return sendJson(res, 200, buildUndeliveredOrdersDataset());
  }

  if (pathname === '/api/workflow/ticket-status') {
    const ticketId = resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], getDefaultTicketId());
    return sendJson(res, 200, singleTicketStatusJson(ticketId));
  }

  if (pathname.startsWith('/api/workflow/ticket-status/')) {
    const ticketId = decodeURIComponent(pathname.substring('/api/workflow/ticket-status/'.length));
    return sendJson(res, 200, singleTicketStatusJson(ticketId));
  }

  if (pathname === '/api/workflow/order-details') {
    const ticketId = resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], getDefaultTicketId());
    return sendJson(res, 200, singleOrderDetailsJson(ticketId));
  }

  if (pathname.startsWith('/api/workflow/order-details/')) {
    const ticketId = decodeURIComponent(pathname.substring('/api/workflow/order-details/'.length));
    return sendJson(res, 200, singleOrderDetailsJson(ticketId));
  }

  if (pathname === '/api/workflow/order-lifecycle/by-service-msg') {
    const serviceMsgNum = resolveParam(url, '', ['serviceMsgNum', 'SERVICE_MSG_NUM'], getDefaultServiceMsgNum());
    return sendJson(res, 200, singleOrderLifecycleByServiceMsgJson(serviceMsgNum));
  }

  if (pathname.startsWith('/api/workflow/order-lifecycle/by-service-msg/')) {
    const serviceMsgNum = decodeURIComponent(pathname.substring('/api/workflow/order-lifecycle/by-service-msg/'.length));
    return sendJson(res, 200, singleOrderLifecycleByServiceMsgJson(serviceMsgNum));
  }

  if (pathname === '/api/workflow/order-lifecycle') {
    const ticketId = resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], getDefaultTicketId());
    return sendJson(res, 200, singleOrderLifecycleByTicketJson(ticketId));
  }

  if (pathname.startsWith('/api/workflow/order-lifecycle/')) {
    const ticketId = decodeURIComponent(pathname.substring('/api/workflow/order-lifecycle/'.length));
    return sendJson(res, 200, singleOrderLifecycleByTicketJson(ticketId));
  }

  if (pathname === '/api/workflow/delivery/zone-summary') {
    const date = resolveParam(url, '', ['date'], '');
    const thrudate = resolveParam(url, '', ['thrudate'], '');
    const priorityIDList = resolveParam(url, '', ['priorityIDList'], '');
    const designedOnly = resolveParam(url, '', ['designedOnly'], 'false');

    let rows = filterZoneSummaryRows(designedOnly, priorityIDList);
    if (date || thrudate) {
      rows = rows.map((row) => ({ ...row }));
    }

    return sendJson(res, 200, { ...zoneSummary, rows });
  }

  if (pathname === '/api/workflow/delivery/in-progress-route-summary') {
    const date = resolveParam(url, '', ['date'], '');
    const thrudate = resolveParam(url, '', ['thrudate'], '');
    const rows = filterByDateRange(inProgressRouteSummary.rows, 'LAST_SCAN_TIME', date, thrudate);
    return sendJson(res, 200, { ...inProgressRouteSummary, rows });
  }

  if (pathname === '/api/workflow/delivery/failed-delivery') {
    const date = resolveParam(url, '', ['date'], '');
    const thrudate = resolveParam(url, '', ['thrudate'], '');
    const rows = filterByDateRange(failedDelivery.rows, 'DELIVERY_DATE', date, thrudate);
    return sendJson(res, 200, { ...failedDelivery, rows });
  }

  if (pathname === '/api/workflow/delivery/orders-by-zone') {
    const deliveryDate = resolveParam(url, '', ['deliveryDate'], '');
    const deliveryThruDate = resolveParam(url, '', ['deliveryThruDate'], '');
    const designedOrders = resolveParam(url, '', ['designedOrders'], 'false');
    const priorityIDList = resolveParam(url, '', ['priorityIDList'], '');
    const rows = filterOrdersByZoneRows(deliveryDate, deliveryThruDate, designedOrders, priorityIDList);
    return sendJson(res, 200, { ...ordersByZone, rows });
  }

  if (pathname === '/api/workflow/delivery/orders-by-routes') {
    const deliveryDate = resolveParam(url, '', ['deliveryDate'], '');
    const deliveryThruDate = resolveParam(url, '', ['deliveryThruDate'], '');
    const rows = filterOrdersByRoutesRows(deliveryDate, deliveryThruDate);
    return sendJson(res, 200, { ...ordersByRoutes, rows });
  }

  if (pathname === '/api/workflow/messages/list') {
    const filters = {
      wireService: resolveParam(url, '', ['wireService'], '0'),
      storeID: resolveParam(url, '', ['storeID'], '0'),
      msgType: resolveParam(url, '', ['msgType'], '0'),
      msgDirection: resolveParam(url, '', ['msgDirection'], '0'),
      delivDate: resolveParam(url, '', ['delivDate'], ''),
      msgDate: resolveParam(url, '', ['msgDate'], ''),
      memberCode: resolveParam(url, '', ['memberCode'], ''),
      ticketNum: resolveParam(url, '', ['ticketNum'], ''),
      recipientName: resolveParam(url, '', ['recipientName'], ''),
      mercuryNum: resolveParam(url, '', ['mercuryNum'], ''),
      maxRows: resolveParam(url, '', ['maxRows'], '50'),
      msgID: resolveParam(url, '', ['msgID'], '0')
    };

    return sendJson(res, 200, {
      ...messageList,
      rows: filterMessageListRows(filters)
    });
  }

  if (pathname === '/') {
    return sendJson(res, 200, {
      message: 'Mercury workflow dashboard mock server is running.',
      jsonEndpoints: [
        '/health',
        '/api/workflow/focus',
        '/api/workflow/dashboard/enabled',
        '/api/workflow/framework/server-time',
        '/api/workflow/events-now',
        '/api/workflow/undelivered-orders',
        '/api/workflow/ticket-status/:ticketId',
        '/api/workflow/order-details/:ticketId',
        '/api/workflow/order-lifecycle/:ticketId',
        '/api/workflow/order-lifecycle/by-service-msg/:serviceMsgNum',
        '/api/workflow/delivery/zone-summary',
        '/api/workflow/delivery/in-progress-route-summary',
        '/api/workflow/delivery/failed-delivery',
        '/api/workflow/delivery/orders-by-zone',
        '/api/workflow/delivery/orders-by-routes',
        '/api/workflow/messages/list'
      ],
      mercuryLikeEndpoints: [
        '/WsMercuryWebAPI/dashboard.asmx/GetDashboardEventsNow',
        '/WsMercuryWebAPI/dashboard.asmx/GetUndeliveredOrders',
        '/WsMercuryWebAPI/dashboard.asmx/GetDashboardEnabled',
        '/WsMercuryWebAPI/framework.asmx/GetServerTime',
        '/WsMercuryWebAPI/orderentry.asmx/GetTicketStatus',
        '/WsMercuryWebAPI/delivery.asmx/LoadOrderDetails',
        '/WsMercuryWebAPI/delivery.asmx/LoadZoneSummary',
        '/WsMercuryWebAPI/delivery.asmx/LoadInProgressRouteSummary',
        '/WsMercuryWebAPI/delivery.asmx/LoadFailedDelivery',
        '/WsMercuryWebAPI/delivery.asmx/LoadOrderByZone',
        '/WsMercuryWebAPI/delivery.asmx/LoadOrderByRoutes',
        '/WsMercuryWebAPI/message.asmx/GetMessageList',
        '/WsMercuryWebAPI/orderlifecycle.asmx/OLCGetByTicket',
        '/WsMercuryWebAPI/orderlifecycle.asmx/OLCGetBySERVICE_MSG_NUM'
      ]
    });
  }

  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveMercuryRoute(pathname) {
  const lower = pathname.toLowerCase();
  const routes = [
    { prefix: '/wsmercurywebapi/dashboard.asmx/', service: 'dashboard' },
    { prefix: '/wsmercurywebapi/orderentry.asmx/', service: 'orderentry' },
    { prefix: '/wsmercurywebapi/delivery.asmx/', service: 'delivery' },
    { prefix: '/wsmercurywebapi/orderlifecycle.asmx/', service: 'orderlifecycle' },
    { prefix: '/wsmercurywebapi/framework.asmx/', service: 'framework' },
    { prefix: '/wsmercurywebapi/message.asmx/', service: 'message' }
  ];

  for (const route of routes) {
    if (lower.startsWith(route.prefix)) {
      const op = pathname.substring(route.prefix.length);
      return { service: route.service, op };
    }
  }

  return null;
}

function routeMercuryLike(res, route, url, body) {
  const opLower = route.op.toLowerCase();

  if (route.service === 'dashboard') {
    if (opLower === 'getdashboardeventsnow' || opLower === 'getdashboardevents') {
      sendXml(res, 200, datasetToXml(dashboardEvents));
      return true;
    }
    if (opLower === 'getundeliveredorders') {
      sendXml(res, 200, datasetToXml(buildUndeliveredOrdersDataset()));
      return true;
    }
    if (opLower === 'getdashboardenabled') {
      sendXml(res, 200, boolXml(primitives.GetDashboardEnabled));
      return true;
    }
    return false;
  }

  if (route.service === 'framework') {
    if (opLower === 'getservertime') {
      sendXml(res, 200, stringXml(new Date().toISOString()));
      return true;
    }
    return false;
  }

  if (route.service === 'orderentry') {
    if (opLower === 'getticketstatus') {
      const ticketId = resolveParam(url, body, ['ticketID', 'TicketID', 'ticketId', 'id'], getDefaultTicketId());
      sendXml(res, 200, datasetToXml(buildTicketStatusDataset(ticketId)));
      return true;
    }
    return false;
  }

  if (route.service === 'delivery') {
    if (opLower === 'loadorderdetails') {
      const ticketId = resolveParam(url, body, ['ticketID', 'TicketID', 'ticketId', 'id'], getDefaultTicketId());
      sendXml(res, 200, datasetToXml(buildOrderDetailsDataset(ticketId)));
      return true;
    }

    if (opLower === 'loadzonesummary') {
      const designedOnly = resolveParam(url, body, ['designedOnly'], 'false');
      const priorityIDList = resolveParam(url, body, ['priorityIDList'], '');
      const rows = filterZoneSummaryRows(designedOnly, priorityIDList);
      sendXml(res, 200, datasetToXml(toSingleTableDataset(zoneSummary, rows)));
      return true;
    }

    if (opLower === 'loadinprogressroutesummary') {
      const date = resolveParam(url, body, ['date'], '');
      const thrudate = resolveParam(url, body, ['thrudate'], '');
      const rows = filterByDateRange(inProgressRouteSummary.rows, 'LAST_SCAN_TIME', date, thrudate);
      sendXml(res, 200, datasetToXml(toSingleTableDataset(inProgressRouteSummary, rows)));
      return true;
    }

    if (opLower === 'loadfaileddelivery') {
      const date = resolveParam(url, body, ['date'], '');
      const thrudate = resolveParam(url, body, ['thrudate'], '');
      const rows = filterByDateRange(failedDelivery.rows, 'DELIVERY_DATE', date, thrudate);
      sendXml(res, 200, datasetToXml(toSingleTableDataset(failedDelivery, rows)));
      return true;
    }

    if (opLower === 'loadorderbyzone') {
      const deliveryDate = resolveParam(url, body, ['deliveryDate'], '');
      const deliveryThruDate = resolveParam(url, body, ['deliveryThruDate'], '');
      const designedOrders = resolveParam(url, body, ['designedOrders'], 'false');
      const priorityIDList = resolveParam(url, body, ['priorityIDList'], '');
      const rows = filterOrdersByZoneRows(deliveryDate, deliveryThruDate, designedOrders, priorityIDList);
      sendXml(res, 200, datasetToXml(toSingleTableDataset(ordersByZone, rows)));
      return true;
    }

    if (opLower === 'loadorderbyroutes') {
      const deliveryDate = resolveParam(url, body, ['deliveryDate'], '');
      const deliveryThruDate = resolveParam(url, body, ['deliveryThruDate'], '');
      const rows = filterOrdersByRoutesRows(deliveryDate, deliveryThruDate);
      sendXml(res, 200, datasetToXml(toSingleTableDataset(ordersByRoutes, rows)));
      return true;
    }

    return false;
  }

  if (route.service === 'message') {
    if (opLower === 'getmessagelist') {
      const filters = {
        wireService: resolveParam(url, body, ['wireService'], '0'),
        storeID: resolveParam(url, body, ['storeID'], '0'),
        msgType: resolveParam(url, body, ['msgType'], '0'),
        msgDirection: resolveParam(url, body, ['msgDirection'], '0'),
        delivDate: resolveParam(url, body, ['delivDate'], ''),
        msgDate: resolveParam(url, body, ['msgDate'], ''),
        memberCode: resolveParam(url, body, ['memberCode'], ''),
        ticketNum: resolveParam(url, body, ['ticketNum'], ''),
        recipientName: resolveParam(url, body, ['recipientName'], ''),
        mercuryNum: resolveParam(url, body, ['mercuryNum'], ''),
        maxRows: resolveParam(url, body, ['maxRows'], '50'),
        msgID: resolveParam(url, body, ['msgID'], '0')
      };

      sendXml(res, 200, datasetToXml(toSingleTableDataset(messageList, filterMessageListRows(filters))));
      return true;
    }

    return false;
  }

  if (route.service === 'orderlifecycle') {
    if (opLower === 'olcgetbyticket') {
      const ticketId = resolveParam(url, body, ['TicketID', 'ticketID', 'ticketId', 'id'], getDefaultTicketId());
      sendXml(res, 200, datasetToXml(buildOrderLifecycleByTicketDataset(ticketId)));
      return true;
    }

    if (opLower === 'olcgetbyservice_msg_num') {
      const serviceMsgNum = resolveParam(
        url,
        body,
        ['SERVICE_MSG_NUM', 'serviceMsgNum', 'service_msg_num'],
        getDefaultServiceMsgNum()
      );
      sendXml(res, 200, datasetToXml(buildOrderLifecycleByServiceMsgDataset(serviceMsgNum)));
      return true;
    }

    return false;
  }

  return false;
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  const jsonHandled = routeJson(res, url, pathname);
  if (jsonHandled !== false) {
    return;
  }

  if (req.method === 'POST' || req.method === 'GET') {
    const route = resolveMercuryRoute(pathname);
    if (route) {
      const body = req.method === 'POST' ? await readBody(req) : '';
      const handled = routeMercuryLike(res, route, url, body);
      if (handled) {
        return;
      }
    }
  }

  sendJson(res, 404, { error: 'Not found', path: pathname });
});

server.listen(port, () => {
  console.log(`Mock server listening on http://127.0.0.1:${port}`);
});
