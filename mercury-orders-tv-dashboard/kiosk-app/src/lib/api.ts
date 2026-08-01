import type {
  DashboardEventsDataset,
  DeliveryOrdersByRoutesDataset,
  DeliveryOrdersByZoneDataset,
  LifecycleDataset,
  MercuryMessageDetailDataset,
  MercuryMessageDetailRow,
  OrderDetailsDataset,
  OrderDetailsRow,
  MercuryMessageListDataset,
  TicketStatusDataset,
  TicketStatusRow,
  LifecycleRow,
  TicketSearchDataset,
} from './types';

export interface DistanceEstimateResponse {
  ok?: boolean;
  distance_miles?: number | string | null;
  duration_minutes?: number | string | null;
  provider?: string;
  warning?: string;
  origin?: {
    latitude?: number | null;
    longitude?: number | null;
    source?: string;
  };
  destination?: {
    latitude?: number | null;
    longitude?: number | null;
    source?: string;
  };
}

export interface AddressSuggestion {
  id: string;
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface AddressSuggestionResponse {
  suggestions: AddressSuggestion[];
  mapboxEnabled?: boolean;
}

const RAW_ENV_BASE_URL = String((import.meta.env.VITE_WORKFLOW_BASE_URL as string | undefined) || '').trim();

function normalizeBaseUrl(raw: string): string {
  return String(raw || '').trim().replace(/\/+$/, '');
}

const ENV_BASE_URL = normalizeBaseUrl(RAW_ENV_BASE_URL);
let runtimeBaseUrlOverride = '';

function isLoopbackHost(rawHost: string): boolean {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || host.startsWith('127.');
}

function effectiveBaseUrl(): string {
  const override = runtimeBaseUrlOverride || '';
  if (override && typeof window !== 'undefined') {
    try {
      const overrideUrl = new URL(override, window.location.href);
      const pageHost = window.location.hostname;
      if (!isLoopbackHost(pageHost) && isLoopbackHost(overrideUrl.hostname)) {
        return ENV_BASE_URL;
      }
    } catch {
      // Keep existing behavior for relative or malformed override values.
    }
  }
  return override || ENV_BASE_URL;
}

export function setWorkflowBaseUrlOverride(raw: string): void {
  runtimeBaseUrlOverride = normalizeBaseUrl(raw);
}

const DEVICE_TOKEN_HEADER = 'X-Device-Token';
let runtimeDeviceToken = '';

export function setDeviceToken(raw: string): void {
  runtimeDeviceToken = String(raw || '').trim();
}

export function getDeviceToken(): string {
  return runtimeDeviceToken;
}

function requestHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(extra || {}) };
  if (runtimeDeviceToken) headers[DEVICE_TOKEN_HEADER] = runtimeDeviceToken;
  return headers;
}

export class WorkflowApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkflowApiError';
    this.status = status;
  }
}

function currentPageBasePath(): string {
  // Same-origin requests (no explicit base URL override) need to target
  // wherever this page actually lives, not always the site root - e.g.
  // behind an IIS reverse proxy at /Talaria/, "/api/..." must become
  // "/Talaria/api/...", or it silently misses the proxy and 404s at the
  // site root instead. This app never changes window.location.pathname
  // itself (no client-side router), so the current pathname IS the base.
  if (typeof window === 'undefined') return '';
  return String(window.location.pathname || '').replace(/\/+$/, '');
}

export function buildRequestUrl(path: string): string {
  const baseUrl = effectiveBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!baseUrl) return `${currentPageBasePath()}${normalizedPath}`;

  if (baseUrl.endsWith('/api/workflow') && normalizedPath.startsWith('/api/workflow/')) {
    return `${baseUrl}${normalizedPath.slice('/api/workflow'.length)}`;
  }
  if (baseUrl.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    return `${baseUrl}${normalizedPath.slice('/api'.length)}`;
  }

  return `${baseUrl}${normalizedPath}`;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

function normalizeTicketIdForApi(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  const slashForm = value.match(/^(\d{5,12})\/\d{1,3}$/);
  if (slashForm) return slashForm[1];
  return value;
}

