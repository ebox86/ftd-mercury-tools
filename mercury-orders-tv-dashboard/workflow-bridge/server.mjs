import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const refDir = join(__dirname, '..', 'reference');
const dashboardConfigDir = join(__dirname, '..', 'artifacts', 'tooling-local');
const dashboardServerConfigPath = join(dashboardConfigDir, 'dashboard-server-config.json');
const serviceName = 'pi-kiosk-mercury-workflow-bridge';

function readDashboardServerConfig() {
  if (!existsSync(dashboardServerConfigPath)) return {};
  const raw = readFileSync(dashboardServerConfigPath, 'utf8');
  const parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

function writeDashboardServerConfig(payload) {
  const config = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  mkdirSync(dashboardConfigDir, { recursive: true });
  writeFileSync(dashboardServerConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

function parseEnvLine(rawLine = '') {
  const line = String(rawLine || '').trim();
  if (!line || line.startsWith('#')) return null;
  const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;
  const key = String(match[1] || '').trim();
  let value = String(match[2] || '');
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFileIfPresent(filePath) {
  if (!existsSync(filePath)) return;
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const lines = String(raw || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const parsed = parseEnvLine(rawLine);
    if (!parsed?.key) continue;
    if (process.env[parsed.key] !== undefined && process.env[parsed.key] !== '') continue;
    process.env[parsed.key] = parsed.value;
  }
}

function loadLocalEnvFiles() {
  // Keep explicit process env highest priority; then read local files.
  const candidates = [
    join(__dirname, '..', '.env'),
    join(__dirname, '.env'),
  ];
  for (const candidate of candidates) {
    loadEnvFileIfPresent(candidate);
  }
}

loadLocalEnvFiles();

function normalizeAccessToken(rawToken = '') {
  let token = String(rawToken || '').trim();
  const assignment = token.match(/^(?:MAPBOX_TOKEN|MAPBOX_ACCESS_TOKEN)\s*=\s*(.*)$/i);
  if (assignment) {
    token = String(assignment[1] || '').trim();
  }
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  const embeddedToken = token.match(/\b(?:pk|sk)\.[A-Za-z0-9._-]+/);
  if (embeddedToken) {
    token = embeddedToken[0].trim();
  }
  return token;
}

function readJsonFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const text = String(raw).replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

const workflowFocus = readJsonFile(join(refDir, 'job-workflow-api-focus.json'));
const dashboardEvents = { dataset: 'DashboardEventDataset', tables: { OrderItems: [], MessageItems: [] } };
const ticketStatus = { dataset: 'TicketStatusDataSet', table: 'GetTicketStatus', byTicketId: {} };
const orderDetails = { dataset: 'OrderDetailsDataSet', table: 'LoadOrderDetails', rows: [] };
const orderLifecycle = { dataset: 'OrderLifeCycleDataSet', table: 'OLCStatusMsg', rows: [] };
const primitives = { GetDashboardEnabled: true };
const zoneSummary = { dataset: 'DeliveryZoneSummaryDataSet', table: 'LoadZoneSummary', rows: [] };
const inProgressRouteSummary = { dataset: 'DeliveryInProgressRouteSummaryDataSet', table: 'LoadInProgressRouteSummary', rows: [] };
const failedDelivery = { dataset: 'DeliveryFailedDeliveryDataSet', table: 'LoadFailedDelivery', rows: [] };
const ordersByZone = { dataset: 'DeliveryOrdersByZoneDataSet', table: 'LoadOrderByZone', rows: [] };
const ordersByRoutes = { dataset: 'DeliveryOrdersByRoutesDataSet', table: 'LoadOrderByRoutes', rows: [] };
const messageList = { dataset: 'MercuryMessageListDataSet', table: 'GetMessageList', rows: [] };

const port = Number(process.env.PORT || 17344);
const host = String(process.env.BRIDGE_HOST || '0.0.0.0').trim() || '0.0.0.0';
const localNetworkOnly = !/^(0|false|no)$/i.test(String(process.env.MERCURY_LOCAL_NETWORK_ONLY || 'true').trim());
const trustProxyHeaders = /^(1|true|yes)$/i.test(String(process.env.MERCURY_TRUST_PROXY_HEADERS || '').trim());
const apiKey = String(process.env.MERCURY_API_KEY || '').trim();
const xmlNs = 'http://localhost/webservices/';
const liveEnabled = true;
const liveMercuryBaseUrl = String(process.env.MERCURY_BASE_URL || '').trim() || 'http://127.0.0.1/WsMercuryWebAPI';
const liveSoapNamespace = String(process.env.MERCURY_SOAP_NAMESPACE || xmlNs).trim() || xmlNs;
const liveTimeoutMs = Number(process.env.MERCURY_TIMEOUT_MS || 12000);
const liveDeliveryLookupTtlMs = Number(process.env.MERCURY_DELIVERY_LOOKUP_TTL_MS || 5 * 60 * 1000);
const liveDeliveryLookupCache = {
  expiresAt: 0,
  storeIds: [],
  zoneIds: []
};
const liveApiCacheTtlMs = Number(process.env.MERCURY_LIVE_CACHE_TTL_MS || 3500);
const liveApiCacheMaxEntries = Number(process.env.MERCURY_LIVE_CACHE_MAX_ENTRIES || 2000);
const liveApiCacheBypassParam = String(process.env.MERCURY_LIVE_CACHE_BYPASS_PARAM || 'nocache').trim() || 'nocache';
const liveApiResponseCache = new Map();
const liveApiInFlight = new Map();
const mapboxToken = normalizeAccessToken(process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN || '');
const mapboxApiBaseUrl = String(process.env.MAPBOX_API_BASE_URL || 'https://api.mapbox.com').trim().replace(/\/+$/, '') || 'https://api.mapbox.com';
const mapboxProfileRaw = String(process.env.MAPBOX_DIRECTIONS_PROFILE || 'driving').trim();
const mapboxProfile = mapboxProfileRaw.includes('/') ? mapboxProfileRaw : `mapbox/${mapboxProfileRaw}`;
const mapboxTimeoutMs = Number(process.env.MAPBOX_TIMEOUT_MS || 8000);
const mapboxRouteCacheTtlMs = Number(process.env.MAPBOX_ROUTE_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const mapboxAddressCacheTtlMs = Number(process.env.MAPBOX_ADDRESS_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const mapboxDistanceFallbackToHaversine = !/^(0|false|no)$/i.test(String(process.env.MAPBOX_FALLBACK_TO_HAVERSINE || 'true').trim());
const liveMainStoreCoordCache = { expiresAt: 0, point: null };
const weatherForecastCachePath = join(dashboardConfigDir, 'weather-forecast-cache.json');
const weatherTimeoutMs = Number(process.env.WEATHER_TIMEOUT_MS || 10000);
const weatherForecastCacheTtlMs = Number(process.env.WEATHER_FORECAST_CACHE_TTL_MS || 15 * 60 * 1000);
const weatherForecastStaleTtlMs = Number(process.env.WEATHER_FORECAST_STALE_TTL_MS || 12 * 60 * 60 * 1000);
const weatherForecastCache = new Map();
const weatherForecastInFlight = new Map();
let weatherForecastCacheLoaded = false;

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

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeSoapNamespace(rawNs, trailingSlash = false) {
  const base = String(rawNs || xmlNs).trim().replace(/\/+$/, '');
  if (!base) return trailingSlash ? `${xmlNs.replace(/\/+$/, '')}/` : xmlNs.replace(/\/+$/, '');
  return trailingSlash ? `${base}/` : base;
}

function trimSlashes(value = '') {
  return String(value || '').replace(/\/+$/, '').replace(/^\/+/, '');
}

function extractTagValue(xmlText, tagName) {
  const safeTag = String(tagName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<(?:\\w+:)?${safeTag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${safeTag}>`, 'i');
  const match = String(xmlText || '').match(regex);
  return match?.[1] || '';
}

function parseXmlRow(rowXml) {
  const row = {};
  const fieldRegex = /<(?:\w+:)?([A-Za-z0-9_]+)[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g;
  let fieldMatch = null;
  while ((fieldMatch = fieldRegex.exec(rowXml)) !== null) {
    const key = String(fieldMatch[1] || '').trim();
    if (!key) continue;
    row[key] = decodeXmlEntities(String(fieldMatch[2] || '').trim());
  }
  return row;
}

function parseTableRows(xmlText, tableName) {
  const safeTag = String(tableName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRegex = new RegExp(`<(?:\\w+:)?${safeTag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${safeTag}>`, 'g');
  const rows = [];
  let rowMatch = null;
  while ((rowMatch = rowRegex.exec(xmlText)) !== null) {
    const row = parseXmlRow(rowMatch[1] || '');
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

function parseSoapDatasetResponse(xmlText, operationName, tableNames = [], datasetNameFallback = '') {
  const opResultTag = `${operationName}Result`;
  let payload = extractTagValue(xmlText, opResultTag) || String(xmlText || '');
  payload = decodeXmlEntities(payload);
  const tables = {};
  for (const tableName of tableNames) {
    tables[tableName] = parseTableRows(payload, tableName);
  }

  const datasetNameMatch = payload.match(/<(?:\w+:)?([A-Za-z0-9_]*(?:DataSet|Dataset))\b/i);
  const datasetName = datasetNameMatch?.[1] || datasetNameFallback || 'Dataset';
  return { dataset: datasetName, tables };
}

function parseSoapBooleanResponse(xmlText, operationName, fallback = false) {
  const opResultTag = `${operationName}Result`;
  const resultRaw = extractTagValue(xmlText, opResultTag) || extractTagValue(xmlText, 'boolean');
  if (!resultRaw) return fallback;
  return /^(true|1|yes)$/i.test(String(resultRaw || '').trim());
}

function parseSoapStringResponse(xmlText, operationName, fallback = '') {
  const opResultTag = `${operationName}Result`;
  const resultRaw = extractTagValue(xmlText, opResultTag) || extractTagValue(xmlText, 'string');
  if (!resultRaw) return fallback;
  return decodeXmlEntities(String(resultRaw || '').trim());
}

function buildSoapEnvelope(operationName, params = {}) {
  const nsWithSlash = normalizeSoapNamespace(liveSoapNamespace, true);
  const payload = Object.entries(params)
    .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operationName} xmlns="${xmlEscape(nsWithSlash)}">${payload}</${operationName}></soap:Body></soap:Envelope>`;
}

function buildSoap12Envelope(operationName, innerXml = '') {
  const nsWithSlash = normalizeSoapNamespace(liveSoapNamespace, true);
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><${operationName} xmlns="${xmlEscape(nsWithSlash)}">${innerXml}</${operationName}></soap12:Body></soap12:Envelope>`;
}

function buildSoap11Envelope(operationName, innerXml = '') {
  const nsWithSlash = normalizeSoapNamespace(liveSoapNamespace, true);
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operationName} xmlns="${xmlEscape(nsWithSlash)}">${innerXml}</${operationName}></soap:Body></soap:Envelope>`;
}

function normalizeNumericId(raw) {
  const text = String(raw ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function uniqueNumericIds(values = []) {
  return Array.from(new Set(values.map(normalizeNumericId).filter(Boolean)));
}

function boolFromMercuryFlag(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return false;
  if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return true;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric > 0;
  return false;
}

function normalizeSpace(raw = '') {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function normalizeAddressText(raw = '') {
  return normalizeSpace(raw).toUpperCase();
}

function normalizePostalCode(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zipMatch) return zipMatch[1];
  return text.toUpperCase();
}

function normalizeCoord(raw, min, max) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function hasUsableCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  // Common sentinel from failed geocode responses.
  if (Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001) return false;
  return true;
}

function extractCoordsFromRow(row = {}, latKeys = [], lonKeys = []) {
  let lat = null;
  let lon = null;
  for (const key of latKeys) {
    lat = normalizeCoord(row?.[key], -90, 90);
    if (lat !== null) break;
  }
  for (const key of lonKeys) {
    lon = normalizeCoord(row?.[key], -180, 180);
    if (lon !== null) break;
  }
  if (lat === null || lon === null) return null;
  if (!hasUsableCoords(lat, lon)) return null;
  return { latitude: lat, longitude: lon };
}

function roundTo(raw, decimals = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** Math.max(0, Math.floor(decimals));
  return Math.round(value * factor) / factor;
}

function haversineDistanceMiles(origin, destination) {
  const originLat = Number(origin?.latitude);
  const originLon = Number(origin?.longitude);
  const destLat = Number(destination?.latitude);
  const destLon = Number(destination?.longitude);
  if (![originLat, originLon, destLat, destLon].every(Number.isFinite)) return null;
  const toRadians = (value) => value * (Math.PI / 180);
  const dLat = toRadians(destLat - originLat);
  const dLon = toRadians(destLon - originLon);
  const lat1 = toRadians(originLat);
  const lat2 = toRadians(destLat);
  const a = Math.sin(dLat / 2) ** 2
    + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const earthRadiusMiles = 3958.7613;
  return earthRadiusMiles * c;
}

function buildTypedAnyTypeArrayXml(nodeName, values = []) {
  const ids = uniqueNumericIds(values);
  const items = ids.map(value => `<anyType xsi:type="xsd:int">${xmlEscape(value)}</anyType>`).join('');
  return `<${nodeName}>${items}</${nodeName}>`;
}

function toLiveParams(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    query.set(key, String(value));
  }
  return query;
}

async function callLiveMercuryAttempt(url, init, signal) {
  const response = await fetch(url, {
    ...init,
    signal,
  });
  const responseText = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: responseText,
  };
}

async function callLiveMercury(serviceName, operationName, params = {}) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, liveTimeoutMs));
  try {
    const base = String(liveMercuryBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('MERCURY_BASE_URL is empty');
    const servicePath = `${trimSlashes(serviceName)}.asmx`;
    const url = `${base}/${servicePath}/${operationName}`;
    const soapAction = `"${normalizeSoapNamespace(liveSoapNamespace, false)}/${operationName}"`;
    const encodedParams = toLiveParams(params).toString();

    const attempts = [
      {
        label: 'soap',
        url,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: soapAction,
          },
          body: buildSoapEnvelope(operationName, params),
        },
      },
      {
        label: 'form-post',
        url,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body: encodedParams,
        },
      },
      {
        label: 'query-get',
        url: encodedParams ? `${url}?${encodedParams}` : url,
        init: {
          method: 'GET',
        },
      },
    ];

    let lastFailure = '';
    for (const attempt of attempts) {
      const result = await callLiveMercuryAttempt(attempt.url, attempt.init, controller.signal);
      if (result.ok) {
        return result.body;
      }

      lastFailure = `[${attempt.label}] ${result.status}: ${result.body.slice(0, 300)}`;
      const isFormatError = /request format is invalid/i.test(result.body);
      const shouldTryNext = isFormatError || result.status === 404 || result.status === 405 || result.status === 415 || result.status >= 500;
      if (!shouldTryNext) {
        break;
      }
    }

    throw new Error(`Mercury ${operationName} failed. ${lastFailure}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function callLiveMercurySoap12(serviceName, operationName, innerXml = '') {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, liveTimeoutMs));
  try {
    const base = String(liveMercuryBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('MERCURY_BASE_URL is empty');

    const servicePath = `${trimSlashes(serviceName)}.asmx`;
    const url = `${base}/${servicePath}`;
    const soapAction = `${normalizeSoapNamespace(liveSoapNamespace, false)}/${operationName}`;
    const contentType = `application/soap+xml; charset=utf-8; action="${soapAction}"`;

    const result = await callLiveMercuryAttempt(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType
      },
      body: buildSoap12Envelope(operationName, innerXml)
    }, controller.signal);

    if (result.ok) return result.body;

    throw new Error(`Mercury ${operationName} SOAP12 failed. ${result.status}: ${result.body.slice(0, 400)}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function callLiveMercurySoap11(serviceName, operationName, innerXml = '') {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, liveTimeoutMs));
  try {
    const base = String(liveMercuryBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('MERCURY_BASE_URL is empty');

    const servicePath = `${trimSlashes(serviceName)}.asmx`;
    const url = `${base}/${servicePath}`;
    const soapAction = `"${normalizeSoapNamespace(liveSoapNamespace, false)}/${operationName}"`;

    const result = await callLiveMercuryAttempt(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction,
      },
      body: buildSoap11Envelope(operationName, innerXml)
    }, controller.signal);

    if (result.ok) return result.body;

    throw new Error(`Mercury ${operationName} SOAP11 failed. ${result.status}: ${result.body.slice(0, 400)}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function normalizeCacheParamValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildLiveCacheKey(scope, params = {}) {
  const entries = Object.entries(params || {})
    .map(([key, value]) => [String(key), normalizeCacheParamValue(value)])
    .filter(([, value]) => value !== '')
    .sort((a, b) => a[0].localeCompare(b[0]));

  const encoded = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  return `${scope}?${encoded}`;
}

function isCacheBypassRequested(url) {
  const raw = url?.searchParams?.get(liveApiCacheBypassParam) || '';
  return /^(1|true|yes)$/i.test(String(raw || '').trim());
}

function clampCacheTtlMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function enforceLiveCacheSizeLimit() {
  const limit = Math.max(50, Math.floor(Number(liveApiCacheMaxEntries) || 0));
  while (liveApiResponseCache.size > limit) {
    const oldest = liveApiResponseCache.keys().next().value;
    if (!oldest) break;
    liveApiResponseCache.delete(oldest);
  }
}

async function getLiveCachedPayload(cacheKey, ttlMs, loader, bypass = false) {
  const effectiveTtlMs = clampCacheTtlMs(ttlMs);
  if (bypass || effectiveTtlMs <= 0) {
    try {
      return { payload: await loader(), cacheStatus: 'BYPASS' };
    } catch (error) {
      const stale = liveApiResponseCache.get(cacheKey);
      if (stale) {
        console.warn(`Live fetch failed for ${cacheKey}, serving stale cache: ${String(error?.message || error)}`);
        return { payload: stale.payload, cacheStatus: 'STALE-ERROR' };
      }
      throw error;
    }
  }

  const now = Date.now();
  const cached = liveApiResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { payload: cached.payload, cacheStatus: 'HIT' };
  }

  const existingInFlight = liveApiInFlight.get(cacheKey);
  if (existingInFlight) {
    const payload = await existingInFlight;
    return { payload, cacheStatus: 'SHARED' };
  }

  const pending = (async () => {
    const payload = await loader();
    liveApiResponseCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + effectiveTtlMs
    });
    enforceLiveCacheSizeLimit();
    return payload;
  })();

  liveApiInFlight.set(cacheKey, pending);
  try {
    const payload = await pending;
    return { payload, cacheStatus: 'MISS' };
  } catch (error) {
    // A Mercury SOAP fault (e.g. the dashboard truncation bug) shouldn't blank out
    // the dashboard if we still have a previous good response for this scope.
    if (cached) {
      console.warn(`Live refresh failed for ${cacheKey}, serving stale cache: ${String(error?.message || error)}`);
      return { payload: cached.payload, cacheStatus: 'STALE-ERROR' };
    }
    throw error;
  } finally {
    liveApiInFlight.delete(cacheKey);
  }
}

async function sendLiveCachedJson(res, url, options) {
  const {
    scope,
    params = {},
    endpoint = scope,
    ttlMs = liveApiCacheTtlMs,
    loader
  } = options || {};
  try {
    const cacheKey = buildLiveCacheKey(scope, params);
    const { payload, cacheStatus } = await getLiveCachedPayload(
      cacheKey,
      ttlMs,
      loader,
      isCacheBypassRequested(url)
    );
    return sendJson(res, 200, payload, {
      'X-Mercury-Cache': cacheStatus
    });
  } catch (error) {
    return sendJson(res, 502, { error: String(error?.message || error), endpoint });
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendBinary(res, statusCode, payload, contentType, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': contentType || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  res.end(payload);
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

function firstHeaderValue(raw) {
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return String(raw || '').trim();
}

function normalizeClientIp(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const base = text.split(',')[0]?.trim() || '';
  const withoutZone = base.includes('%') ? base.slice(0, base.indexOf('%')) : base;
  if (withoutZone.startsWith('::ffff:')) {
    return withoutZone.slice('::ffff:'.length);
  }
  return withoutZone;
}

function isPrivateClientIp(rawIp) {
  const ip = normalizeClientIp(rawIp);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;

  const ipv4 = ip.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (ipv4) {
    const octets = ip.split('.').map(part => Number(part));
    if (octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  const lowered = ip.toLowerCase();
  if (lowered.startsWith('fc') || lowered.startsWith('fd')) return true;
  if (lowered.startsWith('fe8') || lowered.startsWith('fe9') || lowered.startsWith('fea') || lowered.startsWith('feb')) return true;
  return false;
}

function extractClientIp(req) {
  if (trustProxyHeaders) {
    const forwarded = firstHeaderValue(req.headers['x-forwarded-for']);
    const forwardedIp = normalizeClientIp(forwarded);
    if (forwardedIp) return forwardedIp;
  }
  return normalizeClientIp(req.socket?.remoteAddress || '');
}

function isRequestAllowed(req) {
  const clientIp = extractClientIp(req);
  if (localNetworkOnly && !isPrivateClientIp(clientIp)) {
    return {
      allowed: false,
      status: 403,
      reason: 'Access is restricted to localhost and private LAN ranges.',
      clientIp: clientIp || 'unknown'
    };
  }
  return { allowed: true, clientIp };
}

function hasValidApiKey(req, url) {
  if (!apiKey) return true;
  const headerValue = firstHeaderValue(req.headers['x-mercury-key']) || firstHeaderValue(req.headers['x-api-key']);
  const queryValue = String(url?.searchParams?.get('key') || '').trim();
  return headerValue === apiKey || queryValue === apiKey;
}

function formatMercuryDateTimeLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
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
    // Treat the range as [start, end) to avoid day-window overlap when
    // callers pass end as the next-day midnight boundary.
    if (endEpoch !== null && rowEpoch >= endEpoch) {
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
  return '610002';
}

function getDefaultServiceMsgNum() {
  return 'MSG-470002';
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

function firstRowValue(row, keys = []) {
  for (const key of keys) {
    const value = String(row?.[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function parseSalePosition(rawValue = '') {
  const text = String(rawValue || '').trim();
  if (!text) return { saleId: '', ticketPosition: '' };
  const [left = '', right = ''] = text.split('/');
  const saleId = String(left || '').trim();
  const ticketPosition = String(right || '').trim();
  return { saleId, ticketPosition };
}

// Mercury SALE_TYP_ID integer → human-readable order type string
// TicketSearch returns values in the 100-range (102=Local, 103=Wire In, 104=Wire Out).
// 100 and 101 are unmapped by Mercury docs but reserved here for OE/Pickup variants.
const SALE_TYP_ID_MAP = {
  100: 'Pickup', // OE / in-store pickup (TicketSearch 100-range; unconfirmed, added defensively)
  101: 'Pickup', // Pickup/COD (TicketSearch 100-range; unconfirmed, added defensively)
  102: 'Local',
  103: 'Wire In',
  104: 'Wire Out',
};

function normalizeTicketSearchRow(rawRow = {}) {
  const row = rawRow || {};
  const rawUserReference = firstRowValue(row, [
    'USER_REFERENCE',
    'REFERENCE',
    'DELIVERY',
    'DELIVERY_NO',
    'DELIVERY_NUM',
    'ORDER_NUMBER',
    'ORDER_NO',
    'ORDERNUM',
  ]);
  const fromUserReference = parseSalePosition(rawUserReference);
  const saleId = firstRowValue(row, [
    'SALE_ID',
    'SALEID',
    'ORDER_ID',
    'ORDERID',
    'INVOICE_NO',
    'INVOICE',
  ]) || fromUserReference.saleId;
  const ticketPosition = firstRowValue(row, [
    'TICKET_POSITION',
    'TICKETPOS',
    'POSITION',
    'POS',
  ]) || fromUserReference.ticketPosition || '1';
  const ticketId = firstRowValue(row, [
    'ID',
    'TICKET_ID',
    'TICKETID',
    'TICKET_NUM',
    'TICKETNUM',
    'DELIVERY_ID',
  ]) || saleId;
  const userReference = rawUserReference || (saleId && ticketPosition ? `${saleId}/${ticketPosition}` : saleId || ticketId);

  const designStatus = firstRowValue(row, [
    'DESIGN_STATUS',
    'DESIGNSTATUS',
    'DESIGNER_STATUS',
    'DESIGNERSTATUS',
    'PRODUCTION_STATUS',
    'PRODUCTIONSTATUS',
    'DESIGN STATUS',
  ]);
  const deliveryStatus = firstRowValue(row, [
    'DELIVERY_STATUS',
    'DELIVERYSTATUS',
    'STATUS',
    'ORDER_STATUS',
    'ORDERSTATUS',
    'DELIVERY STATUS',
  ]);

  return {
    ID: String(ticketId || '').trim(),
    SALE_ID: String(saleId || '').trim(),
    TICKET_POSITION: String(ticketPosition || '1').trim(),
    USER_REFERENCE: String(userReference || '').trim(),
    SALE_STATUS_ID: firstRowValue(row, ['SALE_STATUS_ID', 'SALESTATUSID', 'ORDER_STATUS_ID', 'ORDERSTATUSID', 'ORDER_STATUS']),
    ORDER_TYPE: (() => {
      // SALE_TYP_ID is an integer in Mercury's TicketSearch (102=Local, 103=Wire In, 104=Wire Out)
      const saleTypId = parseInt(String(row.SALE_TYP_ID || ''), 10);
      const mappedType = !isNaN(saleTypId) ? SALE_TYP_ID_MAP[saleTypId] : undefined;
      if (mappedType) {
        // Wire In / Local orders with no recipient name are store pickups, never deliveries.
        // TicketSearch only returns RECIP_NAME (no address fields), so empty name is definitive.
        const recipName = String(row.RECIP_NAME || row.RECIPIENT_NAME || '').trim();
        if (!recipName && (mappedType === 'Wire In' || mappedType === 'Local')) return 'Pickup';
        return mappedType;
      }
      const candidates = ['ORDER_TYPE', 'SALE_TYPE', 'SALETYPE', 'TYPE', 'DELIVERY_TYPE'];
      // Prefer pickup/COD keyword match over wire keyword to avoid misclassifying pickups
      const pickupValue = candidates.map(k => String(row[k] || '').trim()).find(v => /\bpick[\s-]*up\b|\bcod\b/i.test(v));
      if (pickupValue) return pickupValue;
      const wireValue = candidates.map(k => String(row[k] || '').trim()).find(v => /\bwire\b/i.test(v));
      return wireValue || firstRowValue(row, candidates);
    })(),
    RECIPIENT_NAME: firstRowValue(row, ['RECIPIENT_NAME', 'RECIP_NAME', 'RECIPIENTREF', 'RECIPIENT_REF', 'RECIPIENT', 'SUMMARY_TEXT', 'NAME']),
    RECIPIENT_ADDRESS: firstRowValue(row, [
      'RECIPIENT_ADDRESS',
      'RECIPIENT_ADDRESS_1',
      'RECIPIENT_ADDRESS1',
      'RECIPIENT_ADDR1',
      'RECIP_ADDR1',
      'ADDRESS',
      'ADDR1',
      'ADDR_LINE1',
      'STREET',
      'STREET_ADDRESS',
    ]),
    RECIPIENT_CITY: firstRowValue(row, ['RECIPIENT_CITY', 'RECIPIENT_CITY_NAME', 'CITY', 'CITY_NAME']),
    RECIPIENT_STATE_ABBREV: firstRowValue(row, [
      'RECIPIENT_STATE_ABBREV',
      'RECIPIENT_STATE_PROV_NAME',
      'STATE_PROVINCE_NAME',
      'STATE_ABBREV',
      'STATE',
      'STATE_NAME',
      'RECIPIENT_STATE',
    ]),
    RECIPIENT_ZIP: firstRowValue(row, [
      'RECIPIENT_ZIP',
      'RECIPIENT_ZIP_CODE',
      'RECIPIENT_POSTAL_CODE',
      'RECIPIENT_POSTAL',
      'ZIP_CODE',
      'ZIP5',
      'ZIP_5',
      'ZIP',
      'POSTAL_CODE',
      'POST_CODE',
      'POSTAL',
      'POSTCODE',
    ]),
    DELIVERY_DATE: firstRowValue(row, ['DELIVERY_DATE', 'DELIV_DATE', 'DELIVERYDATETIME', 'DELIVERY_DATETIME']),
    SALE_DATE: firstRowValue(row, ['SALE_DATE', 'SALEDATE']),
    CUSTOMER_NAME: firstRowValue(row, ['CUSTOMER_NAME', 'CUST_NAME', 'CUSTOMER']),
    DESIGN_STATUS: String(designStatus || '').trim(),
    DELIVERY_STATUS: String(deliveryStatus || '').trim(),
    STATUS: String(deliveryStatus || '').trim(),
    TOTAL: firstRowValue(row, ['TOTAL', 'TOTAL_AMOUNT', 'AMOUNT', 'TICKET_AMT']),
    AMT_PAID: firstRowValue(row, ['AMT_PAID', 'AMOUNT_PAID', 'PAID']),
  };
}

const DELIVERED_STATUS_MARKERS = [
  'DELIVER',
  'LEFT_AT_FRONT_DOOR',
  'LEFT_WITH_NEIGHBOR',
  'LEFT_WITH_RECEPTION',
  'LEFT_WITH_CONCIERGE',
  'LEFT_WITH',
  'PICKED_UP',
  'PICKUP',
  'COMPLETE',
  'COMPLETED',
];

const EXCEPTION_STATUS_MARKERS = [
  'EXCEPT',
  'FAIL',
  'UNDELIVER',
  'RETURN',
  'NOT_AT_HOME',
  'NOT_AT_WORK',
  'BAD_ADDRESS',
  'DISCHARGED_FROM_HOSPITAL',
  'REFUSED',
];

function normalizeStatusToken(raw = '') {
  const token = String(raw || '').trim().toUpperCase();
  if (!token || token === '0' || token === 'UNKNOWN' || token === 'N/A' || token === 'NULL') return '';
  return token.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function hasAnyStatusMarker(status = '', markers = []) {
  return markers.some(marker => status.includes(marker));
}

function deliverySemanticFromStatus(statusRaw = '') {
  const status = normalizeStatusToken(statusRaw);
  if (!status) return 'unknown';

  if (/^\d+$/.test(status)) {
    const code = Number.parseInt(status, 10);
    if (code >= 1 && code <= 3) return 'delivered';
    if (code >= 4) return 'exception';
    return 'unknown';
  }

  if (hasAnyStatusMarker(status, EXCEPTION_STATUS_MARKERS)) return 'exception';
  if (hasAnyStatusMarker(status, DELIVERED_STATUS_MARKERS)) return 'delivered';
  return 'unknown';
}

function isDeliveredOrExceptionStatus(statusRaw = '') {
  const semantic = deliverySemanticFromStatus(statusRaw);
  return semantic === 'delivered' || semantic === 'exception';
}

function filterTicketSearchRows(rows = [], fromDate = '', toDate = '', notDeliveredOnly = true) {
  let filtered = filterByDateRange(rows, 'DELIVERY_DATE', fromDate, toDate);
  if (notDeliveredOnly) {
    filtered = filtered.filter(row => !isDeliveredOrExceptionStatus(row.DELIVERY_STATUS || row.STATUS));
  }
  return filtered;
}

function dedupeTicketSearchRows(rows = []) {
  return Array.from(
    new Map(
      (rows || []).map(row => [
        `${String(row.ID || '').trim()}|${String(row.USER_REFERENCE || '').trim()}|${String(row.DELIVERY_DATE || '').trim()}`,
        row,
      ]),
    ).values(),
  );
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

async function getLiveDashboardEventsNow() {
  const xmlText = await callLiveMercury('dashboard', 'GetDashboardEventsNow', {});
  return parseSoapDatasetResponse(
    xmlText,
    'GetDashboardEventsNow',
    ['DashboardEventTable', 'MessageItems', 'OrderItems', 'BlabberItems', 'DeliveryZones'],
    'DashboardEventDataset'
  );
}

async function getLiveUndeliveredOrders() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const fromDate = formatMercuryDateTimeLocal(start);
  const toDate = formatMercuryDateTimeLocal(end);

  try {
    const search = await getLiveTicketSearch({
      fromDate,
      toDate,
      notDelivered: true,
      includeDelivered: false,
    });
    const rows = (search.rows || []).map((row) => ({
      CATEGORY: '12',
      ID: String(row.ID || '').trim(),
      USER_REFERENCE: String(row.USER_REFERENCE || '').trim(),
      SUMMARY_TEXT: String(row.RECIPIENT_NAME || '').trim(),
      SALE_ID: String(row.SALE_ID || '').trim(),
      TICKET_POSITION: String(row.TICKET_POSITION || '1').trim(),
      ORDER_TYPE: String(row.ORDER_TYPE || 'Delivery').trim() || 'Delivery',
      RECIPIENT_NAME: String(row.RECIPIENT_NAME || '').trim(),
      RECIPIENT_ADDRESS: String(row.RECIPIENT_ADDRESS || '').trim(),
      RECIPIENT_CITY: String(row.RECIPIENT_CITY || '').trim(),
      RECIPIENT_STATE: '',
      RECIPIENT_STATE_ABBREV: String(row.RECIPIENT_STATE_ABBREV || '').trim(),
      RECIPIENT_ZIP: String(row.RECIPIENT_ZIP || '').trim(),
      DELIVERY_DATE: String(row.DELIVERY_DATE || '').trim(),
    }));
    const dedupedRows = Array.from(
      new Map(rows.map(row => [String(row.ID || '').trim(), row])).values(),
    );
    return {
      dataset: 'DashboardEventDataset',
      tables: {
        OrderItems: dedupedRows,
        MessageItems: [],
      },
    };
  } catch {
    try {
      const xmlText = await callLiveMercury('dashboard', 'GetUndeliveredOrders', {});
      const dataset = parseSoapDatasetResponse(
        xmlText,
        'GetUndeliveredOrders',
        ['DashboardEventTable', 'MessageItems', 'OrderItems', 'BlabberItems', 'DeliveryZones'],
        'DashboardEventDataset'
      );
      return {
        dataset: 'DashboardEventDataset',
        tables: {
          OrderItems: dataset.tables?.OrderItems || [],
          MessageItems: dataset.tables?.MessageItems || [],
        },
      };
    } catch {
      return {
        dataset: 'DashboardEventDataset',
        tables: {
          OrderItems: [],
          MessageItems: [],
        },
      };
    }
  }
}

async function getLiveDashboardEnabled() {
  const xmlText = await callLiveMercury('dashboard', 'GetDashboardEnabled', {});
  return parseSoapBooleanResponse(xmlText, 'GetDashboardEnabled', true);
}

async function getLiveServerTime() {
  const xmlText = await callLiveMercury('framework', 'GetServerTime', {});
  return parseSoapStringResponse(xmlText, 'GetServerTime', new Date().toISOString());
}

async function getLiveTicketStatus(ticketId) {
  const xmlText = await callLiveMercury('orderentry', 'GetTicketStatus', { ticketID: ticketId });
  const dataset = parseSoapDatasetResponse(xmlText, 'GetTicketStatus', ['GetTicketStatus'], 'TicketStatusDataSet');
  const row = dataset.tables?.GetTicketStatus?.[0] || null;
  return {
    dataset: 'TicketStatusDataSet',
    table: 'GetTicketStatus',
    byTicketId: row ? { [ticketId]: row } : {}
  };
}

async function getLiveOrderDetails(ticketId) {
  const xmlText = await callLiveMercury('delivery', 'LoadOrderDetails', { ticketID: ticketId });
  const dataset = parseSoapDatasetResponse(xmlText, 'LoadOrderDetails', ['DeliveryOrderDetailsLoad'], 'OrderDetailsDataset');
  return {
    dataset: 'OrderDetailsDataset',
    table: 'DeliveryOrderDetailsLoad',
    rows: dataset.tables?.DeliveryOrderDetailsLoad || []
  };
}

async function getLiveLifecycleByTicket(ticketId) {
  const xmlText = await callLiveMercury('orderlifecycle', 'OLCGetByTicket', { TicketID: ticketId });
  const dataset = parseSoapDatasetResponse(xmlText, 'OLCGetByTicket', ['OLCStatusMsg'], 'OrderLifeCycleMsgDataSet');
  return {
    dataset: 'OrderLifeCycleMsgDataSet',
    table: 'OLCStatusMsg',
    rows: dataset.tables?.OLCStatusMsg || []
  };
}

async function getLiveLifecycleByServiceMsg(serviceMsgNum) {
  const xmlText = await callLiveMercury('orderlifecycle', 'OLCGetBySERVICE_MSG_NUM', { SERVICE_MSG_NUM: serviceMsgNum });
  const dataset = parseSoapDatasetResponse(xmlText, 'OLCGetBySERVICE_MSG_NUM', ['OLCStatusMsg'], 'OrderLifeCycleMsgDataSet');
  return {
    dataset: 'OrderLifeCycleMsgDataSet',
    table: 'OLCStatusMsg',
    rows: dataset.tables?.OLCStatusMsg || []
  };
}

async function getLiveZoneSummary(params) {
  const xmlText = await callLiveMercury('delivery', 'LoadZoneSummary', params);
  const dataset = parseSoapDatasetResponse(xmlText, 'LoadZoneSummary', ['LoadZoneSummary'], 'ZoneSummaryDataSet');
  return {
    dataset: 'ZoneSummaryDataSet',
    table: 'LoadZoneSummary',
    rows: dataset.tables?.LoadZoneSummary || []
  };
}

async function getLiveInProgressRouteSummary(params) {
  const xmlText = await callLiveMercury('delivery', 'LoadInProgressRouteSummary', params);
  const dataset = parseSoapDatasetResponse(
    xmlText,
    'LoadInProgressRouteSummary',
    ['LoadInProgressRouteSummary'],
    'InProgressRouteSummaryDataSet'
  );
  return {
    dataset: 'InProgressRouteSummaryDataSet',
    table: 'LoadInProgressRouteSummary',
    rows: dataset.tables?.LoadInProgressRouteSummary || []
  };
}

async function getLiveFailedDelivery() {
  const xmlText = await callLiveMercury('delivery', 'LoadFailedDelivery', {});
  const dataset = parseSoapDatasetResponse(xmlText, 'LoadFailedDelivery', ['LoadFailedDelivery'], 'FailedDeliveryDataSet');
  return {
    dataset: 'FailedDeliveryDataSet',
    table: 'LoadFailedDelivery',
    rows: dataset.tables?.LoadFailedDelivery || []
  };
}

async function getLiveDeliveryLookupIds() {
  const now = Date.now();
  if (
    liveDeliveryLookupCache.expiresAt > now
    && liveDeliveryLookupCache.storeIds.length > 0
    && liveDeliveryLookupCache.zoneIds.length > 0
  ) {
    return {
      storeIds: liveDeliveryLookupCache.storeIds,
      zoneIds: liveDeliveryLookupCache.zoneIds
    };
  }

  try {
    const [storesXml, zonesXml] = await Promise.all([
      callLiveMercurySoap12('delivery', 'LoadStore', ''),
      callLiveMercurySoap12('delivery', 'LoadZone', ''),
    ]);

    const storesDs = parseSoapDatasetResponse(storesXml, 'LoadStore', ['DeliveryStoreLoad', 'LoadStore'], 'StoreDataset');
    const zonesDs = parseSoapDatasetResponse(zonesXml, 'LoadZone', ['DeliveryZoneLoad', 'LoadZone'], 'ZoneDataset');
    const storeRows = [
      ...(storesDs.tables?.DeliveryStoreLoad || []),
      ...(storesDs.tables?.LoadStore || []),
    ];
    const zoneRows = [
      ...(zonesDs.tables?.DeliveryZoneLoad || []),
      ...(zonesDs.tables?.LoadZone || []),
    ];

    const storeIds = uniqueNumericIds(storeRows.flatMap(row => [row.ID, row.STORE_ID]));
    const zoneIds = uniqueNumericIds(zoneRows.flatMap(row => [row.DELIVERY_ZONE_ID, row.ZONE_ID, row.ID]));
    if (!storeIds.length || !zoneIds.length) {
      throw new Error(`LoadStore/LoadZone did not return usable IDs (stores=${storeIds.length}, zones=${zoneIds.length}).`);
    }

    liveDeliveryLookupCache.expiresAt = now + Math.max(30000, liveDeliveryLookupTtlMs);
    liveDeliveryLookupCache.storeIds = storeIds;
    liveDeliveryLookupCache.zoneIds = zoneIds;
    return { storeIds, zoneIds };
  } catch (error) {
    if (liveDeliveryLookupCache.storeIds.length && liveDeliveryLookupCache.zoneIds.length) {
      return {
        storeIds: liveDeliveryLookupCache.storeIds,
        zoneIds: liveDeliveryLookupCache.zoneIds
      };
    }
    throw error;
  }
}

function normalizeLiveZoneOrderRow(rawRow, fallbackDeliveryDate = '') {
  const row = rawRow || {};
  const userReference = String(row.USER_REFERENCE || '').trim();
  const userRefParts = userReference.split('/');
  const saleFromRef = String(userRefParts[0] || '').trim();
  const posFromRef = String(userRefParts[1] || '').trim();
  const invoiceNo = String(row.INVOICE_NO || row.INVOICE || '').trim();
  const rawTicketId = String(row.ID || row.TICKET_ID || row.TICKETID || '').trim();
  const rawSaleId = String(row.SALE_ID || row.SALEID || row.ORDER_ID || row.ORDER_NO || '').trim();
  const saleId = saleFromRef || rawSaleId || invoiceNo || rawTicketId;
  const ticketId = rawTicketId || invoiceNo || saleId;
  const ticketPosition = posFromRef
    || String(row.TICKET_POSITION || row.TICKETPOS || row.POSITION || '').trim()
    || '1';
  const designed = boolFromMercuryFlag(row.DESIGNED_IND ?? row.DESIGNED ?? row.IS_DESIGNED);
  const assigned = boolFromMercuryFlag(row.ASSIGNED_IND ?? row.ASSIGNED ?? row.IS_ASSIGNED);
  const delivered = boolFromMercuryFlag(row.DELIVERED_IND ?? row.DELIVERED ?? row.IS_DELIVERED);
  const routeName = String(row.ROUTE_NAME || row.ROUTE || '').trim();
  const rawStatus = String(row.STATUS || row.ORDER_STATUS || row.DELIVERY_STATUS || '').trim();

  let status = rawStatus.toUpperCase();
  if (!status) {
    status = 'NOT_DESIGNED';
    if (delivered) status = 'DELIVERED';
    else if (assigned || routeName) status = 'ON_TRUCK';
    else if (designed) status = 'DESIGNED';
  }

  const deliveryDate = String(
    row.DELIVERY_DATE
      || row.DELIVERY_DATETIME
      || fallbackDeliveryDate
      || ''
  ).trim();
  const normalizedUserReference = userReference
    || (saleId && ticketPosition ? `${saleId}/${ticketPosition}` : saleId || ticketId);

  return {
    ID: String(ticketId || '').trim(),
    INVOICE_NO: String(invoiceNo || '').trim(),
    SALE_ID: String(saleId || '').trim(),
    TICKET_POSITION: ticketPosition,
    RECIPIENT_NAME: String(row.RECIPIENT_NAME || '').trim(),
    ZONE_ID: String(row.DELIVERY_ZONE_ID || row.ZONE_ID || '').trim(),
    ZONE_NAME: String(row.DELIVERY_ZONE_NAME || row.ZONE_NAME || row.ZONENAMECODE || '').trim(),
    PRIORITY_ID: String(row.DELIVERY_PRIORITY_CODE_ID || row.PRIORITY_ID || '').trim(),
    PRIORITY_NAME: String(row.PRIORITY || row.PRIORITY_CODE || '').trim(),
    ROUTE_NAME: routeName,
    DELIVERY_DATE: deliveryDate,
    DESIGNED_IND: designed ? '1' : '0',
    STATUS: status,
    LATITUDE: String(row.LATITUDE || '').trim(),
    LONGITUDE: String(row.LONGITUDE || '').trim(),
    RECIPIENT_ADDRESS: firstRowValue(row, [
      'RECIPIENT_ADDRESS',
      'RECIPIENT_ADDRESS_1',
      'RECIPIENT_ADDRESS1',
      'RECIPIENT_ADDR1',
      'RECIP_ADDR1',
      'ADDRESS',
      'ADDR1',
      'ADDR_LINE1',
      'STREET',
      'STREET_ADDRESS',
    ]),
    RECIPIENT_CITY: firstRowValue(row, ['RECIPIENT_CITY', 'RECIPIENT_CITY_NAME', 'CITY', 'CITY_NAME']),
    RECIPIENT_STATE_ABBREV: String(
      row.RECIPIENT_STATE_ABBREV
      || row.RECIPIENT_STATE_PROV_NAME
      || row.STATE_PROVINCE_NAME
      || row.STATE_NAME
      || row.STATE_ABBREV
      || row.STATE
      || ''
    ).trim(),
    RECIPIENT_ZIP: firstRowValue(row, [
      'RECIPIENT_ZIP',
      'RECIPIENT_ZIP_CODE',
      'RECIPIENT_POSTAL_CODE',
      'ZIP_CODE',
      'ZIP',
      'POSTAL_CODE',
      'POST_CODE',
    ]),
    USER_REFERENCE: normalizedUserReference
  };
}

function addressLookupCacheKey(address = {}) {
  return buildLiveCacheKey('distance-address-coords', {
    firmName: normalizeAddressText(address.firmName || ''),
    addressLine1: normalizeAddressText(address.addressLine1 || ''),
    addressLine2: normalizeAddressText(address.addressLine2 || ''),
    city: normalizeAddressText(address.city || ''),
    state: normalizeAddressText(address.state || ''),
    postalCode: normalizePostalCode(address.postalCode || ''),
    country: normalizeAddressText(address.country || ''),
  });
}

function routeDistanceCacheKey(origin, destination) {
  const originLat = roundTo(origin?.latitude, 5);
  const originLon = roundTo(origin?.longitude, 5);
  const destinationLat = roundTo(destination?.latitude, 5);
  const destinationLon = roundTo(destination?.longitude, 5);
  return buildLiveCacheKey('distance-route', {
    profile: mapboxProfile,
    originLat,
    originLon,
    destinationLat,
    destinationLon,
  });
}

function scoreMatchedAddressCandidate(candidate = {}, target = {}) {
  let score = 0;
  const targetPostal = normalizePostalCode(target.postalCode || '');
  const candidatePostal = normalizePostalCode(candidate.PostalCode || candidate.postalCode || '');
  if (targetPostal && candidatePostal && targetPostal === candidatePostal) score += 40;

  const targetCity = normalizeAddressText(target.city || '');
  const candidateCity = normalizeAddressText(candidate.City || candidate.city || '');
  if (targetCity && candidateCity && targetCity === candidateCity) score += 14;

  const targetState = normalizeAddressText(target.state || '');
  const candidateState = normalizeAddressText(candidate.State || candidate.state || '');
  if (targetState && candidateState && targetState === candidateState) score += 12;

  const targetAddressLine = normalizeAddressText(target.addressLine1 || '');
  const candidateAddressLine = normalizeAddressText(candidate.AddressLine1 || candidate.addressLine1 || '');
  if (targetAddressLine && candidateAddressLine) {
    if (targetAddressLine === candidateAddressLine) score += 18;
    else if (candidateAddressLine.includes(targetAddressLine) || targetAddressLine.includes(candidateAddressLine)) score += 8;
  }
  return score;
}

async function getLiveMainStoreCoords() {
  const now = Date.now();
  if (liveMainStoreCoordCache.expiresAt > now && liveMainStoreCoordCache.point) {
    return liveMainStoreCoordCache.point;
  }

  const cacheKey = buildLiveCacheKey('distance-main-store', {});
  const { payload } = await getLiveCachedPayload(cacheKey, Math.max(30000, liveDeliveryLookupTtlMs), async () => {
    const xmlText = await callLiveMercurySoap12('delivery', 'LoadMainStore', '');
    const dataset = parseSoapDatasetResponse(
      xmlText,
      'LoadMainStore',
      ['DeliveryStoreDetailsLoad', 'LoadMainStore', 'StoreDetails'],
      'StoreDetailsDataset',
    );
    const rows = [
      ...(dataset.tables?.DeliveryStoreDetailsLoad || []),
      ...(dataset.tables?.LoadMainStore || []),
      ...(dataset.tables?.StoreDetails || []),
    ];
    for (const row of rows) {
      const coords = extractCoordsFromRow(
        row,
        ['LATITUDE', 'Latitude', 'latitude'],
        ['LONGITUDE', 'Longitude', 'longitude'],
      );
      if (coords) {
        return {
          ...coords,
          source: 'main_store',
        };
      }
    }
    throw new Error('LoadMainStore did not return usable LATITUDE/LONGITUDE.');
  });

  liveMainStoreCoordCache.expiresAt = now + Math.max(30000, liveDeliveryLookupTtlMs);
  liveMainStoreCoordCache.point = payload;
  return payload;
}

function firstNonEmptyAddressField(...values) {
  for (const value of values) {
    const text = normalizeSpace(value);
    if (text) return text;
  }
  return '';
}

async function getLiveOrderDistanceContext(ticketId) {
  const id = String(ticketId || '').trim();
  if (!id) return { coords: null, address: null };
  const details = await getLiveOrderDetails(id);
  const row = details?.rows?.[0] || null;
  if (!row) return { coords: null, address: null };

  const coords = extractCoordsFromRow(
    row,
    ['RECIPIENT_LATITUDE', 'LATITUDE', 'Latitude', 'latitude'],
    ['RECIPIENT_LONGITUDE', 'LONGITUDE', 'Longitude', 'longitude'],
  );

  const address = {
    firmName: firstNonEmptyAddressField(row.RECIPIENT_NAME, row.FIRM_NAME),
    addressLine1: firstNonEmptyAddressField(
      row.RECIPIENT_ADDRESS,
      row.RECIPIENT_ADDRESS_1,
      row.ADDRESS,
      row.STREET,
    ),
    addressLine2: firstNonEmptyAddressField(row.RECIPIENT_ADDRESS_2, row.ADDRESS2),
    city: firstNonEmptyAddressField(row.RECIPIENT_CITY, row.RECIPIENT_CITY_NAME, row.CITY_NAME, row.CITY),
    state: firstNonEmptyAddressField(
      row.RECIPIENT_STATE_ABBREV,
      row.RECIPIENT_STATE_PROV_NAME,
      row.RECIPIENT_STATE,
      row.STATE_ABBREV,
      row.STATE_NAME,
      row.STATE,
    ),
    postalCode: firstNonEmptyAddressField(
      row.RECIPIENT_ZIP,
      row.RECIPIENT_POSTAL_CODE,
      row.RECIPIENT_ZIP_CODE,
      row.ZIP,
      row.ZIP_CODE,
      row.POSTAL_CODE,
    ),
    country: firstNonEmptyAddressField(row.COUNTRY_NAME, row.COUNTRY, 'US'),
  };

  return { coords, address };
}

async function resolveDestinationCoordsFromAddress(address = {}) {
  const addressLine1 = normalizeSpace(address.addressLine1 || '');
  const city = normalizeSpace(address.city || '');
  const state = normalizeSpace(address.state || '');
  const postalCode = normalizePostalCode(address.postalCode || '');
  const country = normalizeSpace(address.country || 'US') || 'US';
  const firmName = normalizeSpace(address.firmName || '');
  const addressLine2 = normalizeSpace(address.addressLine2 || '');

  if (!addressLine1 && !city && !state && !postalCode) return null;

  const cacheKey = addressLookupCacheKey({
    firmName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
  });

  const { payload } = await getLiveCachedPayload(cacheKey, mapboxAddressCacheTtlMs, async () => {
    const payloadXml = [
      `<firmName>${xmlEscape(firmName)}</firmName>`,
      `<addressLine1>${xmlEscape(addressLine1)}</addressLine1>`,
      `<addressLine2>${xmlEscape(addressLine2)}</addressLine2>`,
      `<city>${xmlEscape(city)}</city>`,
      `<state>${xmlEscape(state)}</state>`,
      `<postalCode>${xmlEscape(postalCode)}</postalCode>`,
      `<country>${xmlEscape(country)}</country>`,
      '<upgradeToMostProbableMatch>true</upgradeToMostProbableMatch>',
    ].join('');

    const xmlText = await callLiveMercurySoap11('addressverification', 'ValidateAddress', payloadXml);
    const candidates = parseTableRows(xmlText, 'MatchedAddress');
    let winner = null;
    let winnerScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const coords = extractCoordsFromRow(
        candidate,
        ['Latitude', 'LATITUDE', 'latitude'],
        ['Longitude', 'LONGITUDE', 'longitude'],
      );
      if (!coords) continue;
      const score = scoreMatchedAddressCandidate(candidate, {
        addressLine1,
        city,
        state,
        postalCode,
      });
      if (score > winnerScore) {
        winner = coords;
        winnerScore = score;
      }
    }

    if (!winner) {
      throw new Error('AddressVerification.ValidateAddress returned no usable coordinates.');
    }

    return {
      ...winner,
      source: 'address_verification',
    };
  });

  return payload;
}

async function getMapboxRouteDistance(origin, destination) {
  if (!mapboxToken) {
    throw new Error('MAPBOX_TOKEN is missing.');
  }

  const cacheKey = routeDistanceCacheKey(origin, destination);
  const { payload } = await getLiveCachedPayload(cacheKey, mapboxRouteCacheTtlMs, async () => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, mapboxTimeoutMs));
    try {
      const coordinates = `${destination.longitude},${destination.latitude}`;
      const originCoords = `${origin.longitude},${origin.latitude}`;
      const profilePath = String(mapboxProfile || 'mapbox/driving')
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');
      const endpoint = `${mapboxApiBaseUrl}/directions/v5/${profilePath}/${originCoords};${coordinates}`;
      const params = new URLSearchParams({
        alternatives: 'false',
        steps: 'false',
        overview: 'false',
        access_token: mapboxToken,
      });
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`Mapbox Directions failed (${response.status}): ${bodyText.slice(0, 240)}`);
      }
      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error('Mapbox Directions returned invalid JSON.');
      }
      const route = Array.isArray(body?.routes) ? body.routes[0] : null;
      const distanceMeters = Number(route?.distance);
      const durationSeconds = Number(route?.duration);
      if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
        throw new Error('Mapbox Directions did not include route distance.');
      }

      const milesRaw = distanceMeters / 1609.344;
      const minutesRaw = Number.isFinite(durationSeconds) && durationSeconds > 0 ? (durationSeconds / 60) : null;
      return {
        distance_miles: roundTo(milesRaw, 1),
        duration_minutes: minutesRaw === null ? null : Math.max(1, Math.round(minutesRaw)),
        provider: 'mapbox_directions',
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  });

  return payload;
}

function buildMapboxGeocodeQuery(address = {}) {
  const parts = [
    normalizeSpace(address.addressLine1 || ''),
    normalizeSpace(address.addressLine2 || ''),
    normalizeSpace(address.city || ''),
    normalizeSpace(address.state || ''),
    normalizePostalCode(address.postalCode || ''),
    normalizeSpace(address.country || ''),
  ].filter(Boolean);
  return parts.join(', ');
}

async function getMapboxGeocodeCoords(address = {}) {
  if (!mapboxToken) {
    throw new Error('MAPBOX_TOKEN is missing.');
  }
  const query = buildMapboxGeocodeQuery(address);
  if (!query) {
    throw new Error('Mapbox geocode query is empty.');
  }
  const country = normalizeSpace(address.country || 'US').toLowerCase();
  const cacheKey = buildLiveCacheKey('distance-mapbox-geocode', { query, country });
  const { payload } = await getLiveCachedPayload(cacheKey, mapboxAddressCacheTtlMs, async () => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, mapboxTimeoutMs));
    try {
      const encodedQuery = encodeURIComponent(query);
      const endpoint = `${mapboxApiBaseUrl}/geocoding/v5/mapbox.places/${encodedQuery}.json`;
      const params = new URLSearchParams({
        access_token: mapboxToken,
        limit: '1',
        autocomplete: 'false',
      });
      if (country) {
        params.set('country', country);
      }
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`Mapbox Geocoding failed (${response.status}): ${bodyText.slice(0, 240)}`);
      }
      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error('Mapbox Geocoding returned invalid JSON.');
      }
      const feature = Array.isArray(body?.features) ? body.features[0] : null;
      const center = Array.isArray(feature?.center) ? feature.center : null;
      if (!center || center.length < 2) {
        throw new Error('Mapbox Geocoding returned no coordinate match.');
      }
      const lon = Number(center[0]);
      const lat = Number(center[1]);
      if (!hasUsableCoords(lat, lon)) {
        throw new Error('Mapbox Geocoding returned unusable coordinates.');
      }
      return {
        latitude: lat,
        longitude: lon,
        source: 'mapbox_geocoding',
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  });
  return payload;
}

function normalizeMapboxFeature(feature) {
  const coordinates = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates
    : (Array.isArray(feature?.center) ? feature.center : null);
  const longitude = Number(coordinates?.[0]);
  const latitude = Number(coordinates?.[1]);
  if (!hasUsableCoords(latitude, longitude)) return null;
  const properties = feature?.properties || {};
  const label = normalizeSpace(
    properties.full_address
    || properties.place_formatted
    || feature?.place_name
    || properties.name
    || feature?.text
    || '',
  );
  return {
    id: String(feature?.id || feature?.mapbox_id || properties.mapbox_id || label || ''),
    label,
    address: label,
    latitude,
    longitude,
  };
}

function mapboxRequestContextFromReq(req) {
  return {
    referer: firstHeaderValue(req.headers.referer),
    origin: firstHeaderValue(req.headers.origin),
  };
}

function mapboxRequestHeaders(accept, options = {}) {
  const headers = { Accept: accept };
  const referer = normalizeSpace(options.referer || options.referrer || '');
  const origin = normalizeSpace(options.origin || '');
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  return headers;
}

async function getMapboxAddressSuggestions(query, options = {}) {
  if (!mapboxToken) {
    throw new Error('MAPBOX_TOKEN is missing.');
  }
  const normalizedQuery = normalizeSpace(query || '');
  if (normalizedQuery.length < 3) {
    return { suggestions: [], mapboxEnabled: Boolean(mapboxToken) };
  }
  const country = normalizeSpace(options.country || 'US').toLowerCase();
  const limit = Math.max(1, Math.min(8, Number(options.limit || 5) || 5));
  const cacheKey = buildLiveCacheKey('mapbox-address-suggest', { query: normalizedQuery, country, limit });
  const { payload } = await getLiveCachedPayload(cacheKey, mapboxAddressCacheTtlMs, async () => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, mapboxTimeoutMs));
    try {
      const headers = mapboxRequestHeaders('application/json', options);
      let v6Error = '';
      let v6NoMatches = false;

      const v6Endpoint = `${mapboxApiBaseUrl}/search/geocode/v6/forward`;
      const v6Params = new URLSearchParams({
        access_token: mapboxToken,
        q: normalizedQuery,
        limit: String(limit),
        autocomplete: 'true',
        types: 'address,street,place,postcode',
      });
      if (country) v6Params.set('country', country);
      const v6Response = await fetch(`${v6Endpoint}?${v6Params.toString()}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const v6BodyText = await v6Response.text();
      if (v6Response.ok) {
        let body = null;
        try {
          body = JSON.parse(v6BodyText);
        } catch {
          throw new Error('Mapbox Geocoding v6 returned invalid JSON.');
        }
        const suggestions = (Array.isArray(body?.features) ? body.features : [])
          .map(normalizeMapboxFeature)
          .filter(Boolean);
        if (suggestions.length) {
          return {
            suggestions,
            mapboxEnabled: true,
            provider: 'mapbox_geocoding_v6',
          };
        }
        v6NoMatches = true;
      } else {
        v6Error = `v6 (${v6Response.status}): ${v6BodyText.slice(0, 240)}`;
      }

      const v5Endpoint = `${mapboxApiBaseUrl}/geocoding/v5/mapbox.places/${encodeURIComponent(normalizedQuery)}.json`;
      const v5Params = new URLSearchParams({
        access_token: mapboxToken,
        limit: String(limit),
        autocomplete: 'true',
        types: 'address,poi,place',
      });
      if (country) v5Params.set('country', country);
      const response = await fetch(`${v5Endpoint}?${v5Params.toString()}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`Mapbox Geocoding failed. ${v6Error || (v6NoMatches ? 'v6 returned no matches.' : 'v6 was not attempted.')}; v5 (${response.status}): ${bodyText.slice(0, 240)}`);
      }
      let body = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error('Mapbox Geocoding returned invalid JSON.');
      }
      const suggestions = (Array.isArray(body?.features) ? body.features : [])
        .map(normalizeMapboxFeature)
        .filter(Boolean);
      return {
        suggestions,
        mapboxEnabled: true,
        provider: suggestions.length ? 'mapbox_geocoding_v5' : (v6NoMatches ? 'mapbox_geocoding_v6_v5_no_matches' : 'mapbox_geocoding_v5'),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  });
  return payload;
}

async function getMapboxStaticMapImage(params = {}) {
  if (!mapboxToken) {
    throw new Error('MAPBOX_TOKEN is missing.');
  }
  const latitude = Number(params.latitude);
  const longitude = Number(params.longitude);
  if (!hasUsableCoords(latitude, longitude)) {
    throw new Error('Mapbox static map requires usable latitude and longitude.');
  }
  const width = Math.max(240, Math.min(900, Number(params.width || 640) || 640));
  const height = Math.max(140, Math.min(640, Number(params.height || 260) || 260));
  const zoom = Math.max(8, Math.min(18, Number(params.zoom || 14) || 14));
  const marker = `pin-s+1f3d64(${longitude.toFixed(6)},${latitude.toFixed(6)})`;
  const overlay = /^(1|true|yes)$/i.test(String(params.marker ?? 'false').trim()) ? `${marker}/` : '';
  const endpoint = `${mapboxApiBaseUrl}/styles/v1/mapbox/streets-v12/static/${overlay}${longitude.toFixed(6)},${latitude.toFixed(6)},${zoom},0/${Math.round(width)}x${Math.round(height)}@2x`;
  const url = `${endpoint}?${new URLSearchParams({
    access_token: mapboxToken,
    attribution: 'false',
    logo: 'false',
  }).toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: mapboxRequestHeaders('image/png,image/*', params),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Mapbox Static Images failed (${response.status}): ${body.toString('utf8').slice(0, 240)}`);
  }
  return {
    body,
    contentType: response.headers.get('content-type') || 'image/png',
  };
}

async function getMapboxDiagnostics(options = {}) {
  const diagnostics = {
    enabled: Boolean(mapboxToken),
    apiBaseUrl: mapboxApiBaseUrl,
    forwardedReferer: Boolean(options.referer || options.origin),
    geocoding: {
      ok: false,
      matchCount: 0,
      firstMatch: '',
      error: '',
    },
    staticMap: {
      ok: false,
      contentType: '',
      bytes: 0,
      error: '',
    },
  };

  if (!mapboxToken) {
    diagnostics.geocoding.error = 'MAPBOX_TOKEN is missing.';
    diagnostics.staticMap.error = 'MAPBOX_TOKEN is missing.';
    return diagnostics;
  }

  try {
    const geocode = await getMapboxAddressSuggestions('608 Foreland Street Pittsburgh PA 15212', {
      country: 'US',
      limit: 1,
      referer: options.referer,
      origin: options.origin,
    });
    const suggestions = Array.isArray(geocode?.suggestions) ? geocode.suggestions : [];
    diagnostics.geocoding.ok = suggestions.length > 0;
    diagnostics.geocoding.matchCount = suggestions.length;
    diagnostics.geocoding.firstMatch = String(suggestions[0]?.address || suggestions[0]?.label || '');
    if (!suggestions.length) {
      diagnostics.geocoding.error = 'Mapbox returned no geocoding matches for the diagnostic address.';
    }
  } catch (error) {
    diagnostics.geocoding.error = String(error?.message || error);
  }

  try {
    const image = await getMapboxStaticMapImage({
      latitude: 40.454896,
      longitude: -79.999037,
      width: 320,
      height: 180,
      zoom: 13,
      marker: false,
      referer: options.referer,
      origin: options.origin,
    });
    diagnostics.staticMap.ok = Buffer.isBuffer(image.body) && image.body.length > 0;
    diagnostics.staticMap.contentType = String(image.contentType || '');
    diagnostics.staticMap.bytes = Buffer.isBuffer(image.body) ? image.body.length : 0;
    if (!diagnostics.staticMap.ok) {
      diagnostics.staticMap.error = 'Mapbox returned an empty static map image.';
    }
  } catch (error) {
    diagnostics.staticMap.error = String(error?.message || error);
  }

  return diagnostics;
}

function normalizeWeatherZipValue(raw = '') {
  const match = String(raw || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || '15212';
}

function buildWeatherLocationLabel(location = {}) {
  const city = normalizeSpace(location.name || '');
  const region = normalizeSpace(location.admin1 || location.state || '');
  if (city && region) return `${city}, ${region}`;
  return city || region || 'Local forecast';
}

function parseWeatherSunTime(isoDateTime) {
  if (!isoDateTime) return '--';
  const timePart = String(isoDateTime || '').split('T')[1] || '';
  const [rawHour, rawMinute] = timePart.split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '--';
  const period = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${period}`;
}

function weatherNumber(raw, fallback = 0) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function weatherCodeFromText(raw = '') {
  const text = String(raw || '').toLowerCase();
  if (/thunder|storm/.test(text)) return 95;
  if (/snow|sleet|flurr/.test(text)) return 71;
  if (/freezing|ice/.test(text)) return 66;
  if (/shower/.test(text)) return 80;
  if (/rain/.test(text)) return 61;
  if (/drizzle/.test(text)) return 51;
  if (/fog|mist|haze/.test(text)) return 45;
  if (/overcast|cloudy/.test(text)) return 3;
  if (/partly/.test(text)) return 2;
  if (/mostly/.test(text)) return 1;
  if (/sunny|clear|fair/.test(text)) return 0;
  return 3;
}

function windSpeedMph(raw = '') {
  const matches = String(raw || '').match(/\d+(?:\.\d+)?/g) || [];
  const speeds = matches.map(Number).filter(Number.isFinite);
  if (speeds.length === 0) return 0;
  return Math.round(Math.max(...speeds));
}

function compassToDegrees(raw = '') {
  const dir = String(raw || '').trim().toUpperCase();
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = dirs.indexOf(dir);
  return idx >= 0 ? idx * 22.5 : 0;
}

function precipProbabilityFromNws(period = {}) {
  return weatherNumber(period?.probabilityOfPrecipitation?.value, 0);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 10000));
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`${url} failed (${response.status}): ${bodyText.slice(0, 240)}`);
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error(`${url} returned invalid JSON.`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveWeatherLocation(zip) {
  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({
    name: zip,
    count: '10',
    language: 'en',
    format: 'json',
    countryCode: 'US',
  }).toString()}`;

  try {
    const geocode = await fetchJsonWithTimeout(geocodeUrl, {}, weatherTimeoutMs);
    const results = Array.isArray(geocode?.results) ? geocode.results : [];
    const match = results.find(result => String(result?.country_code || '').toUpperCase() === 'US') || results[0];
    const latitude = Number(match?.latitude);
    const longitude = Number(match?.longitude);
    if (hasUsableCoords(latitude, longitude)) {
      return {
        latitude,
        longitude,
        name: match?.name,
        admin1: match?.admin1,
        source: 'open_meteo_geocoding',
      };
    }
  } catch {
    // Fall through to ZIP lookup fallback.
  }

  const zipLookupUrl = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const zipLookup = await fetchJsonWithTimeout(zipLookupUrl, {}, weatherTimeoutMs);
  const place = Array.isArray(zipLookup?.places) ? zipLookup.places[0] : null;
  const latitude = Number(place?.latitude);
  const longitude = Number(place?.longitude);
  if (!hasUsableCoords(latitude, longitude)) {
    throw new Error(`No usable US weather location found for ZIP ${zip}.`);
  }
  return {
    latitude,
    longitude,
    name: place?.['place name'] || zipLookup?.['post code'] || zip,
    admin1: place?.state || place?.['state abbreviation'] || '',
    source: 'zippopotam_us',
  };
}

async function fetchNwsRadarStationLive(lat, lon) {
  try {
    const data = await fetchJsonWithTimeout(
      `https://api.weather.gov/points/${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'FTD-Mercury-Dashboard/1.0 (florist-dashboard)',
        },
      },
      weatherTimeoutMs,
    );
    return normalizeSpace(data?.properties?.radarStation || '') || null;
  } catch {
    return null;
  }
}

function buildNwsDayForecast(periods = [], dayIndex = 0) {
  const groups = new Map();
  for (const period of periods) {
    const dateKey = normalizeSpace(period?.startTime || '').slice(0, 10);
    if (!dateKey) continue;
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(period);
  }

  const dateKey = Array.from(groups.keys()).sort()[dayIndex] || Array.from(groups.keys()).sort()[0] || '';
  const dayPeriods = groups.get(dateKey) || [];
  const daytimePeriods = dayPeriods.filter(period => Boolean(period?.isDaytime));
  const nighttimePeriods = dayPeriods.filter(period => !period?.isDaytime);
  const highSource = daytimePeriods.length > 0 ? daytimePeriods : dayPeriods;
  const lowSource = nighttimePeriods.length > 0 ? nighttimePeriods : dayPeriods;
  const displayPeriod = daytimePeriods[0] || dayPeriods[0] || {};
  const highTemps = highSource.map(period => weatherNumber(period?.temperature)).filter(Number.isFinite);
  const lowTemps = lowSource.map(period => weatherNumber(period?.temperature)).filter(Number.isFinite);
  const precipValues = dayPeriods.map(precipProbabilityFromNws).filter(Number.isFinite);

  return {
    high: highTemps.length > 0 ? Math.round(Math.max(...highTemps)) : 0,
    low: lowTemps.length > 0 ? Math.round(Math.min(...lowTemps)) : 0,
    weatherCode: weatherCodeFromText(displayPeriod?.shortForecast || displayPeriod?.detailedForecast || ''),
    precipSum: 0,
    precipProbability: precipValues.length > 0 ? Math.max(...precipValues) : 0,
    sunrise: '--',
    sunset: '--',
  };
}

function buildNwsForecastPayload(zip, location, point, dailyForecast, hourlyForecast) {
  const dailyPeriods = Array.isArray(dailyForecast?.properties?.periods) ? dailyForecast.properties.periods : [];
  const hourlyPeriods = Array.isArray(hourlyForecast?.properties?.periods) ? hourlyForecast.properties.periods : [];
  if (hourlyPeriods.length === 0 && dailyPeriods.length === 0) {
    throw new Error('NWS forecast response did not include forecast periods.');
  }

  const current = hourlyPeriods[0] || dailyPeriods[0] || {};
  const hourly = hourlyPeriods.slice(0, 12).map((period) => {
    const iso = normalizeSpace(period?.startTime || '');
    const hour = Number((iso.split('T')[1] || '').split(':')[0]);
    return {
      isoTime: iso,
      hour: Number.isFinite(hour) ? hour : 0,
      temp: Math.round(weatherNumber(period?.temperature)),
      precipProbability: precipProbabilityFromNws(period),
      weatherCode: weatherCodeFromText(period?.shortForecast || period?.detailedForecast || ''),
    };
  });

  return {
    zip,
    location: {
      label: buildWeatherLocationLabel(location),
      lat: Number(location.latitude),
      lon: Number(location.longitude),
      source: location.source || 'unknown',
    },
    current: {
      temp: Math.round(weatherNumber(current?.temperature)),
      feelsLike: Math.round(weatherNumber(current?.temperature)),
      humidity: 0,
      windSpeed: windSpeedMph(current?.windSpeed),
      windDirection: compassToDegrees(current?.windDirection),
      weatherCode: weatherCodeFromText(current?.shortForecast || current?.detailedForecast || ''),
      isDay: current?.isDaytime !== false,
      precipitation: 0,
    },
    today: buildNwsDayForecast(dailyPeriods, 0),
    tomorrow: buildNwsDayForecast(dailyPeriods, 1),
    hourly,
    radarStation: normalizeSpace(point?.properties?.radarStation || '') || null,
    provider: 'nws',
  };
}

async function fetchWeatherForecastFromNws(zip, location) {
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  const point = await fetchJsonWithTimeout(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    {
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': 'FTD-Mercury-Dashboard/1.0 (florist-dashboard)',
      },
    },
    weatherTimeoutMs,
  );
  const forecastUrl = normalizeSpace(point?.properties?.forecast || '');
  const hourlyUrl = normalizeSpace(point?.properties?.forecastHourly || '');
  if (!forecastUrl || !hourlyUrl) {
    throw new Error('NWS points response did not include forecast URLs.');
  }
  const [dailyForecast, hourlyForecast] = await Promise.all([
    fetchJsonWithTimeout(forecastUrl, {
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': 'FTD-Mercury-Dashboard/1.0 (florist-dashboard)',
      },
    }, weatherTimeoutMs),
    fetchJsonWithTimeout(hourlyUrl, {
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': 'FTD-Mercury-Dashboard/1.0 (florist-dashboard)',
      },
    }, weatherTimeoutMs),
  ]);
  return buildNwsForecastPayload(zip, location, point, dailyForecast, hourlyForecast);
}

