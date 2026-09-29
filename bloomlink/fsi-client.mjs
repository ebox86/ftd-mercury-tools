// BloomNet FSI v2 client — reverse-engineered from the Bloomlink desktop client
// (see FINDINGS.md in this folder for the full protocol notes and citations).
//
// Transport is a single HTTP GET:  {address}/fsiv2/processor?func={func}&data={XML}
// Auth is the <security> block inside the XML (no session token).
//
// SAFETY:
//   * Read paths (getAuditInfo, getMessages, memberDirectory) are safe to run and
//     do NOT consume anything.  Prefer getAuditInfo* for observing so we never
//     steal acks from the still-running desktop client.
//   * postMessage() actually sends an outbound wire message (deny/reject, reply,
//     ack, cancel, ...).  It refuses to send unless you pass { confirm: true }.
//     Do a single, watched live test with the user before wiring anything auto.
//   * Never send an Ackf while the desktop client is the order-taker.
//
// Credentials are read from the desktop client's own Network.config by default
// (never hard-code the password in the repo).  Override with env or opts.

import { readFileSync } from 'node:fs';

const NETWORK_CONFIG = 'C:\\ProgramData\\Bloomlink Client\\7.0\\Network.config';

const ENV_URLS = {
  Production: 'https://www.bloomlink.net',
  Staging: 'https://blink-dev.bloomlink.net',
};

const FSI_XSI =
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ' xsi:noNamespaceSchemaLocation="C:\\logistics_services\\components\\fsicore\\xsd\\client/ForeignSystemInterface.xsd"';

// messageType codes (Entities.Definitions.MessageType)
export const MessageType = {
  Order: 0, Inquiry: 1, Response: 2, Cancellation: 3, Rejection: 4, Denial: 6,
  Delivery_Confirmation: 7, Delivery_Outbound: 8, Dispute: 9, Confirmation: 11,
  Information: 12, New_Tracking_Number: 13, Price_Change: 18, Message: 19,
  Acknowledgement_Bloomlink: 23, Acknowledgement_Fulfiller: 24, Delivery_Attempted: 26,
};

function tag(name, value) {
  return `<${name}>${value ?? ''}</${name}>`;
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// getAuditInfo by-date wants MM/dd/yyyy (the server rejects yyyyMMdd).
function auditDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}
// The wire value for "both" is "Both", not the enum name Inbound_and_Outbound.
function wireDirection(dir) {
  return dir === 'Inbound_and_Outbound' ? 'Both' : dir;
}
// The desktop client encodes newlines and & inside message text this way.
function escapeText(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Read shopCode/user/password/environment from the desktop client's Network.config. */
export function loadCredentials({ configPath = NETWORK_CONFIG } = {}) {
  const fromEnv = {
    shopCode: process.env.BLOOM_SHOPCODE,
    user: process.env.BLOOM_USER,
    password: process.env.BLOOM_PASSWORD,
    environment: process.env.BLOOM_ENV,
    address: process.env.BLOOM_ADDRESS,
  };
  let fromFile = {};
  try {
    const xml = readFileSync(configPath, 'utf8');
    const pick = (t) => (xml.match(new RegExp(`<${t}>(.*?)</${t}>`, 'i')) || [])[1];
    fromFile = {
      shopCode: pick('ShopCode'),
      user: pick('User'),
      password: pick('Password'),
      environment: pick('Environment'),
    };
  } catch {
    /* config not present / not readable — rely on env or opts */
  }
  const merged = { ...fromFile, ...Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v)) };
  merged.environment = merged.environment || 'Production';
  merged.address = merged.address || ENV_URLS[merged.environment] || ENV_URLS.Production;
  if (!merged.shopCode || !merged.user || !merged.password) {
    throw new Error('BloomNet credentials not found (need shopCode/user/password via Network.config or BLOOM_* env vars).');
  }
  return merged;
}

function security(c) {
  return `<security>${tag('username', c.user)}${tag('password', c.password)}${tag('shopCode', c.shopCode)}</security>`;
}
function buildUrl(c, func, xml) {
  return `${c.address}/fsiv2/processor?func=${func}&data=${encodeURIComponent(xml)}`;
}

// ---- request builders (mirror QueryTexts.cs exactly) -----------------------