async function getJson<T>(path: string): Promise<T> {
  const requestUrl = buildRequestUrl(path);
  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: requestHeaders(),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const bodyText = await response.text();
        if (bodyText) {
          try {
            const body = JSON.parse(bodyText) as { error?: unknown; detail?: unknown; endpoint?: unknown };
            detail = String(body.error || body.detail || '').trim();
            if (body.endpoint && detail) detail = `${body.endpoint}: ${detail}`;
          } catch {
            detail = bodyText.slice(0, 240);
          }
        }
      } catch {
        detail = '';
      }
      throw new WorkflowApiError(`Request failed: ${requestUrl} (${response.status})${detail ? `. ${detail}` : ''}`, response.status);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof WorkflowApiError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach workflow API at ${requestUrl}. ${reason}`);
  }
}

async function putJson<T>(path: string, payload: unknown): Promise<T> {
  const requestUrl = buildRequestUrl(path);
  const response = await fetch(requestUrl, {
    method: 'PUT',
    headers: requestHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload || {}),
  });
  if (!response.ok) {
    throw new WorkflowApiError(`Request failed: ${requestUrl} (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

async function mutateJson<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown): Promise<T> {
  const requestUrl = buildRequestUrl(path);
  const response = await fetch(requestUrl, {
    method,
    headers: requestHeaders({ 'Content-Type': 'application/json' }),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const bodyText = await response.text();
      const body = bodyText ? (JSON.parse(bodyText) as { error?: unknown }) : {};
      detail = String(body.error || '').trim();
    } catch {
      detail = '';
    }
    throw new WorkflowApiError(`Request failed: ${requestUrl} (${response.status})${detail ? `. ${detail}` : ''}`, response.status);
  }
  return response.json() as Promise<T>;
}

async function getJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return await getJson<T>(path);
  } catch {
    return null;
  }
}

export async function fetchDashboardServerConfig(): Promise<Record<string, unknown> | null> {
  return getJsonOrNull<Record<string, unknown>>('/api/workflow/dashboard-config/server');
}

export async function saveDashboardServerConfig(config: Record<string, unknown>): Promise<boolean> {
  try {
    await putJson<Record<string, unknown>>('/api/workflow/dashboard-config/server', config);
    return true;
  } catch {
    return false;
  }
}

function firstDatasetRows(result: unknown, tableKey: string): Array<Record<string, unknown>> {
  const rowsFromTables = (result as { tables?: Record<string, Array<Record<string, unknown>>> })?.tables?.[tableKey] || [];
  const rowsFromFlat = (result as { rows?: Array<Record<string, unknown>> })?.rows || [];
  return rowsFromTables.length ? rowsFromTables : rowsFromFlat;
}

function lifecycleText(row: LifecycleRow): string {
  return `${String(row.STATUS_CD || '')} ${String(row.STATUS_CD_DESC || '')} ${String(row.STATUS_TEXT || '')}`.toUpperCase();
}

function isTerminalLifecycleRow(row: LifecycleRow): boolean {
  const text = lifecycleText(row);
  return text.includes('DELIVER')
    || text.includes('EXCEPT')
    || text.includes('FAIL')
    || text.includes('UNDELIVER')
    || text.includes('RETURN');
}

function pickLifecycleSignal(rows: LifecycleRow[]): LifecycleRow | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => {
    const at = Date.parse(String(a.MSG_DATETIME || ''));
    const bt = Date.parse(String(b.MSG_DATETIME || ''));
    return bt - at;
  });
  const latestTerminal = sorted.find(row => isTerminalLifecycleRow(row));
  return latestTerminal || sorted[0];
}

export async function fetchEventsNow(): Promise<DashboardEventsDataset> {
  return getJson<DashboardEventsDataset>('/api/workflow/events-now');
}

export async function fetchUndeliveredOrders(): Promise<DashboardEventsDataset> {
  return getJson<DashboardEventsDataset>('/api/workflow/undelivered-orders');
}