function buildWeatherForecastPayload(zip, location, forecast, radarStation) {
  const current = forecast?.current || {};
  const daily = forecast?.daily || {};
  const hourlyData = forecast?.hourly || {};
  const currentHourKey = normalizeSpace(current.time || '').slice(0, 13);

  const buildDay = (idx) => ({
    high: Math.round(weatherNumber(daily.temperature_2m_max?.[idx])),
    low: Math.round(weatherNumber(daily.temperature_2m_min?.[idx])),
    weatherCode: weatherNumber(daily.weather_code?.[idx]),
    precipSum: Math.round(weatherNumber(daily.precipitation_sum?.[idx]) * 10) / 10,
    precipProbability: weatherNumber(daily.precipitation_probability_max?.[idx]),
    sunrise: parseWeatherSunTime(daily.sunrise?.[idx]),
    sunset: parseWeatherSunTime(daily.sunset?.[idx]),
  });

  const hourlyTimes = Array.isArray(hourlyData.time) ? hourlyData.time : [];
  const hourlyTemps = Array.isArray(hourlyData.temperature_2m) ? hourlyData.temperature_2m : [];
  const hourlyPrecip = Array.isArray(hourlyData.precipitation_probability) ? hourlyData.precipitation_probability : [];
  const hourlyCodes = Array.isArray(hourlyData.weather_code) ? hourlyData.weather_code : [];
  const hourly = [];

  for (let i = 0; i < hourlyTimes.length && hourly.length < 12; i += 1) {
    const iso = normalizeSpace(hourlyTimes[i]);
    if (!iso) continue;
    if (currentHourKey && iso.slice(0, 13) < currentHourKey) continue;
    const hour = Number((iso.split('T')[1] || '').split(':')[0]);
    hourly.push({
      isoTime: iso,
      hour: Number.isFinite(hour) ? hour : 0,
      temp: Math.round(weatherNumber(hourlyTemps[i])),
      precipProbability: weatherNumber(hourlyPrecip[i]),
      weatherCode: weatherNumber(hourlyCodes[i]),
    });
  }

  return {
    zip,
    location: {
      label: buildWeatherLocationLabel(location),
      lat: Number(location.latitude),
      lon: Number(location.longitude),
      source: location.source || 'unknown',
    },
    current: {
      temp: Math.round(weatherNumber(current.temperature_2m)),
      feelsLike: Math.round(weatherNumber(current.apparent_temperature)),
      humidity: Math.round(weatherNumber(current.relative_humidity_2m)),
      windSpeed: Math.round(weatherNumber(current.wind_speed_10m)),
      windDirection: weatherNumber(current.wind_direction_10m),
      weatherCode: weatherNumber(current.weather_code),
      isDay: weatherNumber(current.is_day, 1) !== 0,
      precipitation: Math.round(weatherNumber(current.precipitation) * 100) / 100,
    },
    today: buildDay(0),
    tomorrow: buildDay(1),
    hourly,
    radarStation,
    provider: 'open_meteo',
  };
}