export function urlGetMessages(c, { systemType = 'GENERAL', maxGeneral = 25, maxAckf = 25, maxOrder = 25 } = {}) {
  const xml =
    `<foreignSystemInterfaceOutboundRequest>${security(c)}` +
    tag('fulfillerShopCode', c.shopCode) + tag('systemType', systemType) +
    tag('maxNumOfGeneralMessages', maxGeneral) + tag('maxNumOfAckfMessages', maxAckf) +
    tag('maxNumOfOrderMessages', maxOrder) +
    `</foreignSystemInterfaceOutboundRequest>`;
  return buildUrl(c, 'getmessages', xml);
}

/** Read-only audit — the coexistence-safe way to observe. direction: Inbound|Outbound|Inbound_and_Outbound */
export function urlAuditOrdersByDate(c, date, direction = 'Inbound') {
  const xml =
    `<auditInterface><auditRequest>${security(c)}<auditSearchOptions><auditOrdersByDate>` +
    tag('messageDirection', wireDirection(direction)) + tag('date', date) +
    `</auditOrdersByDate></auditSearchOptions></auditRequest></auditInterface>`;
  return buildUrl(c, 'getAuditInfo', xml);
}
export function urlAuditMessagesByDate(c, date, direction = 'Both') {
  const xml =
    `<auditInterface><auditRequest>${security(c)}<auditSearchOptions><auditMessagesByDate>` +
    tag('messageDirection', wireDirection(direction)) + tag('date', date) +
    `</auditMessagesByDate></auditSearchOptions></auditRequest></auditInterface>`;
  return buildUrl(c, 'getAuditInfo', xml);
}
export function urlAuditMessagesByDateRange(c, startDate, endDate, direction = 'Both') {
  const xml =
    `<auditInterface><auditRequest>${security(c)}<auditSearchOptions><auditMessagesByDateRange>` +
    tag('messageDirection', wireDirection(direction)) + tag('startDate', startDate) + tag('endDate', endDate) +
    `</auditMessagesByDateRange></auditSearchOptions></auditRequest></auditInterface>`;
  return buildUrl(c, 'getAuditInfo', xml);
}
export function urlAuditOrderByOrderNumber(c, orderNumber, direction = 'Both') {
  const xml =
    `<auditInterface><auditRequest>${security(c)}<auditSearchOptions><auditDetailedInfoOnOrderByOrderNumber>` +
    tag('messageDirection', wireDirection(direction)) + tag('orderNumberType', 'Internal') + tag('orderNumber', orderNumber) +
    `</auditDetailedInfoOnOrderByOrderNumber></auditSearchOptions></auditRequest></auditInterface>`;
  return buildUrl(c, 'getAuditInfo', xml);
}

// ---- OUTBOUND builders (postmessages). These SEND real wire messages. --------

function generalIdentifiers({ bmtOrderNumber = '', bmtSeqNumberOfOrder = '', bmtSeqNumberOfMessage = '', externalShopMessageNumber = '' } = {}) {
  return `<identifiers><generalIdentifiers>${tag('bmtOrderNumber', bmtOrderNumber)}${tag('bmtSeqNumberOfOrder', bmtSeqNumberOfOrder)}${tag('bmtSeqNumberOfMessage', bmtSeqNumberOfMessage)}${tag('externalShopMessageNumber', externalShopMessageNumber)}</generalIdentifiers></identifiers>`;
}

/**
 * Reject an inbound order. Live audit shows the shop's own rejects go out as
 * messageType 4 (Rejection) via <messageRjct>, keyed to the order, with the
 * reason in messageText (Bloom's reason enum is web-side; free text works).
 * o: { receivingShopCode(original sender), bmtOrderNumber, bmtSeqNumberOfOrder, externalShopMessageNumber, reason }
 * UNVERIFIED wire shape (no outbound RJCT builder in the decompiled client) —
 * confirm against a real reject before automating.
 */
export function urlReject(c, o) {
  const xml =
    `<foreignSystemInterface${FSI_XSI}>${security(c)}<errors/><messagesOnOrder>` +
    tag('messageCount', 1) + `<messageRjct>` + tag('messageType', MessageType.Rejection) +
    tag('sendingShopCode', c.shopCode) + tag('receivingShopCode', o.receivingShopCode) + tag('fulfillingShopCode', c.shopCode) +
    tag('systemType', 'GENERAL') + generalIdentifiers(o) + tag('messageCreateTimestamp', stamp()) +
    tag('messageText', escapeText(o.reason)) +
    `</messageRjct></messagesOnOrder></foreignSystemInterface>`;
  return buildUrl(c, 'postmessages', xml);
}