export async function fetchOrdersByZone(params: {
  deliveryDate: string;
  deliveryThruDate: string;
  designedOrders?: boolean;
  priorityIDList?: string;
}): Promise<DeliveryOrdersByZoneDataset> {
  const query = buildQuery({
    deliveryDate: params.deliveryDate,
    deliveryThruDate: params.deliveryThruDate,
    designedOrders: params.designedOrders ?? false,
    priorityIDList: params.priorityIDList ?? '',
  });
  return getJson<DeliveryOrdersByZoneDataset>(`/api/workflow/delivery/orders-by-zone${query}`);
}

export async function fetchOrdersByRoutes(params: {
  deliveryDate: string;
  deliveryThruDate: string;
}): Promise<DeliveryOrdersByRoutesDataset> {
  const query = buildQuery({
    deliveryDate: params.deliveryDate,
    deliveryThruDate: params.deliveryThruDate,
  });
  return getJson<DeliveryOrdersByRoutesDataset>(`/api/workflow/delivery/orders-by-routes${query}`);
}

export async function fetchTicketSearch(params: {
  fromDate?: string;
  toDate?: string;
  notDelivered?: boolean;
  includeDelivered?: boolean;
  recipientName?: string;
  customerName?: string;
  city?: string;
  zone?: string;
  orderNumber?: string;
}): Promise<TicketSearchDataset> {
  const query = buildQuery({
    fromDate: params.fromDate ?? '',
    toDate: params.toDate ?? '',
    notDelivered: params.notDelivered ?? true,
    includeDelivered: params.includeDelivered ?? false,
    recipientName: params.recipientName ?? '',
    customerName: params.customerName ?? '',
    city: params.city ?? '',
    zone: params.zone ?? '',
    orderNumber: params.orderNumber ?? '',
  });
  return getJson<TicketSearchDataset>(`/api/workflow/tickets/search${query}`);
}

export async function fetchMessageList(params?: {
  maxRows?: number;
  msgDirection?: number;
  wireService?: string | number;
  storeID?: string | number;
  msgType?: string | number;
  delivDate?: string;
  msgDate?: string;
  memberCode?: string;
  ticketNum?: string;
  recipientName?: string;
  mercuryNum?: string;
  msgID?: string | number;
}): Promise<MercuryMessageListDataset> {
  const query = buildQuery({
    wireService: params?.wireService ?? '',
    storeID: params?.storeID ?? '',
    msgType: params?.msgType ?? '',
    maxRows: params?.maxRows ?? 200,
    msgDirection: params?.msgDirection ?? 1,
    delivDate: params?.delivDate ?? '',
    msgDate: params?.msgDate ?? '',
    memberCode: params?.memberCode ?? '',
    ticketNum: params?.ticketNum ?? '',
    recipientName: params?.recipientName ?? '',
    mercuryNum: params?.mercuryNum ?? '',
    msgID: params?.msgID ?? '',
  });
  return getJson<MercuryMessageListDataset>(`/api/workflow/messages/list${query}`);
}

export async function fetchMessageDetail(msgID: string, params?: {
  mercID?: string;
  isCanadian?: boolean;
}): Promise<MercuryMessageDetailRow | null> {
  const id = String(msgID || '').trim();
  if (!id) return null;
  const query = buildQuery({
    msgID: id,
    mercID: params?.mercID ?? '',
    isCanadian: params?.isCanadian ?? false,
  });
  const paths = [
    `/api/workflow/messages/detail/${encodeURIComponent(id)}`,
    `/api/workflow/messages/detail${query}`,
  ];

  for (const path of paths) {
    const result = await getJsonOrNull<MercuryMessageDetailDataset>(path);
    if (!result) continue;
    const rowFromFlat = (result as unknown as { rows?: MercuryMessageDetailRow[] })?.rows?.[0];
    if (rowFromFlat) return rowFromFlat;
    const rowFromTables = firstDatasetRows(result as unknown, 'MessageDetailResp')?.[0] as MercuryMessageDetailRow | undefined;
    if (rowFromTables) return rowFromTables;
  }
  return null;
}