async function fetchWeatherForecastLive(zip) {
  const location = await resolveWeatherLocation(zip);
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);
  const forecastUrl = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '2',
  }).toString()}`;

  try {
    const [forecast, radarStation] = await Promise.all([
      fetchJsonWithTimeout(forecastUrl, {}, weatherTimeoutMs),
      fetchNwsRadarStationLive(lat, lon),
    ]);

    if (!forecast?.current) {
      throw new Error('Weather forecast response did not include current conditions.');
    }
    return buildWeatherForecastPayload(zip, location, forecast, radarStation);
  } catch (openMeteoError) {
    try {
      const nwsPayload = await fetchWeatherForecastFromNws(zip, location);
      return {
        ...nwsPayload,
        providerFallbackReason: String(openMeteoError?.message || openMeteoError),
      };
    } catch (nwsError) {
      throw new Error(
        `Open-Meteo failed: ${String(openMeteoError?.message || openMeteoError)}; `
        + `NWS fallback failed: ${String(nwsError?.message || nwsError)}`,
      );
    }
  }
}

function ensureWeatherForecastCacheLoaded() {
  if (weatherForecastCacheLoaded) return;
  weatherForecastCacheLoaded = true;
  if (!existsSync(weatherForecastCachePath)) return;
  try {
    const raw = readFileSync(weatherForecastCachePath, 'utf8');
    const parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
    const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    for (const [rawZip, entry] of Object.entries(entries)) {
      const zip = normalizeWeatherZipValue(rawZip);
      const fetchedAt = Number(entry?.fetchedAt || 0);
      if (!zip || !Number.isFinite(fetchedAt) || !entry?.payload) continue;
      weatherForecastCache.set(zip, { fetchedAt, payload: entry.payload });
    }
  } catch {
    weatherForecastCache.clear();
  }
}

function writeWeatherForecastCacheFile() {
  try {
    const now = Date.now();
    const maxAgeMs = Math.max(weatherForecastStaleTtlMs, weatherForecastCacheTtlMs);
    const entries = {};
    for (const [zip, entry] of weatherForecastCache.entries()) {
      if (maxAgeMs > 0 && now - Number(entry.fetchedAt || 0) > maxAgeMs) continue;
      entries[zip] = entry;
    }
    mkdirSync(dashboardConfigDir, { recursive: true });
    writeFileSync(weatherForecastCachePath, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`Unable to write weather forecast cache: ${String(error?.message || error)}`);
  }
}

function weatherPayloadFromCacheEntry(entry, cacheStatus, stale = false, warning = '') {
  return {
    ...entry.payload,
    cachedAt: new Date(Number(entry.fetchedAt || Date.now())).toISOString(),
    cacheStatus,
    stale,
    ...(warning ? { warning } : {}),
  };
}

async function getWeatherForecastCached(zip, bypass = false) {
  ensureWeatherForecastCacheLoaded();
  const cached = weatherForecastCache.get(zip);
  const now = Date.now();
  const freshTtlMs = Math.max(0, Number(weatherForecastCacheTtlMs) || 0);
  const staleTtlMs = Math.max(freshTtlMs, Number(weatherForecastStaleTtlMs) || 0);

  if (!bypass && cached && freshTtlMs > 0 && now - Number(cached.fetchedAt || 0) <= freshTtlMs) {
    return weatherPayloadFromCacheEntry(cached, 'HIT', false);
  }

  if (!bypass && weatherForecastInFlight.has(zip)) {
    return weatherForecastInFlight.get(zip);
  }

  const pending = (async () => {
    try {
      const payload = await fetchWeatherForecastLive(zip);
      const entry = { payload, fetchedAt: Date.now() };
      weatherForecastCache.set(zip, entry);
      writeWeatherForecastCacheFile();
      return weatherPayloadFromCacheEntry(entry, cached ? 'REFRESH' : 'MISS', false);
    } catch (error) {
      if (cached && staleTtlMs > 0 && now - Number(cached.fetchedAt || 0) <= staleTtlMs) {
        return weatherPayloadFromCacheEntry(cached, 'STALE', true, String(error?.message || error));
      }
      throw error;
    }
  })();

  if (!bypass) weatherForecastInFlight.set(zip, pending);
  try {
    return await pending;
  } finally {
    if (!bypass) weatherForecastInFlight.delete(zip);
  }
}

async function getLiveDistanceEstimate(params = {}) {
  const ticketId = String(params.ticketId || '').trim();
  const requestCoords = extractCoordsFromRow(
    params,
    ['latitude', 'lat', 'destLat', 'destinationLat'],
    ['longitude', 'lon', 'lng', 'destLon', 'destinationLon'],
  );
  const requestAddress = {
    firmName: String(params.firmName || '').trim(),
    addressLine1: String(params.addressLine1 || '').trim(),
    addressLine2: String(params.addressLine2 || '').trim(),
    city: String(params.city || '').trim(),
    state: String(params.state || '').trim(),
    postalCode: String(params.postalCode || params.zip || '').trim(),
    country: String(params.country || 'US').trim() || 'US',
  };

  const origin = await getLiveMainStoreCoords();
  let destination = requestCoords ? { ...requestCoords, source: 'request_coordinates' } : null;
  let destinationSource = destination?.source || '';
  let destinationAddressUsed = { ...requestAddress };

  if (!destination && ticketId) {
    try {
      const context = await getLiveOrderDistanceContext(ticketId);
      if (context?.coords) {
        destination = {
          latitude: context.coords.latitude,
          longitude: context.coords.longitude,
          source: 'order_details',
        };
        destinationSource = 'order_details';
      }
      if (context?.address) {
        destinationAddressUsed = {
          firmName: destinationAddressUsed.firmName || context.address.firmName || '',
          addressLine1: destinationAddressUsed.addressLine1 || context.address.addressLine1 || '',
          addressLine2: destinationAddressUsed.addressLine2 || context.address.addressLine2 || '',
          city: destinationAddressUsed.city || context.address.city || '',
          state: destinationAddressUsed.state || context.address.state || '',
          postalCode: destinationAddressUsed.postalCode || context.address.postalCode || '',
          country: destinationAddressUsed.country || context.address.country || 'US',
        };
      }
    } catch {
      // Fall through to address verification path if order-details lookup fails.
    }
  }

  if (!destination) {
    try {
      destination = await resolveDestinationCoordsFromAddress(destinationAddressUsed);
      destinationSource = destination?.source || 'address_verification';
    } catch {
      destination = null;
    }
  }

  if (!destination) {
    destination = await getMapboxGeocodeCoords(destinationAddressUsed);
    destinationSource = destination?.source || 'mapbox_geocoding';
  }

  if (!destination) {
    throw new Error('Unable to resolve destination coordinates. Provide ticketId or a usable address.');
  }

  try {
    const routed = await getMapboxRouteDistance(origin, destination);
    return {
      ok: true,
      distance_miles: routed.distance_miles,
      duration_minutes: routed.duration_minutes,
      provider: routed.provider,
      origin: {
        latitude: roundTo(origin.latitude, 6),
        longitude: roundTo(origin.longitude, 6),
        source: origin.source || 'main_store',
      },
      destination: {
        latitude: roundTo(destination.latitude, 6),
        longitude: roundTo(destination.longitude, 6),
        source: destinationSource || 'unknown',
      },
    };
  } catch (error) {
    if (!mapboxDistanceFallbackToHaversine) {
      throw error;
    }
    const fallbackMiles = haversineDistanceMiles(origin, destination);
    if (fallbackMiles === null) {
      throw error;
    }
    return {
      ok: true,
      distance_miles: roundTo(fallbackMiles, 1),
      duration_minutes: null,
      provider: 'haversine_fallback',
      origin: {
        latitude: roundTo(origin.latitude, 6),
        longitude: roundTo(origin.longitude, 6),
        source: origin.source || 'main_store',
      },
      destination: {
        latitude: roundTo(destination.latitude, 6),
        longitude: roundTo(destination.longitude, 6),
        source: destinationSource || destination.source || 'unknown',
      },
      warning: String(error?.message || error),
    };
  }
}

async function getLiveOrdersByZone(params) {
  const deliveryDate = String(params?.deliveryDate || '').trim();
  const deliveryThruDate = String(params?.deliveryThruDate || '').trim();
  const designedOrders = parseBoolean(params?.designedOrders, false);
  const priorityIDList = String(params?.priorityIDList || '').trim();
  const { storeIds, zoneIds } = await getLiveDeliveryLookupIds();
  const zonesNode = buildTypedAnyTypeArrayXml('zones', zoneIds);
  const storesNode = buildTypedAnyTypeArrayXml('stores', storeIds);
  const payloadXml = [
    zonesNode,
    `<deliveryDate>${xmlEscape(deliveryDate)}</deliveryDate>`,
    `<deliveryThruDate>${xmlEscape(deliveryThruDate)}</deliveryThruDate>`,
    storesNode,
    `<designedOrders>${designedOrders ? 'true' : 'false'}</designedOrders>`,
    `<priorityIDList>${xmlEscape(priorityIDList)}</priorityIDList>`,
  ].join('');

  const xmlText = await callLiveMercurySoap12('delivery', 'LoadOrderByZone', payloadXml);
  const dataset = parseSoapDatasetResponse(
    xmlText,
    'LoadOrderByZone',
    ['DeliveryOrderLoad', 'LoadOrderByZone'],
    'DeliveryOrdersByZoneDataSet'
  );
  const rawRows = [
    ...(dataset.tables?.DeliveryOrderLoad || []),
    ...(dataset.tables?.LoadOrderByZone || []),
  ];
  const normalizedRows = rawRows
    .map(row => normalizeLiveZoneOrderRow(row, deliveryDate))
    .filter(row => String(row.ID || row.SALE_ID || '').trim());
  const dedupedRows = Array.from(new Map(
    normalizedRows.map(row => [`${row.ID}|${row.TICKET_POSITION}|${row.ZONE_ID}`, row])
  ).values());

  return {
    dataset: 'DeliveryOrdersByZoneDataSet',
    table: 'LoadOrderByZone',
    rows: dedupedRows
  };
}

async function getLiveOrdersByZonesAndRoutes(params) {
  const deliveryDate = String(params?.deliveryDate || '').trim();
  const deliveryThruDate = String(params?.deliveryThruDate || '').trim();
  const { storeIds, zoneIds } = await getLiveDeliveryLookupIds();
  let routeIds = [];
  try {
    routeIds = await getLiveRouteIdsByStore(deliveryDate, deliveryThruDate, storeIds);
  } catch {
    routeIds = [];
  }

  const zoneNode = buildTypedAnyTypeArrayXml('zone', zoneIds);
  const storesNode = buildTypedAnyTypeArrayXml('stores', storeIds);
  const routeListNode = buildTypedAnyTypeArrayXml('routeList', routeIds);
  const payloadXml = [
    zoneNode,
    `<deliveryDate>${xmlEscape(deliveryDate)}</deliveryDate>`,
    `<deliveryThruDate>${xmlEscape(deliveryThruDate)}</deliveryThruDate>`,
    storesNode,
    routeListNode,
  ].join('');

  const xmlText = await callLiveMercurySoap12('delivery', 'LoadOrderByZonesAndRoutes', payloadXml);
  const dataset = parseSoapDatasetResponse(
    xmlText,
    'LoadOrderByZonesAndRoutes',
    ['DeliveryOrderLoad', 'LoadOrderByZonesAndRoutes', 'LoadOrderByZone'],
    'DeliveryOrdersByZonesAndRoutesDataSet',
  );
  const rawRows = [
    ...(dataset.tables?.DeliveryOrderLoad || []),
    ...(dataset.tables?.LoadOrderByZonesAndRoutes || []),
    ...(dataset.tables?.LoadOrderByZone || []),
  ];
  const normalizedRows = rawRows
    .map(row => normalizeLiveZoneOrderRow(row, deliveryDate))
    .filter(row => String(row.ID || row.SALE_ID || '').trim());
  const dedupedRows = Array.from(new Map(
    normalizedRows.map(row => [`${row.ID}|${row.TICKET_POSITION}|${row.ZONE_ID}|${row.ROUTE_NAME}`, row]),
  ).values());

  return {
    dataset: 'DeliveryOrdersByZonesAndRoutesDataSet',
    table: 'LoadOrderByZonesAndRoutes',
    rows: dedupedRows,
  };
}

async function getLiveRouteIdsByStore(deliveryDate, deliveryThruDate, storeIds = []) {
  const storesNode = buildTypedAnyTypeArrayXml('stores', storeIds);
  const payloadXml = [
    storesNode,
    `<deliveryDate>${xmlEscape(String(deliveryDate || ''))}</deliveryDate>`,
    `<deliveryThruDate>${xmlEscape(String(deliveryThruDate || ''))}</deliveryThruDate>`,
  ].join('');
  const xmlText = await callLiveMercurySoap12('delivery', 'LoadRouteByStore', payloadXml);
  const dataset = parseSoapDatasetResponse(
    xmlText,
    'LoadRouteByStore',
    ['DeliveryRouteLoad', 'LoadRouteByStore'],
    'RouteDataset'
  );
  const routeRows = [
    ...(dataset.tables?.DeliveryRouteLoad || []),
    ...(dataset.tables?.LoadRouteByStore || []),
  ];
  return uniqueNumericIds(routeRows.flatMap(row => [row.ROUTE_ID, row.ID]));
}

async function getLiveOrdersByRoutes(params) {
  const deliveryDate = String(params?.deliveryDate || '').trim();
  const deliveryThruDate = String(params?.deliveryThruDate || '').trim();
  const dataset = await getLiveOrdersByZonesAndRoutes({ deliveryDate, deliveryThruDate });
  const routeRows = (dataset.rows || [])
    .filter((row) => String(row.ROUTE_NAME || '').trim())
    .map((row) => ({
      ID: String(row.ID || '').trim(),
      SALE_ID: String(row.SALE_ID || '').trim(),
      TICKET_POSITION: String(row.TICKET_POSITION || '1').trim(),
      RECIPIENT_NAME: String(row.RECIPIENT_NAME || '').trim(),
      RECIPIENT_ADDRESS: String(row.RECIPIENT_ADDRESS || '').trim(),
      RECIPIENT_CITY: String(row.RECIPIENT_CITY || '').trim(),
      RECIPIENT_STATE_ABBREV: String(row.RECIPIENT_STATE_ABBREV || '').trim(),
      RECIPIENT_ZIP: String(row.RECIPIENT_ZIP || '').trim(),
      ROUTE_ID: '',
      ROUTE_NAME: String(row.ROUTE_NAME || '').trim(),
      DRIVER_NAME: '',
      STOP_SEQ: '',
      DELIVERY_DATE: String(row.DELIVERY_DATE || '').trim(),
      STATUS: String(row.STATUS || '').trim(),
    }));
  return {
    dataset: 'DeliveryOrdersByRoutesDataSet',
    table: 'LoadOrderByRoutes',
    rows: routeRows,
  };
}

async function getLiveMessageList(params) {
  const wireService = String(params?.wireService ?? '0').trim() || '0';
  const storeID = String(params?.storeID ?? '0').trim() || '0';
  const msgType = String(params?.msgType ?? '0').trim() || '0';
  const msgDirection = String(params?.msgDirection ?? '0').trim() || '0';
  const delivDate = String(params?.delivDate ?? '').trim();
  const msgDate = String(params?.msgDate ?? '').trim();
  const memberCode = String(params?.memberCode ?? '').trim();
  const ticketNum = String(params?.ticketNum ?? '').trim();
  const recipientName = String(params?.recipientName ?? '').trim();
  const mercuryNum = String(params?.mercuryNum ?? '').trim();
  const maxRows = String(params?.maxRows ?? '50').trim() || '50';
  const msgID = String(params?.msgID ?? '0').trim() || '0';

  const payloadXml = [
    `<wireService>${xmlEscape(wireService)}</wireService>`,
    `<storeID>${xmlEscape(storeID)}</storeID>`,
    `<msgType>${xmlEscape(msgType)}</msgType>`,
    `<msgDirection>${xmlEscape(msgDirection)}</msgDirection>`,
    delivDate ? `<delivDate>${xmlEscape(delivDate)}</delivDate>` : '<delivDate xsi:nil="true" />',
    msgDate ? `<msgDate>${xmlEscape(msgDate)}</msgDate>` : '<msgDate xsi:nil="true" />',
    `<memberCode>${xmlEscape(memberCode)}</memberCode>`,
    `<ticketNum>${xmlEscape(ticketNum)}</ticketNum>`,
    `<recipientName>${xmlEscape(recipientName)}</recipientName>`,
    `<mercuryNum>${xmlEscape(mercuryNum)}</mercuryNum>`,
    `<maxRows>${xmlEscape(maxRows)}</maxRows>`,
    `<msgID>${xmlEscape(msgID)}</msgID>`,
  ].join('');

  let xmlText = '';
  try {
    xmlText = await callLiveMercurySoap11('message', 'GetMessageList', payloadXml);
  } catch (soap11Error) {
    try {
      xmlText = await callLiveMercurySoap12('message', 'GetMessageList', payloadXml);
    } catch (soap12Error) {
      throw new Error(
        `GetMessageList failed (SOAP11 + SOAP12). SOAP11: ${String(soap11Error?.message || soap11Error)} | SOAP12: ${String(soap12Error?.message || soap12Error)}`
      );
    }
  }

  const dataset = parseSoapDatasetResponse(xmlText, 'GetMessageList', ['GetMessageList', 'MessageList'], 'MercuryMessageListDataSet');
  let rows = dataset.tables?.GetMessageList || dataset.tables?.MessageList || [];
  if (!rows.length) {
    const rawPayload = decodeXmlEntities(String(xmlText || ''));
    rows = parseTableRows(rawPayload, 'MessageList');
  }
  return {
    dataset: 'MercuryMessageListDataSet',
    table: 'GetMessageList',
    rows
  };
}

async function getLiveMessageDetail(params = {}) {
  const msgID = String(params?.msgID ?? params?.msgId ?? '0').trim() || '0';
  const mercID = String(params?.mercID ?? params?.mercId ?? '').trim();
  const isCanadian = parseBoolean(params?.isCanadian, false);
  const payloadXml = [
    `<msgID>${xmlEscape(msgID)}</msgID>`,
    `<mercID>${xmlEscape(mercID)}</mercID>`,
    `<isCanadian>${isCanadian ? 'true' : 'false'}</isCanadian>`,
  ].join('');

  let xmlText = '';
  try {
    xmlText = await callLiveMercurySoap11('message', 'GetMessageDetail', payloadXml);
  } catch (soap11Error) {
    try {
      xmlText = await callLiveMercurySoap12('message', 'GetMessageDetail', payloadXml);
    } catch (soap12Error) {
      throw new Error(
        `GetMessageDetail failed (SOAP11 + SOAP12). SOAP11: ${String(soap11Error?.message || soap11Error)} | SOAP12: ${String(soap12Error?.message || soap12Error)}`
      );
    }
  }

  const dataset = parseSoapDatasetResponse(
    xmlText,
    'GetMessageDetail',
    ['MessageDetailResp', 'GetMessageDetail'],
    'MessageDetailRespDataset',
  );
  return {
    dataset: dataset.dataset || 'MessageDetailRespDataset',
    table: 'MessageDetailResp',
    rows: dataset.tables?.MessageDetailResp || dataset.tables?.GetMessageDetail || [],
  };
}

async function getLiveTicketSearchDeliveredRows(params = {}) {
  const fromDate = String(params?.fromDate || params?.deliveryDate || '').trim();
  const toDate = String(params?.toDate || params?.deliveryThruDate || '').trim();
  const storeID = String(params?.storeID || params?.store || '0').trim() || '0';
  const recipientName = String(params?.recipientName || '').trim();
  const customerName = String(params?.customerName || '').trim();
  const city = String(params?.city || '').trim();
  const zone = String(params?.zone || '').trim();
  const orderNumber = String(params?.orderNumber || params?.orderNum || '').trim();

  const payloadXml = [
    `<StoreID>${xmlEscape(storeID)}</StoreID>`,
    fromDate ? `<FromDate>${xmlEscape(fromDate)}</FromDate>` : '<FromDate xsi:nil="true" />',
    toDate ? `<ToDate>${xmlEscape(toDate)}</ToDate>` : '<ToDate xsi:nil="true" />',
    '<SaleDateInd>0</SaleDateInd>',
    '<DelivDateInd>1</DelivDateInd>',
    `<CustName>${xmlEscape(customerName)}</CustName>`,
    `<RecipientName>${xmlEscape(recipientName)}</RecipientName>`,
    '<RecipientAddr></RecipientAddr>',
    `<RecipientCity>${xmlEscape(city)}</RecipientCity>`,
    '<ProductCode></ProductCode>',
    `<DelivZone>${xmlEscape(zone)}</DelivZone>`,
    `<SaleID>${xmlEscape(orderNumber)}</SaleID>`,
    '<OrderType>0</OrderType>',
    '<OrderStatus>0</OrderStatus>',
    '<EmpName></EmpName>',
    '<JobType>0</JobType>',
    '<AssignInd>1</AssignInd>',
    '<DesignInd>1</DesignInd>',
    '<DelivInd>1</DelivInd>',
    '<NotAssignInd>1</NotAssignInd>',
    '<NotDesignInd>1</NotDesignInd>',
    '<NotDeliverInd>1</NotDeliverInd>',
    '<PictureSentInd>0</PictureSentInd>',
    '<OEInd>0</OEInd>',
    '<OrderHistoryInd>1</OrderHistoryInd>',
    '<MaxResultsInd>500</MaxResultsInd>',
  ].join('');

  let xmlText = '';
  try {
    xmlText = await callLiveMercurySoap11('orderentry', 'TicketSearch', payloadXml);
  } catch (soap11Error) {
    try {
      xmlText = await callLiveMercurySoap12('orderentry', 'TicketSearch', payloadXml);
    } catch (soap12Error) {
      throw new Error(
        `TicketSearch (delivered) failed (SOAP11 + SOAP12). SOAP11: ${String(soap11Error?.message || soap11Error)} | SOAP12: ${String(soap12Error?.message || soap12Error)}`
      );
    }
  }

  const dataset = parseSoapDatasetResponse(
    xmlText,
    'TicketSearch',
    [
      'TicketSearch',
      'TicketSearchByDesigner',
      'GetTickets',
      'Ticket',
      'TicketData',
      'OrderItems',
      'LoadOrder',
    ],
    'TicketSearchDataSet',
  );

  const rawRows = [
    ...(dataset.tables?.TicketSearch || []),
    ...(dataset.tables?.TicketSearchByDesigner || []),
    ...(dataset.tables?.GetTickets || []),
    ...(dataset.tables?.Ticket || []),
    ...(dataset.tables?.TicketData || []),
    ...(dataset.tables?.OrderItems || []),
    ...(dataset.tables?.LoadOrder || []),
  ];

  const normalizedRows = rawRows
    .map(row => normalizeTicketSearchRow(row))
    .filter(row => String(row.ID || row.SALE_ID || '').trim());

  return dedupeTicketSearchRows(normalizedRows);
}

async function getLiveTicketSearch(params = {}) {
  const fromDate = String(params?.fromDate || params?.deliveryDate || '').trim();
  const toDate = String(params?.toDate || params?.deliveryThruDate || '').trim();
  const storeID = String(params?.storeID || params?.store || '').trim();
  const recipientName = String(params?.recipientName || '').trim();
  const customerName = String(params?.customerName || '').trim();
  const city = String(params?.city || '').trim();
  const zone = String(params?.zone || '').trim();
  const orderNumber = String(params?.orderNumber || params?.orderNum || '').trim();
  const includeDelivered = parseBoolean(params?.includeDelivered, false);
  const notDeliveredOnly = parseBoolean(params?.notDelivered, true) && !includeDelivered;

  const variants = [
    {
      date: 'true',
      saleDate: 'false',
      deliveryDate: 'true',
      from: fromDate,
      to: toDate,
      fromDate,
      toDate,
      storeID,
      recipientName,
      customerName,
      city,
      zone,
      orderNum: orderNumber,
      orderNumber,
      notDelivered: notDeliveredOnly ? 'true' : 'false',
      delivered: notDeliveredOnly ? 'false' : '',
    },
    {
      Date: 'true',
      SaleDate: 'false',
      DeliveryDate: 'true',
      From: fromDate,
      To: toDate,
      StoreID: storeID,
      RecipientName: recipientName,
      CustomerName: customerName,
      City: city,
      Zone: zone,
      OrderNum: orderNumber,
      NotDelivered: notDeliveredOnly ? 'true' : 'false',
      Delivered: notDeliveredOnly ? 'false' : '',
    },
  ];

  let lastError = null;
  let sawRawRows = false;
  let mergedRows = [];
  for (const variant of variants) {
    try {
      const xmlText = await callLiveMercury('orderentry', 'TicketSearch', variant);
      const dataset = parseSoapDatasetResponse(
        xmlText,
        'TicketSearch',
        [
          'TicketSearch',
          'TicketSearchByDesigner',
          'GetTickets',
          'Ticket',
          'TicketData',
          'OrderItems',
          'LoadOrder',
        ],
        'TicketSearchDataSet',
      );
      const rawRows = [
        ...(dataset.tables?.TicketSearch || []),
        ...(dataset.tables?.TicketSearchByDesigner || []),
        ...(dataset.tables?.GetTickets || []),
        ...(dataset.tables?.Ticket || []),
        ...(dataset.tables?.TicketData || []),
        ...(dataset.tables?.OrderItems || []),
        ...(dataset.tables?.LoadOrder || []),
      ];
      sawRawRows = sawRawRows || rawRows.length > 0;
      const normalizedRows = rawRows
        .map(row => normalizeTicketSearchRow(row))
        .filter(row => String(row.ID || row.SALE_ID || '').trim());
      if (normalizedRows.length > 0) {
        mergedRows = dedupeTicketSearchRows([...mergedRows, ...normalizedRows]);
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (includeDelivered) {
    try {
      const deliveredRows = await getLiveTicketSearchDeliveredRows({
        fromDate,
        toDate,
        storeID,
        recipientName,
        customerName,
        city,
        zone,
        orderNumber,
      });
      if (deliveredRows.length > 0) {
        mergedRows = dedupeTicketSearchRows([...mergedRows, ...deliveredRows]);
      }
    } catch (error) {
      if (!mergedRows.length) {
        lastError = error;
      }
    }
  }

  if (mergedRows.length > 0 || sawRawRows) {
    return {
      dataset: 'TicketSearchDataSet',
      table: 'TicketSearch',
      rows: filterTicketSearchRows(mergedRows, fromDate, toDate, notDeliveredOnly),
    };
  }

  try {
    const fallback = await getLiveOrdersByZonesAndRoutes({
      deliveryDate: fromDate,
      deliveryThruDate: toDate,
    });
    const fallbackRows = (fallback.rows || []).map((row) => normalizeTicketSearchRow({
      ...row,
      DELIVERY: row.USER_REFERENCE,
      DELIVERY_STATUS: row.STATUS,
      DESIGN_STATUS: String(row.DESIGNED_IND || '').trim() === '1' ? 'Designed' : 'Not Assigned',
      SALE_TYPE: 'Local',
    }));
    return {
      dataset: 'TicketSearchDataSet',
      table: 'TicketSearch',
      rows: filterTicketSearchRows(fallbackRows, fromDate, toDate, notDeliveredOnly),
    };
  } catch {
    if (lastError) throw lastError;
    return {
      dataset: 'TicketSearchDataSet',
      table: 'TicketSearch',
      rows: [],
    };
  }
}

async function routeJson(req, res, url, pathname) {
  if (pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: serviceName,
      mode: 'live',
      mercuryBaseUrl: liveMercuryBaseUrl,
      host,
      networkPolicy: {
        localNetworkOnly,
        trustProxyHeaders,
        apiKeyRequired: Boolean(apiKey)
      },
      liveCache: {
        ttlMs: Math.max(0, Math.floor(liveApiCacheTtlMs)),
        maxEntries: Math.max(50, Math.floor(Number(liveApiCacheMaxEntries) || 0)),
        bypassParam: liveApiCacheBypassParam
      },
      mapbox: {
        enabled: Boolean(mapboxToken),
        profile: mapboxProfile,
        apiBaseUrl: mapboxApiBaseUrl,
        routeCacheTtlMs: Math.max(0, Math.floor(mapboxRouteCacheTtlMs)),
        addressCacheTtlMs: Math.max(0, Math.floor(mapboxAddressCacheTtlMs)),
        fallbackToHaversine: mapboxDistanceFallbackToHaversine,
      },
      weather: {
        timeoutMs: Math.max(1000, Math.floor(Number(weatherTimeoutMs) || 0)),
        forecastCacheTtlMs: Math.max(0, Math.floor(Number(weatherForecastCacheTtlMs) || 0)),
        forecastStaleTtlMs: Math.max(0, Math.floor(Number(weatherForecastStaleTtlMs) || 0)),
      }
    });
  }

  if (pathname === '/api/workflow/focus') {
    return sendJson(res, 200, workflowFocus);
  }

  if (pathname === '/api/workflow/dashboard-config/server') {
    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, readDashboardServerConfig());
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message || error), endpoint: 'dashboard-config-read' });
      }
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(String(body || '{}'));
        const payload = parsed?.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
          ? parsed.config
          : parsed;
        return sendJson(res, 200, writeDashboardServerConfig(payload));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message || error), endpoint: 'dashboard-config-write' });
      }
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (pathname === '/api/workflow/enabled' || pathname === '/api/workflow/dashboard/enabled') {
    if (liveEnabled) {
      try {
        const enabled = await getLiveDashboardEnabled();
        return sendJson(res, 200, { enabled });
      } catch (error) {
        return sendJson(res, 502, { error: String(error?.message || error), endpoint: 'GetDashboardEnabled' });
      }
    }
    return sendJson(res, 200, { enabled: primitives.GetDashboardEnabled });
  }

  if (pathname === '/api/workflow/server-time' || pathname === '/api/workflow/framework/server-time') {
    if (liveEnabled) {
      try {
        const serverTime = await getLiveServerTime();
        return sendJson(res, 200, { serverTime });
      } catch (error) {
        return sendJson(res, 502, { error: String(error?.message || error), endpoint: 'GetServerTime' });
      }
    }
    return sendJson(res, 200, { serverTime: new Date().toISOString() });
  }

  if (pathname === '/api/workflow/events-now' || pathname === '/api/workflow/events') {
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'events-now',
        endpoint: 'GetDashboardEventsNow',
        loader: () => getLiveDashboardEventsNow()
      });
    }
    return sendJson(res, 200, dashboardEvents);
  }

  if (pathname === '/api/workflow/undelivered-orders') {
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'undelivered-orders',
        endpoint: 'GetUndeliveredOrders',
        loader: () => getLiveUndeliveredOrders()
      });
    }
    return sendJson(res, 200, buildUndeliveredOrdersDataset());
  }

  if (pathname === '/api/workflow/tickets/search') {
    const fromDate = resolveParam(url, '', ['fromDate', 'deliveryDate', 'date'], '');
    const toDate = resolveParam(url, '', ['toDate', 'deliveryThruDate', 'thrudate'], '');
    const notDelivered = resolveParam(url, '', ['notDelivered'], 'true');
    const includeDelivered = resolveParam(url, '', ['includeDelivered'], 'false');
    const recipientName = resolveParam(url, '', ['recipientName'], '');
    const customerName = resolveParam(url, '', ['customerName'], '');
    const city = resolveParam(url, '', ['city'], '');
    const zone = resolveParam(url, '', ['zone'], '');
    const orderNumber = resolveParam(url, '', ['orderNumber', 'orderNum'], '');

    return sendLiveCachedJson(res, url, {
      scope: 'ticket-search',
      params: {
        fromDate,
        toDate,
        notDelivered,
        includeDelivered,
        recipientName,
        customerName,
        city,
        zone,
        orderNumber,
      },
      endpoint: 'TicketSearch',
      ttlMs: 3000,
      loader: () => getLiveTicketSearch({
        fromDate,
        toDate,
        notDelivered,
        includeDelivered,
        recipientName,
        customerName,
        city,
        zone,
        orderNumber,
      }),
    });
  }

  if (pathname === '/api/workflow/ticket-status') {
    const ticketId = resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], getDefaultTicketId());
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'ticket-status',
        params: { ticketId },
        endpoint: 'GetTicketStatus',
        ttlMs: 3000,
        loader: () => getLiveTicketStatus(ticketId)
      });
    }
    return sendJson(res, 200, singleTicketStatusJson(ticketId));
  }

  if (pathname.startsWith('/api/workflow/ticket-status/')) {
    const ticketId = decodeURIComponent(pathname.substring('/api/workflow/ticket-status/'.length));
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'ticket-status',
        params: { ticketId },
        endpoint: 'GetTicketStatus',
        ttlMs: 3000,
        loader: () => getLiveTicketStatus(ticketId)
      });
    }
    return sendJson(res, 200, singleTicketStatusJson(ticketId));
  }

  if (pathname === '/api/workflow/order-details') {
    const ticketId = resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], getDefaultTicketId());
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'order-details',
        params: { ticketId },
        endpoint: 'LoadOrderDetails',
        ttlMs: 10000,
        loader: () => getLiveOrderDetails(ticketId)
      });
    }
    return sendJson(res, 200, singleOrderDetailsJson(ticketId));
  }

  if (pathname.startsWith('/api/workflow/order-details/')) {
    const ticketId = decodeURIComponent(pathname.substring('/api/workflow/order-details/'.length));
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'order-details',
        params: { ticketId },
        endpoint: 'LoadOrderDetails',
        ttlMs: 10000,
        loader: () => getLiveOrderDetails(ticketId)
      });
    }
    return sendJson(res, 200, singleOrderDetailsJson(ticketId));
  }

  if (pathname === '/api/workflow/distance/estimate') {
    const params = {
      ticketId: resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], ''),
      firmName: resolveParam(url, '', ['firmName'], ''),
      addressLine1: resolveParam(url, '', ['addressLine1', 'address', 'street'], ''),
      addressLine2: resolveParam(url, '', ['addressLine2'], ''),
      city: resolveParam(url, '', ['city'], ''),
      state: resolveParam(url, '', ['state', 'stateAbbrev'], ''),
      postalCode: resolveParam(url, '', ['postalCode', 'zip', 'zipCode'], ''),
      country: resolveParam(url, '', ['country'], 'US'),
      latitude: resolveParam(url, '', ['latitude', 'lat', 'destLat', 'destinationLat'], ''),
      longitude: resolveParam(url, '', ['longitude', 'lon', 'lng', 'destLon', 'destinationLon'], ''),
    };

    const hasTicket = Boolean(String(params.ticketId || '').trim());
    const hasAddress = Boolean(
      String(params.addressLine1 || '').trim()
      || String(params.city || '').trim()
      || String(params.postalCode || '').trim(),
    );
    const hasCoords = Boolean(String(params.latitude || '').trim() && String(params.longitude || '').trim());
    if (!hasTicket && !hasAddress && !hasCoords) {
      return sendJson(res, 400, {
        error: 'distance estimate requires ticketId, coordinates, or destination address fields.',
        endpoint: 'distance-estimate',
      });
    }

    return sendLiveCachedJson(res, url, {
      scope: 'distance-estimate',
      params,
      endpoint: 'distance-estimate',
      ttlMs: mapboxRouteCacheTtlMs,
      loader: () => getLiveDistanceEstimate(params),
    });
  }

  if (pathname === '/api/workflow/mapbox/diagnostics') {
    return sendJson(res, 200, await getMapboxDiagnostics(mapboxRequestContextFromReq(req)), {
      'Cache-Control': 'no-store',
    });
  }

  if (pathname === '/api/workflow/mapbox/address-suggest') {
    const query = resolveParam(url, '', ['q', 'query', 'address'], '');
    const country = resolveParam(url, '', ['country'], 'US');
    const limit = resolveParam(url, '', ['limit'], '5');
    const mapboxRequestContext = mapboxRequestContextFromReq(req);
    return sendLiveCachedJson(res, url, {
      scope: 'mapbox-address-suggest',
      params: { query, country, limit },
      endpoint: 'mapbox-address-suggest',
      ttlMs: mapboxAddressCacheTtlMs,
      loader: () => getMapboxAddressSuggestions(query, { country, limit, ...mapboxRequestContext }),
    });
  }

  if (pathname === '/api/workflow/mapbox/static-map') {
    try {
      const mapboxRequestContext = mapboxRequestContextFromReq(req);
      const image = await getMapboxStaticMapImage({
        latitude: resolveParam(url, '', ['latitude', 'lat'], ''),
        longitude: resolveParam(url, '', ['longitude', 'lon', 'lng'], ''),
        width: resolveParam(url, '', ['width', 'w'], '640'),
        height: resolveParam(url, '', ['height', 'h'], '260'),
        zoom: resolveParam(url, '', ['zoom', 'z'], '14'),
        marker: resolveParam(url, '', ['marker'], 'false'),
        ...mapboxRequestContext,
      });
      return sendBinary(res, 200, image.body, image.contentType, {
        'Cache-Control': 'public, max-age=3600',
      });
    } catch (error) {
      return sendJson(res, 502, {
        error: String(error?.message || error),
        endpoint: 'mapbox-static-map',
      });
    }
  }

  if (pathname === '/api/workflow/mapbox/static-map-base') {
    try {
      const mapboxRequestContext = mapboxRequestContextFromReq(req);
      const image = await getMapboxStaticMapImage({
        latitude: resolveParam(url, '', ['latitude', 'lat'], ''),
        longitude: resolveParam(url, '', ['longitude', 'lon', 'lng'], ''),
        width: resolveParam(url, '', ['width', 'w'], '640'),
        height: resolveParam(url, '', ['height', 'h'], '260'),
        zoom: resolveParam(url, '', ['zoom', 'z'], '14'),
        marker: 'false',
        ...mapboxRequestContext,
      });
      return sendBinary(res, 200, image.body, image.contentType, {
        'Cache-Control': 'no-store',
      });
    } catch (error) {
      return sendJson(res, 502, {
        error: String(error?.message || error),
        endpoint: 'mapbox-static-map-base',
      });
    }
  }

  if (pathname === '/api/workflow/weather/forecast') {
    const zip = normalizeWeatherZipValue(resolveParam(url, '', ['zip', 'postalCode', 'weatherZip'], '15212'));
    try {
      const payload = await getWeatherForecastCached(zip, isCacheBypassRequested(url));
      return sendJson(res, 200, payload, {
        'Cache-Control': 'no-store',
        'X-Weather-Cache': String(payload.cacheStatus || 'UNKNOWN'),
      });
    } catch (error) {
      return sendJson(res, 502, {
        error: String(error?.message || error),
        endpoint: 'weather-forecast',
        zip,
      });
    }
  }

  if (pathname === '/api/workflow/order-lifecycle/by-service-msg') {
    const serviceMsgNum = resolveParam(url, '', ['serviceMsgNum', 'SERVICE_MSG_NUM'], getDefaultServiceMsgNum());
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'lifecycle-by-service-msg',
        params: { serviceMsgNum },
        endpoint: 'OLCGetBySERVICE_MSG_NUM',
        ttlMs: 3000,
        loader: () => getLiveLifecycleByServiceMsg(serviceMsgNum)
      });
    }
    return sendJson(res, 200, singleOrderLifecycleByServiceMsgJson(serviceMsgNum));
  }

  if (pathname.startsWith('/api/workflow/order-lifecycle/by-service-msg/')) {
    const serviceMsgNum = decodeURIComponent(pathname.substring('/api/workflow/order-lifecycle/by-service-msg/'.length));
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'lifecycle-by-service-msg',
        params: { serviceMsgNum },
        endpoint: 'OLCGetBySERVICE_MSG_NUM',
        ttlMs: 3000,
        loader: () => getLiveLifecycleByServiceMsg(serviceMsgNum)
      });
    }
    return sendJson(res, 200, singleOrderLifecycleByServiceMsgJson(serviceMsgNum));
  }

  if (pathname === '/api/workflow/order-lifecycle') {
    const ticketId = resolveParam(url, '', ['ticketId', 'ticketID', 'TicketID'], getDefaultTicketId());
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'lifecycle-by-ticket',
        params: { ticketId },
        endpoint: 'OLCGetByTicket',
        ttlMs: 3000,
        loader: () => getLiveLifecycleByTicket(ticketId)
      });
    }
    return sendJson(res, 200, singleOrderLifecycleByTicketJson(ticketId));
  }

  if (pathname.startsWith('/api/workflow/order-lifecycle/')) {
    const ticketId = decodeURIComponent(pathname.substring('/api/workflow/order-lifecycle/'.length));
    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'lifecycle-by-ticket',
        params: { ticketId },
        endpoint: 'OLCGetByTicket',
        ttlMs: 3000,
        loader: () => getLiveLifecycleByTicket(ticketId)
      });
    }
    return sendJson(res, 200, singleOrderLifecycleByTicketJson(ticketId));
  }

  if (pathname === '/api/workflow/delivery/zone-summary') {
    const date = resolveParam(url, '', ['date'], '');
    const thrudate = resolveParam(url, '', ['thrudate'], '');
    const priorityIDList = resolveParam(url, '', ['priorityIDList'], '');
    const designedOnly = resolveParam(url, '', ['designedOnly'], 'false');

    if (liveEnabled) {
      try {
        const payload = await getLiveZoneSummary({ date, thrudate, priorityIDList, designedOnly });
        return sendJson(res, 200, payload);
      } catch (error) {
        return sendJson(res, 502, { error: String(error?.message || error), endpoint: 'LoadZoneSummary' });
      }
    }

    let rows = filterZoneSummaryRows(designedOnly, priorityIDList);
    if (date || thrudate) {
      rows = rows.map((row) => ({ ...row }));
    }

    return sendJson(res, 200, { ...zoneSummary, rows });
  }

  if (pathname === '/api/workflow/delivery/in-progress-route-summary') {
    const date = resolveParam(url, '', ['date'], '');
    const thrudate = resolveParam(url, '', ['thrudate'], '');

    if (liveEnabled) {
      try {
        const payload = await getLiveInProgressRouteSummary({ date, thrudate });
        return sendJson(res, 200, payload);
      } catch (error) {
        return sendJson(res, 502, { error: String(error?.message || error), endpoint: 'LoadInProgressRouteSummary' });
      }
    }

    const rows = filterByDateRange(inProgressRouteSummary.rows, 'LAST_SCAN_TIME', date, thrudate);
    return sendJson(res, 200, { ...inProgressRouteSummary, rows });
  }

  if (pathname === '/api/workflow/delivery/failed-delivery') {
    const date = resolveParam(url, '', ['date'], '');
    const thrudate = resolveParam(url, '', ['thrudate'], '');

    if (liveEnabled) {
      try {
        const payload = await getLiveFailedDelivery();
        const rows = filterByDateRange(payload.rows || [], 'DELIVERY_DATE', date, thrudate);
        return sendJson(res, 200, { ...payload, rows });
      } catch (error) {
        return sendJson(res, 502, { error: String(error?.message || error), endpoint: 'LoadFailedDelivery' });
      }
    }

    const rows = filterByDateRange(failedDelivery.rows, 'DELIVERY_DATE', date, thrudate);
    return sendJson(res, 200, { ...failedDelivery, rows });
  }

  if (pathname === '/api/workflow/delivery/orders-by-zone') {
    const deliveryDate = resolveParam(url, '', ['deliveryDate'], '');
    const deliveryThruDate = resolveParam(url, '', ['deliveryThruDate'], '');
    const designedOrders = resolveParam(url, '', ['designedOrders'], 'false');
    const priorityIDList = resolveParam(url, '', ['priorityIDList'], '');

    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'orders-by-zone',
        params: { deliveryDate, deliveryThruDate, designedOrders, priorityIDList },
        endpoint: 'LoadOrderByZonesAndRoutes',
        loader: async () => {
          const payload = await getLiveOrdersByZonesAndRoutes({ deliveryDate, deliveryThruDate });
          let rows = [...(payload.rows || [])];
          const designedOnly = parseBoolean(designedOrders, false);
          const priorityList = parsePriorityList(priorityIDList);
          if (priorityList.length > 0) {
            rows = rows.filter(row => priorityList.includes(String(row.PRIORITY_ID || '').trim()));
          }
          if (designedOnly) {
            rows = rows.filter(row => String(row.DESIGNED_IND || '').trim() === '1');
          }
          return {
            dataset: 'DeliveryOrdersByZoneDataSet',
            table: 'LoadOrderByZone',
            rows,
          };
        }
      });
    }

    const rows = filterOrdersByZoneRows(deliveryDate, deliveryThruDate, designedOrders, priorityIDList);
    return sendJson(res, 200, { ...ordersByZone, rows });
  }

  if (pathname === '/api/workflow/delivery/orders-by-routes') {
    const deliveryDate = resolveParam(url, '', ['deliveryDate'], '');
    const deliveryThruDate = resolveParam(url, '', ['deliveryThruDate'], '');

    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'orders-by-routes',
        params: { deliveryDate, deliveryThruDate },
        endpoint: 'LoadOrderByZonesAndRoutes',
        loader: () => getLiveOrdersByRoutes({ deliveryDate, deliveryThruDate })
      });
    }

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

    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'messages-list',
        params: filters,
        endpoint: 'GetMessageList',
        ttlMs: 2500,
        loader: () => getLiveMessageList(filters)
      });
    }

    return sendJson(res, 200, {
      ...messageList,
      rows: filterMessageListRows(filters)
    });
  }

  if (pathname === '/api/workflow/messages/detail') {
    const msgID = resolveParam(url, '', ['msgID', 'msgId'], '0');
    const mercID = resolveParam(url, '', ['mercID', 'mercId', 'mercuryNum'], '');
    const isCanadian = resolveParam(url, '', ['isCanadian'], 'false');
    const params = { msgID, mercID, isCanadian };

    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'messages-detail',
        params,
        endpoint: 'GetMessageDetail',
        ttlMs: 5000,
        loader: () => getLiveMessageDetail(params)
      });
    }

    const fallbackRow = (messageList.rows || []).find(row => String(row.MSG_ID || '').trim() === msgID);
    const rows = fallbackRow
      ? [{
          ID: String(fallbackRow.MSG_ID || '').trim(),
          INTERNAL_MSG_ID: String(fallbackRow.MSG_ID || '').trim(),
          TICKET_ID: String(fallbackRow.TICKET_NUM || '').trim(),
          MERC_ID: String(fallbackRow.MERCURY_NUM || '').trim(),
          RECIPIENT_NAME: String(fallbackRow.RECIPIENT_NAME || '').trim(),
          MSG_DATETIME: String(fallbackRow.MSG_DATE || '').trim(),
          REQ_DELIVERY_DATE: String(fallbackRow.DELIVERY_DATE || '').trim(),
        }]
      : [];
    return sendJson(res, 200, {
      dataset: 'MessageDetailRespDataset',
      table: 'MessageDetailResp',
      rows,
    });
  }

  if (pathname.startsWith('/api/workflow/messages/detail/')) {
    const msgID = decodeURIComponent(pathname.substring('/api/workflow/messages/detail/'.length));
    const mercID = resolveParam(url, '', ['mercID', 'mercId', 'mercuryNum'], '');
    const isCanadian = resolveParam(url, '', ['isCanadian'], 'false');
    const params = { msgID, mercID, isCanadian };

    if (liveEnabled) {
      return sendLiveCachedJson(res, url, {
        scope: 'messages-detail',
        params,
        endpoint: 'GetMessageDetail',
        ttlMs: 5000,
        loader: () => getLiveMessageDetail(params)
      });
    }

    const fallbackRow = (messageList.rows || []).find(row => String(row.MSG_ID || '').trim() === msgID);
    const rows = fallbackRow
      ? [{
          ID: String(fallbackRow.MSG_ID || '').trim(),
          INTERNAL_MSG_ID: String(fallbackRow.MSG_ID || '').trim(),
          TICKET_ID: String(fallbackRow.TICKET_NUM || '').trim(),
          MERC_ID: String(fallbackRow.MERCURY_NUM || '').trim(),
          RECIPIENT_NAME: String(fallbackRow.RECIPIENT_NAME || '').trim(),
          MSG_DATETIME: String(fallbackRow.MSG_DATE || '').trim(),
          REQ_DELIVERY_DATE: String(fallbackRow.DELIVERY_DATE || '').trim(),
        }]
      : [];
    return sendJson(res, 200, {
      dataset: 'MessageDetailRespDataset',
      table: 'MessageDetailResp',
      rows,
    });
  }

  if (pathname === '/') {
    return sendJson(res, 200, {
      message: 'Mercury workflow dashboard live bridge is running.',
      mode: 'live',
      mercuryBaseUrl: liveMercuryBaseUrl,
      host,
      networkPolicy: {
        localNetworkOnly,
        trustProxyHeaders,
        apiKeyRequired: Boolean(apiKey)
      },
      liveCache: {
        ttlMs: Math.max(0, Math.floor(liveApiCacheTtlMs)),
        maxEntries: Math.max(50, Math.floor(Number(liveApiCacheMaxEntries) || 0)),
        bypassParam: liveApiCacheBypassParam
      },
      mapbox: {
        enabled: Boolean(mapboxToken),
        profile: mapboxProfile,
        apiBaseUrl: mapboxApiBaseUrl,
        routeCacheTtlMs: Math.max(0, Math.floor(mapboxRouteCacheTtlMs)),
        addressCacheTtlMs: Math.max(0, Math.floor(mapboxAddressCacheTtlMs)),
        fallbackToHaversine: mapboxDistanceFallbackToHaversine,
      },
      weather: {
        timeoutMs: Math.max(1000, Math.floor(Number(weatherTimeoutMs) || 0)),
        forecastCacheTtlMs: Math.max(0, Math.floor(Number(weatherForecastCacheTtlMs) || 0)),
        forecastStaleTtlMs: Math.max(0, Math.floor(Number(weatherForecastStaleTtlMs) || 0)),
      },
      jsonEndpoints: [
        '/health',
        '/api/workflow/focus',
        '/api/workflow/dashboard/enabled',
        '/api/workflow/framework/server-time',
        '/api/workflow/events-now',
        '/api/workflow/undelivered-orders',
        '/api/workflow/tickets/search',
        '/api/workflow/ticket-status/:ticketId',
        '/api/workflow/order-details/:ticketId',
        '/api/workflow/distance/estimate',
        '/api/workflow/weather/forecast?zip=15212',
        '/api/workflow/order-lifecycle/:ticketId',
        '/api/workflow/order-lifecycle/by-service-msg/:serviceMsgNum',
        '/api/workflow/delivery/zone-summary',
        '/api/workflow/delivery/in-progress-route-summary',
        '/api/workflow/delivery/failed-delivery',
        '/api/workflow/delivery/orders-by-zone',
        '/api/workflow/delivery/orders-by-routes',
        '/api/workflow/messages/list',
        '/api/workflow/messages/detail/:msgId'
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
        '/WsMercuryWebAPI/message.asmx/GetMessageDetail',
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
    if (opLower === 'getmessagedetail') {
      const msgID = resolveParam(url, body, ['msgID', 'msgId'], '0');
      const mercID = resolveParam(url, body, ['mercID', 'mercId', 'mercuryNum'], '');
      const fallbackRow = (messageList.rows || []).find(row => String(row.MSG_ID || '').trim() === msgID);
      const rows = fallbackRow
        ? [{
            ID: String(fallbackRow.MSG_ID || '').trim(),
            INTERNAL_MSG_ID: String(fallbackRow.MSG_ID || '').trim(),
            TICKET_ID: String(fallbackRow.TICKET_NUM || '').trim(),
            MERC_ID: mercID || String(fallbackRow.MERCURY_NUM || '').trim(),
            RECIPIENT_NAME: String(fallbackRow.RECIPIENT_NAME || '').trim(),
            MSG_DATETIME: String(fallbackRow.MSG_DATE || '').trim(),
            REQ_DELIVERY_DATE: String(fallbackRow.DELIVERY_DATE || '').trim(),
          }]
        : [];
      sendXml(res, 200, datasetToXml({
        dataset: 'MessageDetailRespDataset',
        tables: {
          MessageDetailResp: rows,
        }
      }));
      return true;
    }

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
  const baseHost = String(req.headers.host || `${host}:${port}`).trim() || `${host}:${port}`;
  const url = new URL(req.url || '/', `http://${baseHost}`);
  const pathname = url.pathname;

  const requestGate = isRequestAllowed(req);
  if (!requestGate.allowed) {
    sendJson(res, requestGate.status || 403, {
      error: requestGate.reason || 'Forbidden',
      clientIp: requestGate.clientIp || 'unknown',
      localNetworkOnly
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Mercury-Key, X-API-Key'
    });
    res.end();
    return;
  }

  if (!hasValidApiKey(req, url)) {
    sendJson(res, 401, { error: 'Invalid API key' });
    return;
  }

  const jsonHandled = await routeJson(req, res, url, pathname);
  if (jsonHandled !== false) {
    return;
  }

  if (!liveEnabled && (req.method === 'POST' || req.method === 'GET')) {
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

// ── Ticket text-length guard ─────────────────────────────────────────────────
// Mercury's GetDashboardEventsNow throws "String or binary data would be
// truncated" (breaking both this bridge's events feed and Mercury's own
// mobile app sync) when an active ticket's DELIVERY_INST/SPECIAL_INST grows
// past whatever fixed-width buffer its internal dashboard proc uses. The
// base FTD.TICKET columns are varchar(max), so nothing on Mercury's side
// stops an order (e.g. a wire-in order) from landing with an oversized
// field. This periodically finds active tickets that cross a safe
// threshold and trims them before they can trip the dashboard query,
// logging the original text first so nothing is lost silently.
// Incident: 2026-07-23, ticket 386446 / order 380186, SPECIAL_INST at 1054 chars.

const ticketGuardEnabled = !/^(0|false|no)$/i.test(String(process.env.MERCURY_TICKET_GUARD_ENABLED ?? '1').trim());
const ticketGuardIntervalMs = Number(process.env.MERCURY_TICKET_GUARD_INTERVAL_MS || 5 * 60 * 1000);
const ticketGuardMaxLen = Number(process.env.MERCURY_TICKET_TEXT_MAX_LEN || 850);
const ticketGuardTruncateLen = Number(process.env.MERCURY_TICKET_TEXT_TRUNCATE_LEN || 700);
const ticketGuardSqlServer = String(process.env.MERCURY_SQL_SERVER || 'localhost').trim();
const ticketGuardSqlDatabase = String(process.env.MERCURY_SQL_DATABASE || 'store').trim();
const ticketGuardFields = ['SPECIAL_INST', 'DELIVERY_INST'];

const ticketGuardAuditDir = join(process.env['PROGRAMDATA'] || 'C:\\ProgramData', 'FTD', 'MercuryDashboardBridge');
const ticketGuardAuditPath = join(ticketGuardAuditDir, 'ticket-text-guard-audit.log');

function findSqlcmdPath() {
  const candidates = [
    String(process.env.MERCURY_SQLCMD_PATH || '').trim(),
    'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\130\\Tools\\Binn\\SQLCMD.EXE',
    'C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\130\\Tools\\Binn\\SQLCMD.EXE',
    'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\110\\Tools\\Binn\\SQLCMD.EXE',
    'C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\110\\Tools\\Binn\\SQLCMD.EXE',
    'sqlcmd.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'sqlcmd.exe' || existsSync(candidate)) return candidate;
  }
  return null;
}

const ticketGuardSqlcmdPath = findSqlcmdPath();

function runSqlcmd(query) {
  return new Promise((resolve, reject) => {
    execFile(
      ticketGuardSqlcmdPath,
      ['-S', ticketGuardSqlServer, '-E', '-d', ticketGuardSqlDatabase, '-W', '-h', '-1', '-s', '|', '-Q', query],
      { timeout: 20000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`sqlcmd failed: ${error.message}${stderr ? ` (${String(stderr).trim()})` : ''}`));
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

function parseSqlcmdRows(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^-+$/.test(line) && !/^\(\d+ rows? affected\)$/i.test(line))
    .map(line => line.split('|').map(cell => cell.trim()));
}

function appendTicketGuardAudit(entry) {
  try {
    mkdirSync(ticketGuardAuditDir, { recursive: true });
    appendFileSync(ticketGuardAuditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch (error) {
    console.warn(`[TicketGuard] Failed to write audit log: ${String(error?.message || error)}`);
  }
}

async function runTicketTextGuardOnce() {
  const findSql = `SET NOCOUNT ON; SELECT t.ID, t.SALE_ID, t.USER_REFERENCE, ${ticketGuardFields.map(f => `LEN(t.${f})`).join(', ')
    } FROM FTD.TICKET t WHERE t.DELIVERED_IND = 0 AND (${ticketGuardFields.map(f => `ISNULL(LEN(t.${f}),0) > ${ticketGuardMaxLen}`).join(' OR ')
    });`;

  const rows = parseSqlcmdRows(await runSqlcmd(findSql));

  for (const row of rows) {
    const [idRaw, saleIdRaw, userReference, ...lens] = row;
    const ticketId = Number(idRaw);
    if (!Number.isInteger(ticketId) || ticketId <= 0) continue;

    for (let i = 0; i < ticketGuardFields.length; i += 1) {
      const field = ticketGuardFields[i];
      const len = Number(lens[i]);
      if (!Number.isFinite(len) || len <= ticketGuardMaxLen) continue;

      try {
        const original = await runSqlcmd(`SET NOCOUNT ON; SELECT ${field} FROM FTD.TICKET WHERE ID = ${ticketId};`);
        appendTicketGuardAudit({
          ticketId,
          saleId: saleIdRaw,
          userReference,
          field,
          originalLength: len,
          truncatedToLength: ticketGuardTruncateLen,
          originalValue: original.trim()
        });

        await runSqlcmd(
          `SET NOCOUNT ON; UPDATE FTD.TICKET SET ${field} = LEFT(${field}, ${ticketGuardTruncateLen}) WHERE ID = ${ticketId} AND LEN(${field}) > ${ticketGuardMaxLen};`
        );

        console.warn(
          `[TicketGuard] Truncated ${field} on ticket ${ticketId} (order ${saleIdRaw}/${userReference}): ${len} -> ${ticketGuardTruncateLen} chars. Full original text saved to ${ticketGuardAuditPath}`
        );
      } catch (error) {
        console.warn(`[TicketGuard] Failed to truncate ${field} on ticket ${ticketId}: ${String(error?.message || error)}`);
      }
    }
  }
}

function startTicketTextGuard() {
  if (!ticketGuardEnabled) {
    console.log('[TicketGuard] Disabled via MERCURY_TICKET_GUARD_ENABLED.');
    return;
  }
  if (!ticketGuardSqlcmdPath) {
    console.warn('[TicketGuard] sqlcmd.exe not found (set MERCURY_SQLCMD_PATH) — guard disabled.');
    return;
  }
  console.log(
    `[TicketGuard] Watching FTD.TICKET.${ticketGuardFields.join('/')} on ${ticketGuardSqlServer}/${ticketGuardSqlDatabase} ` +
    `every ${Math.round(ticketGuardIntervalMs / 1000)}s (max ${ticketGuardMaxLen} chars, truncates to ${ticketGuardTruncateLen}).`
  );
  const tick = () => {
    runTicketTextGuardOnce().catch(error => {
      console.warn(`[TicketGuard] Check failed: ${String(error?.message || error)}`);
    });
  };
  tick();
  setInterval(tick, Math.max(30000, ticketGuardIntervalMs));
}

server.listen(port, host, () => {
  console.log(`Live bridge listening on http://${host}:${port} -> ${liveMercuryBaseUrl}`);
  startTicketTextGuard();
});