/** Deny a CANCELLATION request (not an order reject). messageType 6 / <messageDeni>. */
export function urlDenyCancellation(c, o) {
  const xml =
    `<foreignSystemInterface${FSI_XSI}>${security(c)}<errors/><messagesOnOrder>` +
    tag('messageCount', 1) + `<messageDeni>` + tag('messageType', MessageType.Denial) +
    tag('sendingShopCode', c.shopCode) + tag('receivingShopCode', o.receivingShopCode) + tag('fulfillingShopCode', c.shopCode) +
    tag('systemType', 'GENERAL') + generalIdentifiers(o) + tag('messageCreateTimestamp', stamp()) +
    tag('messageText', escapeText(o.reason)) +
    `</messageDeni></messagesOnOrder></foreignSystemInterface>`;
  return buildUrl(c, 'postmessages', xml);
}

/** Free-text reply / message on an order. o: { receivingShopCode, bmtOrderNumber, bmtSeqNumberOfMessage, text } */
export function urlMesg(c, o) {
  const xml =
    `<foreignSystemInterface${FSI_XSI}>${security(c)}<errors/><messageMesg>` +
    tag('messageType', MessageType.Message) +
    tag('sendingShopCode', c.shopCode) + tag('receivingShopCode', o.receivingShopCode) + tag('systemType', 'GENERAL') +
    `<identifiers><generalIdentifiers>${tag('bmtOrderNumber', o.bmtOrderNumber)}${tag('bmtSeqNumberOfMessage', o.bmtSeqNumberOfMessage)}</generalIdentifiers></identifiers>` +
    tag('messageCreateTimestamp', stamp()) + tag('messageText', escapeText(o.text)) +
    `</messageMesg></foreignSystemInterface>`;
  return buildUrl(c, 'postmessages', xml);
}

// ---- transport --------------------------------------------------------------

// Mirrors Request.CleanXml: strip CR/LF, decode &amp;, drop stray Â, decode %0A/%0D.
function cleanXml(xml) {
  if (!xml) return xml;
  return xml.replace(/\r/g, '').replace(/\n/g, '').replace(/&amp;/g, ' and ')
    .replace(/\u00C2/g, '').replace(/%0A/g, ' ').replace(/%0D/g, '');
}

/** GET a built FSI url and return the cleaned XML text. */
export async function fetchFsi(url) {
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) throw new Error(`FSI HTTP ${res.status}: ${text.slice(0, 400)}`);
  return cleanXml(text);
}

/**
 * Send an outbound (postmessages) request. Guarded: throws unless confirm:true.
 * Returns the cleaned XML response. USE ONLY for deliberate, watched live tests.
 */
export async function postMessage(url, { confirm = false } = {}) {
  if (!/func=postmessages/.test(url)) throw new Error('postMessage() is only for func=postmessages URLs.');
  if (!confirm) throw new Error('Refusing to send a live wire message without { confirm: true }. This is a real outbound action.');
  return fetchFsi(url);
}

// ---- tiny read-only CLI -----------------------------------------------------
// Usage:
//   node fsi-client.mjs audit-today [Inbound|Outbound|Inbound_and_Outbound]
//   node fsi-client.mjs audit-order <orderNumber>
//   node fsi-client.mjs messages            (getmessages read; does NOT ack)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fsi-client.mjs')) {
  const [cmd, arg, arg2] = process.argv.slice(2);
  const c = loadCredentials();
  const run = async () => {
    switch (cmd) {
      case 'audit-today':
        console.log(await fetchFsi(urlAuditOrdersByDate(c, auditDate(), arg || 'Both')));
        break;
      case 'audit-msgs-today':
        console.log(await fetchFsi(urlAuditMessagesByDate(c, auditDate(), arg || 'Both')));
        break;
      case 'audit-date': // audit-date MM/dd/yyyy [direction]  (orders)
        console.log(await fetchFsi(urlAuditOrdersByDate(c, arg, arg2 || 'Both')));
        break;
      case 'audit-order':
        if (!arg) throw new Error('audit-order needs an order number');
        console.log(await fetchFsi(urlAuditOrderByOrderNumber(c, arg)));
        break;
      case 'messages':
        console.log(await fetchFsi(urlGetMessages(c)));
        break;
      default:
        console.log('commands: audit-today [dir] | audit-msgs-today [dir] | audit-date MM/dd/yyyy [dir] | audit-order <n> | messages');
        console.log(`shop ${c.shopCode} @ ${c.address} (env ${c.environment})`);
    }
  };
  run().catch((e) => { console.error(e.message); process.exit(1); });
}