export async function fetchTicketStatus(ticketId: string): Promise<TicketStatusRow | null> {
  const id = normalizeTicketIdForApi(ticketId);
  if (!id) return null;

  const query = buildQuery({ ticketId: id });
  const paths = [
    `/api/workflow/ticket-status/${encodeURIComponent(id)}`,
    `/api/workflow/ticket-status${query}`,
  ];

  for (const path of paths) {
    const result = await getJsonOrNull<TicketStatusDataset>(path);
    if (!result) continue;
    const rowFromTables = (result as unknown as { tables?: { GetTicketStatus?: TicketStatusRow[] } })?.tables?.GetTicketStatus?.[0];
    if (rowFromTables) return rowFromTables;

    const byTicketId = (result as unknown as { byTicketId?: Record<string, TicketStatusRow> })?.byTicketId || {};
    const rowFromByTicket = byTicketId[id] || byTicketId[String(id).toUpperCase()] || byTicketId[String(id).toLowerCase()];
    if (rowFromByTicket) return rowFromByTicket;

    const firstByTicket = Object.values(byTicketId)[0] || null;
    if (firstByTicket) return firstByTicket;
  }
  return null;
}

export async function fetchOrderDetails(ticketId: string): Promise<OrderDetailsRow | null> {
  const id = normalizeTicketIdForApi(ticketId);
  if (!id) return null;
  const query = buildQuery({ ticketId: id });
  const paths = [
    `/api/workflow/order-details/${encodeURIComponent(id)}`,
    `/api/workflow/order-details${query}`,
  ];

  for (const path of paths) {
    const result = await getJsonOrNull<OrderDetailsDataset>(path);
    if (!result) continue;
    const rowFromTables = (result as unknown as { tables?: { LoadOrderDetails?: OrderDetailsRow[] } })?.tables?.LoadOrderDetails?.[0];
    if (rowFromTables) return rowFromTables;
    const rowFromFlat = (result as unknown as { rows?: OrderDetailsRow[] })?.rows?.[0];
    if (rowFromFlat) return rowFromFlat;
  }
  return null;
}

export async function fetchDistanceEstimate(params: {
  ticketId?: string;
  firmName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: string | number;
  longitude?: string | number;
}): Promise<DistanceEstimateResponse | null> {
  const query = buildQuery({
    ticketId: params.ticketId ?? '',
    firmName: params.firmName ?? '',
    addressLine1: params.addressLine1 ?? '',
    addressLine2: params.addressLine2 ?? '',
    city: params.city ?? '',
    state: params.state ?? '',
    postalCode: params.postalCode ?? '',
    country: params.country ?? '',
    latitude: params.latitude ?? '',
    longitude: params.longitude ?? '',
  });
  if (!query) return null;
  return getJson<DistanceEstimateResponse>(`/api/workflow/distance/estimate${query}`);
}

export async function fetchAddressSuggestions(queryText: string): Promise<AddressSuggestion[]> {
  const query = buildQuery({ q: queryText, country: 'US', limit: 5 });
  if (!query) return [];
  const response = await getJson<AddressSuggestionResponse>(`/api/workflow/mapbox/address-suggest${query}`);
  return Array.isArray(response.suggestions) ? response.suggestions : [];
}

export function buildStaticMapUrl(params: {
  latitude: string | number;
  longitude: string | number;
  width?: string | number;
  height?: string | number;
  zoom?: string | number;
  marker?: boolean;
  cacheKey?: string | number;
}): string {
  const query = buildQuery({
    latitude: params.latitude,
    longitude: params.longitude,
    width: params.width ?? 640,
    height: params.height ?? 260,
    zoom: params.zoom ?? 14,
    marker: params.marker === undefined ? undefined : (params.marker ? 'true' : 'false'),
    v: params.cacheKey,
  });
  return buildRequestUrl(`/api/workflow/mapbox/static-map${query}`);
}

export function buildStaticMapBaseUrl(params: {
  latitude: string | number;
  longitude: string | number;
  width?: string | number;
  height?: string | number;
  zoom?: string | number;
  cacheKey?: string | number;
}): string {
  const query = buildQuery({
    latitude: params.latitude,
    longitude: params.longitude,
    width: params.width ?? 640,
    height: params.height ?? 260,
    zoom: params.zoom ?? 14,
    v: params.cacheKey,
  });
  return buildRequestUrl(`/api/workflow/mapbox/static-map-base${query}`);
}

export async function fetchLifecycleLatest(ticketId: string): Promise<LifecycleRow | null> {
  const id = normalizeTicketIdForApi(ticketId);
  if (!id) return null;
  const query = buildQuery({ ticketId: id });
  const paths = [
    `/api/workflow/order-lifecycle/${encodeURIComponent(id)}`,
    `/api/workflow/order-lifecycle${query}`,
  ];

  for (const path of paths) {
    const result = await getJsonOrNull<LifecycleDataset>(path);
    if (!result) continue;
    const rows = firstDatasetRows(result as unknown, 'OLCStatusMsg') as LifecycleRow[];
    if (!rows.length) continue;
    return pickLifecycleSignal(rows);
  }
  return null;
}

export async function fetchLifecycleByServiceMsg(serviceMsgNum: string): Promise<LifecycleRow | null> {
  const serviceMsg = String(serviceMsgNum || '').trim();
  if (!serviceMsg) return null;
  const query = buildQuery({ serviceMsgNum: serviceMsg });
  const paths = [
    `/api/workflow/order-lifecycle/by-service-msg/${encodeURIComponent(serviceMsg)}`,
    `/api/workflow/order-lifecycle/by-service-msg${query}`,
  ];

  for (const path of paths) {
    const result = await getJsonOrNull<LifecycleDataset>(path);
    if (!result) continue;
    const rows = firstDatasetRows(result as unknown, 'OLCStatusMsg') as LifecycleRow[];
    if (!rows.length) continue;
    return pickLifecycleSignal(rows);
  }
  return null;
}

// ── Device pairing ──────────────────────────────────────────────────────────
// Each physical TV/kiosk carries its own long-lived token (issued from the
// Settings > Paired Devices panel on an already-paired screen) instead of one
// secret shared by every client, so a lost or decommissioned screen can be
// revoked individually. The bridge only enforces this once at least one
// device has been created; until then every call below behaves as if
// pairing were not required.

export interface PairedDevice {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
}

export interface PairDeviceResult {
  ok: boolean;
  paired: boolean;
  deviceId?: string;
  label?: string;
  status: number;
  error?: string;
}

export async function checkDevicePairing(candidateToken: string): Promise<PairDeviceResult> {
  const token = String(candidateToken || '').trim();
  const requestUrl = buildRequestUrl('/api/workflow/device/pair');
  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: token ? { Accept: 'application/json', [DEVICE_TOKEN_HEADER]: token } : { Accept: 'application/json' },
    });
    const bodyText = await response.text().catch(() => '');
    let body: Record<string, unknown> = {};
    try {
      body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      return { ok: false, paired: false, status: response.status, error: String(body.error || 'Invalid pairing code') };
    }
    return {
      ok: true,
      paired: Boolean(body.paired),
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      status: response.status,
    };
  } catch (error) {
    return { ok: false, paired: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchDevices(): Promise<PairedDevice[]> {
  const result = await getJson<{ devices: PairedDevice[] }>('/api/workflow/devices');
  return Array.isArray(result?.devices) ? result.devices : [];
}

export async function createDeviceToken(label: string): Promise<(PairedDevice & { token: string }) | null> {
  try {
    const result = await mutateJson<{ device: PairedDevice & { token: string } }>('POST', '/api/workflow/devices', { label });
    return result?.device || null;
  } catch {
    return null;
  }
}

export async function updateDeviceRecord(id: string, patch: { label?: string; enabled?: boolean }): Promise<PairedDevice | null> {
  try {
    const result = await mutateJson<{ device: PairedDevice }>('PATCH', `/api/workflow/devices/${encodeURIComponent(id)}`, patch);
    return result?.device || null;
  } catch {
    return null;
  }
}

export async function deleteDeviceRecord(id: string): Promise<boolean> {
  try {
    await mutateJson<{ ok: boolean }>('DELETE', `/api/workflow/devices/${encodeURIComponent(id)}`);
    return true;
  } catch {
    return false;
  }
}
