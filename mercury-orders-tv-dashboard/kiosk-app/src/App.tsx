import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUp,
  faArrowDown,
  faCalendarDay,
  faClock,
  faCircleCheck,
  faChevronLeft,
  faChevronRight,
  faFloppyDisk,
  faGear,
  faInbox,
  faMagnifyingGlass,
  faMinus,
  faDownLeftAndUpRightToCenter,
  faPlay,
  faPlus,
  faScroll,
  faTriangleExclamation,
  faTrash,
  faTruck,
  faUpRightAndDownLeftFromCenter,
  faVolumeHigh,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import {
  fetchDashboardServerConfig,
  buildStaticMapBaseUrl,
  buildStaticMapUrl,
  type AddressSuggestion,
  type DistanceEstimateResponse,
  fetchAddressSuggestions,
  fetchEventsNow,
  fetchDistanceEstimate,
  fetchLifecycleByServiceMsg,
  fetchLifecycleLatest,
  fetchMessageDetail,
  fetchMessageList,
  fetchOrderDetails,
  fetchOrdersByRoutes,
  fetchOrdersByZone,
  setWorkflowBaseUrlOverride,
  fetchTicketSearch,
  fetchTicketStatus,
  fetchUndeliveredOrders,
  saveDashboardServerConfig,
} from './lib/api';
import { deriveStage } from './lib/stageResolver';
import {
  STAGE_ORDER,
  type BoardCard,
  type DeliveryOrderByRouteRow,
  type DeliveryOrderByZoneRow,
  type LifecycleRow,
  type MessageItem,
  type MercuryMessageListRow,
  type OrderItem,
  type StatusStage,
  type TicketSearchRow,
  type TicketStatusRow,
} from './lib/types';
import { buildTickerItems, buildTickerScrollText } from './ticker/buildTickerFeed';
import { normalizeTickerModuleIds, TICKER_MODULE_DEFINITIONS } from './ticker/registry';
import { normalizeWeatherZip, prefetchWeatherTicker } from './ticker/modules/weather';
import { DEFAULT_STORE_HOURS_CONFIG, type StoreHoursConfig } from './ticker/modules/storeHours';
import type { TickerModuleId, WeatherTickerSnapshot } from './ticker/types';
import { fetchWeatherForecast, fetchRadarFrames, latLonToTile, weatherCodeDisplay, ccefIconName, degreesToCompass, type WeatherForecastData, type RadarFrame } from './lib/weatherForecast';
import appPackage from '../package.json';

type GroupedCards = Record<StatusStage, BoardCard[]>;
type IntakeKind = 'uncreated' | 'ask' | 'cancel' | 'message';
type IntakeMessageTypeKey = 'ask' | 'ans' | 'con' | 'cancel' | 'other' | 'unknown';
type ZipGateMode = 'watchlist' | 'allowlist';
type SenderGateMatchMode = 'contains' | 'exact';
type OrderGateSeverity = 'review' | 'reject';

interface SenderGateRule {
  id: string;
  pattern: string;
  matchMode: SenderGateMatchMode;
  label: string;
  enabled: boolean;
}

interface IntakeGateResult {
  key: string;
  label: string;
  detail: string;
  severity: OrderGateSeverity;
}

interface IntakeTicketCard {
  id: string;
  recipientName: string;
  summary: string;
  displayRef: string;
  destinationAddressLine: string;
  destinationCity: string;
  destinationState: string;
  destinationZip: string;
  destinationLabel: string;
  distanceMilesLabel: string;
  orderAmount: string;
  deliveryDate: string;
  messageDate: string;
  notes: string;
  wireService: string;
  senderName: string;
  senderGateText: string;
  msgType: string;
  messageTypeKey: IntakeMessageTypeKey;
  messageTypeLabel: string;
  kind: IntakeKind;
  relatedOrderNumber: string;
  relatedTicketId: string;
  relatedOrderStatus: string;
  requiresAttention: boolean;
  isStaleAsk: boolean;
  isMarketplace: boolean;
  isFlashing: boolean;
  askDebugSummary: string;
  askDebugDetails: string[];
  askMessageKeys: string[];
  gateResults: IntakeGateResult[];
}

interface OrderReferenceEntry {
  ID: string;
  RECIPIENT_NAME: string;
  SUMMARY_TEXT: string;
  DELIVERY_DATE: string;
  DELIVERY_CITY_STATE_ZIP: string;
  DELIVERY_ZIP: string;
  ORDER_AMOUNT: string;
  USER_REFERENCE: string;
  SALE_ID: string;
  STAGE_LABEL?: string;
}

type CandidateStrength = 'strong' | 'weak';

interface AskIdCandidate {
  value: string;
  normalized: string;
  source: string;
  strength: CandidateStrength;
  rank: number;
}

interface AskCandidateAttempt {
  candidate: string;
  source: string;
  strength: CandidateStrength;
  testedTicketIds: string[];
  testedOrderNumbers: string[];
  outcome: 'matched' | 'failed';
  reason: string;
}

type AudioAlertKind = 'marketplace' | 'today';
type AlertSoundPreset = 'alarm_pulse' | 'classic_ding' | 'bright_beep' | 'custom_upload';
type ClockFormat = '12h' | '24h';
type DashboardPageId = 'alerts_active' | 'page2' | 'weather' | 'delivery_map';
interface DashboardUserConfig {
  pollMs: number;
  flashMs: number;
  askStaleHours: number;
  mercuryBaseUrl: string;
  marketplaceDings: number;
  todayDings: number;
  dingGapMs: number;
  soundPreset: AlertSoundPreset;
  customSoundDataUrl: string;
  marketplaceSoundPreset: AlertSoundPreset;
  marketplaceCustomSoundDataUrl: string;
  customLogoDataUrl: string;
  clockFormat: ClockFormat;
  clockFlashColons: boolean;
  clockShowNanoseconds: boolean;
  tickerScrollDurationSec: number;
  tickerWeatherZip: string;
  tickerModules: TickerModuleId[];
  enabledPageIds: DashboardPageId[];
  pageAutoRotateEnabled: boolean;
  pageAutoRotateIntervalSec: number;
  deliveryMapInitialZoom: number;
  deliveryMapMinZoom: number;
  deliveryMapMaxZoom: number;
  deliveryMapZoomAdjustment: number;
  deliveryMapPadding: number;
  minOrderThreshold: number;
  minOrderPadding: number;
  zipGateMode: ZipGateMode;
  gateZipCodes: string[];
  blockedSenderRules: SenderGateRule[];
  currencySymbol: string;
  storeHours: StoreHoursConfig;
  shopName: string;
  shopAddress: string;
  shopAddressLatitude: number | null;
  shopAddressLongitude: number | null;
}

interface DeliveryMapPin {
  id: string;
  label: string;
  orderRef: string;
  statusLabel: string;
  deliveryDate: string;
  address: string;
  latitude: number;
  longitude: number;
  xPercent: number;
  yPercent: number;
}

interface DeliveryMapViewport {
  latitude: number;
  longitude: number;
  zoom: number;
}

interface DeliveryMapViewportConfig {
  initialZoom: number;
  minZoom: number;
  maxZoom: number;
  zoomAdjustment: number;
  padding: number;
}

const DEFAULT_POLL_MS = 15000;
const DEFAULT_FLASH_MS = 120000;
const DEFAULT_ASK_STALE_HOURS = 12;
const MERCURY_ENRICHMENT_CACHE_TTL_MS = 45000;
const MERCURY_FEED_CACHE_TTL_MS = 20000;
const MERCURY_FEED_STAGGER_MS = 500;
const DEFAULT_MARKETPLACE_DINGS = 3;
const DEFAULT_TODAY_DINGS = 1;
const DEFAULT_DING_GAP_MS = 620;
const DEFAULT_PAGE_AUTO_ROTATE_INTERVAL_SEC = 20;
const DELIVERY_MAP_IMAGE_WIDTH = 900;
const DELIVERY_MAP_IMAGE_HEIGHT = 520;
const DEFAULT_DELIVERY_MAP_INITIAL_ZOOM = 12;
const DEFAULT_DELIVERY_MAP_MIN_ZOOM = 9;
const DEFAULT_DELIVERY_MAP_MAX_ZOOM = 12;
const DEFAULT_DELIVERY_MAP_ZOOM_ADJUSTMENT = 0;
const DEFAULT_DELIVERY_MAP_PADDING = 140;
const DELIVERY_MAP_GEOCODE_MAX_DISTANCE_FROM_SHOP_MILES = 120;
const DELIVERY_MAP_OUTLIER_MAX_CLUSTER_DISTANCE_MILES = 100;
const NEW_ORDER_PULSE_WINDOW_MINUTES = 30;
const WEATHER_FORECAST_REFRESH_MS = 10 * 60 * 1000;
const WEATHER_FORECAST_RETRY_MS = 30 * 1000;
const CHART_ML = 40;
const CHART_MR = 36;
const CHART_MT = 14;
const CHART_MB = 28;
const CHART_VW = 1000;
const CHART_VH = 220;
const CHART_PW = CHART_VW - CHART_ML - CHART_MR;
const CHART_PH = CHART_VH - CHART_MT - CHART_MB;
const CHART_VISIBLE_HOURS = Array.from({ length: 24 }, (_, i) => i); // [0, 1, …, 23]
const APP_VERSION_LABEL = `v${String(appPackage.version || '0.0.0').trim() || '0.0.0'}`;
const LOADING_TICKER_TEXT = Array.from({ length: 18 }, () => 'Loading').join('  🌸  ');
const DASHBOARD_MODE_STORAGE_KEY = 'kiosk_dashboard_mode';
const AUDIO_ALERTS_STORAGE_KEY = 'kiosk_audio_alerts';
const DASHBOARD_CLIENT_CONFIG_STORAGE_KEY = 'kiosk_dashboard_client_config_v1';
const DASHBOARD_CONFIG_STORAGE_KEY_LEGACY = 'kiosk_dashboard_user_config_v1';
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const MARKETPLACE_REGEX = /\b(grub\s*hub|uber\s*eats|door\s*dash|doordash)\b/i;
const DEFAULT_DASHBOARD_CONFIG: DashboardUserConfig = {
  pollMs: DEFAULT_POLL_MS,
  flashMs: DEFAULT_FLASH_MS,
  askStaleHours: DEFAULT_ASK_STALE_HOURS,
  mercuryBaseUrl: '',
  marketplaceDings: DEFAULT_MARKETPLACE_DINGS,
  todayDings: DEFAULT_TODAY_DINGS,
  dingGapMs: DEFAULT_DING_GAP_MS,
  soundPreset: 'alarm_pulse',
  customSoundDataUrl: '',
  marketplaceSoundPreset: 'alarm_pulse',
  marketplaceCustomSoundDataUrl: '',
  customLogoDataUrl: '',
  clockFormat: '12h',
  clockFlashColons: true,
  clockShowNanoseconds: false,
  tickerScrollDurationSec: 22,
  tickerWeatherZip: '15212',
  tickerModules: normalizeTickerModuleIds(undefined),
  enabledPageIds: ['alerts_active'],
  pageAutoRotateEnabled: false,
  pageAutoRotateIntervalSec: DEFAULT_PAGE_AUTO_ROTATE_INTERVAL_SEC,
  deliveryMapInitialZoom: DEFAULT_DELIVERY_MAP_INITIAL_ZOOM,
  deliveryMapMinZoom: DEFAULT_DELIVERY_MAP_MIN_ZOOM,
  deliveryMapMaxZoom: DEFAULT_DELIVERY_MAP_MAX_ZOOM,
  deliveryMapZoomAdjustment: DEFAULT_DELIVERY_MAP_ZOOM_ADJUSTMENT,
  deliveryMapPadding: DEFAULT_DELIVERY_MAP_PADDING,
  minOrderThreshold: 55,
  minOrderPadding: 2,
  zipGateMode: 'watchlist',
  gateZipCodes: [],
  blockedSenderRules: [],
  currencySymbol: '$',
  storeHours: DEFAULT_STORE_HOURS_CONFIG,
  shopName: '',
  shopAddress: '',
  shopAddressLatitude: null,
  shopAddressLongitude: null,
};
const USD_ORDER_TOTAL_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const RECIPIENT_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'attn',
  'attention',
  'c',
  'care',
  'co',
  'for',
  'fwd',
  'in',
  'of',
  'on',
  'or',
  's',
  'so',
  'the',
  'to',
]);
const ACTIVE_STAGE_RANK: Record<StatusStage, number> = {
  incoming: 1,
  queued_not_designed: 2,
  designed: 3,
  saved_or_staged: 4,
  on_truck: 3,
  delivered_or_exception: 6,
};
const STAGE_SHORT_LABELS: Record<StatusStage, string> = {
  incoming: 'Incoming',
  queued_not_designed: 'Queued',
  designed: 'Designed',
  saved_or_staged: 'Staged',
  on_truck: 'Ready for Ship',
  delivered_or_exception: 'Delivered',
};
const STATE_NAME_TO_ABBREV: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
  'DISTRICT OF COLUMBIA': 'DC',
  'PUERTO RICO': 'PR',
  GUAM: 'GU',
  'AMERICAN SAMOA': 'AS',
  'NORTHERN MARIANA ISLANDS': 'MP',
  'U S VIRGIN ISLANDS': 'VI',
  'US VIRGIN ISLANDS': 'VI',
  'VIRGIN ISLANDS': 'VI',
};

function friendlyStatusLabel(stage: StatusStage, reason = ''): string {
  if (String(reason || '').toLowerCase().includes('cancel')) return 'Canceled';
  if (stage !== 'delivered_or_exception') {
    return STAGE_SHORT_LABELS[stage];
  }
  const reasonText = String(reason || '').toLowerCase();
  if (isExceptionStatusReason(reasonText)) return 'Exception';
  if (
    reasonText.includes('deliver')
    || reasonText.includes('left at front door')
    || reasonText.includes('left with')
    || reasonText.includes('picked up')
    || reasonText.includes('complete')
  ) {
    return 'Delivered';
  }
  return 'Delivered/Exception';
}

function isExceptionStatusReason(reason = ''): boolean {
  const reasonText = String(reason || '').toLowerCase();
  return reasonText.includes('exception')
    || reasonText.includes('fail')
    || reasonText.includes('undeliver')
    || reasonText.includes('return')
    || reasonText.includes('not at home')
    || reasonText.includes('not at work')
    || reasonText.includes('bad address')
    || reasonText.includes('refused');
}

function normalizeStageForOrderCard(stage: StatusStage): StatusStage {
  return stage === 'incoming' ? 'queued_not_designed' : stage;
}

function isCanceledOrder(card: BoardCard): boolean {
  const reason = String(card.stageReason || '').toLowerCase();
  const delivery = String(card.deliveryStatus || '').toLowerCase();
  const design = String(card.designStatus || '').toLowerCase();
  return reason.includes('cancel') || delivery.includes('cancel') || design.includes('cancel');
}

function isRefundOrder(card: BoardCard): boolean {
  const recipient = String(card.recipientName || '').trim();
  if (!recipient) return false;
  return recipient.toLowerCase().includes('refund of sale');
}

function isCompletedOrder(card: BoardCard): boolean {
  return card.stage === 'delivered_or_exception' || isCanceledOrder(card) || isRefundOrder(card);
}

function formatMercuryDateTimeLocal(raw: Date): string {
  const year = raw.getFullYear();
  const month = String(raw.getMonth() + 1).padStart(2, '0');
  const day = String(raw.getDate()).padStart(2, '0');
  const hour = String(raw.getHours()).padStart(2, '0');
  const minute = String(raw.getMinutes()).padStart(2, '0');
  const second = String(raw.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function activeRangeDayWindows(baseDate: Date, includeNextDay: boolean): Array<{ deliveryDate: string; deliveryThruDate: string }> {
  const windows: Array<{ deliveryDate: string; deliveryThruDate: string }> = [];
  const daysToFetch = includeNextDay ? 2 : 1;
  for (let i = 0; i < daysToFetch; i += 1) {
    const start = new Date(baseDate);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + i);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    windows.push({
      deliveryDate: formatMercuryDateTimeLocal(start),
      deliveryThruDate: formatMercuryDateTimeLocal(end),
    });
  }
  return windows;
}

function dateKeyFromDate(raw: Date): string {
  const year = raw.getFullYear();
  const month = String(raw.getMonth() + 1).padStart(2, '0');
  const day = String(raw.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateFromDateKey(raw: string): Date | null {
  const text = String(raw || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const value = new Date(year, month, day);
  value.setHours(0, 0, 0, 0);
  return value;
}

function dayOffsetFromToday(targetDate: Date): number {
  const now = new Date();
  const todayUtcEpoch = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const targetUtcEpoch = Date.UTC(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  return Math.round((targetUtcEpoch - todayUtcEpoch) / (24 * 60 * 60 * 1000));
}

function activeDeliveryDateKeys(baseDate: Date, includeNextDay: boolean): Set<string> {
  const keys = new Set<string>();
  const daysToFetch = includeNextDay ? 2 : 1;
  for (let i = 0; i < daysToFetch; i += 1) {
    const day = new Date(baseDate);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + i);
    keys.add(dateKeyFromDate(day));
  }
  return keys;
}

function isWithinDateKeys(deliveryDateRaw: string, allowedDateKeys: Set<string>): boolean {
  const deliveryDateKey = toDateKey(deliveryDateRaw);
  if (!deliveryDateKey) return false;
  return allowedDateKeys.has(deliveryDateKey);
}

function countOrdersForDateKey(cards: BoardCard[], dateKey: string): number {
  if (!dateKey) return 0;
  let count = 0;
  for (const card of cards) {
    if (toDateKey(card.deliveryDate) === dateKey) {
      count += 1;
    }
  }
  return count;
}

function emptyGroups(): GroupedCards {
  return {
    incoming: [],
    queued_not_designed: [],
    designed: [],
    saved_or_staged: [],
    on_truck: [],
    delivered_or_exception: [],
  };
}


function normalizeText(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function formatDisplayRecipientName(raw: string): string {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  // Drop trailing appended numeric token if present (e.g., "- 1372125").
  text = text.replace(/\s+-\s+\d{5,12}\s*$/, '').trim();
  if (!text) return '';

  if (text.includes(',')) {
    return text.toUpperCase();
  }

  const careOfMatch = text.match(/\s+(c\/o\s+.+)$/i);
  const careOfSuffix = careOfMatch ? ` ${careOfMatch[1].trim()}` : '';
  const baseName = careOfMatch ? text.slice(0, careOfMatch.index).trim() : text;
  const parts = baseName.split(' ').filter(Boolean);

  if (parts.length <= 1) {
    return `${baseName}${careOfSuffix}`.trim().toUpperCase();
  }

  const last = parts[parts.length - 1];
  const firstAndMiddle = parts.slice(0, -1).join(' ');
  return `${last}, ${firstAndMiddle}${careOfSuffix}`.toUpperCase();
}

function firstNonEmptyText(...values: Array<string | number | null | undefined>): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function firstNonEmptyRowValue(row: unknown, keys: string[]): string {
  const record = row as Record<string, unknown> | null | undefined;
  if (!record) return '';
  for (const key of keys) {
    const text = String(record[key] ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizedRowKey(raw: string): string {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function firstNonEmptyRowValueLoose(row: unknown, keys: string[]): string {
  const record = row as Record<string, unknown> | null | undefined;
  if (!record) return '';
  const lookup = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizedRowKey(rawKey);
    if (!key) continue;
    const text = String(rawValue ?? '').trim();
    if (!text) continue;
    if (!lookup.has(key)) lookup.set(key, text);
  }
  for (const keyCandidate of keys) {
    const key = normalizedRowKey(keyCandidate);
    if (!key) continue;
    const text = lookup.get(key) || '';
    if (text) return text;
  }
  return '';
}

function firstAmountLikeRowValue(row: unknown): string {
  const record = row as Record<string, unknown> | null | undefined;
  if (!record) return '';
  let bestScore = -1;
  let bestRaw = '';
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const valueText = String(rawValue ?? '').trim();
    if (!valueText) continue;
    if (!formatOrderAmount(valueText)) continue;
    const key = normalizedRowKey(rawKey);
    if (!key) continue;
    if (key.includes('paid') || key.includes('auth') || key.includes('exchange') || key.includes('rate')) continue;
    let score = -1;
    if (key === 'ccamount') score = 120;
    else if (key.includes('orderpriceamt')) score = 112;
    else if (key.includes('orderamount')) score = 108;
    else if (key.includes('totalamount')) score = 102;
    else if (key === 'total' || key.includes('ordertotal') || key.includes('saletotal')) score = 96;
    else if (key.includes('amount') || key.endsWith('amt') || key.includes('priceamt') || key.includes('chargeamt')) score = 88;
    if (score > bestScore) {
      bestScore = score;
      bestRaw = valueText;
    }
  }
  return bestRaw;
}

function normalizedStreetLine(row: unknown): string {
  return firstNonEmptyRowValue(row, [
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
  ]);
}

function normalizedCity(row: unknown): string {
  return firstNonEmptyRowValue(row, [
    'RECIPIENT_CITY',
    'RECIPIENT_CITY_NAME',
    'CITY_NAME',
    'CITY',
  ]);
}

function abbreviateState(stateRaw: string): string {
  const stateText = String(stateRaw || '').trim();
  if (!stateText) return '';
  const normalized = stateText
    .replace(/[^a-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return STATE_NAME_TO_ABBREV[normalized] || normalized;
}

function normalizedStateAbbrev(row: unknown): string {
  return abbreviateState(firstNonEmptyRowValue(row, [
    'RECIPIENT_STATE_ABBREV',
    'RECIPIENT_STATE_PROV_NAME',
    'STATE_PROVINCE_NAME',
    'STATE_ABBREV',
    'STATE_NAME',
    'RECIPIENT_STATE',
    'STATE',
  ]));
}

function extractUsZip5(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const stateZip = text.match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/i);
  if (stateZip) return stateZip[1];
  const zipPlus4 = text.match(/\b(\d{5})-\d{4}\b/);
  if (zipPlus4) return zipPlus4[1];
  const plainFive = text.match(/\b(\d{5})\b/);
  if (plainFive) return plainFive[1];
  const compactNine = text.replace(/\s+/g, '').match(/\b(\d{5})\d{4}\b/);
  if (compactNine) return compactNine[1];
  return '';
}

function extractZipFromRowKeys(row: unknown, keys: string[]): string {
  const record = row as Record<string, unknown> | null | undefined;
  if (!record) return '';
  for (const key of keys) {
    const zip = extractUsZip5(String(record[key] ?? ''));
    if (zip) return zip;
  }
  return '';
}

function normalizedPostalCode(row: unknown): string {
  return extractZipFromRowKeys(row, [
    'RECIPIENT_ZIP',
    'RECIPIENT_ZIP_CODE',
    'RECIPIENT_POSTAL_CODE',
    'RECIPIENT_POSTAL',
    'ZIP_CODE',
    'ZIP5',
    'ZIP_5',
    'POST_CODE',
    'POSTCODE',
    'POSTAL',
    'POSTAL_CODE',
    'ZIP',
  ]);
}

function formatOrderAmount(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const numericText = text.replace(/[^0-9.-]/g, '');
  if (!numericText || numericText === '-' || numericText === '.' || numericText === '-.') return '';
  const numericValue = Number(numericText);
  if (!Number.isFinite(numericValue)) return '';
  return USD_ORDER_TOTAL_FORMAT.format(numericValue);
}

function normalizedOrderAmount(row: unknown): string {
  const preferred = firstNonEmptyText(
    firstNonEmptyRowValue(row, [
      'CC_AMOUNT',
      'ORDER_TOTAL',
      'TOTAL_AMOUNT',
      'TOTAL',
      'AMOUNT',
      'NET_AMOUNT',
      'SALE_TOTAL',
      'ORDER_PRICE_AMT',
      'NEW_PRICE_AMT',
      'CHARGE_AMT',
      'ORDER_AMOUNT',
      'MESSAGE_AMOUNT',
      'TICKET_AMT',
      'BALANCE_DUE',
    ]),
    firstNonEmptyRowValueLoose(row, [
      'CC_AMOUNT',
      'ORDER_TOTAL',
      'TOTAL_AMOUNT',
      'TOTAL',
      'AMOUNT',
      'NET_AMOUNT',
      'SALE_TOTAL',
      'ORDER_PRICE_AMT',
      'NEW_PRICE_AMT',
      'CHARGE_AMT',
      'ORDER_AMOUNT',
      'MESSAGE_AMOUNT',
      'TICKET_AMT',
      'BALANCE_DUE',
    ]),
    firstAmountLikeRowValue(row),
  );
  return formatOrderAmount(preferred);
}

function amountToCents(raw: string): number | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const numericText = text.replace(/[^0-9.-]/g, '');
  if (!numericText || numericText === '-' || numericText === '.' || numericText === '-.') return null;
  const numericValue = Number(numericText);
  if (!Number.isFinite(numericValue)) return null;
  return Math.round(numericValue * 100);
}

function compactTownZipLabel(cityStateZipRaw: string, zipRaw: string): string {
  const cityStateZip = String(cityStateZipRaw || '').trim();
  const zip = extractUsZip5(zipRaw || cityStateZip);
  const cityCandidate = cityStateZip ? cityStateZip.split(',')[0].trim() : '';
  const city = cityCandidate && !extractUsZip5(cityCandidate) ? cityCandidate.toUpperCase() : '';
  if (city && zip) return `${city} ${zip}`;
  if (cityStateZip) {
    if (city) {
      const commaIndex = cityStateZip.indexOf(',');
      if (commaIndex >= 0) {
        return `${city}${cityStateZip.slice(commaIndex)}`;
      }
      return city;
    }
    return zip ? `ZIP ${zip}` : cityStateZip;
  }
  return zip ? `ZIP ${zip}` : '';
}

function deriveCardFooterZip(card: BoardCard): string {
  return String(card.deliveryZip || '').trim();
}

function normalizeAddressKeyText(raw: string): string {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function pendingDistanceLookupKey(ticket: IntakeTicketCard): string {
  const ticketId = String(ticket.relatedTicketId || '').trim();
  if (ticketId) return `ticket:${ticketId}`;
  const line1 = normalizeAddressKeyText(ticket.destinationAddressLine);
  const city = normalizeAddressKeyText(ticket.destinationCity);
  const state = normalizeAddressKeyText(ticket.destinationState);
  const zip = String(ticket.destinationZip || '').trim().replace(/\D/g, '').slice(0, 5);
  if (!line1 && !city && !state && !zip) return '';
  return `addr:${line1}|${city}|${state}|${zip}`;
}

function formatDistanceMilesLabel(raw: unknown): string {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  if (numeric >= 100) return `${Math.round(numeric)} MI`;
  return `${numeric.toFixed(1)} MI`;
}

function toEpoch(raw: string): number {
  const t = Date.parse(String(raw || ''));
  return Number.isNaN(t) ? 0 : t;
}

function parseCalendarDateParts(raw: string): { year: number; month: number; day: number } | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  const ymdLooseMatch = text.match(/(\d{4})\s*[\/-]\s*(\d{1,2})\s*[\/-]\s*(\d{1,2})/);
  if (ymdLooseMatch) {
    return {
      year: Number(ymdLooseMatch[1]),
      month: Number(ymdLooseMatch[2]),
      day: Number(ymdLooseMatch[3]),
    };
  }

  const mdyMatch = text.match(/(\d{1,2})\s*[\/-]\s*(\d{1,2})\s*[\/-]\s*(\d{4})/);
  if (mdyMatch) {
    return {
      year: Number(mdyMatch[3]),
      month: Number(mdyMatch[1]),
      day: Number(mdyMatch[2]),
    };
  }

  const epoch = toEpoch(text);
  if (!epoch) return null;
  const date = new Date(epoch);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function toDateKey(raw: string): string {
  const parts = parseCalendarDateParts(raw);
  if (!parts) return '';
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseToggle(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function parseMercuryDate(raw: string): Date | null {
  const parts = parseCalendarDateParts(raw);
  if (!parts) return null;
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function deliveryDateSortEpoch(raw: string): number {
  const date = parseMercuryDate(raw);
  if (!date) return 0;
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function hasMarketplaceKeyword(...parts: string[]): boolean {
  return MARKETPLACE_REGEX.test(parts.join(' '));
}

function hasPickupKeyword(...parts: string[]): boolean {
  const text = parts.join(' ');
  const compact = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return (
    compact.includes('pickup')
    || /\bpick[\s-]*up\b/i.test(text)
    || /\bp\.?\s*\/?\s*u\.?\b/i.test(text)
  );
}

function isPickupOrderType(orderTypeRaw: string): boolean {
  const orderType = String(orderTypeRaw || '');
  const compact = orderType.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return (
    hasPickupKeyword(orderType)
    || compact.includes('willcall')
    || compact.includes('carryout')
  );
}

function isPickupOrCodOrderType(orderTypeRaw: string): boolean {
  const orderType = String(orderTypeRaw || '');
  return (
    isPickupOrderType(orderType)
    || orderType.toLowerCase().includes('cod')
  );
}

function isPickupDeliveryMapCard(card: Pick<BoardCard, 'orderType' | 'addressLine' | 'recipientName'>): boolean {
  return isPickupOrderType(card.orderType) || hasPickupKeyword(card.addressLine, card.recipientName);
}


function isWireOrderType(orderTypeRaw: string): boolean {
  return /\bwire\b/i.test(String(orderTypeRaw || ''));
}

function isWireOutOrderType(orderTypeRaw: string): boolean {
  const t = String(orderTypeRaw || '').toLowerCase();
  return /\bwire\b/.test(t) && /\bout\b/.test(t);
}

function isLocalOrderType(orderTypeRaw: string): boolean {
  return /\blocal\b/i.test(String(orderTypeRaw || ''));
}

function resolvePreferredOrderType(currentTypeRaw: string, incomingTypeRaw: string): string {
  const currentType = String(currentTypeRaw || '').trim();
  const incomingType = String(incomingTypeRaw || '').trim();
  if (isLocalOrderType(incomingType) || isWireOrderType(incomingType) || isPickupOrCodOrderType(incomingType)) return incomingType;
  if (isLocalOrderType(currentType) || isWireOrderType(currentType) || isPickupOrCodOrderType(currentType)) return currentType;
  return firstNonEmptyText(incomingType, currentType);
}

function normalizeIdLike(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeTicketLookupId(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const slashForm = raw.match(/^(\d{5,12})\/(\d{1,3})$/);
  if (slashForm) return slashForm[1];
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function fetchRowsWithRetry<T>(
  loader: () => Promise<{ rows?: T[] }>,
  attempts = 2,
): Promise<T[]> {
  let remaining = Math.max(1, attempts);
  let lastError: unknown = null;
  while (remaining > 0) {
    try {
      const payload = await loader();
      return payload?.rows || [];
    } catch (error) {
      lastError = error;
      remaining -= 1;
      if (remaining <= 0) break;
      await sleep(180);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Feed request failed after retries.');
}

async function allSettledInBatches<TInput, TResult>(
  items: TInput[],
  batchSize: number,
  worker: (item: TInput) => Promise<TResult>,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const size = Math.max(1, batchSize);
  const settledResults: Array<PromiseSettledResult<TResult>> = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const batch = items.slice(offset, offset + size);
    const settled = await Promise.allSettled(batch.map(item => worker(item)));
    settledResults.push(...settled);
  }
  return settledResults;
}

async function mapWithStagger<TInput, TResult>(
  items: TInput[],
  delayMs: number,
  worker: (item: TInput, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  const waitMs = Math.max(0, Math.floor(delayMs));
  for (let index = 0; index < items.length; index += 1) {
    results.push(await worker(items[index], index));
    if (waitMs > 0 && index < items.length - 1) {
      await sleep(waitMs);
    }
  }
  return results;
}

function isAskDebugEnabledFromBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const queryEnabled = parseToggle(new URLSearchParams(window.location.search).get('askDebug'));
    if (queryEnabled) return true;
    return parseToggle(window.localStorage.getItem('askDebug'));
  } catch {
    return false;
  }
}

function initialDashboardMode(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const query = new URLSearchParams(window.location.search);
    const mode = String(query.get('mode') || '').trim().toLowerCase();
    const dashboardParam = parseToggle(query.get('dashboard'));
    const path = String(window.location.pathname || '').trim().toLowerCase().replace(/\/+$/, '');
    const forceByPath = path.endsWith('/dashboard') || path.endsWith('/dashboard-mode');
    if (dashboardParam || mode === 'dashboard' || forceByPath) return true;
    const saved = window.localStorage.getItem(DASHBOARD_MODE_STORAGE_KEY);
    if (saved === null) return true;
    return parseToggle(saved);
  } catch {
    return true;
  }
}

function initialAudioAlertsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const saved = window.localStorage.getItem(AUDIO_ALERTS_STORAGE_KEY);
    if (saved === null) return false;
    return parseToggle(saved);
  } catch {
    return false;
  }
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.floor(numeric);
  if (rounded < minimum) return minimum;
  if (rounded > maximum) return maximum;
  return rounded;
}

function clampCurrencyAmount(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.max(minimum, Math.min(maximum, numeric));
  return Math.round(clamped * 100) / 100;
}

function normalizeSoundPreset(value: unknown): AlertSoundPreset {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'classic_ding') return 'classic_ding';
  if (raw === 'bright_beep') return 'bright_beep';
  if (raw === 'custom_upload') return 'custom_upload';
  return 'alarm_pulse';
}

function normalizeMercuryBaseUrl(value: unknown): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeClockFormat(value: unknown): ClockFormat {
  return value === '24h' ? '24h' : '12h';
}

function normalizeToggle(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

function normalizeConfigText(value: unknown, maxLength: number): string {
  return String(value || '').slice(0, maxLength);
}

function normalizeZipGateMode(value: unknown): ZipGateMode {
  return value === 'allowlist' ? 'allowlist' : 'watchlist';
}

function normalizeSenderGateMatchMode(value: unknown): SenderGateMatchMode {
  return value === 'exact' ? 'exact' : 'contains';
}

function normalizeGateZipCodes(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[\s,;]+/);
  const next: string[] = [];
  for (const part of parts) {
    const zip = extractUsZip5(String(part || ''));
    if (!zip || next.includes(zip)) continue;
    next.push(zip);
    if (next.length >= 100) break;
  }
  return next;
}

function createSenderGateRuleId(): string {
  return `sender-rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeSenderGateRules(raw: unknown): SenderGateRule[] {
  const input = Array.isArray(raw) ? raw : [];
  const rules: SenderGateRule[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] as string | Partial<SenderGateRule> | null | undefined;
    const patternRaw = typeof item === 'string'
      ? item
      : firstNonEmptyText(item?.pattern, (item as { value?: string } | null | undefined)?.value);
    const pattern = normalizeConfigText(patternRaw, 120).trim();
    const id = normalizeConfigText(typeof item === 'string' ? '' : item?.id, 80).trim();
    if (!pattern && !id) continue;
    const label = typeof item === 'string'
      ? ''
      : normalizeConfigText(item?.label, 60).trim();
    rules.push({
      id: id || `sender-rule-${index + 1}`,
      pattern,
      matchMode: normalizeSenderGateMatchMode(typeof item === 'string' ? 'contains' : item?.matchMode),
      label,
      enabled: typeof item === 'string' ? true : normalizeToggle(item?.enabled, true),
    });
    if (rules.length >= 50) break;
  }
  return rules;
}

function normalizeOptionalCoordinate(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < -180 || numeric > 180) return null;
  return numeric;
}

function normalizeStoreHoursTime(value: unknown, fallback: string): string {
  const raw = String(value || '').trim();
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;
  return fallback;
}

function normalizeStoreHoursConfig(raw: Partial<StoreHoursConfig> | null | undefined): StoreHoursConfig {
  const base = DEFAULT_STORE_HOURS_CONFIG;
  return {
    monFriEnabled: normalizeToggle(raw?.monFriEnabled, base.monFriEnabled),
    monFriOpen: normalizeStoreHoursTime(raw?.monFriOpen, base.monFriOpen),
    monFriClose: normalizeStoreHoursTime(raw?.monFriClose, base.monFriClose),
    saturdayEnabled: normalizeToggle(raw?.saturdayEnabled, base.saturdayEnabled),
    saturdayOpen: normalizeStoreHoursTime(raw?.saturdayOpen, base.saturdayOpen),
    saturdayClose: normalizeStoreHoursTime(raw?.saturdayClose, base.saturdayClose),
    sundayEnabled: normalizeToggle(raw?.sundayEnabled, base.sundayEnabled),
    sundayOpen: normalizeStoreHoursTime(raw?.sundayOpen, base.sundayOpen),
    sundayClose: normalizeStoreHoursTime(raw?.sundayClose, base.sundayClose),
  };
}

function mercatorWorldPoint(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const sinLat = Math.sin((Math.max(-85.05113, Math.min(85.05113, latitude)) * Math.PI) / 180);
  const scale = 512 * (2 ** zoom);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function deliveryMapDistanceMiles(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const earthRadiusMiles = 3958.8;
  const lat1 = degreesToRadians(left.latitude);
  const lat2 = degreesToRadians(right.latitude);
  const deltaLat = degreesToRadians(right.latitude - left.latitude);
  const deltaLon = degreesToRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * (Math.sin(deltaLon / 2) ** 2);
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function medianNumber(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function deliveryMapShopPoint(config: DashboardUserConfig): { latitude: number; longitude: number } | null {
  if (config.shopAddressLatitude === null || config.shopAddressLongitude === null) return null;
  return {
    latitude: config.shopAddressLatitude,
    longitude: config.shopAddressLongitude,
  };
}

function pickDeliveryMapAddressSuggestion(
  suggestions: AddressSuggestion[],
  origin: { latitude: number; longitude: number } | null,
): AddressSuggestion | null {
  if (!suggestions.length) return null;
  if (!origin) return suggestions[0] || null;

  const ranked = suggestions
    .map(suggestion => ({
      suggestion,
      distanceMiles: deliveryMapDistanceMiles(origin, suggestion),
    }))
    .filter(item => Number.isFinite(item.distanceMiles))
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  if (!ranked.length) return suggestions[0] || null;
  const nearest = ranked[0];
  if (nearest.distanceMiles > DELIVERY_MAP_GEOCODE_MAX_DISTANCE_FROM_SHOP_MILES) {
    return null;
  }
  return nearest.suggestion;
}

function pickDeliveryMapViewportPoints<TPoint extends { latitude: number; longitude: number }>(
  points: TPoint[],
  origin: { latitude: number; longitude: number } | null,
): TPoint[] {
  if (points.length < 4) return points;

  if (origin) {
    const nearShop = points.filter(point => (
      deliveryMapDistanceMiles(origin, point) <= DELIVERY_MAP_GEOCODE_MAX_DISTANCE_FROM_SHOP_MILES
    ));
    if (nearShop.length >= Math.max(3, Math.ceil(points.length * 0.6))) {
      return nearShop;
    }
  }

  const medianPoint = {
    latitude: medianNumber(points.map(point => point.latitude)),
    longitude: medianNumber(points.map(point => point.longitude)),
  };
  const distances = points.map(point => deliveryMapDistanceMiles(medianPoint, point));
  const medianDistance = medianNumber(distances);
  const threshold = Math.min(
    DELIVERY_MAP_OUTLIER_MAX_CLUSTER_DISTANCE_MILES,
    Math.max(20, medianDistance * 3),
  );
  const clustered = points.filter((_, index) => distances[index] <= threshold);
  if (clustered.length >= Math.max(3, Math.ceil(points.length * 0.6))) {
    return clustered;
  }

  return points;
}

function buildDeliveryMapViewportFitPoints<TPoint extends { latitude: number; longitude: number }>(
  points: TPoint[],
  origin: { latitude: number; longitude: number } | null,
): Array<{ latitude: number; longitude: number }> {
  const clusteredPoints = pickDeliveryMapViewportPoints(points, origin);
  if (!clusteredPoints.length || !origin) return clusteredPoints;
  return [...clusteredPoints, origin];
}

function deliveryMapLookupKey(card: BoardCard): string {
  return [
    normalizeAddressKeyText(card.addressLine),
    normalizeAddressKeyText(card.cityStateZip),
    normalizeAddressKeyText(deriveCardFooterZip(card)),
  ].filter(Boolean).join('|');
}

function deliveryMapAddressLineForQuery(addressLineRaw: string): string {
  const lines = String(addressLineRaw || '')
    .split(/\r?\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] || '';

  const streetLineIndex = lines.findIndex(line => (
    /^\d+\s+\S+/.test(line)
    || /\b(ave|avenue|blvd|boulevard|cir|circle|ct|court|dr|drive|hwy|highway|ln|lane|pkwy|parkway|pl|place|rd|road|st|street|ter|terrace|trl|trail|way)\b/i.test(line)
  ));
  if (streetLineIndex >= 0) {
    return lines.slice(streetLineIndex).join(' ');
  }

  return lines[lines.length - 1] || '';
}

function deliveryMapAddressQuery(card: BoardCard): string {
  return [
    deliveryMapAddressLineForQuery(card.addressLine),
    card.cityStateZip,
    deriveCardFooterZip(card),
  ].map(value => String(value || '').trim()).filter(Boolean).join(', ');
}

function normalizeDeliveryMapViewportConfig(raw: Partial<DeliveryMapViewportConfig> | null | undefined): DeliveryMapViewportConfig {
  const rawMinZoom = clampInteger(raw?.minZoom, 8, 18, DEFAULT_DELIVERY_MAP_MIN_ZOOM);
  const rawMaxZoom = clampInteger(raw?.maxZoom, 8, 18, DEFAULT_DELIVERY_MAP_MAX_ZOOM);
  const minZoom = Math.min(rawMinZoom, rawMaxZoom);
  const maxZoom = Math.max(rawMinZoom, rawMaxZoom);
  const initialZoom = Math.max(
    minZoom,
    Math.min(maxZoom, clampInteger(raw?.initialZoom, 8, 18, DEFAULT_DELIVERY_MAP_INITIAL_ZOOM)),
  );
  return {
    initialZoom,
    minZoom,
    maxZoom,
    zoomAdjustment: clampInteger(raw?.zoomAdjustment, -4, 4, DEFAULT_DELIVERY_MAP_ZOOM_ADJUSTMENT),
    padding: clampInteger(raw?.padding, 40, 260, DEFAULT_DELIVERY_MAP_PADDING),
  };
}

function buildDeliveryMapViewport(
  points: Array<{ latitude: number; longitude: number }>,
  rawConfig?: Partial<DeliveryMapViewportConfig>,
): DeliveryMapViewport | null {
  if (!points.length) return null;
  const viewportConfig = normalizeDeliveryMapViewportConfig(rawConfig);
  const minLat = Math.min(...points.map(point => point.latitude));
  const maxLat = Math.max(...points.map(point => point.latitude));
  const minLon = Math.min(...points.map(point => point.longitude));
  const maxLon = Math.max(...points.map(point => point.longitude));
  const latitude = (minLat + maxLat) / 2;
  const longitude = (minLon + maxLon) / 2;
  if (points.length === 1) {
    const zoom = Math.max(
      viewportConfig.minZoom,
      Math.min(viewportConfig.maxZoom, viewportConfig.initialZoom + viewportConfig.zoomAdjustment),
    );
    return { latitude, longitude, zoom };
  }

  const sw = mercatorWorldPoint(minLat, minLon, 0);
  const ne = mercatorWorldPoint(maxLat, maxLon, 0);
  const spanX = Math.max(0.00001, Math.abs(ne.x - sw.x));
  const spanY = Math.max(0.00001, Math.abs(sw.y - ne.y));
  const zoomX = Math.log2(Math.max(1, DELIVERY_MAP_IMAGE_WIDTH - viewportConfig.padding) / spanX);
  const zoomY = Math.log2(Math.max(1, DELIVERY_MAP_IMAGE_HEIGHT - viewportConfig.padding) / spanY);
  const fitZoom = Math.floor(Math.min(zoomX, zoomY));
  const zoom = Math.max(viewportConfig.minZoom, Math.min(viewportConfig.maxZoom, fitZoom + viewportConfig.zoomAdjustment));
  return { latitude, longitude, zoom };
}

function positionDeliveryMapPins(
  points: Array<Omit<DeliveryMapPin, 'xPercent' | 'yPercent'>>,
  viewport: DeliveryMapViewport | null,
): DeliveryMapPin[] {
  if (!viewport) return [];
  const center = mercatorWorldPoint(viewport.latitude, viewport.longitude, viewport.zoom);
  const positioned = points.map(point => {
    const projected = mercatorWorldPoint(point.latitude, point.longitude, viewport.zoom);
    return {
      ...point,
      xPercent: ((DELIVERY_MAP_IMAGE_WIDTH / 2 + projected.x - center.x) / DELIVERY_MAP_IMAGE_WIDTH) * 100,
      yPercent: ((DELIVERY_MAP_IMAGE_HEIGHT / 2 + projected.y - center.y) / DELIVERY_MAP_IMAGE_HEIGHT) * 100,
    };
  });

  const clusters: DeliveryMapPin[][] = [];
  for (const pin of positioned) {
    const cluster = clusters.find(existing => existing.some(other => (
      Math.abs(other.xPercent - pin.xPercent) < 3.2
      && Math.abs(other.yPercent - pin.yPercent) < 4.6
    )));
    if (cluster) cluster.push(pin);
    else clusters.push([pin]);
  }

  return clusters.flatMap(cluster => {
    if (cluster.length === 1) return cluster;
    const centerX = cluster.reduce((sum, pin) => sum + pin.xPercent, 0) / cluster.length;
    const centerY = cluster.reduce((sum, pin) => sum + pin.yPercent, 0) / cluster.length;
    const radius = Math.min(6.2, Math.max(2.6, 1.35 + cluster.length * 0.36));
    return cluster.map((pin, index) => {
      const angle = (-Math.PI / 2) + (index / cluster.length) * Math.PI * 2;
      return {
        ...pin,
        xPercent: Math.max(3, Math.min(97, centerX + Math.cos(angle) * radius)),
        yPercent: Math.max(5, Math.min(95, centerY + Math.sin(angle) * radius)),
      };
    });
  });
}

const DASHBOARD_PAGE_DEFINITIONS: Array<{ id: DashboardPageId; label: string }> = [
  { id: 'alerts_active', label: 'Alerts + Active Orders' },
  { id: 'page2', label: 'Today\'s Stats' },
  { id: 'weather', label: 'Weather' },
  { id: 'delivery_map', label: 'Delivery Map' },
];

function normalizeEnabledPageIds(raw: unknown): DashboardPageId[] {
  const input = Array.isArray(raw) ? raw : [];
  const allowed = new Set<DashboardPageId>(DASHBOARD_PAGE_DEFINITIONS.map(page => page.id));
  const next: DashboardPageId[] = [];
  for (const item of input) {
    const value = String(item || '').trim() as DashboardPageId;
    if (!allowed.has(value)) continue;
    if (next.includes(value)) continue;
    next.push(value);
  }
  return next.length ? next : ['alerts_active'];
}

function renderPagePreviewSvg(pageId: DashboardPageId) {
  if (pageId === 'alerts_active') {
    return (
      <svg viewBox="0 0 120 56" role="img" aria-label="Alerts and active orders page preview">
        <rect x="1" y="1" width="118" height="54" rx="6" fill="#f4f8ff" stroke="#9fb3d0" />
        <rect x="8" y="8" width="50" height="40" rx="4" fill="#fff5df" stroke="#d8b679" />
        <rect x="13" y="14" width="40" height="5" rx="2" fill="#d68c2b" />
        <rect x="13" y="23" width="34" height="4" rx="2" fill="#c9a574" />
        <rect x="13" y="31" width="36" height="4" rx="2" fill="#c9a574" />
        <rect x="62" y="8" width="50" height="40" rx="4" fill="#edf4ff" stroke="#90a8ca" />
        <rect x="67" y="14" width="40" height="5" rx="2" fill="#3d6db4" />
        <rect x="67" y="23" width="36" height="4" rx="2" fill="#7f9fcf" />
        <rect x="67" y="31" width="38" height="4" rx="2" fill="#7f9fcf" />
      </svg>
    );
  }
  if (pageId === 'page2') {
    return (
      <svg viewBox="0 0 120 56" role="img" aria-label="Today's stats page preview">
        <rect x="1" y="1" width="118" height="54" rx="6" fill="#f6f8fb" stroke="#a9b5c8" />
        {/* KPI cards row */}
        {[8, 26, 44, 62, 80, 98].map((x, i) => (
          <rect key={i} x={x} y="6" width="16" height="12" rx="2" fill={i === 1 ? '#d4f0e4' : i === 3 ? '#fde8ea' : '#e2e8f3'} stroke="#b0bdc8" strokeWidth="0.5" />
        ))}
        {/* Pipeline row */}
        <rect x="8" y="22" width="104" height="10" rx="2" fill="#dde4ec" stroke="#b0bdc8" strokeWidth="0.5" />
        {[8, 26, 44, 62, 80].map((x, i) => (
          <rect key={i} x={x} y="22" width={i === 0 ? 18 : i === 1 ? 14 : i === 2 ? 10 : i === 3 ? 22 : 16} height="10" rx="0" fill={i === 3 ? '#c8dff5' : i === 4 ? '#d4f0e4' : '#e8ecf4'} />
        ))}
        {/* Intake cards + ring */}
        {[8, 34, 60, 86].map((x, i) => (
          <rect key={i} x={x} y="36" width="22" height="14" rx="2" fill={i === 1 ? '#fde8ea' : '#e2e8f3'} stroke="#b0bdc8" strokeWidth="0.5" />
        ))}
        <circle cx="110" cy="43" r="8" fill="none" stroke="#d4f0e4" strokeWidth="3" />
        <circle cx="110" cy="43" r="8" fill="none" stroke="#4caf7a" strokeWidth="3" strokeDasharray="30 21" strokeDashoffset="12" transform="rotate(-90 110 43)" />
      </svg>
    );
  }
  if (pageId === 'delivery_map') {
    return (
      <svg viewBox="0 0 120 56" role="img" aria-label="Delivery map page preview">
        <rect x="1" y="1" width="118" height="54" rx="6" fill="#e6eef5" stroke="#86a4bd" />
        <path d="M6 18 C18 12, 26 14, 40 9 C52 5, 62 11, 72 8 C88 4, 98 10, 114 6 L114 50 C100 45, 88 49, 74 44 C62 39, 50 46, 38 42 C24 37, 18 45, 6 40 Z" fill="#d7e7d9" stroke="#9bb9a2" strokeWidth="0.8" />
        <path d="M8 34 C24 26, 38 28, 52 22 C68 15, 78 20, 92 15 C100 12, 106 10, 114 11" fill="none" stroke="#f8fafc" strokeWidth="4" />
        <path d="M16 8 C24 20, 32 25, 46 32 C58 38, 70 37, 84 47" fill="none" stroke="#f8fafc" strokeWidth="3" />
        {[
          [28, 23],
          [50, 31],
          [68, 18],
          [87, 38],
          [101, 20],
        ].map(([x, y], index) => (
          <g key={index}>
            <path d={`M${x} ${y - 7} c-3.4 0-6 2.6-6 5.8 0 4.2 6 10.2 6 10.2s6-6 6-10.2c0-3.2-2.6-5.8-6-5.8z`} fill="#1f3d64" />
            <circle cx={x} cy={y - 1.6} r="2" fill="#fff" />
          </g>
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 56" role="img" aria-label="Weather page preview">
      <rect x="1" y="1" width="118" height="54" rx="6" fill="#e4f0fa" stroke="#7aaed0" />
      {/* Current conditions card */}
      <rect x="5" y="5" width="34" height="30" rx="3" fill="#fff9e8" stroke="#c9a83c" strokeWidth="0.8" />
      <circle cx="22" cy="16" r="7" fill="#f5d04a" />
      <rect x="9" y="27" width="26" height="3" rx="1.5" fill="#c9a830" opacity="0.6" />
      {/* Today card */}
      <rect x="43" y="5" width="32" height="30" rx="3" fill="#eef5ff" stroke="#7fa8d4" strokeWidth="0.8" />
      <rect x="48" y="9" width="22" height="5" rx="2" fill="#2a5fa0" opacity="0.5" />
      <rect x="48" y="17" width="16" height="3" rx="1.5" fill="#5080b8" opacity="0.4" />
      <rect x="48" y="23" width="20" height="3" rx="1.5" fill="#5080b8" opacity="0.35" />
      {/* Tomorrow card */}
      <rect x="79" y="5" width="34" height="30" rx="3" fill="#eef5ff" stroke="#7fa8d4" strokeWidth="0.8" />
      <rect x="84" y="9" width="22" height="5" rx="2" fill="#2a5fa0" opacity="0.5" />
      <rect x="84" y="17" width="18" height="3" rx="1.5" fill="#5080b8" opacity="0.4" />
      <rect x="84" y="23" width="14" height="3" rx="1.5" fill="#5080b8" opacity="0.35" />
      {/* Hourly chart strip */}
      <rect x="5" y="39" width="64" height="13" rx="2" fill="#d0e4f0" stroke="#8ab0cc" strokeWidth="0.5" />
      <polyline points="7,50 18,44 29,46 40,42 51,43 62,47 68,50" fill="none" stroke="#1a5a9a" strokeWidth="1.5" />
      {/* Radar strip */}
      <rect x="73" y="39" width="40" height="13" rx="2" fill="#c4d8e0" stroke="#6898aa" strokeWidth="0.5" />
      <ellipse cx="93" cy="45" rx="6" ry="5" fill="none" stroke="#3a788a" strokeWidth="0.6" />
      <ellipse cx="93" cy="45" rx="3" ry="2.5" fill="#70b880" opacity="0.5" />
    </svg>
  );
}

function pageDescription(pageId: DashboardPageId): string {
  if (pageId === 'alerts_active') return 'Alerts + Active Orders';
  if (pageId === 'page2') return 'Stats & KPIs';
  if (pageId === 'weather') return 'Weather Forecast';
  if (pageId === 'delivery_map') return 'Delivery Map';
  return 'Page';
}

function pickServerConfigFields(raw: Partial<DashboardUserConfig> | null | undefined): Partial<DashboardUserConfig> {
  return {
    pollMs: raw?.pollMs,
    flashMs: raw?.flashMs,
    askStaleHours: raw?.askStaleHours,
    mercuryBaseUrl: raw?.mercuryBaseUrl,
    marketplaceDings: raw?.marketplaceDings,
    todayDings: raw?.todayDings,
    dingGapMs: raw?.dingGapMs,
    clockFormat: raw?.clockFormat,
    clockFlashColons: raw?.clockFlashColons,
    clockShowNanoseconds: raw?.clockShowNanoseconds,
    tickerScrollDurationSec: raw?.tickerScrollDurationSec,
    customLogoDataUrl: raw?.customLogoDataUrl,
    tickerWeatherZip: raw?.tickerWeatherZip,
    tickerModules: raw?.tickerModules,
    enabledPageIds: raw?.enabledPageIds,
    pageAutoRotateEnabled: raw?.pageAutoRotateEnabled,
    pageAutoRotateIntervalSec: raw?.pageAutoRotateIntervalSec,
    deliveryMapInitialZoom: raw?.deliveryMapInitialZoom,
    deliveryMapMinZoom: raw?.deliveryMapMinZoom,
    deliveryMapMaxZoom: raw?.deliveryMapMaxZoom,
    deliveryMapZoomAdjustment: raw?.deliveryMapZoomAdjustment,
    deliveryMapPadding: raw?.deliveryMapPadding,
    minOrderThreshold: raw?.minOrderThreshold,
    minOrderPadding: raw?.minOrderPadding,
    zipGateMode: raw?.zipGateMode,
    gateZipCodes: raw?.gateZipCodes,
    blockedSenderRules: raw?.blockedSenderRules,
    currencySymbol: raw?.currencySymbol,
    storeHours: raw?.storeHours,
    shopName: raw?.shopName,
    shopAddress: raw?.shopAddress,
    shopAddressLatitude: raw?.shopAddressLatitude,
    shopAddressLongitude: raw?.shopAddressLongitude,
  };
}

function pickClientConfigFields(raw: Partial<DashboardUserConfig> | null | undefined): Partial<DashboardUserConfig> {
  return {
    soundPreset: raw?.soundPreset,
    customSoundDataUrl: raw?.customSoundDataUrl,
    marketplaceSoundPreset: raw?.marketplaceSoundPreset,
    marketplaceCustomSoundDataUrl: raw?.marketplaceCustomSoundDataUrl,
    enabledPageIds: raw?.enabledPageIds,
    pageAutoRotateEnabled: raw?.pageAutoRotateEnabled,
    pageAutoRotateIntervalSec: raw?.pageAutoRotateIntervalSec,
  };
}

function sanitizeServerBackedConfig(raw: Partial<DashboardUserConfig> | null | undefined): Partial<DashboardUserConfig> {
  return pickServerConfigFields(sanitizeDashboardConfig(raw));
}

function sanitizeClientConfig(raw: Partial<DashboardUserConfig> | null | undefined): Partial<DashboardUserConfig> {
  return pickClientConfigFields(sanitizeDashboardConfig(raw));
}

function sanitizeDashboardConfig(raw: Partial<DashboardUserConfig> | null | undefined): DashboardUserConfig {
  return {
    pollMs: clampInteger(raw?.pollMs, 15000, 60000, DEFAULT_DASHBOARD_CONFIG.pollMs),
    flashMs: clampInteger(raw?.flashMs, 10000, 600000, DEFAULT_DASHBOARD_CONFIG.flashMs),
    askStaleHours: clampInteger(raw?.askStaleHours, 1, 72, DEFAULT_DASHBOARD_CONFIG.askStaleHours),
    mercuryBaseUrl: normalizeMercuryBaseUrl(raw?.mercuryBaseUrl),
    marketplaceDings: clampInteger(raw?.marketplaceDings, 1, 9, DEFAULT_DASHBOARD_CONFIG.marketplaceDings),
    todayDings: clampInteger(raw?.todayDings, 1, 9, DEFAULT_DASHBOARD_CONFIG.todayDings),
    dingGapMs: clampInteger(raw?.dingGapMs, 250, 2500, DEFAULT_DASHBOARD_CONFIG.dingGapMs),
    soundPreset: normalizeSoundPreset(raw?.soundPreset),
    customSoundDataUrl: String(raw?.customSoundDataUrl || '').trim(),
    marketplaceSoundPreset: normalizeSoundPreset(raw?.marketplaceSoundPreset),
    marketplaceCustomSoundDataUrl: String(raw?.marketplaceCustomSoundDataUrl || '').trim(),
    customLogoDataUrl: String(raw?.customLogoDataUrl || '').trim(),
    clockFormat: normalizeClockFormat(raw?.clockFormat),
    clockFlashColons: normalizeToggle(raw?.clockFlashColons, DEFAULT_DASHBOARD_CONFIG.clockFlashColons),
    clockShowNanoseconds: normalizeToggle(raw?.clockShowNanoseconds, DEFAULT_DASHBOARD_CONFIG.clockShowNanoseconds),
    tickerScrollDurationSec: clampInteger(raw?.tickerScrollDurationSec, 8, 80, DEFAULT_DASHBOARD_CONFIG.tickerScrollDurationSec),
    tickerWeatherZip: normalizeWeatherZip(raw?.tickerWeatherZip),
    tickerModules: normalizeTickerModuleIds(raw?.tickerModules),
    enabledPageIds: normalizeEnabledPageIds(raw?.enabledPageIds),
    pageAutoRotateEnabled: normalizeToggle(raw?.pageAutoRotateEnabled, DEFAULT_DASHBOARD_CONFIG.pageAutoRotateEnabled),
    pageAutoRotateIntervalSec: clampInteger(
      raw?.pageAutoRotateIntervalSec,
      5,
      300,
      DEFAULT_DASHBOARD_CONFIG.pageAutoRotateIntervalSec,
    ),
    ...(() => {
      const viewportConfig = normalizeDeliveryMapViewportConfig({
        initialZoom: raw?.deliveryMapInitialZoom,
        minZoom: raw?.deliveryMapMinZoom,
        maxZoom: raw?.deliveryMapMaxZoom,
        zoomAdjustment: raw?.deliveryMapZoomAdjustment,
        padding: raw?.deliveryMapPadding,
      });
      return {
        deliveryMapInitialZoom: viewportConfig.initialZoom,
        deliveryMapMinZoom: viewportConfig.minZoom,
        deliveryMapMaxZoom: viewportConfig.maxZoom,
        deliveryMapZoomAdjustment: viewportConfig.zoomAdjustment,
        deliveryMapPadding: viewportConfig.padding,
      };
    })(),
    minOrderThreshold: clampInteger(raw?.minOrderThreshold, 0, 9999, DEFAULT_DASHBOARD_CONFIG.minOrderThreshold),
    minOrderPadding: clampCurrencyAmount(raw?.minOrderPadding, 0, 25, DEFAULT_DASHBOARD_CONFIG.minOrderPadding),
    zipGateMode: normalizeZipGateMode(raw?.zipGateMode),
    gateZipCodes: normalizeGateZipCodes(raw?.gateZipCodes),
    blockedSenderRules: normalizeSenderGateRules(raw?.blockedSenderRules),
    currencySymbol: String(raw?.currencySymbol ?? DEFAULT_DASHBOARD_CONFIG.currencySymbol).trim().slice(0, 3) || '$',
    storeHours: normalizeStoreHoursConfig(raw?.storeHours),
    shopName: normalizeConfigText(raw?.shopName, 80),
    shopAddress: normalizeConfigText(raw?.shopAddress, 180),
    shopAddressLatitude: normalizeOptionalCoordinate(raw?.shopAddressLatitude),
    shopAddressLongitude: normalizeOptionalCoordinate(raw?.shopAddressLongitude),
  };
}

function buildSoundConfigForAlertKind(baseRaw: DashboardUserConfig, kind: AudioAlertKind): DashboardUserConfig {
  const base = sanitizeDashboardConfig(baseRaw);
  if (kind === 'marketplace') {
    return sanitizeDashboardConfig({
      ...base,
      soundPreset: base.marketplaceSoundPreset,
      customSoundDataUrl: base.marketplaceCustomSoundDataUrl,
    });
  }
  return base;
}

function isDashboardConfigEqual(leftRaw: DashboardUserConfig, rightRaw: DashboardUserConfig): boolean {
  const left = sanitizeDashboardConfig(leftRaw);
  const right = sanitizeDashboardConfig(rightRaw);
  return left.pollMs === right.pollMs
    && left.flashMs === right.flashMs
    && left.askStaleHours === right.askStaleHours
    && left.mercuryBaseUrl === right.mercuryBaseUrl
    && left.marketplaceDings === right.marketplaceDings
    && left.todayDings === right.todayDings
    && left.dingGapMs === right.dingGapMs
    && left.soundPreset === right.soundPreset
    && left.customSoundDataUrl === right.customSoundDataUrl
    && left.marketplaceSoundPreset === right.marketplaceSoundPreset
    && left.marketplaceCustomSoundDataUrl === right.marketplaceCustomSoundDataUrl
    && left.customLogoDataUrl === right.customLogoDataUrl
    && left.clockFormat === right.clockFormat
    && left.clockFlashColons === right.clockFlashColons
    && left.clockShowNanoseconds === right.clockShowNanoseconds
    && left.tickerScrollDurationSec === right.tickerScrollDurationSec
    && left.tickerWeatherZip === right.tickerWeatherZip
    && left.tickerModules.join('|') === right.tickerModules.join('|')
    && left.enabledPageIds.join('|') === right.enabledPageIds.join('|')
    && left.pageAutoRotateEnabled === right.pageAutoRotateEnabled
    && left.pageAutoRotateIntervalSec === right.pageAutoRotateIntervalSec
    && left.deliveryMapInitialZoom === right.deliveryMapInitialZoom
    && left.deliveryMapMinZoom === right.deliveryMapMinZoom
    && left.deliveryMapMaxZoom === right.deliveryMapMaxZoom
    && left.deliveryMapZoomAdjustment === right.deliveryMapZoomAdjustment
    && left.deliveryMapPadding === right.deliveryMapPadding
    && left.minOrderThreshold === right.minOrderThreshold
    && left.minOrderPadding === right.minOrderPadding
    && left.zipGateMode === right.zipGateMode
    && left.gateZipCodes.join('|') === right.gateZipCodes.join('|')
    && JSON.stringify(left.blockedSenderRules) === JSON.stringify(right.blockedSenderRules)
    && left.currencySymbol === right.currencySymbol
    && JSON.stringify(left.storeHours) === JSON.stringify(right.storeHours)
    && left.shopName === right.shopName
    && left.shopAddress === right.shopAddress
    && left.shopAddressLatitude === right.shopAddressLatitude
    && left.shopAddressLongitude === right.shopAddressLongitude;
}

function initialDashboardConfig(): DashboardUserConfig {
  if (typeof window === 'undefined') return DEFAULT_DASHBOARD_CONFIG;
  try {
    const saved = window.localStorage.getItem(DASHBOARD_CLIENT_CONFIG_STORAGE_KEY)
      || window.localStorage.getItem(DASHBOARD_CONFIG_STORAGE_KEY_LEGACY);
    if (!saved) return DEFAULT_DASHBOARD_CONFIG;
    const parsed = JSON.parse(saved) as Partial<DashboardUserConfig>;
    return sanitizeDashboardConfig({
      ...DEFAULT_DASHBOARD_CONFIG,
      ...sanitizeClientConfig(parsed),
    });
  } catch {
    return DEFAULT_DASHBOARD_CONFIG;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Unable to read file.'));
    };
    reader.onload = () => {
      resolve(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
  });
}

function currentLocalDateKey(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return dateKeyFromDate(now);
}

function classifyAudioAlertKind(isMarketplace: boolean, deliveryDateRaw: string, todayDateKey: string): AudioAlertKind | null {
  const deliveryDateKey = toDateKey(deliveryDateRaw);
  if (isMarketplace) {
    return deliveryDateKey && deliveryDateKey === todayDateKey ? 'marketplace' : null;
  }
  if (deliveryDateKey && deliveryDateKey === todayDateKey) return 'today';
  return null;
}

function buildAudioAlertKindMap(pending: IntakeTicketCard[], active: BoardCard[], todayDateKey: string): Map<string, AudioAlertKind> {
  const next = new Map<string, AudioAlertKind>();
  const marketplaceAudioIdentity = (recipientRaw: string, deliveryRaw: string, zipRaw: string): string => {
    const recipientKey = normalizeText(recipientRaw || '');
    const deliveryKey = toDateKey(deliveryRaw || '');
    const zipKey = normalizeIdLike(zipRaw || '');
    return [recipientKey, deliveryKey, zipKey].filter(Boolean).join('|');
  };

  for (const ticket of pending) {
    const kind = classifyAudioAlertKind(ticket.isMarketplace, ticket.deliveryDate, todayDateKey);
    if (!kind) continue;
    const key = kind === 'marketplace'
      ? marketplaceAudioIdentity(ticket.recipientName || ticket.summary, ticket.deliveryDate, ticket.destinationZip)
      : normalizeIdLike(ticket.id);
    if (!key) continue;
    next.set(`${kind}:${key}`, kind);
  }

  for (const order of active) {
    const kind = classifyAudioAlertKind(order.isMarketplace, order.deliveryDate, todayDateKey);
    if (!kind) continue;
    const key = kind === 'marketplace'
      ? marketplaceAudioIdentity(order.recipientName, order.deliveryDate, order.deliveryZip)
      : normalizeIdLike(order.ticketId || order.userReference);
    if (!key) continue;
    next.set(`${kind}:${key}`, kind);
  }

  return next;
}

function countNewAudioAlertsByKind(
  previous: Set<string>,
  next: Map<string, AudioAlertKind>,
): { marketplaceCount: number; todayCount: number } {
  let marketplaceCount = 0;
  let todayCount = 0;
  for (const [key, kind] of next.entries()) {
    if (previous.has(key)) continue;
    if (kind === 'marketplace') {
      marketplaceCount += 1;
      continue;
    }
    todayCount += 1;
  }
  return { marketplaceCount, todayCount };
}

function tokenizeRecipient(raw: string): string[] {
  const tokens = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !RECIPIENT_STOP_WORDS.has(token) && !/^\d+$/.test(token));

  return Array.from(new Set(tokens));
}

function recipientSimilarityScore(
  incomingNorm: string,
  incomingTokens: string[],
  candidateNorm: string,
  candidateTokens: string[],
): number {
  if (!incomingNorm || !candidateNorm) return 0;
  if (incomingNorm === candidateNorm) return 42;

  let score = 0;
  if (incomingNorm.includes(candidateNorm) || candidateNorm.includes(incomingNorm)) {
    score += 18;
  }

  if (!incomingTokens.length || !candidateTokens.length) return score;

  const left = new Set(incomingTokens);
  const right = new Set(candidateTokens);
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }

  if (!shared) return score;
  const denominator = Math.max(left.size, right.size);
  const ratio = denominator > 0 ? shared / denominator : 0;
  score += Math.round(ratio * 28);
  return score;
}

function dateSimilarityScore(referenceEpoch: number, candidateEpoch: number): { score: number; deltaDays: number } {
  if (referenceEpoch <= 0 || candidateEpoch <= 0) {
    return { score: 0, deltaDays: Number.POSITIVE_INFINITY };
  }
  const deltaDays = Math.abs(referenceEpoch - candidateEpoch) / (24 * 60 * 60 * 1000);
  if (deltaDays <= 0.25) return { score: 24, deltaDays };
  if (deltaDays <= 1) return { score: 18, deltaDays };
  if (deltaDays <= 3) return { score: 12, deltaDays };
  if (deltaDays <= 7) return { score: 6, deltaDays };
  if (deltaDays <= 14) return { score: 1, deltaDays };
  return { score: -8, deltaDays };
}

function buildAskIdCandidates(message: MessageItem): AskIdCandidate[] {
  const byNormalized = new Map<string, AskIdCandidate>();
  const addCandidate = (rawValue: string, source: string, strength: CandidateStrength, rank: number): void => {
    const raw = String(rawValue || '').trim();
    if (!raw) return;
    const variants = new Set<string>([raw]);
    const slashHead = raw.split('/')[0]?.trim() || '';
    if (slashHead) variants.add(slashHead);

    for (const variant of variants) {
      const normalized = normalizeIdLike(variant);
      if (!normalized || !/^\d{5,12}$/.test(normalized)) continue;
      const existing = byNormalized.get(normalized);
      if (!existing || rank > existing.rank) {
        byNormalized.set(normalized, {
          value: variant,
          normalized,
          source,
          strength,
          rank,
        });
      } else if (existing && existing.source !== source && existing.rank === rank) {
        existing.source = `${existing.source}+${source}`;
      }
    }
  };

  addCandidate(String(message.TICKET_NUM || ''), 'ticket_num', 'strong', 120);
  addCandidate(String(message.ORDER_ID || ''), 'order_id', 'strong', 116);
  addCandidate(String(message.USER_REFERENCE || ''), 'user_reference', 'strong', 112);
  addCandidate(String(message.SALE_ID || ''), 'sale_id', 'strong', 108);
  addCandidate(String(message.MERCURY_NUM || ''), 'service_msg', 'weak', 92);

  for (const numeric of extractNumericTokens(
    String(message.ORDER_ID || ''),
    String(message.USER_REFERENCE || ''),
    String(message.SALE_ID || ''),
    String(message.TICKET_NUM || ''),
    String(message.SUMMARY_TEXT || ''),
    String(message.MSG_NOTES || ''),
    String(message.MERCURY_NUM || ''),
  )) {
    addCandidate(numeric, 'numeric_token', 'weak', 82);
  }

  return Array.from(byNormalized.values()).sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return a.normalized.localeCompare(b.normalized);
  });
}

function extractOrderIdForDisplay(saleIdRaw: string, userReferenceRaw: string, ticketIdRaw = ''): string {
  const saleId = String(saleIdRaw || '').trim();
  const userReference = String(userReferenceRaw || '').trim();
  const ticketId = String(ticketIdRaw || '').trim();
  const userReferenceHead = userReference.split('/')[0]?.trim() || '';

  // Prefer user-facing order refs (often USER_REFERENCE like 370282/1)
  // over internal SALE_ID values (often 364xxx internal IDs).
  if (userReferenceHead && userReferenceHead !== ticketId && /^\d{5,12}$/.test(userReferenceHead)) {
    return userReferenceHead;
  }
  if (saleId && saleId !== ticketId && /^\d{5,12}$/.test(saleId)) return saleId;
  if (saleId) return saleId;
  if (userReferenceHead && userReferenceHead !== ticketId) return userReferenceHead;
  return '';
}

function inferOrderIdFromMessage(message: MessageItem): string {
  const ticketNum = String(message.TICKET_NUM || '').trim();
  const messageId = String(message.ID || '').trim();
  const orderIdField = String(message.ORDER_ID || '').trim();
  const userReference = String(message.USER_REFERENCE || '').trim();
  const saleId = String(message.SALE_ID || '').trim();
  const ticketNumHead = ticketNum.split('/')[0]?.trim() || '';

  // ASK/linked message rows often include the external order as TICKET_NUM (e.g., 370282/1).
  if (ticketNum.includes('/') && ticketNumHead && ticketNumHead !== messageId && /^\d{5,12}$/.test(ticketNumHead)) {
    return ticketNumHead;
  }

  for (const candidate of [saleId, userReference, orderIdField]) {
    const orderHead = String(candidate || '').split('/')[0]?.trim() || '';
    if (orderHead && orderHead !== ticketNum && orderHead !== messageId && /^\d{5,12}$/.test(orderHead)) {
      return orderHead;
    }
  }

  if (orderIdField && orderIdField !== ticketNum && orderIdField !== messageId) {
    const orderHead = orderIdField.split('/')[0]?.trim() || '';
    if (orderHead && /^\d{5,12}$/.test(orderHead)) return orderHead;
  }

  const summaryText = `${String(message.SUMMARY_TEXT || '')} ${String(message.MSG_NOTES || '')}`;
  const slashMatch = summaryText.match(/\b(\d{5,12})\/\d{1,3}\b/);
  if (slashMatch?.[1]) return slashMatch[1];

  const orderWordMatch = summaryText.match(/\border\s*#?\s*(\d{5,12})\b/i);
  if (orderWordMatch?.[1] && orderWordMatch[1] !== ticketNum && orderWordMatch[1] !== messageId) {
    return orderWordMatch[1];
  }

  return '';
}

function sourcePillLabel(wireServiceRaw: string): string {
  const value = String(wireServiceRaw || '').trim();
  if (!value) return 'Unknown';
  const normalized = value.toLowerCase();

  if (normalized === '1' || normalized === 'ftd' || normalized.includes('transworld')) return 'FTD';
  if (normalized === '2' || normalized === 'dov' || normalized.includes('dove') || normalized.includes('teleflora')) {
    return 'DOV';
  }

  return value.toUpperCase();
}

function senderGateFieldsForMessage(message: MessageItem): string[] {
  const wireService = String(message.WIRE_SERVICE || '').trim();
  return [
    String(message.FIRM_NAME || '').trim(),
    String(message.SHOP_NAME || '').trim(),
    String(message.SHOP_CODE || '').trim(),
    String(message.MEMBER_CODE || '').trim(),
    String(message.MERCURY_NUM || '').trim(),
    wireService,
    wireService ? sourcePillLabel(wireService) : '',
  ].filter(Boolean);
}

function senderDisplayNameForMessage(message: MessageItem): string {
  const fields = senderGateFieldsForMessage(message);
  return firstNonEmptyText(
    message.FIRM_NAME,
    message.SHOP_NAME,
    message.SHOP_CODE,
    fields[0],
  );
}

function senderGateTextForMessage(message: MessageItem): string {
  return Array.from(new Set(senderGateFieldsForMessage(message))).join(' | ');
}

function normalizeGateMatchText(raw: string): { loose: string; compact: string } {
  const loose = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    loose,
    compact: loose.replace(/[^a-z0-9]/g, ''),
  };
}

function senderGateRuleMatches(rule: SenderGateRule, senderGateText: string): boolean {
  const pattern = normalizeGateMatchText(rule.pattern);
  if (!pattern.loose && !pattern.compact) return false;
  const fields = senderGateText
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
  if (!fields.length) return false;

  if (rule.matchMode === 'exact') {
    return fields.some(field => {
      const fieldText = normalizeGateMatchText(field);
      return Boolean(pattern.loose && fieldText.loose === pattern.loose)
        || Boolean(pattern.compact && fieldText.compact === pattern.compact);
    });
  }

  const haystack = normalizeGateMatchText(fields.join(' '));
  return Boolean(pattern.loose && haystack.loose.includes(pattern.loose))
    || Boolean(pattern.compact && haystack.compact.includes(pattern.compact));
}

function formatGateCurrencyAmount(value: number, currencySymbol: string): string {
  const symbol = String(currencySymbol || '$').trim() || '$';
  const amount = Number.isFinite(value) ? value : 0;
  const amountText = Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
  return `${symbol}${amountText}`;
}

function formatGateCurrencyCents(cents: number, currencySymbol: string): string {
  return formatGateCurrencyAmount(cents / 100, currencySymbol);
}

function evaluateIntakeGateResults(ticket: IntakeTicketCard, config: DashboardUserConfig): IntakeGateResult[] {
  const results: IntakeGateResult[] = [];
  const isIncomingOrder = ticket.kind === 'uncreated';
  const currencySymbol = config.currencySymbol || '$';

  if (isIncomingOrder && config.minOrderThreshold > 0) {
    const totalCents = amountToCents(ticket.orderAmount);
    const minimumCents = Math.round(config.minOrderThreshold * 100);
    const paddingCents = Math.round(config.minOrderPadding * 100);
    const effectiveMinimumCents = Math.max(0, minimumCents - paddingCents);
    const minimumLabel = formatGateCurrencyAmount(config.minOrderThreshold, currencySymbol);
    const paddingLabel = formatGateCurrencyAmount(config.minOrderPadding, currencySymbol);

    if (totalCents === null) {
      results.push({
        key: 'price-missing',
        label: 'Total Missing',
        detail: `No order total is available for minimum ${minimumLabel}.`,
        severity: 'review',
      });
    } else if (totalCents < effectiveMinimumCents) {
      results.push({
        key: 'price-low',
        label: 'Low Total',
        detail: `Total ${formatGateCurrencyCents(totalCents, currencySymbol)} is below ${minimumLabel}${paddingCents > 0 ? ` after ${paddingLabel} padding` : ''}.`,
        severity: 'reject',
      });
    } else if (paddingCents > 0 && totalCents < minimumCents) {
      results.push({
        key: 'price-padding',
        label: 'Price Buffer',
        detail: `Total ${formatGateCurrencyCents(totalCents, currencySymbol)} is inside the ${paddingLabel} buffer below ${minimumLabel}.`,
        severity: 'review',
      });
    }
  }

  if (isIncomingOrder && config.gateZipCodes.length) {
    const zip = extractUsZip5(firstNonEmptyText(ticket.destinationZip, ticket.destinationLabel));
    const gateZipSet = new Set(config.gateZipCodes);
    if (config.zipGateMode === 'allowlist') {
      if (!zip) {
        results.push({
          key: 'zip-missing',
          label: 'ZIP Missing',
          detail: 'No destination ZIP is available for the incoming order allowlist.',
          severity: 'review',
        });
      } else if (!gateZipSet.has(zip)) {
        results.push({
          key: 'zip-outside',
          label: 'Outside ZIPs',
          detail: `Destination ZIP ${zip} is not in the configured allowlist.`,
          severity: 'reject',
        });
      }
    } else if (zip && gateZipSet.has(zip)) {
      results.push({
        key: 'zip-watch',
        label: 'ZIP Gate',
        detail: `Destination ZIP ${zip} is on the configured watchlist.`,
        severity: 'review',
      });
    }
  }

  for (const rule of config.blockedSenderRules) {
    if (!rule.enabled || !senderGateRuleMatches(rule, ticket.senderGateText)) continue;
    const sender = ticket.senderName || ticket.senderGateText || 'Unknown sender';
    results.push({
      key: `sender-${rule.id}`,
      label: rule.label || 'Sender Rule',
      detail: `${sender} matched "${rule.pattern}" using ${rule.matchMode} matching.`,
      severity: 'reject',
    });
    if (results.filter(result => result.key.startsWith('sender-')).length >= 3) break;
  }

  return results;
}

function extractNumericTokens(...parts: string[]): string[] {
  const joined = parts.join(' ');
  const matches = joined.match(/\b\d{5,10}\b/g) || [];
  return Array.from(new Set(matches));
}

function messageExtraField(message: MessageItem, ...keys: string[]): string {
  const extra = message as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = extra[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function messageTypeText(message: MessageItem): string {
  return firstNonEmptyText(
    String(message.MSG_TYPE || ''),
    messageExtraField(
      message,
      'MSG_TYP',
      'MESSAGE_TYPE',
      'MESSAGETYPE',
      'TYPE',
      'SYSTEM_MSG_TYP_ABBR',
      'SYSTEM_MSG_TYP_DESCRIPTION',
    ),
  ).trim();
}

function messageDirectionText(message: MessageItem): string {
  return firstNonEmptyText(
    String(message.MSG_DIRECTION || ''),
    messageExtraField(message, 'DIRECTION', 'IN_OUT', 'INOUT', 'MESSAGE_DIRECTION', 'MSG_DIR'),
  ).trim();
}

function messageDirection(message: MessageItem): 'in' | 'out' | 'unknown' {
  const explicit = parseMessageDirection(messageDirectionText(message));
  if (explicit !== 'unknown') return explicit;
  return parseMessageDirection(messageTypeText(message));
}

function classifySystemMessageType(typeRaw: string): { key: IntakeMessageTypeKey; label: string } | null {
  const canonical = String(typeRaw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!canonical) return null;
  const firstToken = canonical.split(' ')[0]?.trim() || '';
  if (!firstToken) return null;

  const typeByToken: Record<string, { key: IntakeMessageTypeKey; label: string }> = {
    ASK: { key: 'ask', label: 'ASK' },
    ANS: { key: 'ans', label: 'ANS' },
    CON: { key: 'con', label: 'CON' },
    CAN: { key: 'cancel', label: 'CANCEL' },
    ORD: { key: 'other', label: 'ORD' },
    REJ: { key: 'other', label: 'REJ' },
    DEN: { key: 'other', label: 'DEN' },
    FOR: { key: 'other', label: 'FOR' },
    GEN: { key: 'other', label: 'GEN' },
    RES: { key: 'other', label: 'RES' },
    SUS: { key: 'other', label: 'SUS' },
  };

  return typeByToken[firstToken] || null;
}

function isAskMessage(message: MessageItem): boolean {
  const typeRaw = messageTypeText(message);
  const raw = [
    typeRaw,
    String(message.SUMMARY_TEXT || ''),
    String(message.MSG_NOTES || ''),
  ].join(' ');
  const typeToken = normalizeText(typeRaw);
  return /\bask\b/i.test(raw)
    || typeToken === 'ask'
    || typeToken === 'qry'
    || typeToken.includes('question');
}

function classifyIncomingMessageType(message: MessageItem): { key: IntakeMessageTypeKey; label: string } {
  const typeRaw = messageTypeText(message);
  const canonicalFromSystemType = classifySystemMessageType(typeRaw);
  if (canonicalFromSystemType) return canonicalFromSystemType;
  const raw = [
    typeRaw,
    String(message.SUMMARY_TEXT || ''),
    String(message.MSG_NOTES || ''),
  ].join(' ');
  const typeToken = normalizeText(typeRaw);

  const hasCancelSignal = /\b(cancel(?:lation)?|cxl|void\s+order|stop\s+delivery|do\s*not\s+deliver|dont\s+deliver)\b/i.test(raw)
    || typeToken.startsWith('cxl')
    || typeToken.includes('cancel');
  if (hasCancelSignal) return { key: 'cancel', label: 'CANCEL' };

  const hasAskSignal = /\bask\b/i.test(raw)
    || typeToken === 'ask'
    || typeToken === 'qry'
    || typeToken.includes('question');
  if (hasAskSignal) return { key: 'ask', label: 'ASK' };

  const hasAnswerSignal = /\b(ans|answer|answered|response|responded)\b/i.test(raw)
    || typeToken.startsWith('ans')
    || typeToken.includes('answer')
    || typeToken === 'response';
  if (hasAnswerSignal) return { key: 'ans', label: 'ANS' };

  const hasConfirmSignal = /\b(con|confirm|confirmation|confirmed)\b/i.test(raw)
    || typeToken === 'con'
    || typeToken.includes('confirm');
  if (hasConfirmSignal) return { key: 'con', label: 'CON' };

  return { key: 'unknown', label: '' };
}

function intakeBadgeForTicket(ticket: IntakeTicketCard): { label: string; className: string } {
  if (ticket.messageTypeKey === 'cancel') return { label: ticket.messageTypeLabel || 'CANCEL', className: 'badge--msg-cancel' };
  if (ticket.messageTypeKey === 'ans') return { label: ticket.messageTypeLabel || 'ANS', className: 'badge--msg-ans' };
  if (ticket.messageTypeKey === 'con') return { label: ticket.messageTypeLabel || 'CON', className: 'badge--msg-con' };
  if (ticket.messageTypeKey === 'other' && ticket.messageTypeLabel) return { label: ticket.messageTypeLabel, className: 'badge--msg-other' };
  if (ticket.messageTypeKey === 'ask') return { label: 'ASK', className: 'badge--ask' };
  if (ticket.kind === 'ask') return { label: 'ASK', className: 'badge--ask' };
  if (ticket.kind === 'message') return { label: 'MESSAGE', className: 'badge--msg-other' };
  return { label: 'NEW ORDER', className: 'badge--alert' };
}

function shouldShowSourceBadge(ticket: IntakeTicketCard): boolean {
  if (ticket.messageTypeKey === 'unknown') return ticket.kind === 'uncreated';
  return ticket.messageTypeKey !== 'ask';
}

function linkedOrderStatusBadgeClass(statusRaw: string): string {
  const semantic = deliverySemanticFromStatusText(statusRaw);
  if (semantic === 'canceled') return 'badge--stage-linked-canceled';
  if (semantic === 'exception') return 'badge--stage-linked-exception';
  if (semantic === 'delivered') return 'badge--stage-linked-delivered';
  if (semantic === 'queued') return 'badge--stage-linked-queued';
  return 'badge--stage';
}

function parseMessageDirection(rawDirection: string | undefined): 'in' | 'out' | 'unknown' {
  const text = String(rawDirection || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('out')) return 'out';
  if (text.includes('in')) return 'in';
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return 'unknown';
  if (numeric === 2) return 'out';
  if (numeric === 1) return 'in';
  return 'unknown';
}

function isInboundIntakeMessage(message: MessageItem): boolean {
  const msgType = messageTypeText(message);
  const messageType = classifyIncomingMessageType(message);
  const msgDirection = messageDirectionText(message).toLowerCase();
  const category = String(message.CATEGORY || '').trim();
  const requiresAttention = String(message.REQUIRES_ATTENTION || '').trim() === '1';
  const explicitDirection = parseMessageDirection(msgDirection);
  const direction = explicitDirection === 'unknown'
    ? parseMessageDirection(msgType)
    : explicitDirection;

  return direction !== 'out'
    && (
      direction === 'in'
      || msgType.toLowerCase().includes('order')
      || messageType.key === 'ask'
      || messageType.key === 'cancel'
      || requiresAttention
      || category === '2'
      || category === '12'
    );
}

function messageLinkKeySet(message: MessageItem): Set<string> {
  const keys = new Set<string>();
  const idLike = [
    normalizeIdLike(String(message.ID || '')),
    normalizeIdLike(String(message.TICKET_NUM || '')),
    normalizeIdLike(String(message.ORDER_ID || '')),
    normalizeIdLike(String(message.USER_REFERENCE || '')),
    normalizeIdLike(String(message.SALE_ID || '')),
    normalizeIdLike(String(message.MERCURY_NUM || '')),
  ];
  for (const key of idLike) {
    if (key) keys.add(key);
  }

  for (const numeric of extractNumericTokens(
    String(message.ID || ''),
    String(message.TICKET_NUM || ''),
    String(message.ORDER_ID || ''),
    String(message.USER_REFERENCE || ''),
    String(message.SALE_ID || ''),
    String(message.MERCURY_NUM || ''),
    String(message.SUMMARY_TEXT || ''),
    String(message.MSG_NOTES || ''),
  )) {
    const token = normalizeIdLike(numeric);
    if (token) keys.add(token);
  }

  return keys;
}

function hasExplicitTimeComponent(raw: string): boolean {
  const text = String(raw || '').trim();
  if (!text) return false;
  return /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text) || /\b\d{1,2}\s*(am|pm)\b/i.test(text);
}

function askThreadKeySet(message: MessageItem, recipientNorm = '', deliveryDateKey = '', amountNorm = ''): Set<string> {
  const keys = new Set<string>();
  const rawKeys = [
    String(message.TICKET_NUM || ''),
    String(message.ORDER_ID || ''),
    String(message.USER_REFERENCE || ''),
    String(message.SALE_ID || ''),
  ];

  for (const raw of rawKeys) {
    const normalized = normalizeIdLike(raw);
    if (normalized) keys.add(normalized);
    const head = normalizeIdLike(String(raw || '').split('/')[0] || '');
    if (head) keys.add(head);
  }

  for (const numeric of extractNumericTokens(...rawKeys)) {
    const token = normalizeIdLike(numeric);
    if (token) keys.add(token);
  }

  if (recipientNorm && deliveryDateKey) {
    if (amountNorm) {
      keys.add(normalizeIdLike(`${recipientNorm}|${deliveryDateKey}|${amountNorm}`));
    } else {
      keys.add(normalizeIdLike(`${recipientNorm}|${deliveryDateKey}`));
    }
  }

  return keys;
}

function hasSharedKey(left: Set<string>, right: Set<string>): boolean {
  if (!left.size || !right.size) return false;
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function messageLookupTicketCandidates(message: MessageItem): string[] {
  const candidates = new Set<string>();
  const rawValues = [
    String(message.TICKET_NUM || ''),
    String(message.ORDER_ID || ''),
    String(message.USER_REFERENCE || ''),
    String(message.SALE_ID || ''),
    ...extractNumericTokens(
      String(message.TICKET_NUM || ''),
      String(message.ORDER_ID || ''),
      String(message.USER_REFERENCE || ''),
      String(message.SALE_ID || ''),
    ),
  ];

  for (const rawValue of rawValues) {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) continue;
    const normalized = normalizeTicketLookupId(trimmed);
    if (normalized) candidates.add(normalized);
    const slashHead = normalized.split('/')[0]?.trim();
    if (slashHead) candidates.add(slashHead);
  }

  return Array.from(candidates).filter(value => /^\d{5,12}$/.test(value));
}

function orderEnrichmentLookupCandidates(order: { ID?: string; USER_REFERENCE?: string; SALE_ID?: string; TICKET_POSITION?: string }): string[] {
  const candidates = new Set<string>();
  const rawId = String(order.ID || '').trim();
  const rawUserReference = String(order.USER_REFERENCE || '').trim();
  const rawSaleId = String(order.SALE_ID || '').trim();
  const rawTicketPosition = String(order.TICKET_POSITION || '').trim();
  const salePositionRef = rawSaleId && rawTicketPosition ? `${rawSaleId}/${rawTicketPosition}` : '';
  const displayOrderId = extractOrderIdForDisplay(rawSaleId, rawUserReference, rawId);

  for (const rawValue of [rawId, rawUserReference, rawSaleId, salePositionRef, displayOrderId]) {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) continue;
    const normalized = normalizeTicketLookupId(trimmed);
    if (normalized) candidates.add(normalized);
    const head = normalized.split('/')[0]?.trim() || '';
    if (head) candidates.add(head);
  }

  for (const numeric of extractNumericTokens(rawId, rawUserReference, rawSaleId, salePositionRef, displayOrderId)) {
    candidates.add(numeric);
  }

  return Array.from(candidates).filter(value => Boolean(String(value || '').trim())).slice(0, 6);
}

function hasUsefulTicketStatus(ticketStatus: TicketStatusRow | null): boolean {
  if (!ticketStatus) return false;
  const row = ticketStatus as unknown as Record<string, unknown>;
  const keys = Object.keys(row);
  for (const key of keys) {
    const normalizedKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedKey !== 'designerstatus' && normalizedKey !== 'designstatus' && normalizedKey !== 'deliverystatus') {
      continue;
    }
    const value = String(row[key] ?? '').trim();
    if (value) return true;
  }
  return false;
}

function readTicketStatusField(ticketStatus: TicketStatusRow | null, normalizedKeys: string[]): string {
  if (!ticketStatus || !normalizedKeys.length) return '';
  const wanted = new Set(normalizedKeys.map(key => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean));
  const row = ticketStatus as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!wanted.has(normalizedKey)) continue;
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function lifecycleStatusText(lifecycle: LifecycleRow | null): string {
  const code = String(lifecycle?.STATUS_CD || '').trim();
  const desc = String(lifecycle?.STATUS_CD_DESC || lifecycle?.STATUS_TEXT || '').trim();
  if (code && desc) return `${code} ${desc}`;
  return code || desc;
}

function designStatusLabel(ticketStatus: TicketStatusRow | null, stage: StatusStage, externalStatus = ''): string {
  const fromTicketStatus = readTicketStatusField(ticketStatus, ['designerstatus', 'designstatus']);
  if (fromTicketStatus) return fromTicketStatus;
  const normalizedExternal = String(externalStatus || '').toUpperCase();
  if (normalizedExternal.includes('NOT_ASSIGN') || normalizedExternal.includes('UNASSIGN')) return 'Not Designed';
  if (normalizedExternal.includes('ASSIGN')) return 'Assigned';
  if (normalizedExternal.includes('DESIGN')) return 'Designed';
  if (stage === 'queued_not_designed') return 'Not Designed';
  if (stage === 'incoming') return 'Incoming';
  if (stage === 'designed' || stage === 'saved_or_staged') {
    return 'Designed';
  }
  return 'Unknown';
}

function deliveryStatusLabel(
  ticketStatus: TicketStatusRow | null,
  lifecycle: LifecycleRow | null,
  stage: StatusStage,
  stageReason: string,
  _routeName = '',
  externalStatus = '',
): string {
  const fromTicketStatus = readTicketStatusField(ticketStatus, ['deliverystatus']);
  if (fromTicketStatus) return fromTicketStatus;

  const lifecycleText = lifecycleStatusText(lifecycle);
  if (lifecycleText) return lifecycleText;

  const normalizedExternal = String(externalStatus || '');
  if (normalizedExternal) {
    const deliverySemantic = deliverySemanticFromStatusText(normalizedExternal);
    if (deliverySemantic === 'canceled') return 'Canceled';
    if (deliverySemantic === 'delivered') return 'Delivered';
    if (deliverySemantic === 'exception') return 'Exception';
    if (deliverySemantic === 'in_transit') return '';
    if (deliverySemantic === 'queued') return 'Queued';

    const upperExternal = normalizedExternal.toUpperCase();
    if (upperExternal.includes('SAVE') || upperExternal.includes('STAGE')) return 'Staged/In Shop';
    if (upperExternal.includes('ASSIGN')) return 'Assigned';
  }

  if (stage === 'delivered_or_exception') return isExceptionStatusReason(stageReason) ? 'Exception' : 'Delivered';
  if (stage === 'saved_or_staged') return 'Staged/In Shop';
  if (stage === 'designed') return 'In Shop';
  if (stage === 'queued_not_designed') return 'Queued';
  if (stage === 'incoming') return 'Incoming';
  return 'Unknown';
}

function normalizedStatusToken(raw: string): string {
  const token = String(raw || '').trim().toUpperCase();
  if (!token || token === '0' || token === 'UNKNOWN' || token === 'N/A' || token === 'NULL') return '';
  return token.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function titleCaseStatus(raw: string): string {
  const normalized = String(raw || '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized
    .toLowerCase()
    .split(' ')
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
    .join(' ');
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

const CANCELED_STATUS_MARKERS = [
  'CANCEL',
  'CANCELED',
  'CANCELLED',
  'VOID',
];

const QUEUED_STATUS_MARKERS = [
  'NOT_DESIGN',
  'NOTDESIGN',
  'NOT_ASSIGN',
  'UNASSIGN',
  'QUEUED',
];

const IN_TRANSIT_STATUS_MARKERS = [
  'ON_TRUCK',
  'ROUTE',
  'IN_PROGRESS',
  'OUT_FOR',
  'EN_ROUTE',
];

type DeliverySemantic = 'delivered' | 'exception' | 'queued' | 'in_transit' | 'canceled' | 'unknown';

function hasAnyStatusMarker(status: string, markers: string[]): boolean {
  return markers.some(marker => status.includes(marker));
}

function deliverySemanticFromStatusText(raw: string): DeliverySemantic {
  const status = normalizedStatusToken(raw);
  if (!status) return 'unknown';

  if (/^\d+$/.test(status)) {
    const code = Number.parseInt(status, 10);
    if (code >= 1 && code <= 3) return 'delivered';
    if (code >= 4) return 'exception';
    return 'unknown';
  }

  if (hasAnyStatusMarker(status, CANCELED_STATUS_MARKERS)) return 'canceled';
  if (hasAnyStatusMarker(status, EXCEPTION_STATUS_MARKERS)) return 'exception';
  if (hasAnyStatusMarker(status, DELIVERED_STATUS_MARKERS)) return 'delivered';
  if (hasAnyStatusMarker(status, QUEUED_STATUS_MARKERS)) return 'queued';
  if (hasAnyStatusMarker(status, IN_TRANSIT_STATUS_MARKERS)) return 'in_transit';
  if (status.includes('ASSIGN')) return 'in_transit';
  return 'unknown';
}

function saleStatusIndicatesCanceled(raw: string): boolean {
  return String(raw || '').trim() === '4';
}

function canceledStatusFromTicketSearchRow(row: TicketSearchRow): string {
  const extra = row as unknown as Record<string, string | undefined>;
  const rawStatus = firstNonEmptyText(
    String(row.DELIVERY_STATUS || ''),
    String(row.STATUS || ''),
    String(row.ORDER_STATUS || ''),
    String(extra.ORDER_STATUS || ''),
  );
  if (deliverySemanticFromStatusText(rawStatus) === 'canceled') return 'CANCELED';

  const saleStatus = firstNonEmptyText(
    String(row.SALE_STATUS_ID || ''),
    String(extra.SALE_STATUS_ID || ''),
    String(extra.SALESTATUSID || ''),
  );
  if (saleStatusIndicatesCanceled(saleStatus)) return 'CANCELED';
  return '';
}

function effectiveDeliveryStatusFromTicketSearchRow(row: TicketSearchRow): string {
  return firstNonEmptyText(
    String(row.DELIVERY_STATUS || ''),
    String(row.STATUS || ''),
    canceledStatusFromTicketSearchRow(row),
  );
}

type OrderPillTheme =
  | 'queued'
  | 'design-assigned'
  | 'designed'
  | 'ready-for-ship'
  | 'delivered'
  | 'exception'
  | 'incoming';

interface OrderPillStatus {
  label: string;
  theme: OrderPillTheme;
}

function classifyDeliveryStatus(deliveryStatusRaw: string): OrderPillStatus | null {
  const semantic = deliverySemanticFromStatusText(deliveryStatusRaw);
  if (semantic === 'canceled') return { label: 'Canceled', theme: 'exception' };
  if (semantic === 'delivered') return { label: 'Delivered', theme: 'delivered' };
  if (semantic === 'exception') return { label: 'Exception', theme: 'exception' };
  if (semantic === 'queued') return { label: 'Queued', theme: 'queued' };
  return null;
}

function classifyDesignStatus(designStatusRaw: string): OrderPillStatus | null {
  const status = normalizedStatusToken(designStatusRaw);
  if (!status) return null;
  if (status.includes('NOT_ASSIGN') || status.includes('NOT_DESIGN') || status.includes('QUEUED')) return null;
  if (status.includes('ASSIGN')) return { label: 'Design Assigned', theme: 'design-assigned' };
  if (status.includes('DESIGN') || status.includes('COMPLETE')) return { label: 'Designed', theme: 'designed' };
  const label = titleCaseStatus(status);
  if (!label) return null;
  return { label, theme: 'design-assigned' };
}

function singleStatusPill(card: BoardCard): OrderPillStatus {
  const delivery = classifyDeliveryStatus(card.deliveryStatus);
  const design = classifyDesignStatus(card.designStatus);
  const hasDeliveryValue = Boolean(normalizedStatusToken(card.deliveryStatus));
  const isCanceledByReason = String(card.stageReason || '').toUpperCase().includes('CANCEL');

  if (isCanceledByReason) {
    return { label: 'Canceled', theme: 'exception' };
  }

  if (delivery && (delivery.theme === 'delivered' || delivery.theme === 'exception')) {
    return delivery;
  }

  if (design) {
    if (!hasDeliveryValue && design.label === 'Designed') return { label: 'Ready for Ship', theme: 'ready-for-ship' };
    return design;
  }

  if (delivery) {
    return delivery;
  }

  if (card.stage === 'delivered_or_exception') {
    return isExceptionStatusReason(card.stageReason)
      ? { label: 'Exception', theme: 'exception' }
      : { label: 'Delivered', theme: 'delivered' };
  }
  if (card.stage === 'incoming') return { label: 'Incoming', theme: 'incoming' };
  return { label: 'Queued', theme: 'queued' };
}

function mergeMessageFields(primary: MessageItem, secondary: MessageItem): MessageItem {
  const merged: MessageItem = { ...primary };
  const secondaryEntries = Object.entries(secondary) as Array<[keyof MessageItem, string | undefined]>;
  for (const [key, value] of secondaryEntries) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    const existing = String(merged[key] || '').trim();
    if (!existing) {
      merged[key] = value;
    }
  }
  return merged;
}

function messageMergeKey(message: MessageItem): string {
  const explicitId = String(message.ID || '').trim();
  if (explicitId) return explicitId;
  return `${normalizeText(String(message.RECIPIENT_NAME || message.SUMMARY_TEXT || ''))}|${String(message.MSG_DATE || '')}|${messageTypeText(message)}|${normalizedOrderAmount(message)}`;
}

function formatCityStateZip(city: string, state: string, zip: string): string {
  const cityPart = String(city || '').trim();
  const statePart = abbreviateState(state);
  const zipPart = String(zip || '').trim();
  const left = [cityPart, statePart].filter(Boolean).join(', ');
  return left || zipPart;
}

function formatDateOnly(raw: string): string {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString([], {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatHeaderDateShort(date: Date): string {
  return date.toLocaleDateString([], {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
  });
}

function formatHeaderDateFullYear(date: Date): string {
  return date.toLocaleDateString([], {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  });
}

function stageFromExternalStatus(statusRaw: string, designedIndicator = ''): StatusStage {
  const status = String(statusRaw || '').toUpperCase();
  const deliverySemantic = deliverySemanticFromStatusText(status);
  if (deliverySemantic === 'canceled') return 'queued_not_designed';
  if (deliverySemantic === 'delivered' || deliverySemantic === 'exception') return 'delivered_or_exception';
  if (deliverySemantic === 'queued') return 'queued_not_designed';
  if (deliverySemantic === 'in_transit') return 'on_truck';
  if (status.includes('NOT_ASSIGN') || status.includes('UNASSIGN')) return 'queued_not_designed';
  if (status.includes('ASSIGN')) return 'designed';
  if (status.includes('SAVE') || status.includes('STAGE')) return 'saved_or_staged';
  if (status.includes('NOT_DESIGN') || status.includes('NOTDESIGN') || status.includes('QUEUED')) return 'queued_not_designed';
  if (status.includes('DESIGN')) return 'designed';
  if (String(designedIndicator || '').trim() === '1') return 'designed';
  return 'incoming';
}

function designedIndicatorFromStatusText(designStatusRaw: string): string {
  const normalized = String(designStatusRaw || '').toUpperCase();
  if (!normalized) return '0';
  if (normalized.includes('NOT_ASSIGN') || normalized.includes('UNASSIGN') || normalized.includes('NOT_DESIGN')) {
    return '0';
  }
  if (normalized.includes('DESIGN') || normalized.includes('ASSIGN') || normalized.includes('COMPLETE')) {
    return '1';
  }
  return '0';
}

function stageLookupKeys(ticketIdRaw: string, saleIdRaw: string, userReferenceRaw: string, ticketPositionRaw = ''): string[] {
  const ticketId = String(ticketIdRaw || '').trim();
  const saleId = String(saleIdRaw || '').trim();
  const userReference = String(userReferenceRaw || '').trim();
  const ticketPosition = String(ticketPositionRaw || '').trim();
  const salePos = saleId && ticketPosition ? `${saleId}/${ticketPosition}` : '';
  const candidates = new Set<string>();

  for (const raw of [ticketId, saleId, userReference, salePos]) {
    const value = String(raw || '').trim();
    if (!value) continue;
    candidates.add(normalizeIdLike(value));
    const head = value.split('/')[0]?.trim() || '';
    if (head) candidates.add(normalizeIdLike(head));
  }

  for (const numeric of extractNumericTokens(ticketId, saleId, userReference, salePos)) {
    candidates.add(normalizeIdLike(numeric));
  }

  return Array.from(candidates).filter(Boolean);
}

function shouldUseExternalStage(
  current: { stage: StatusStage; reason: string },
  external: { stage: StatusStage; reason: string },
): boolean {
  if (current.stage === 'delivered_or_exception') return false;
  if (external.stage === 'delivered_or_exception') return true;

  const currentRank = ACTIVE_STAGE_RANK[current.stage] || 0;
  const externalRank = ACTIVE_STAGE_RANK[external.stage] || 0;
  if (externalRank > currentRank) return true;

  const weakCurrentReason = current.reason.startsWith('Category ')
    || current.reason === 'Default mapping'
    || current.reason.startsWith('Undelivered feed');
  if (weakCurrentReason && externalRank >= currentRank) return true;

  return false;
}

function toMessageItem(row: MercuryMessageListRow): MessageItem {
  const extra = row as unknown as Record<string, string | undefined>;
  const ticketNum = firstNonEmptyText(row.TICKET_NUM, row.TICKET_ID, extra.TICKETID);
  const userReference = firstNonEmptyText(row.USER_REFERENCE, extra.USER_REF, extra.USERREFERENCE);
  const saleId = firstNonEmptyText(row.SALE_ID, extra.SALEID);
  const orderId = firstNonEmptyText(row.ORDER_ID, row.ORDER_NUM, row.ORDER_NUMBER, saleId, userReference);
  const msgType = firstNonEmptyText(
    row.MSG_TYPE,
    extra.MSG_TYP,
    extra.MESSAGE_TYPE,
    extra.MESSAGETYPE,
    extra.TYPE,
    extra.SYSTEM_MSG_TYP_ABBR,
    extra.SYSTEM_MSG_TYP_DESCRIPTION,
  );
  const msgDirection = firstNonEmptyText(
    row.MSG_DIRECTION,
    extra.DIRECTION,
    extra.IN_OUT,
    extra.INOUT,
    extra.MESSAGE_DIRECTION,
    extra.MSG_DIR,
  );
  const msgDate = firstNonEmptyText(
    row.MSG_DATE,
    extra.MSG_DATETIME,
    extra.MSG_DATE_TIME,
    extra.MSGDATE,
    extra.MESSAGE_DATE,
    extra.MESSAGE_DATETIME,
    extra.CREATED_ON,
    extra.CREATEDON,
  );
  const deliveryDate = firstNonEmptyText(
    row.DELIVERY_DATE,
    extra.REQ_DELIVERY_DATE,
    extra.DELIVERY_DATETIME,
    extra.DELIV_DATE,
    extra.DELIVERYDATE,
  );
  const recipientAddress = firstNonEmptyText(
    extra.RECIPIENT_ADDRESS,
    extra.RECIPIENT_ADDR1,
    extra.RECIP_ADDR1,
    extra.ADDRESS,
    extra.ADDR1,
    extra.RADDRESS,
    extra.OFROM_ADDRESS,
  );
  const recipientCity = firstNonEmptyText(
    extra.RECIPIENT_CITY,
    extra.CITY_NAME,
    extra.CITY,
    extra.RCITY,
  );
  const recipientState = firstNonEmptyText(
    extra.RECIPIENT_STATE,
    extra.STATE_NAME,
    extra.STATE,
    extra.RSTATE,
  );
  const recipientStateAbbrev = firstNonEmptyText(
    extra.RECIPIENT_STATE_ABBREV,
    extra.STATE_ABBREV,
    extra.STATE_ABBR,
    extra.STATE_PROV,
    extra.STATE_PROVINCE,
    extra.RSTATE,
  );
  const recipientZip = firstNonEmptyText(
    extra.RECIPIENT_ZIP,
    extra.RECIPIENT_POSTAL_CODE,
    extra.ZIP_CODE,
    extra.ZIP,
    extra.POSTAL_CODE,
    extra.RZIP,
  );
  const messageAmount = normalizedOrderAmount(row);

  return {
    ID: String(firstNonEmptyText(row.MSG_ID, extra.ID, extra.INTERNAL_MSG_ID) || ''),
    TICKET_NUM: String(ticketNum || ''),
    ORDER_ID: String(orderId || ''),
    USER_REFERENCE: String(userReference || ''),
    SALE_ID: String(saleId || ''),
    WIRE_SERVICE: String(firstNonEmptyText(row.WIRE_SERVICE, extra.WIRE_SERVICE_ABBR) || ''),
    CATEGORY: String(row.CATEGORY || ''),
    MSG_TYPE: String(msgType || ''),
    SUMMARY_TEXT: String(firstNonEmptyText(row.SUMMARY_TEXT, extra.GEN_TEXT) || ''),
    MSG_NOTES: String(row.MSG_NOTES || ''),
    MSG_DIRECTION: String(msgDirection || ''),
    RECIPIENT_NAME: String(row.RECIPIENT_NAME || ''),
    RECIPIENT_ADDRESS: String(recipientAddress || ''),
    RECIPIENT_CITY: String(recipientCity || ''),
    RECIPIENT_STATE: String(recipientState || ''),
    RECIPIENT_STATE_ABBREV: String(recipientStateAbbrev || ''),
    RECIPIENT_ZIP: String(recipientZip || ''),
    MSG_DATE: String(msgDate || ''),
    DELIVERY_DATE: String(deliveryDate || ''),
    FIRM_NAME: String(firstNonEmptyText(extra.FIRM_NAME, extra.SENDING_FIRM_NAME, extra.SENDER_FIRM_NAME) || ''),
    SHOP_CODE: String(firstNonEmptyText(row.SHOP_CODE, extra.SHOPCODE, extra.SENDER_SHOP_CODE, extra.SENDING_SHOP_CODE) || ''),
    SHOP_NAME: String(firstNonEmptyText(row.SHOP_NAME, extra.SHOPNAME, extra.SENDER_SHOP_NAME, extra.SENDING_SHOP_NAME) || ''),
    MEMBER_CODE: String(firstNonEmptyText(row.MEMBER_CODE, extra.MEMBERCODE, extra.SENDER_MEMBER_CODE) || ''),
    MERCURY_NUM: String(row.MERCURY_NUM || ''),
    CC_AMOUNT: String(messageAmount || ''),
    REQUIRES_ATTENTION: String(row.REQUIRES_ATTENTION || ''),
  };
}

function mergeActiveOrderCard(target: Map<string, BoardCard>, nextCard: BoardCard, includeDelivered = false): void {
  if (!nextCard.ticketId) return;
  if (!includeDelivered && nextCard.stage === 'delivered_or_exception') return;
  const existing = target.get(nextCard.ticketId);
  if (!existing) {
    target.set(nextCard.ticketId, nextCard);
    return;
  }

  const nextRank = ACTIVE_STAGE_RANK[nextCard.stage] || 99;
  const currentRank = ACTIVE_STAGE_RANK[existing.stage] || 99;
  const nextHasMoreDetail = (
    nextCard.addressLine.length
    + nextCard.cityStateZip.length
    + nextCard.deliveryZip.length
  ) > (
    existing.addressLine.length
    + existing.cityStateZip.length
    + existing.deliveryZip.length
  );
  const nextDeliveryEpoch = deliveryDateSortEpoch(nextCard.deliveryDate);
  const currentDeliveryEpoch = deliveryDateSortEpoch(existing.deliveryDate);
  const nextHasLaterDelivery = nextDeliveryEpoch > currentDeliveryEpoch;
  const nextHasKnownDelivery = !currentDeliveryEpoch && !!nextDeliveryEpoch;
  const statusQuality = (card: BoardCard): number => {
    const designKnown = normalizedStatusToken(card.designStatus) ? 1 : 0;
    const deliveryKnown = normalizedStatusToken(card.deliveryStatus) ? 1 : 0;
    return designKnown + deliveryKnown;
  };
  const nextHasBetterStatus = statusQuality(nextCard) > statusQuality(existing);

  if (nextRank > currentRank || nextHasMoreDetail || nextHasLaterDelivery || nextHasKnownDelivery || nextHasBetterStatus) {
    target.set(nextCard.ticketId, {
      ...nextCard,
      orderType: resolvePreferredOrderType(existing.orderType, nextCard.orderType),
      // Preserve known recipient/address data when a higher-rank feed omits it.
      recipientName: firstNonEmptyText(nextCard.recipientName, existing.recipientName),
      addressLine: firstNonEmptyText(nextCard.addressLine, existing.addressLine),
      cityStateZip: firstNonEmptyText(nextCard.cityStateZip, existing.cityStateZip),
      deliveryZip: firstNonEmptyText(nextCard.deliveryZip, existing.deliveryZip),
      isMarketplace: existing.isMarketplace || nextCard.isMarketplace,
    });
    return;
  }

  // Even if the stage/source doesn't win, backfill missing address details (especially ZIP)
  // from alternate feeds that do have them.
  const merged = {
    ...existing,
    orderType: resolvePreferredOrderType(existing.orderType, nextCard.orderType),
    recipientName: firstNonEmptyText(existing.recipientName, nextCard.recipientName),
    addressLine: firstNonEmptyText(existing.addressLine, nextCard.addressLine),
    cityStateZip: firstNonEmptyText(existing.cityStateZip, nextCard.cityStateZip),
    deliveryZip: firstNonEmptyText(existing.deliveryZip, nextCard.deliveryZip),
    isMarketplace: existing.isMarketplace || nextCard.isMarketplace,
  };
  if (
    merged.recipientName !== existing.recipientName
    || merged.addressLine !== existing.addressLine
    || merged.cityStateZip !== existing.cityStateZip
    || merged.deliveryZip !== existing.deliveryZip
  ) {
    target.set(nextCard.ticketId, merged);
  }
}

function orderSortAsc(a: BoardCard, b: BoardCard): number {
  return deliveryDateSortEpoch(a.deliveryDate) - deliveryDateSortEpoch(b.deliveryDate);
}

function activeOrderSort(a: BoardCard, b: BoardCard): number {
  if (a.isMarketplace !== b.isMarketplace) {
    return a.isMarketplace ? -1 : 1;
  }
  const rankA = ACTIVE_STAGE_RANK[a.stage] || 99;
  const rankB = ACTIVE_STAGE_RANK[b.stage] || 99;
  if (rankA !== rankB) return rankA - rankB;
  return orderSortAsc(a, b);
}

function buildPendingIntakeTickets(
  messageItems: MessageItem[],
  allMessages: MessageItem[],
  orders: OrderReferenceEntry[],
  seenTicketIds: Set<string>,
  flashUntilById: Map<string, number>,
  allowStaleAskBadge = true,
  options?: {
    flashMs?: number;
    askStaleMs?: number;
    activeOrderLookupKeys?: Set<string>;
    config?: DashboardUserConfig;
  },
): IntakeTicketCard[] {
  interface LinkedOrderInfo {
    ticketId: string;
    orderNumber: string;
    statusLabel: string;
    destinationLabel: string;
    orderAmount: string;
    orderAmountCents: number | null;
    deliveryEpoch: number;
    deliveryDateKey: string;
    recipientNorm: string;
    recipientTokens: string[];
  }

  interface AskMatchResult {
    linkedOrder: LinkedOrderInfo | null;
    messageKeys: string[];
    attempts: AskCandidateAttempt[];
    summary: string;
  }

  const orderByKey = new Map<string, LinkedOrderInfo[]>();
  const orderByNameDate = new Map<string, LinkedOrderInfo[]>();
  const orderByNameDateAmount = new Map<string, LinkedOrderInfo[]>();
  const orderByToken = new Map<string, LinkedOrderInfo[]>();
  const allOrderInfos: LinkedOrderInfo[] = [];

  function indexOrderKey(keyRaw: string, orderInfo: LinkedOrderInfo): void {
    const key = normalizeIdLike(keyRaw);
    if (!key) return;
    const list = orderByKey.get(key);
    if (!list) {
      orderByKey.set(key, [orderInfo]);
      return;
    }
    if (!list.some(existing => existing.ticketId === orderInfo.ticketId)) {
      list.push(orderInfo);
    }
  }

  function indexNameDateKey(nameDateKey: string, orderInfo: LinkedOrderInfo): void {
    if (!nameDateKey) return;
    const list = orderByNameDate.get(nameDateKey);
    if (!list) {
      orderByNameDate.set(nameDateKey, [orderInfo]);
      return;
    }
    if (!list.some(existing => existing.ticketId === orderInfo.ticketId)) {
      list.push(orderInfo);
    }
  }

  function indexNameDateAmountKey(nameDateAmountKey: string, orderInfo: LinkedOrderInfo): void {
    if (!nameDateAmountKey) return;
    const list = orderByNameDateAmount.get(nameDateAmountKey);
    if (!list) {
      orderByNameDateAmount.set(nameDateAmountKey, [orderInfo]);
      return;
    }
    if (!list.some(existing => existing.ticketId === orderInfo.ticketId)) {
      list.push(orderInfo);
    }
  }

  function indexToken(token: string, orderInfo: LinkedOrderInfo): void {
    if (!token) return;
    const list = orderByToken.get(token);
    if (!list) {
      orderByToken.set(token, [orderInfo]);
      return;
    }
    if (!list.some(existing => existing.ticketId === orderInfo.ticketId)) {
      list.push(orderInfo);
    }
  }

  for (const order of orders) {
    const ticketId = String(order.ID || '').trim();
    const saleId = String(order.SALE_ID || '').trim();
    const userReference = String(order.USER_REFERENCE || '').trim();
    const userReferenceHead = userReference.split('/')[0] || '';
    const orderNumber = extractOrderIdForDisplay(saleId, userReference, ticketId);
    const deliveryRaw = String(order.DELIVERY_DATE || '');
    const recipientNorm = normalizeText(String(order.RECIPIENT_NAME || order.SUMMARY_TEXT || ''));
    const recipientTokens = tokenizeRecipient(String(order.RECIPIENT_NAME || order.SUMMARY_TEXT || ''));
    const deliveryDateKey = toDateKey(deliveryRaw);
    const destinationLabel = compactTownZipLabel(
      String(order.DELIVERY_CITY_STATE_ZIP || ''),
      String(order.DELIVERY_ZIP || ''),
    );
    const info: LinkedOrderInfo = {
      ticketId,
      orderNumber,
      statusLabel: String(order.STAGE_LABEL || '').trim(),
      destinationLabel,
      orderAmount: String(order.ORDER_AMOUNT || '').trim(),
      orderAmountCents: amountToCents(String(order.ORDER_AMOUNT || '').trim()),
      deliveryEpoch: toEpoch(deliveryRaw),
      deliveryDateKey,
      recipientNorm,
      recipientTokens,
    };
    allOrderInfos.push(info);

    indexOrderKey(ticketId, info);
    indexOrderKey(saleId, info);
    indexOrderKey(userReference, info);
    indexOrderKey(userReferenceHead, info);

    for (const numeric of extractNumericTokens(ticketId, saleId, userReference, userReferenceHead)) {
      indexOrderKey(numeric, info);
    }

    if (recipientNorm && deliveryDateKey) {
      indexNameDateKey(`${recipientNorm}|${deliveryDateKey}`, info);
      if (info.orderAmount) {
        indexNameDateAmountKey(`${recipientNorm}|${deliveryDateKey}|${info.orderAmount}`, info);
      }
    }
    for (const token of recipientTokens) {
      indexToken(token, info);
    }
  }

  const now = Date.now();
  const flashMs = clampInteger(options?.flashMs, 10000, 600000, DEFAULT_FLASH_MS);
  const askStaleMs = clampInteger(
    options?.askStaleMs,
    60 * 60 * 1000,
    72 * 60 * 60 * 1000,
    DEFAULT_ASK_STALE_HOURS * 60 * 60 * 1000,
  );
  const activeOrderLookupKeys = options?.activeOrderLookupKeys || new Set<string>();
  const firstObservation = seenTicketIds.size === 0;
  const pending: IntakeTicketCard[] = [];
  const outboundMessages = allMessages
    .filter(message => messageDirection(message) === 'out')
    .map(message => ({
      epoch: toEpoch(String(message.MSG_DATE || '')),
      recipientNorm: normalizeText(String(message.RECIPIENT_NAME || message.SUMMARY_TEXT || '')),
      deliveryDateKey: toDateKey(String(message.DELIVERY_DATE || message.MSG_DATE || '')),
      keys: messageLinkKeySet(message),
    }));
  const latestInboundEpochByRecipientDateKey = new Map<string, number>();
  const latestInboundHasTimeByRecipientDateKey = new Map<string, boolean>();
  for (const message of allMessages) {
    if (messageDirection(message) === 'out') continue;
    const recipientNorm = normalizeText(String(message.RECIPIENT_NAME || message.SUMMARY_TEXT || ''));
    const deliveryDateKey = toDateKey(String(message.DELIVERY_DATE || message.MSG_DATE || ''));
    if (!recipientNorm || !deliveryDateKey) continue;
    const epoch = toEpoch(String(message.MSG_DATE || ''));
    if (!epoch) continue;
    const key = `${recipientNorm}|${deliveryDateKey}`;
    const hasTimePrecision = hasExplicitTimeComponent(String(message.MSG_DATE || ''));
    const existing = latestInboundEpochByRecipientDateKey.get(key) || 0;
    if (epoch > existing) {
      latestInboundEpochByRecipientDateKey.set(key, epoch);
      latestInboundHasTimeByRecipientDateKey.set(key, hasTimePrecision);
    } else if (epoch === existing && hasTimePrecision) {
      latestInboundHasTimeByRecipientDateKey.set(key, true);
    }
  }
  const latestAskEpochByThreadKey = new Map<string, number>();
  const latestAskHasTimeByThreadKey = new Map<string, boolean>();
  // Dedupe ASK threads only within the current intake scope.
  // Using full historical message feeds here can suppress currently visible
  // event rows if an older/later ASK exists outside the active intake set.
  for (const message of messageItems) {
    if (!isAskMessage(message)) continue;
    if (messageDirection(message) === 'out') continue;
    const summary = String(message.SUMMARY_TEXT || '').trim();
    const recipient = String(message.RECIPIENT_NAME || summary || 'Unknown Recipient').trim();
    const msgDateRaw = String(message.MSG_DATE || '').trim();
    const deliveryDateRaw = String(message.DELIVERY_DATE || '').trim();
    const askEpoch = toEpoch(msgDateRaw);
    if (!askEpoch) continue;
    const askRecipientNorm = normalizeText(recipient || summary);
    const askDeliveryDateKey = toDateKey(deliveryDateRaw || msgDateRaw);
    const askAmountNorm = normalizedOrderAmount(message);
    const threadKeys = askThreadKeySet(message, askRecipientNorm, askDeliveryDateKey, askAmountNorm);
    const hasTimePrecision = hasExplicitTimeComponent(msgDateRaw);
    for (const key of threadKeys) {
      if (!key) continue;
      const existing = latestAskEpochByThreadKey.get(key) || 0;
      if (askEpoch > existing) {
        latestAskEpochByThreadKey.set(key, askEpoch);
        latestAskHasTimeByThreadKey.set(key, hasTimePrecision);
      } else if (askEpoch === existing && hasTimePrecision) {
        latestAskHasTimeByThreadKey.set(key, true);
      }
    }
  }

  function selectBestCandidate(
    candidates: LinkedOrderInfo[],
    recipientNorm: string,
    recipientTokens: string[],
    referenceEpoch: number,
    messageAmountCents: number | null,
    baseScore: number,
  ): { info: LinkedOrderInfo; score: number; deltaDays: number } | null {
    if (!candidates.length) return null;
    const scored = candidates.map(info => {
      const recipientScore = recipientSimilarityScore(recipientNorm, recipientTokens, info.recipientNorm, info.recipientTokens);
      const dateScore = dateSimilarityScore(referenceEpoch, info.deliveryEpoch);
      const orderIdScore = info.orderNumber ? 18 : -36;
      let amountScore = 0;
      if (messageAmountCents !== null && info.orderAmountCents !== null) {
        const deltaCents = Math.abs(messageAmountCents - info.orderAmountCents);
        if (deltaCents === 0) amountScore = 24;
        else if (deltaCents <= 100) amountScore = 10;
        else if (deltaCents <= 500) amountScore = -8;
        else amountScore = -20;
      } else if (messageAmountCents !== null && info.orderAmountCents === null) {
        amountScore = -8;
      }
      return {
        info,
        score: baseScore + orderIdScore + recipientScore + dateScore.score + amountScore,
        deltaDays: dateScore.deltaDays,
      };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.deltaDays !== b.deltaDays) return a.deltaDays - b.deltaDays;
      return a.info.ticketId.localeCompare(b.info.ticketId);
    });
    return scored[0] || null;
  }

  function resolveAskLink(
    message: MessageItem,
    recipient: string,
    summary: string,
    msgDateRaw: string,
    deliveryDateRaw: string,
    syntheticId: string,
  ): AskMatchResult {
    const attempts: AskCandidateAttempt[] = [];
    const messageKeys = Array.from(messageLinkKeySet(message));
    messageKeys.push(normalizeIdLike(syntheticId));
    const candidateIds = buildAskIdCandidates(message);
    const recipientNorm = normalizeText(recipient || summary);
    const recipientTokens = tokenizeRecipient(`${recipient} ${summary}`);
    const referenceEpoch = toEpoch(deliveryDateRaw || msgDateRaw);
    const referenceDateKey = toDateKey(deliveryDateRaw || msgDateRaw);
    const messageAmountCents = amountToCents(normalizedOrderAmount(message));

    let bestFromIds: { info: LinkedOrderInfo; score: number; strategy: string; deltaDays: number } | null = null;

    for (const candidate of candidateIds) {
      const byKey = orderByKey.get(candidate.normalized) || [];
      if (!byKey.length) {
        attempts.push({
          candidate: candidate.value,
          source: candidate.source,
          strength: candidate.strength,
          testedTicketIds: [],
          testedOrderNumbers: [],
          outcome: 'failed',
          reason: 'No order indexed for this key.',
        });
        continue;
      }

      const best = selectBestCandidate(byKey, recipientNorm, recipientTokens, referenceEpoch, messageAmountCents, candidate.rank);
      if (!best) {
        attempts.push({
          candidate: candidate.value,
          source: candidate.source,
          strength: candidate.strength,
          testedTicketIds: byKey.map(item => item.ticketId).filter(Boolean),
          testedOrderNumbers: byKey.map(item => item.orderNumber).filter(Boolean),
          outcome: 'failed',
          reason: 'Candidates existed but scoring did not return a winner.',
        });
        continue;
      }

      const testedTicketIds = byKey.map(item => item.ticketId).filter(Boolean);
      const testedOrderNumbers = byKey.map(item => item.orderNumber).filter(Boolean);
      if (!best.info.orderNumber) {
        attempts.push({
          candidate: candidate.value,
          source: candidate.source,
          strength: candidate.strength,
          testedTicketIds,
          testedOrderNumbers,
          outcome: 'failed',
          reason: 'Matched ticket candidate(s) but no displayable order ID was present.',
        });
        continue;
      }

      const current = {
        info: best.info,
        score: best.score,
        strategy: `id_key:${candidate.source}`,
        deltaDays: best.deltaDays,
      };
      if (
        !bestFromIds
        || current.score > bestFromIds.score
        || (current.score === bestFromIds.score && current.deltaDays < bestFromIds.deltaDays)
        || (current.score === bestFromIds.score && current.deltaDays === bestFromIds.deltaDays && current.info.ticketId < bestFromIds.info.ticketId)
      ) {
        bestFromIds = current;
      }
    }

    if (bestFromIds?.info?.orderNumber) {
      attempts.push({
        candidate: bestFromIds.info.orderNumber,
        source: bestFromIds.strategy,
        strength: 'strong',
        testedTicketIds: [bestFromIds.info.ticketId].filter(Boolean),
        testedOrderNumbers: [bestFromIds.info.orderNumber].filter(Boolean),
        outcome: 'matched',
        reason: `Selected by deterministic ID ranking (score ${bestFromIds.score}).`,
      });
      return {
        linkedOrder: bestFromIds.info,
        messageKeys,
        attempts,
        summary: `Matched via ${bestFromIds.strategy}.`,
      };
    }

    const recipientCandidateMap = new Map<string, LinkedOrderInfo>();
    for (const token of recipientTokens) {
      for (const candidate of orderByToken.get(token) || []) {
        recipientCandidateMap.set(candidate.ticketId, candidate);
      }
    }
    const recipientCandidates = recipientCandidateMap.size ? Array.from(recipientCandidateMap.values()) : allOrderInfos;
    const fallbackScored: Array<{ info: LinkedOrderInfo; score: number; strategy: string; deltaDays: number }> = [];

    for (const candidate of recipientCandidates) {
      const recipientScore = recipientSimilarityScore(recipientNorm, recipientTokens, candidate.recipientNorm, candidate.recipientTokens);
      if (recipientScore <= 0) continue;
      const dateScore = dateSimilarityScore(referenceEpoch, candidate.deliveryEpoch);
      const dateExact = Boolean(referenceDateKey && candidate.deliveryDateKey && referenceDateKey === candidate.deliveryDateKey);
      let base = 0;
      let strategy = '';

      if (recipientNorm && candidate.recipientNorm && recipientNorm === candidate.recipientNorm && dateExact) {
        base = 88;
        strategy = 'recipient+delivery_date_exact';
      } else if (recipientScore >= 28 && dateScore.score >= 8) {
        base = 72;
        strategy = 'recipient+date_near';
      } else if (recipientScore >= 32) {
        base = 60;
        strategy = 'recipient_only';
      } else {
        continue;
      }

      fallbackScored.push({
        info: candidate,
        score: base
          + recipientScore
          + dateScore.score
          + (candidate.orderNumber ? 14 : -24)
          + (
            messageAmountCents !== null && candidate.orderAmountCents !== null
              ? (Math.abs(messageAmountCents - candidate.orderAmountCents) === 0 ? 24 : -12)
              : 0
          ),
        strategy,
        deltaDays: dateScore.deltaDays,
      });
    }

    fallbackScored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.deltaDays !== b.deltaDays) return a.deltaDays - b.deltaDays;
      return a.info.ticketId.localeCompare(b.info.ticketId);
    });

    for (const candidate of fallbackScored.slice(0, 6)) {
      attempts.push({
        candidate: `${candidate.info.ticketId || 'n/a'}|${candidate.info.orderNumber || 'n/a'}`,
        source: candidate.strategy,
        strength: 'weak',
        testedTicketIds: [candidate.info.ticketId].filter(Boolean),
        testedOrderNumbers: [candidate.info.orderNumber].filter(Boolean),
        outcome: candidate.info.orderNumber ? 'matched' : 'failed',
        reason: candidate.info.orderNumber
          ? `Recipient/date fallback candidate scored ${candidate.score}.`
          : `Candidate scored ${candidate.score} but had no order ID.`,
      });
    }

    const fallbackWinner = fallbackScored.find(candidate => Boolean(candidate.info.orderNumber));
    if (fallbackWinner) {
      return {
        linkedOrder: fallbackWinner.info,
        messageKeys,
        attempts,
        summary: `Matched via ${fallbackWinner.strategy}.`,
      };
    }

    if (!attempts.length) {
      attempts.push({
        candidate: 'none',
        source: 'no_candidate',
        strength: 'weak',
        testedTicketIds: [],
        testedOrderNumbers: [],
        outcome: 'failed',
        reason: 'No candidate IDs or recipient/date candidates were available.',
      });
    }

    return {
      linkedOrder: null,
      messageKeys,
      attempts,
      summary: 'Unresolved after ranked ID + recipient/date matching.',
    };
  }

  for (const message of messageItems) {
    const summary = String(message.SUMMARY_TEXT || '').trim();
    const recipient = String(message.RECIPIENT_NAME || summary || 'Unknown Recipient').trim();
    const msgDateRaw = String(message.MSG_DATE || '').trim();
    const deliveryDateRaw = String(message.DELIVERY_DATE || '').trim();
    const msgType = messageTypeText(message);
    const messageType = classifyIncomingMessageType(message);
    const notes = String(message.MSG_NOTES || '').trim();
    const messageAmount = normalizedOrderAmount(message);
    const messageAmountCents = amountToCents(messageAmount);
    const ask = messageType.key === 'ask';
    const isCancel = messageType.key === 'cancel';
    const requiresAttention = String(message.REQUIRES_ATTENTION || '').trim() === '1';
    if (!isInboundIntakeMessage(message)) continue;

    const messageId = String(message.ID || '').trim();
    const syntheticId = `${normalizeText(recipient)}|${msgDateRaw || deliveryDateRaw || summary}`;
    const id = messageId || syntheticId;

    const candidateOrderKeys = messageLinkKeySet(message);
    candidateOrderKeys.add(normalizeIdLike(id));

    const askMatch = ask
      ? resolveAskLink(message, recipient, summary, msgDateRaw, deliveryDateRaw, syntheticId)
      : null;

    let linkedOrder: LinkedOrderInfo | null = askMatch?.linkedOrder || null;
    let linkedOrderWithoutOrderNumber: LinkedOrderInfo | null = null;

    if (!ask) {
      for (const key of candidateOrderKeys) {
        if (!key) continue;
        const found = orderByKey.get(key) || [];
        const withOrderNumber = found.find(entry => Boolean(entry.orderNumber)) || null;
        if (withOrderNumber) {
          linkedOrder = withOrderNumber;
          break;
        }
        if (!linkedOrderWithoutOrderNumber && found.length) {
          linkedOrderWithoutOrderNumber = found[0];
        }
      }

      if (!linkedOrder) {
        const nameNorm = normalizeText(recipient || summary);
        const deliveryKey = toDateKey(deliveryDateRaw || msgDateRaw);
        if (nameNorm && deliveryKey) {
          if (messageAmount) {
            const byNameDateAmount = orderByNameDateAmount.get(`${nameNorm}|${deliveryKey}|${messageAmount}`) || [];
            linkedOrder = byNameDateAmount.find(entry => Boolean(entry.orderNumber)) || byNameDateAmount[0] || null;
          }
        }
      }

      if (!linkedOrder) {
        const nameNorm = normalizeText(recipient || summary);
        const deliveryKey = toDateKey(deliveryDateRaw || msgDateRaw);
        if (nameNorm && deliveryKey) {
          const byNameDate = orderByNameDate.get(`${nameNorm}|${deliveryKey}`) || [];
          if (byNameDate.length <= 1) {
            linkedOrder = byNameDate.find(entry => Boolean(entry.orderNumber)) || byNameDate[0] || null;
          } else if (messageAmountCents !== null) {
            const amountSorted = byNameDate
              .filter(entry => entry.orderAmountCents !== null)
              .map(entry => ({
                entry,
                deltaCents: Math.abs(messageAmountCents - (entry.orderAmountCents as number)),
              }))
              .sort((a, b) => {
                if (a.deltaCents !== b.deltaCents) return a.deltaCents - b.deltaCents;
                if (a.entry.orderNumber !== b.entry.orderNumber) return (b.entry.orderNumber ? 1 : 0) - (a.entry.orderNumber ? 1 : 0);
                return a.entry.ticketId.localeCompare(b.entry.ticketId);
              });
            const winner = amountSorted[0];
            if (winner && winner.deltaCents <= 100) {
              linkedOrder = winner.entry;
            }
          }
        }
      }
    }

    let inferredOrderId = inferOrderIdFromMessage(message);
    const inferredLinkedOrderCandidates = !linkedOrder && inferredOrderId
      ? orderByKey.get(normalizeIdLike(inferredOrderId)) || []
      : [];
    const inferredLinkedOrder = inferredLinkedOrderCandidates.find(entry => Boolean(entry.orderNumber))
      || inferredLinkedOrderCandidates[0]
      || null;
    const resolvedLinkedOrder = ask
      ? linkedOrder || (inferredLinkedOrder?.orderNumber ? inferredLinkedOrder : null)
      : linkedOrder || (inferredLinkedOrder?.orderNumber ? inferredLinkedOrder : null) || linkedOrderWithoutOrderNumber;
    const verifiedInferredOrderId = inferredLinkedOrder?.orderNumber || '';
    const displayOrderId = ask
      ? (verifiedInferredOrderId || inferredOrderId || resolvedLinkedOrder?.orderNumber || '')
      : (resolvedLinkedOrder?.orderNumber || verifiedInferredOrderId || inferredOrderId);

    if (!inferredOrderId && resolvedLinkedOrder?.orderNumber) {
      inferredOrderId = resolvedLinkedOrder.orderNumber;
    }

    const shouldKeepLinkedCard =
      ask
      || isCancel
      || messageType.key === 'ans'
      || messageType.key === 'con'
      || (messageType.key === 'other' && messageType.label !== 'ORD')
      || messageType.key === 'unknown';
    const linkedOrderVisibleInActive = Boolean(resolvedLinkedOrder) && (
      activeOrderLookupKeys.has(normalizeIdLike(resolvedLinkedOrder?.ticketId || ''))
      || activeOrderLookupKeys.has(normalizeIdLike(resolvedLinkedOrder?.orderNumber || ''))
    );
    if (resolvedLinkedOrder && linkedOrderVisibleInActive && !shouldKeepLinkedCard) {
      continue;
    }

    if (resolvedLinkedOrder?.ticketId) {
      candidateOrderKeys.add(normalizeIdLike(resolvedLinkedOrder.ticketId));
    }
    if (resolvedLinkedOrder?.orderNumber) {
      candidateOrderKeys.add(normalizeIdLike(resolvedLinkedOrder.orderNumber));
    }

    const wireService = String(message.WIRE_SERVICE || '').trim();
    const displayRef = String(displayOrderId || '').trim();
    const isMarketplace = hasMarketplaceKeyword(
      recipient,
      summary,
      notes,
      wireService,
      String(message.FIRM_NAME || ''),
    );

    if (!seenTicketIds.has(id)) {
      if (!firstObservation) {
        flashUntilById.set(id, now + flashMs);
      }
      seenTicketIds.add(id);
    }

    const askEpoch = toEpoch(msgDateRaw);
    const askHasTimePrecision = hasExplicitTimeComponent(msgDateRaw);
    const askRecipientNorm = normalizeText(recipient || summary);
    const askDeliveryDateKey = toDateKey(deliveryDateRaw || msgDateRaw);
    const askThreadAmountNorm = ask ? normalizedOrderAmount(message) : '';
    const askThreadKeys = ask ? askThreadKeySet(message, askRecipientNorm, askDeliveryDateKey, askThreadAmountNorm) : new Set<string>();
    let effectiveAskEpoch = askEpoch;
    let effectiveAskHasTimePrecision = askHasTimePrecision;
    if (ask) {
      for (const key of askThreadKeys) {
        const threadEpoch = latestAskEpochByThreadKey.get(key) || 0;
        if (threadEpoch > effectiveAskEpoch) {
          effectiveAskEpoch = threadEpoch;
          effectiveAskHasTimePrecision = Boolean(latestAskHasTimeByThreadKey.get(key));
        } else if (threadEpoch === effectiveAskEpoch && threadEpoch > 0 && latestAskHasTimeByThreadKey.get(key)) {
          effectiveAskHasTimePrecision = true;
        }
      }
      if (askEpoch > 0 && effectiveAskEpoch > askEpoch) {
        continue;
      }
    }

    let askAnswered = false;
    if (ask) {
      for (const outgoing of outboundMessages) {
        if (effectiveAskEpoch > 0 && outgoing.epoch > 0 && outgoing.epoch < effectiveAskEpoch) continue;
        if (hasSharedKey(candidateOrderKeys, outgoing.keys)) {
          askAnswered = true;
          break;
        }
        if (askRecipientNorm && outgoing.recipientNorm && askRecipientNorm === outgoing.recipientNorm) {
          if (askDeliveryDateKey && askDeliveryDateKey === outgoing.deliveryDateKey) {
            askAnswered = true;
            break;
          }
        }
      }
    }

    // Stale tagging reflects message age (MSG_DATE), not order delivery age.
    const staleReferenceRaw = msgDateRaw;
    const staleEpoch = ask ? (effectiveAskEpoch || toEpoch(msgDateRaw)) : toEpoch(msgDateRaw);
    const staleHasTimePrecision = ask
      ? (effectiveAskHasTimePrecision || hasExplicitTimeComponent(msgDateRaw))
      : hasExplicitTimeComponent(msgDateRaw);
    const coarseAskDateEpoch = deliveryDateSortEpoch(staleReferenceRaw);
    const recipientDateKey = askRecipientNorm && askDeliveryDateKey
      ? `${askRecipientNorm}|${askDeliveryDateKey}`
      : '';
    const latestInboundEpochForRecipientDate = recipientDateKey
      ? (latestInboundEpochByRecipientDateKey.get(recipientDateKey) || 0)
      : 0;
    const latestInboundHasTimeForRecipientDate = recipientDateKey
      ? Boolean(latestInboundHasTimeByRecipientDateKey.get(recipientDateKey))
      : false;
    const effectiveStaleEpoch = latestInboundEpochForRecipientDate > staleEpoch
      ? latestInboundEpochForRecipientDate
      : staleEpoch;
    const effectiveStaleHasTimePrecision = latestInboundEpochForRecipientDate > staleEpoch
      ? latestInboundHasTimeForRecipientDate
      : staleHasTimePrecision;

    const staleByPreciseTime = effectiveStaleHasTimePrecision && effectiveStaleEpoch > 0 && (now - effectiveStaleEpoch >= askStaleMs);
    const staleByCoarseDate = !staleHasTimePrecision && coarseAskDateEpoch > 0 && (now - coarseAskDateEpoch >= (2 * 24 * 60 * 60 * 1000));
    const staleEligibility = ask ? !askAnswered : true;
    const isStaleAsk = allowStaleAskBadge && staleEligibility && (staleByPreciseTime || staleByCoarseDate);

    const hasLinkedOrder = Boolean(resolvedLinkedOrder?.ticketId || resolvedLinkedOrder?.orderNumber);
    const isKnownNonOrderMessage = messageType.key === 'other' && messageType.label && messageType.label !== 'ORD';
    const kind: IntakeKind = isCancel
      ? 'cancel'
      : (ask ? 'ask' : ((isKnownNonOrderMessage || hasLinkedOrder) ? 'message' : 'uncreated'));
    const isFlashing = isMarketplace
      || ((kind === 'uncreated' || kind === 'cancel') && (flashUntilById.get(id) || 0) > now)
      || (kind === 'ask' && requiresAttention && !isStaleAsk);
    const includeAskDebug = ask && !Boolean(displayOrderId);
    const askDebugDetails = includeAskDebug
      ? (askMatch?.attempts || []).slice(0, 10).map(attempt => {
          const testedTickets = attempt.testedTicketIds.length ? attempt.testedTicketIds.join(', ') : 'none';
          const testedOrders = attempt.testedOrderNumbers.length ? attempt.testedOrderNumbers.join(', ') : 'none';
          return `${attempt.source}:${attempt.candidate} -> ${attempt.reason} (tickets: ${testedTickets}; orders: ${testedOrders})`;
        })
      : [];
    const askMessageKeys = includeAskDebug
      ? (askMatch?.messageKeys || []).filter(Boolean)
      : [];
    const askDebugSummary = includeAskDebug
      ? askMatch?.summary || 'Unresolved ASK card.'
      : '';
    const messageCityStateZip = formatCityStateZip(
      String(message.RECIPIENT_CITY || ''),
      firstNonEmptyText(
        String(message.RECIPIENT_STATE_ABBREV || ''),
        String(message.RECIPIENT_STATE || ''),
      ),
      String(message.RECIPIENT_ZIP || ''),
    );
    const destinationAddressLine = firstNonEmptyText(String(message.RECIPIENT_ADDRESS || ''));
    const destinationCity = firstNonEmptyText(String(message.RECIPIENT_CITY || ''));
    const destinationState = firstNonEmptyText(
      String(message.RECIPIENT_STATE_ABBREV || ''),
      String(message.RECIPIENT_STATE || ''),
    );
    const destinationZip = firstNonEmptyText(String(message.RECIPIENT_ZIP || ''));
    const destinationLabel = firstNonEmptyText(
      resolvedLinkedOrder?.destinationLabel || '',
      compactTownZipLabel(messageCityStateZip, normalizedPostalCode(message)),
    );
    const orderAmount = firstNonEmptyText(
      resolvedLinkedOrder?.orderAmount || '',
      messageAmount,
    );

    const pendingTicket: IntakeTicketCard = {
      id,
      recipientName: recipient,
      summary,
      displayRef,
      destinationAddressLine,
      destinationCity,
      destinationState,
      destinationZip,
      destinationLabel,
      distanceMilesLabel: '',
      orderAmount,
      deliveryDate: deliveryDateRaw,
      messageDate: msgDateRaw,
      notes,
      wireService,
      senderName: senderDisplayNameForMessage(message),
      senderGateText: senderGateTextForMessage(message),
      msgType,
      messageTypeKey: messageType.key,
      messageTypeLabel: messageType.label,
      kind,
      relatedOrderNumber: displayOrderId || '',
      relatedTicketId: resolvedLinkedOrder?.ticketId || '',
      relatedOrderStatus: resolvedLinkedOrder?.statusLabel || '',
      requiresAttention,
      isStaleAsk,
      isMarketplace,
      isFlashing,
      askDebugSummary,
      askDebugDetails,
      askMessageKeys,
      gateResults: [],
    };
    pendingTicket.gateResults = evaluateIntakeGateResults(
      pendingTicket,
      options?.config || DEFAULT_DASHBOARD_CONFIG,
    );
    pending.push(pendingTicket);
  }

  for (const [id, untilEpoch] of flashUntilById.entries()) {
    if (untilEpoch <= now) {
      flashUntilById.delete(id);
    }
  }

  pending.sort((a, b) => {
    if (a.kind !== b.kind) {
      const kindSortRank: Record<IntakeKind, number> = { cancel: 0, uncreated: 1, ask: 2, message: 3 };
      return kindSortRank[a.kind] - kindSortRank[b.kind];
    }
    if (a.isMarketplace !== b.isMarketplace) return a.isMarketplace ? -1 : 1;
    if (a.requiresAttention !== b.requiresAttention) return a.requiresAttention ? -1 : 1;
    return toEpoch(b.messageDate) - toEpoch(a.messageDate);
  });

  return pending;
}

interface OrderEnrichment {
  ticketId: string;
  ticketStatus: TicketStatusRow | null;
  lifecycle: LifecycleRow | null;
}

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export default function App() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const [, setGroups] = useState<GroupedCards>(emptyGroups());
  const [allActiveOrders, setAllActiveOrders] = useState<BoardCard[]>([]);
  const [pendingTickets, setPendingTickets] = useState<IntakeTicketCard[]>([]);
  const [todaySaleDates, setTodaySaleDates] = useState<string[]>([]);
  const [lastYearSaleDates, setLastYearSaleDates] = useState<string[]>([]);
  const [lastYearStats, setLastYearStats] = useState<{ count: number; revenue: number; avgTicket: number } | null>(null);
  const [todayFinancials, setTodayFinancials] = useState<{ revenue: number; avgTicket: number; largestOrder: number; wireInCount: number; wireInRevenue: number }>({ revenue: 0, avgTicket: 0, largestOrder: 0, wireInCount: 0, wireInRevenue: 0 });
  const [loading, setLoading] = useState(true);
  const [isRefreshingActiveOrders, setIsRefreshingActiveOrders] = useState(false);
  const [, setLastUpdated] = useState<string>("");
  const [tickerNow, setTickerNow] = useState<Date>(() => new Date());
  const [error, setError] = useState<string>('');
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const [todayAnchorKey, setTodayAnchorKey] = useState<string>(() => currentLocalDateKey());
  const [dateOffsetDays, setDateOffsetDays] = useState(0);
  const [includeNextDay, setIncludeNextDay] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [isActiveSearchOpen, setIsActiveSearchOpen] = useState(false);
  const [activeOrderSearchQuery, setActiveOrderSearchQuery] = useState('');
  const [isAudioAlertsEnabled, setIsAudioAlertsEnabled] = useState<boolean>(() => initialAudioAlertsEnabled());
  const [isDashboardMode, setIsDashboardMode] = useState<boolean>(() => initialDashboardMode());
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState<'server' | 'client'>('server');
  const [pageSettingsPageId, setPageSettingsPageId] = useState<DashboardPageId | ''>('');
  const [tickerModuleSettingsId, setTickerModuleSettingsId] = useState<TickerModuleId | ''>('');
  const [currentPageId, setCurrentPageId] = useState<DashboardPageId>('alerts_active');
  const [config, setConfig] = useState<DashboardUserConfig>(() => initialDashboardConfig());
  const [configDraft, setConfigDraft] = useState<DashboardUserConfig | null>(null);
  const [configWeatherZipDraft, setConfigWeatherZipDraft] = useState<string>(() => DEFAULT_DASHBOARD_CONFIG.tickerWeatherZip);
  const [configMessage, setConfigMessage] = useState('');
  const [weatherTickerSnapshot, setWeatherTickerSnapshot] = useState<WeatherTickerSnapshot | null>(null);
  const [weatherForecastData, setWeatherForecastData] = useState<WeatherForecastData | null>(null);
  const [weatherForecastZip, setWeatherForecastZip] = useState('');
  const [weatherForecastLoading, setWeatherForecastLoading] = useState(false);
  const [shopAddressSuggestions, setShopAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [isShopAddressSuggesting, setIsShopAddressSuggesting] = useState(false);
  const [shopAddressSuggestionError, setShopAddressSuggestionError] = useState('');
  const [deliveryMapPins, setDeliveryMapPins] = useState<Array<Omit<DeliveryMapPin, 'xPercent' | 'yPercent'>>>([]);
  const [deliveryMapLoading, setDeliveryMapLoading] = useState(false);
  const [deliveryMapError, setDeliveryMapError] = useState('');
  const [selectedDeliveryMapPinId, setSelectedDeliveryMapPinId] = useState('');
  const [hoveredDeliveryMapPinId, setHoveredDeliveryMapPinId] = useState('');
  const [deliveryMapClientZoomAdjustment, setDeliveryMapClientZoomAdjustment] = useState<number | null>(null);
  const [financialsMasked, setFinancialsMasked] = useState(false);
  const [radarFrames, setRadarFrames] = useState<RadarFrame[]>([]);
  const [radarFrameIdx, setRadarFrameIdx] = useState(0);
  const seenTicketIdsRef = useRef<Set<string>>(new Set());
  const flashUntilRef = useRef<Map<string, number>>(new Map());
  const pendingListRef = useRef<HTMLDivElement | null>(null);
  const activeListRef = useRef<HTMLDivElement | null>(null);
  const deliveryMapFullscreenRef = useRef<HTMLDivElement | null>(null);
  const soundUploadRef = useRef<HTMLInputElement | null>(null);
  const marketplaceSoundUploadRef = useRef<HTMLInputElement | null>(null);
  const logoUploadRef = useRef<HTMLInputElement | null>(null);
  const unresolvedAskLogRef = useRef<Map<string, string>>(new Map());
  const activePaneSpinnerRequestedRef = useRef(true);
  const activePaneSpinnerInFlightRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const pollQueuedRef = useRef(false);
  const hasCompletedInitialPollRef = useRef(false);
  const pollFeedCacheRef = useRef<Map<string, TimedCacheEntry<unknown>>>(new Map());
  const selectedDateKeyRef = useRef<string>(currentLocalDateKey());
  const ticketStatusTtlCacheRef = useRef<Map<string, TimedCacheEntry<TicketStatusRow | null>>>(new Map());
  const lifecycleTtlCacheRef = useRef<Map<string, TimedCacheEntry<LifecycleRow | null>>>(new Map());
  const orderDetailsTtlCacheRef = useRef<Map<string, TimedCacheEntry<Awaited<ReturnType<typeof fetchOrderDetails>>>>>(new Map());
  const orderDetailZipByTicketRef = useRef<Map<string, string>>(new Map());
  const pendingDistanceByLookupKeyRef = useRef<Map<string, string>>(new Map());
  const deliveryMapGeocodeCacheRef = useRef<Map<string, Omit<DeliveryMapPin, 'xPercent' | 'yPercent'> | null>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAlertsEnabledRef = useRef(isAudioAlertsEnabled);
  const audioAlertSnapshotReadyRef = useRef(false);
  const alertedItemKeysRef = useRef<Set<string>>(new Set());
  const alertPlaybackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const askDebugEnabled = useMemo(() => isAskDebugEnabledFromBrowser(), []);
  const enabledPages = useMemo(() => {
    const ids = normalizeEnabledPageIds(config.enabledPageIds);
    const allowed = new Set(ids);
    const pages = DASHBOARD_PAGE_DEFINITIONS.filter(page => allowed.has(page.id));
    return pages.length ? pages : [DASHBOARD_PAGE_DEFINITIONS[0]];
  }, [config.enabledPageIds]);
  const currentPageIndex = useMemo(
    () => Math.max(0, enabledPages.findIndex(page => page.id === currentPageId)),
    [currentPageId, enabledPages],
  );
  const activePage = enabledPages[currentPageIndex] || enabledPages[0];
  const hasMultiplePages = enabledPages.length > 1;
  const editingConfig = useMemo(
    () => sanitizeDashboardConfig({
      ...(configDraft || config),
      tickerWeatherZip: configWeatherZipDraft,
    }),
    [config, configDraft, configWeatherZipDraft],
  );
  const hasConfigChanges = useMemo(
    () => !isDashboardConfigEqual(editingConfig, config),
    [config, editingConfig],
  );
  const configForLogoPreview = useMemo(
    () => (isConfigOpen ? editingConfig : config),
    [config, editingConfig, isConfigOpen],
  );
  const customLogoSrc = useMemo(
    () => (configForLogoPreview.customLogoDataUrl ? configForLogoPreview.customLogoDataUrl : '/olivers.png'),
    [configForLogoPreview.customLogoDataUrl],
  );
  const dashboardTitle = useMemo(() => {
    const shopName = config.shopName.trim();
    return shopName ? `${shopName} TV Dashboard` : 'TV Dashboard';
  }, [config.shopName]);
  const deliveryMapOrigin = useMemo(
    () => deliveryMapShopPoint(config),
    [config.shopAddressLatitude, config.shopAddressLongitude],
  );
  const shopMapUrl = useMemo(() => {
    if (!editingConfig.shopAddress.trim()) return '';
    if (editingConfig.shopAddressLatitude === null || editingConfig.shopAddressLongitude === null) return '';
    return buildStaticMapUrl({
      latitude: editingConfig.shopAddressLatitude,
      longitude: editingConfig.shopAddressLongitude,
      width: 640,
      height: 260,
      zoom: 15,
      marker: true,
    });
  }, [editingConfig.shopAddressLatitude, editingConfig.shopAddressLongitude]);
  const effectiveDeliveryMapZoomAdjustment = deliveryMapClientZoomAdjustment ?? config.deliveryMapZoomAdjustment;
  const deliveryMapViewportPoints = useMemo(
    () => buildDeliveryMapViewportFitPoints(deliveryMapPins, deliveryMapOrigin),
    [deliveryMapOrigin, deliveryMapPins],
  );
  const deliveryMapViewport = useMemo(
    () => buildDeliveryMapViewport(deliveryMapViewportPoints, {
      initialZoom: config.deliveryMapInitialZoom,
      minZoom: config.deliveryMapMinZoom,
      maxZoom: config.deliveryMapMaxZoom,
      zoomAdjustment: effectiveDeliveryMapZoomAdjustment,
      padding: config.deliveryMapPadding,
    }),
    [
      config.deliveryMapInitialZoom,
      config.deliveryMapMaxZoom,
      config.deliveryMapMinZoom,
      effectiveDeliveryMapZoomAdjustment,
      config.deliveryMapPadding,
      deliveryMapViewportPoints,
    ],
  );
  const positionedDeliveryMapPins = useMemo(
    () => positionDeliveryMapPins(deliveryMapPins, deliveryMapViewport),
    [deliveryMapPins, deliveryMapViewport],
  );
  const deliveryMapUrl = useMemo(() => {
    if (!deliveryMapViewport) return '';
    return buildStaticMapBaseUrl({
      latitude: deliveryMapViewport.latitude,
      longitude: deliveryMapViewport.longitude,
      width: DELIVERY_MAP_IMAGE_WIDTH,
      height: DELIVERY_MAP_IMAGE_HEIGHT,
      zoom: deliveryMapViewport.zoom,
      cacheKey: 'delivery-map-base-v1',
    });
  }, [deliveryMapViewport]);
  const activeDeliveryMapPinId = hoveredDeliveryMapPinId || selectedDeliveryMapPinId;
  const selectedDeliveryMapPin = useMemo(
    () => positionedDeliveryMapPins.find(pin => pin.id === activeDeliveryMapPinId) || null,
    [activeDeliveryMapPinId, positionedDeliveryMapPins],
  );
  const askStaleMs = useMemo(
    () => clampInteger(config.askStaleHours * 60 * 60 * 1000, 60 * 60 * 1000, 72 * 60 * 60 * 1000, DEFAULT_ASK_STALE_HOURS * 60 * 60 * 1000),
    [config.askStaleHours],
  );
  const playAlertSound = useCallback(async (configOverride?: DashboardUserConfig) => {
    if (typeof window === 'undefined') return;
    const soundConfig = sanitizeDashboardConfig(configOverride || config);

    if (soundConfig.soundPreset === 'custom_upload' && soundConfig.customSoundDataUrl) {
      try {
        const audio = new Audio(soundConfig.customSoundDataUrl);
        audio.preload = 'auto';
        audio.volume = 1;
        await audio.play();
        return;
      } catch {
        // Fall back to synth profile below when browser blocks custom media playback.
      }
    }

    const windowWithWebkit = window as Window & { webkitAudioContext?: typeof AudioContext };
    const AudioContextCtor = globalThis.AudioContext || windowWithWebkit.webkitAudioContext;
    if (!AudioContextCtor) return;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor();
    }

    const audioContext = audioContextRef.current;
    if (!audioContext) return;
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch {
        return;
      }
    }
    if (audioContext.state !== 'running') return;

    const now = audioContext.currentTime;
    const preset = soundConfig.soundPreset === 'custom_upload' ? 'alarm_pulse' : soundConfig.soundPreset;

    if (preset === 'classic_ding') {
      const masterGain = audioContext.createGain();
      masterGain.connect(audioContext.destination);
      masterGain.gain.setValueAtTime(0.0001, now);
      masterGain.gain.exponentialRampToValueAtTime(0.34, now + 0.012);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);

      const toneA = audioContext.createOscillator();
      toneA.type = 'triangle';
      toneA.frequency.setValueAtTime(988, now);
      toneA.connect(masterGain);
      toneA.start(now);
      toneA.stop(now + 0.20);

      const toneB = audioContext.createOscillator();
      toneB.type = 'triangle';
      toneB.frequency.setValueAtTime(1318.5, now + 0.14);
      toneB.connect(masterGain);
      toneB.start(now + 0.14);
      toneB.stop(now + 0.56);

      window.setTimeout(() => {
        masterGain.disconnect();
      }, 1000);
      return;
    }

    if (preset === 'bright_beep') {
      const masterGain = audioContext.createGain();
      masterGain.connect(audioContext.destination);
      masterGain.gain.setValueAtTime(0.0001, now);
      masterGain.gain.exponentialRampToValueAtTime(0.82, now + 0.006);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.56);

      const scheduleBeep = (startAt: number, stopAt: number, frequency: number): void => {
        const beepGain = audioContext.createGain();
        beepGain.connect(masterGain);
        beepGain.gain.setValueAtTime(0.0001, startAt);
        beepGain.gain.exponentialRampToValueAtTime(0.95, startAt + 0.004);
        beepGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        const beep = audioContext.createOscillator();
        beep.type = 'square';
        beep.frequency.setValueAtTime(frequency, startAt);
        beep.connect(beepGain);
        beep.start(startAt);
        beep.stop(stopAt);
      };

      scheduleBeep(now, now + 0.12, 1760);
      scheduleBeep(now + 0.15, now + 0.29, 1568);
      scheduleBeep(now + 0.32, now + 0.46, 1760);

      window.setTimeout(() => {
        masterGain.disconnect();
      }, 900);
      return;
    }

    const masterGain = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-26, now);
    compressor.knee.setValueAtTime(20, now);
    compressor.ratio.setValueAtTime(12, now);
    compressor.attack.setValueAtTime(0.003, now);
    compressor.release.setValueAtTime(0.22, now);

    masterGain.connect(compressor);
    compressor.connect(audioContext.destination);
    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.exponentialRampToValueAtTime(0.75, now + 0.012);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.82);

    const schedulePulse = (startAt: number, stopAt: number, freqA: number, freqB: number): void => {
      const pulseGain = audioContext.createGain();
      pulseGain.connect(masterGain);
      pulseGain.gain.setValueAtTime(0.0001, startAt);
      pulseGain.gain.exponentialRampToValueAtTime(0.95, startAt + 0.006);
      pulseGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

      const toneA = audioContext.createOscillator();
      toneA.type = 'square';
      toneA.frequency.setValueAtTime(freqA, startAt);
      toneA.connect(pulseGain);
      toneA.start(startAt);
      toneA.stop(stopAt);

      const toneB = audioContext.createOscillator();
      toneB.type = 'square';
      toneB.frequency.setValueAtTime(freqB, startAt);
      toneB.connect(pulseGain);
      toneB.start(startAt);
      toneB.stop(stopAt);
    };

    schedulePulse(now, now + 0.15, 980, 1470);
    schedulePulse(now + 0.20, now + 0.37, 830, 1245);
    schedulePulse(now + 0.43, now + 0.60, 980, 1470);

    window.setTimeout(() => {
      masterGain.disconnect();
      compressor.disconnect();
    }, 1200);
  }, [config]);
  const queueAlertDings = useCallback((count: number, options?: { configOverride?: DashboardUserConfig }) => {
    const dingCount = Math.max(0, Math.min(12, Math.floor(Number(count) || 0)));
    if (dingCount <= 0) return;
    const audioConfig = sanitizeDashboardConfig(options?.configOverride || config);
    const dingGapMs = clampInteger(audioConfig.dingGapMs, 250, 2500, DEFAULT_DING_GAP_MS);

    alertPlaybackQueueRef.current = alertPlaybackQueueRef.current
      .catch(() => {
        // Keep queue alive after a playback failure.
      })
      .then(async () => {
        for (let i = 0; i < dingCount; i += 1) {
          await playAlertSound(audioConfig);
          if (i < dingCount - 1) {
            await sleep(dingGapMs);
          }
        }
      });
  }, [config, playAlertSound]);
  const openConfigPage = useCallback(() => {
    setConfigDraft(sanitizeDashboardConfig(config));
    setConfigWeatherZipDraft(sanitizeDashboardConfig(config).tickerWeatherZip);
    setConfigMessage('');
    setPageSettingsPageId('');
    setTickerModuleSettingsId('');
    setIsConfigOpen(true);
  }, [config]);
  const cancelConfigChanges = useCallback(() => {
    setConfigDraft(null);
    setConfigWeatherZipDraft(sanitizeDashboardConfig(config).tickerWeatherZip);
    setConfigMessage('');
    setPageSettingsPageId('');
    setTickerModuleSettingsId('');
    setIsConfigOpen(false);
    if (soundUploadRef.current) soundUploadRef.current.value = '';
    if (marketplaceSoundUploadRef.current) marketplaceSoundUploadRef.current.value = '';
    if (logoUploadRef.current) logoUploadRef.current.value = '';
  }, [config]);
  const saveConfigChanges = useCallback(async () => {
    const nextConfig = editingConfig;
    if (isDashboardConfigEqual(nextConfig, config)) return;

    const serverConfigSaved = await saveDashboardServerConfig(
      sanitizeServerBackedConfig(nextConfig) as Record<string, unknown>,
    );

    setConfig(nextConfig);
    setConfigDraft(null);
    setConfigWeatherZipDraft(nextConfig.tickerWeatherZip);
    setDeliveryMapClientZoomAdjustment(null);
    setConfigMessage(serverConfigSaved ? '' : 'Saved client settings; server settings disk save is unavailable.');
    setPageSettingsPageId('');
    setTickerModuleSettingsId('');
    setIsConfigOpen(false);
    if (soundUploadRef.current) soundUploadRef.current.value = '';
    if (marketplaceSoundUploadRef.current) marketplaceSoundUploadRef.current.value = '';
    if (logoUploadRef.current) logoUploadRef.current.value = '';
  }, [config, editingConfig]);
  const updateConfigNumber = useCallback((key: keyof DashboardUserConfig, valueRaw: string) => {
    const value = Number(valueRaw);
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({ ...base, [key]: Number.isFinite(value) ? value : base[key] });
    });
  }, [config]);
  const updateDeliveryMapClientZoomAdjustment = useCallback((delta: number) => {
    setDeliveryMapClientZoomAdjustment(previous => {
      const current = previous ?? config.deliveryMapZoomAdjustment;
      return clampInteger(current + delta, -4, 4, current);
    });
  }, [config.deliveryMapZoomAdjustment]);
  const fitDeliveryMapToPins = useCallback(() => {
    setDeliveryMapClientZoomAdjustment(0);
  }, []);
  const toggleDeliveryMapFullscreen = useCallback(() => {
    const target = deliveryMapFullscreenRef.current;
    if (!target || typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement === target) {
        void document.exitFullscreen();
      } else {
        void target.requestFullscreen();
      }
    } catch {
      // Ignore unsupported fullscreen failures.
    }
  }, []);
  const updateGateZipCodes = useCallback((valueRaw: string) => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({
        ...base,
        gateZipCodes: normalizeGateZipCodes(valueRaw),
      });
    });
  }, [config]);
  const addSenderGateRule = useCallback(() => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({
        ...base,
        blockedSenderRules: [
          ...base.blockedSenderRules,
          {
            id: createSenderGateRuleId(),
            pattern: 'New sender',
            matchMode: 'contains',
            label: '',
            enabled: true,
          },
        ],
      });
    });
  }, [config]);
  const updateSenderGateRule = useCallback((id: string, updates: Partial<SenderGateRule>) => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      const nextRules = base.blockedSenderRules.map(rule => (
        rule.id === id ? { ...rule, ...updates } : rule
      ));
      return sanitizeDashboardConfig({
        ...base,
        blockedSenderRules: nextRules,
      });
    });
  }, [config]);
  const removeSenderGateRule = useCallback((id: string) => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({
        ...base,
        blockedSenderRules: base.blockedSenderRules.filter(rule => rule.id !== id),
      });
    });
  }, [config]);
  const updateStoreHours = useCallback((updates: Partial<StoreHoursConfig>) => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({
        ...base,
        storeHours: {
          ...base.storeHours,
          ...updates,
        },
      });
    });
  }, [config]);
  const selectShopAddressSuggestion = useCallback((suggestion: AddressSuggestion) => {
    setConfigDraft(previous => sanitizeDashboardConfig({
      ...(previous || config),
      shopAddress: suggestion.address || suggestion.label,
      shopAddressLatitude: suggestion.latitude,
      shopAddressLongitude: suggestion.longitude,
    }));
    setShopAddressSuggestions([]);
    setShopAddressSuggestionError('');
  }, [config]);
  const toggleEnabledPageInDraft = useCallback((pageId: DashboardPageId, enabled: boolean) => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      const nextEnabled = enabled
        ? Array.from(new Set([...base.enabledPageIds, pageId]))
        : base.enabledPageIds.filter(id => id !== pageId);
      return sanitizeDashboardConfig({
        ...base,
        enabledPageIds: nextEnabled,
      });
    });
  }, [config]);
  const resetConfigDefaults = useCallback(() => {
    setConfigDraft(DEFAULT_DASHBOARD_CONFIG);
    setConfigWeatherZipDraft(DEFAULT_DASHBOARD_CONFIG.tickerWeatherZip);
    setPageSettingsPageId('');
    setTickerModuleSettingsId('');
    setConfigMessage('Config reset to defaults.');
    if (soundUploadRef.current) soundUploadRef.current.value = '';
    if (marketplaceSoundUploadRef.current) marketplaceSoundUploadRef.current.value = '';
    if (logoUploadRef.current) logoUploadRef.current.value = '';
  }, []);
  const toggleTickerModuleInDraft = useCallback((moduleId: TickerModuleId, enabled: boolean) => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      const nextIds = enabled
        ? [...base.tickerModules, moduleId]
        : base.tickerModules.filter(id => id !== moduleId);
      return sanitizeDashboardConfig({
        ...base,
        tickerModules: nextIds,
      });
    });
  }, [config]);
  const handleCustomSoundUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!String(file.type || '').toLowerCase().startsWith('audio/')) {
      setConfigMessage('Please upload an audio file (wav, mp3, ogg, etc).');
      event.target.value = '';
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setConfigMessage('Audio file is too large. Keep it under 4 MB.');
      event.target.value = '';
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const nextConfig = sanitizeDashboardConfig({
        ...(configDraft || config),
        soundPreset: 'custom_upload',
        customSoundDataUrl: dataUrl,
      });
      setConfigDraft(nextConfig);
      setConfigMessage(`Custom sound loaded: ${file.name}`);
      queueAlertDings(1, { configOverride: nextConfig });
    } catch {
      setConfigMessage('Failed to load custom sound file.');
    }
  }, [config, configDraft, queueAlertDings]);
  const handleMarketplaceCustomSoundUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!String(file.type || '').toLowerCase().startsWith('audio/')) {
      setConfigMessage('Please upload an audio file (wav, mp3, ogg, etc).');
      event.target.value = '';
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setConfigMessage('Audio file is too large. Keep it under 4 MB.');
      event.target.value = '';
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const nextConfig = sanitizeDashboardConfig({
        ...(configDraft || config),
        marketplaceSoundPreset: 'custom_upload',
        marketplaceCustomSoundDataUrl: dataUrl,
      });
      setConfigDraft(nextConfig);
      setConfigMessage(`Delivery-service sound loaded: ${file.name}`);
      queueAlertDings(1, { configOverride: buildSoundConfigForAlertKind(nextConfig, 'marketplace') });
    } catch {
      setConfigMessage('Failed to load delivery-service sound file.');
    }
  }, [config, configDraft, queueAlertDings]);
  const clearCustomSound = useCallback(() => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({
        ...base,
        customSoundDataUrl: '',
        soundPreset: base.soundPreset === 'custom_upload' ? 'alarm_pulse' : base.soundPreset,
      });
    });
    setConfigMessage('Custom sound cleared.');
    if (soundUploadRef.current) soundUploadRef.current.value = '';
  }, [config]);
  const clearMarketplaceCustomSound = useCallback(() => {
    setConfigDraft(previous => {
      const base = sanitizeDashboardConfig(previous || config);
      return sanitizeDashboardConfig({
        ...base,
        marketplaceCustomSoundDataUrl: '',
        marketplaceSoundPreset: base.marketplaceSoundPreset === 'custom_upload' ? 'alarm_pulse' : base.marketplaceSoundPreset,
      });
    });
    setConfigMessage('Delivery-service sound cleared.');
    if (marketplaceSoundUploadRef.current) marketplaceSoundUploadRef.current.value = '';
  }, [config]);
  const handleLogoUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!String(file.type || '').toLowerCase().startsWith('image/')) {
      setConfigMessage('Please upload an image file for your shop logo.');
      event.target.value = '';
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setConfigMessage('Logo image is too large. Keep it under 4 MB.');
      event.target.value = '';
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setConfigDraft(previous => sanitizeDashboardConfig({
        ...(previous || config),
        customLogoDataUrl: dataUrl,
      }));
      setConfigMessage(`Logo updated: ${file.name}`);
    } catch {
      setConfigMessage('Failed to load logo image.');
    }
  }, [config]);
  const clearCustomLogo = useCallback(() => {
    setConfigDraft(previous => sanitizeDashboardConfig({
      ...(previous || config),
      customLogoDataUrl: '',
    }));
    setConfigMessage('Logo reset to default.');
    if (logoUploadRef.current) logoUploadRef.current.value = '';
  }, [config]);
  const requestActiveOrdersRefreshSpinner = useCallback(() => {
    activePaneSpinnerRequestedRef.current = true;
    setIsRefreshingActiveOrders(true);
  }, []);
  const setSelectedDateByKey = useCallback((dateKeyRaw: string) => {
    const nextDate = localDateFromDateKey(dateKeyRaw);
    if (!nextDate) return;
    if (isRefreshingActiveOrders || loading) return;
    requestActiveOrdersRefreshSpinner();
    setDateOffsetDays(dayOffsetFromToday(nextDate));
  }, [isRefreshingActiveOrders, loading, requestActiveOrdersRefreshSpinner]);
  const selectedDate = useMemo(() => {
    const date = localDateFromDateKey(todayAnchorKey) || new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + dateOffsetDays);
    return date;
  }, [dateOffsetDays, todayAnchorKey]);
  const sourceRangeWindows = useMemo(
    // Always query today + next day for canonical delivery-date reconciliation
    // and instant on/off filtering in the UI.
    () => activeRangeDayWindows(selectedDate, true),
    [selectedDate],
  );
  const sourceDeliveryDateKeys = useMemo(
    () => activeDeliveryDateKeys(selectedDate, true),
    [selectedDate],
  );
  const allowedDeliveryDateKeys = useMemo(
    () => activeDeliveryDateKeys(selectedDate, includeNextDay),
    [selectedDate, includeNextDay],
  );
  const displayEligibleOrders = useMemo(
    () => (showCompleted ? allActiveOrders : allActiveOrders.filter(card => !isCompletedOrder(card))),
    [allActiveOrders, showCompleted],
  );
  const activeOrders = useMemo(() => {
    return displayEligibleOrders.filter(card =>
      isWithinDateKeys(card.deliveryDate, allowedDeliveryDateKeys) &&
      !isWireOutOrderType(card.orderType)
    );
  }, [displayEligibleOrders, allowedDeliveryDateKeys]);
  const normalizedActiveOrderSearchQuery = useMemo(
    () => normalizeText(activeOrderSearchQuery),
    [activeOrderSearchQuery],
  );
  const filteredActiveOrders = useMemo(() => {
    if (!normalizedActiveOrderSearchQuery) return activeOrders;
    return activeOrders.filter(card => {
      const statusLabel = singleStatusPill(card).label;
      const haystack = [
        card.recipientName,
        card.userReference,
        card.ticketId,
        card.addressLine,
        card.cityStateZip,
        card.deliveryZip,
        statusLabel,
      ].map(value => normalizeText(String(value || ''))).join(' ');
      return haystack.includes(normalizedActiveOrderSearchQuery);
    });
  }, [activeOrders, normalizedActiveOrderSearchQuery]);
  const selectedDateKey = useMemo(() => dateKeyFromDate(selectedDate), [selectedDate]);
  // Keep ref in sync so the pollBoard closure (which captures stale values) always sees the current date
  useEffect(() => { selectedDateKeyRef.current = selectedDateKey; }, [selectedDateKey]);
  const nextDateKey = useMemo(() => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + 1);
    return dateKeyFromDate(next);
  }, [selectedDate]);
  const visibleTodayCount = useMemo(
    () => countOrdersForDateKey(activeOrders, selectedDateKey),
    [activeOrders, selectedDateKey],
  );
  const visibleNextDayCount = useMemo(
    () => countOrdersForDateKey(activeOrders, nextDateKey),
    [activeOrders, nextDateKey],
  );
  const hiddenNextDayCount = useMemo(
    () => includeNextDay ? 0 : countOrdersForDateKey(displayEligibleOrders, nextDateKey),
    [displayEligibleOrders, includeNextDay, nextDateKey],
  );
  const selectedDayOrderTotal = useMemo(
    () => allActiveOrders.filter(card => toDateKey(card.deliveryDate) === selectedDateKey && !isWireOutOrderType(card.orderType)).length,
    [allActiveOrders, selectedDateKey],
  );
  const selectedDayOrderCompleted = useMemo(
    () => allActiveOrders.filter(card => toDateKey(card.deliveryDate) === selectedDateKey && !isWireOutOrderType(card.orderType) && isCompletedOrder(card)).length,
    [allActiveOrders, selectedDateKey],
  );
  const selectedDayDeliveryMapOrders = useMemo(() => (
    allActiveOrders.filter(card => {
      if (toDateKey(card.deliveryDate) !== selectedDateKey) return false;
      if (isWireOutOrderType(card.orderType)) return false;
      if (isPickupDeliveryMapCard(card)) return false;
      if (isCompletedOrder(card)) return false;
      if (!String(card.addressLine || '').trim()) return false;
      return true;
    })
  ), [allActiveOrders, selectedDateKey]);
  const selectedDayCompletionPercent = useMemo(() => {
    if (!selectedDayOrderTotal) return 0;
    return Math.max(0, Math.min(100, Math.round((selectedDayOrderCompleted / selectedDayOrderTotal) * 100)));
  }, [selectedDayOrderCompleted, selectedDayOrderTotal]);
  const selectedDayCompletionIsComplete = selectedDayCompletionPercent >= 100;
  const selectedDayCountLabel = useMemo(
    () => (selectedDateKey === currentLocalDateKey() ? 'Today' : formatHeaderDateShort(selectedDate)),
    [selectedDate, selectedDateKey],
  );
  const nextDaySummaryCount = includeNextDay ? visibleNextDayCount : hiddenNextDayCount;

  const pollBoard = useCallback(async () => {
    const trackActivePaneSpinner = activePaneSpinnerRequestedRef.current;
    if (trackActivePaneSpinner) {
      activePaneSpinnerInFlightRef.current += 1;
      setIsRefreshingActiveOrders(true);
    }
    try {
      setError('');
      const isInitialPoll = !hasCompletedInitialPollRef.current;
      const serviceMsgLimit = isInitialPoll ? 36 : 120;
      const unresolvedAskLimit = isInitialPoll ? 36 : 120;
      const askOrderStatusLimit = isInitialPoll ? 40 : 120;
      const intakeLookupLimit = isInitialPoll ? 90 : 260;
      const serviceMsgBatchSize = isInitialPoll ? 10 : 24;
      const unresolvedAskBatchSize = isInitialPoll ? 8 : 18;
      const askOrderStatusBatchSize = isInitialPoll ? 8 : 18;
      const intakeLookupBatchSize = isInitialPoll ? 10 : 30;
      const nowForCache = Date.now();
      for (const [key, entry] of ticketStatusTtlCacheRef.current.entries()) {
        if (entry.expiresAt <= nowForCache) ticketStatusTtlCacheRef.current.delete(key);
      }
      for (const [key, entry] of lifecycleTtlCacheRef.current.entries()) {
        if (entry.expiresAt <= nowForCache) lifecycleTtlCacheRef.current.delete(key);
      }
      for (const [key, entry] of orderDetailsTtlCacheRef.current.entries()) {
        if (entry.expiresAt <= nowForCache) orderDetailsTtlCacheRef.current.delete(key);
      }
      for (const [key, entry] of pollFeedCacheRef.current.entries()) {
        if (entry.expiresAt <= nowForCache) pollFeedCacheRef.current.delete(key);
      }
      const ticketStatusCache = new Map<string, ReturnType<typeof fetchTicketStatus>>();
      const lifecycleCache = new Map<string, ReturnType<typeof fetchLifecycleLatest>>();
      const orderDetailsCache = new Map<string, ReturnType<typeof fetchOrderDetails>>();
      const lifecycleByServiceMsgCache = new Map<string, ReturnType<typeof fetchLifecycleByServiceMsg>>();
      const messageDetailCache = new Map<string, ReturnType<typeof fetchMessageDetail>>();
      const messageListCache = new Map<string, ReturnType<typeof fetchMessageList>>();

      const getTicketStatusCached = (ticketIdRaw: string): ReturnType<typeof fetchTicketStatus> => {
        const ticketId = normalizeTicketLookupId(ticketIdRaw);
        if (!ticketId) return Promise.resolve(null);
        const cacheKey = normalizeIdLike(ticketId);
        const ttlCached = ticketStatusTtlCacheRef.current.get(cacheKey);
        if (ttlCached && ttlCached.expiresAt > Date.now()) {
          return Promise.resolve(ttlCached.value);
        }
        const existing = ticketStatusCache.get(cacheKey);
        if (existing) return existing;
        const next = fetchTicketStatus(ticketId).then(result => {
          ticketStatusTtlCacheRef.current.set(cacheKey, {
            value: result,
            expiresAt: Date.now() + MERCURY_ENRICHMENT_CACHE_TTL_MS,
          });
          return result;
        });
        ticketStatusCache.set(cacheKey, next);
        return next;
      };

      const getLifecycleByTicketCached = (ticketIdRaw: string): ReturnType<typeof fetchLifecycleLatest> => {
        const ticketId = normalizeTicketLookupId(ticketIdRaw);
        if (!ticketId) return Promise.resolve(null);
        const cacheKey = normalizeIdLike(ticketId);
        const ttlCached = lifecycleTtlCacheRef.current.get(cacheKey);
        if (ttlCached && ttlCached.expiresAt > Date.now()) {
          return Promise.resolve(ttlCached.value);
        }
        const existing = lifecycleCache.get(cacheKey);
        if (existing) return existing;
        const next = fetchLifecycleLatest(ticketId).then(result => {
          lifecycleTtlCacheRef.current.set(cacheKey, {
            value: result,
            expiresAt: Date.now() + MERCURY_ENRICHMENT_CACHE_TTL_MS,
          });
          return result;
        });
        lifecycleCache.set(cacheKey, next);
        return next;
      };

      const getOrderDetailsCached = (ticketIdRaw: string): ReturnType<typeof fetchOrderDetails> => {
        const ticketId = normalizeTicketLookupId(ticketIdRaw);
        if (!ticketId) return Promise.resolve(null);
        const cacheKey = normalizeIdLike(ticketId);
        const ttlCached = orderDetailsTtlCacheRef.current.get(cacheKey);
        if (ttlCached && ttlCached.expiresAt > Date.now()) {
          return Promise.resolve(ttlCached.value);
        }
        const existing = orderDetailsCache.get(cacheKey);
        if (existing) return existing;
        const next = fetchOrderDetails(ticketId).then(result => {
          orderDetailsTtlCacheRef.current.set(cacheKey, {
            value: result,
            expiresAt: Date.now() + MERCURY_ENRICHMENT_CACHE_TTL_MS,
          });
          return result;
        });
        orderDetailsCache.set(cacheKey, next);
        return next;
      };

      const getLifecycleByServiceMsgCached = (serviceMsgRaw: string): ReturnType<typeof fetchLifecycleByServiceMsg> => {
        const serviceMsg = String(serviceMsgRaw || '').trim();
        if (!serviceMsg) return Promise.resolve(null);
        const cacheKey = normalizeIdLike(serviceMsg);
        const existing = lifecycleByServiceMsgCache.get(cacheKey);
        if (existing) return existing;
        const next = fetchLifecycleByServiceMsg(serviceMsg);
        lifecycleByServiceMsgCache.set(cacheKey, next);
        return next;
      };

      const getMessageDetailCached = (
        msgIDRaw: string,
        params?: {
          mercID?: string;
          isCanadian?: boolean;
        },
      ): ReturnType<typeof fetchMessageDetail> => {
        const msgID = String(msgIDRaw || '').trim();
        if (!msgID) return Promise.resolve(null);
        const mercID = String(params?.mercID || '').trim();
        const isCanadian = Boolean(params?.isCanadian);
        const cacheKey = [
          normalizeIdLike(msgID),
          normalizeIdLike(mercID),
          isCanadian ? '1' : '0',
        ].join('|');
        const existing = messageDetailCache.get(cacheKey);
        if (existing) return existing;
        const next = fetchMessageDetail(msgID, { mercID, isCanadian });
        messageDetailCache.set(cacheKey, next);
        return next;
      };

      const getMessageListCached = (
        params?: Parameters<typeof fetchMessageList>[0],
      ): ReturnType<typeof fetchMessageList> => {
        const cacheKey = Object.entries(params || {})
          .map(([key, value]) => `${key}:${String(value ?? '')}`)
          .sort((a, b) => a.localeCompare(b))
          .join('|');
        const existing = messageListCache.get(cacheKey);
        if (existing) return existing;
        const next = fetchMessageList(params);
        messageListCache.set(cacheKey, next);
        return next;
      };

      async function getCrossPollCached<T>(
        key: string,
        loader: () => Promise<T>,
        ttlMs = MERCURY_FEED_CACHE_TTL_MS,
      ): Promise<T> {
        const cached = pollFeedCacheRef.current.get(key) as TimedCacheEntry<T> | undefined;
        if (cached && cached.expiresAt > Date.now()) {
          return cached.value;
        }
        const value = await loader();
        pollFeedCacheRef.current.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
        return value;
      }

      const feedStaggerMs = MERCURY_FEED_STAGGER_MS;
      const events = await getCrossPollCached('events-now', () => fetchEventsNow());
      await sleep(feedStaggerMs);
      const undelivered = await getCrossPollCached('undelivered-orders', () => fetchUndeliveredOrders().catch(() => ({
        dataset: 'DashboardEventDataset',
        tables: { OrderItems: [], MessageItems: [] },
      })));
      await sleep(feedStaggerMs);
      const ticketSearchFeeds = await mapWithStagger(
        sourceRangeWindows,
        feedStaggerMs,
        window => getCrossPollCached(
          `ticket-search:${window.deliveryDate}|${window.deliveryThruDate}`,
          () => fetchRowsWithRetry<TicketSearchRow>(
            () => fetchTicketSearch({
              fromDate: window.deliveryDate,
              toDate: window.deliveryThruDate,
              // Keep source rows stable across toggle changes.
              // The toggle should only hide/show completed cards in the UI.
              notDelivered: false,
              includeDelivered: true,
            }),
            2,
          ),
        ),
      );
      await sleep(feedStaggerMs);
      const zoneRequestPlans = sourceRangeWindows.flatMap(window => [
        { window, designedOrders: false },
        { window, designedOrders: true },
      ]);
      const zoneFeeds = await mapWithStagger(
        zoneRequestPlans,
        feedStaggerMs,
        plan => getCrossPollCached(
          `orders-by-zone:designed:${plan.designedOrders ? 'true' : 'false'}:${plan.window.deliveryDate}|${plan.window.deliveryThruDate}`,
          () => fetchRowsWithRetry<DeliveryOrderByZoneRow>(
            () => fetchOrdersByZone({ ...plan.window, designedOrders: plan.designedOrders, priorityIDList: '' }),
            2,
          ),
        ),
      );
      await sleep(feedStaggerMs);
      const routeFeeds = await mapWithStagger(
        sourceRangeWindows,
        feedStaggerMs,
        window => getCrossPollCached(
          `orders-by-routes:${window.deliveryDate}|${window.deliveryThruDate}`,
          () => fetchRowsWithRetry<DeliveryOrderByRouteRow>(
            () => fetchOrdersByRoutes(window),
            2,
          ),
        ),
      );
      await sleep(feedStaggerMs);
      const messageFeedIn = await getCrossPollCached(
        'message-list:dir:1:maxRows:220',
        () => getMessageListCached({ maxRows: 220, msgDirection: 1 }).catch(() => ({ rows: [] as MercuryMessageListRow[] })),
      );
      await sleep(feedStaggerMs);
      const messageFeedOut = await getCrossPollCached(
        'message-list:dir:2:maxRows:220',
        () => getMessageListCached({ maxRows: 220, msgDirection: 2 }).catch(() => ({ rows: [] as MercuryMessageListRow[] })),
      );
      const eventOrders = events?.tables?.OrderItems || [];
      const ticketSearchRows = ticketSearchFeeds.flatMap(rows => rows || []);
      const sortedSourceDateKeys = Array.from(sourceDeliveryDateKeys).sort();
      const maxSourceDeliveryDateKey = sortedSourceDateKeys.length
        ? sortedSourceDateKeys[sortedSourceDateKeys.length - 1]
        : '';
      const ticketSearchByTicketId = new Map<string, TicketSearchRow>();
      for (const row of ticketSearchRows) {
        const ticketId = String(row.ID || '').trim();
        if (!ticketId) continue;
        const existing = ticketSearchByTicketId.get(ticketId);
        if (!existing) {
          ticketSearchByTicketId.set(ticketId, row);
          continue;
        }
        const existingStatus = `${effectiveDeliveryStatusFromTicketSearchRow(existing)} ${String(existing.DESIGN_STATUS || '')}`.trim();
        const nextStatus = `${effectiveDeliveryStatusFromTicketSearchRow(row)} ${String(row.DESIGN_STATUS || '')}`.trim();
        const existingStage = normalizeStageForOrderCard(
          stageFromExternalStatus(existingStatus, designedIndicatorFromStatusText(String(existing.DESIGN_STATUS || ''))),
        );
        const nextStage = normalizeStageForOrderCard(
          stageFromExternalStatus(nextStatus, designedIndicatorFromStatusText(String(row.DESIGN_STATUS || ''))),
        );
        const existingRank = ACTIVE_STAGE_RANK[existingStage] || 0;
        const nextRank = ACTIVE_STAGE_RANK[nextStage] || 0;
        const existingDeliveryEpoch = deliveryDateSortEpoch(String(existing.DELIVERY_DATE || ''));
        const nextDeliveryEpoch = deliveryDateSortEpoch(String(row.DELIVERY_DATE || ''));
        if (nextRank > existingRank || (nextRank === existingRank && nextDeliveryEpoch >= existingDeliveryEpoch)) {
          ticketSearchByTicketId.set(ticketId, row);
        }
      }
      const ticketSearchOrderRef = (row: TicketSearchRow): string => String(row.USER_REFERENCE || '').trim()
        || (String(row.SALE_ID || '').trim() && String(row.TICKET_POSITION || '').trim()
          ? `${String(row.SALE_ID || '').trim()}/${String(row.TICKET_POSITION || '').trim()}`
          : String(row.SALE_ID || row.ID || '').trim());
      const futureTicketSearchRefs = new Set<string>();
      const futureTicketSearchIds = new Set<string>();
      for (const row of ticketSearchRows) {
        const deliveryDateKey = toDateKey(String(row.DELIVERY_DATE || ''));
        if (!deliveryDateKey || !maxSourceDeliveryDateKey) continue;
        if (deliveryDateKey <= maxSourceDeliveryDateKey) continue;
        const ticketId = String(row.ID || '').trim();
        const orderRef = ticketSearchOrderRef(row);
        if (ticketId) futureTicketSearchIds.add(normalizeIdLike(ticketId));
        if (orderRef) futureTicketSearchRefs.add(normalizeIdLike(orderRef));
      }
      const ticketSearchDeliveryByOrderRef = new Map<string, string>();
      const ticketSearchDeliveryByTicketId = new Map<string, string>();
      const upsertCanonicalDelivery = (map: Map<string, string>, keyRaw: string, deliveryRaw: string): void => {
        const key = normalizeIdLike(keyRaw);
        if (!key) return;
        const nextDate = String(deliveryRaw || '').trim();
        if (!toDateKey(nextDate)) return;
        const existingDate = String(map.get(key) || '').trim();
        if (!existingDate || deliveryDateSortEpoch(nextDate) >= deliveryDateSortEpoch(existingDate)) {
          map.set(key, nextDate);
        }
      };
      for (const [ticketId, row] of ticketSearchByTicketId.entries()) {
        const deliveryRaw = String(row.DELIVERY_DATE || '').trim();
        upsertCanonicalDelivery(ticketSearchDeliveryByTicketId, ticketId, deliveryRaw);
        upsertCanonicalDelivery(ticketSearchDeliveryByOrderRef, ticketSearchOrderRef(row), deliveryRaw);
      }
      const canonicalTicketSearchDelivery = (ticketIdRaw: string, userReferenceRaw: string, fallbackRaw: string): string => firstNonEmptyText(
        ticketSearchDeliveryByTicketId.get(normalizeIdLike(ticketIdRaw)) || '',
        ticketSearchDeliveryByOrderRef.get(normalizeIdLike(userReferenceRaw)) || '',
        fallbackRaw,
      );
      const ordersByTicketId = new Map<string, OrderItem>();
      for (const order of eventOrders) {
        const ticketId = String(order.ID || '').trim();
        if (!ticketId) continue;
        ordersByTicketId.set(ticketId, order);
      }
      for (const [ticketId, row] of ticketSearchByTicketId.entries()) {
        const userReference = String(row.USER_REFERENCE || '').trim()
          || (String(row.SALE_ID || '').trim() && String(row.TICKET_POSITION || '').trim()
            ? `${String(row.SALE_ID || '').trim()}/${String(row.TICKET_POSITION || '').trim()}`
            : String(row.SALE_ID || row.ID || '').trim());
        const existing = ordersByTicketId.get(ticketId);
        if (!existing) {
          ordersByTicketId.set(ticketId, {
            CATEGORY: '12',
            ID: ticketId,
            USER_REFERENCE: userReference,
            SUMMARY_TEXT: String(row.RECIPIENT_NAME || '').trim(),
            SALE_ID: String(row.SALE_ID || '').trim(),
            TICKET_POSITION: String(row.TICKET_POSITION || '1').trim(),
            ORDER_TYPE: String(row.ORDER_TYPE || 'Delivery').trim() || 'Delivery',
            RECIPIENT_NAME: String(row.RECIPIENT_NAME || '').trim(),
            RECIPIENT_ADDRESS: normalizedStreetLine(row),
            RECIPIENT_CITY: normalizedCity(row),
            RECIPIENT_STATE: '',
            RECIPIENT_STATE_ABBREV: normalizedStateAbbrev(row),
            RECIPIENT_ZIP: normalizedPostalCode(row),
            DELIVERY_DATE: String(row.DELIVERY_DATE || '').trim(),
          });
          continue;
        }

        existing.USER_REFERENCE = existing.USER_REFERENCE || userReference;
        existing.SALE_ID = existing.SALE_ID || String(row.SALE_ID || '').trim();
        existing.TICKET_POSITION = existing.TICKET_POSITION || String(row.TICKET_POSITION || '1').trim();
        existing.ORDER_TYPE = resolvePreferredOrderType(existing.ORDER_TYPE || '', String(row.ORDER_TYPE || '').trim());
        existing.RECIPIENT_NAME = existing.RECIPIENT_NAME || String(row.RECIPIENT_NAME || '').trim();
        existing.RECIPIENT_ADDRESS = existing.RECIPIENT_ADDRESS || normalizedStreetLine(row);
        existing.RECIPIENT_CITY = existing.RECIPIENT_CITY || normalizedCity(row);
        existing.RECIPIENT_STATE_ABBREV = existing.RECIPIENT_STATE_ABBREV || normalizedStateAbbrev(row);
        existing.RECIPIENT_ZIP = existing.RECIPIENT_ZIP || normalizedPostalCode(row);
        existing.DELIVERY_DATE = canonicalTicketSearchDelivery(ticketId, userReference, existing.DELIVERY_DATE || String(row.DELIVERY_DATE || '').trim());
        existing.SUMMARY_TEXT = existing.SUMMARY_TEXT || String(row.RECIPIENT_NAME || '').trim();
      }
      const orders = Array.from(ordersByTicketId.values());
      const pickupOrCodTicketIds = new Set(
        orders
          .filter(order => isPickupOrCodOrderType(String(order.ORDER_TYPE || '')))
          .map(order => String(order.ID || '').trim())
          .filter(Boolean),
      );
      const undeliveredIds = new Set(
        [
          ...(undelivered?.tables?.OrderItems || []).map(order => String(order.ID || '').trim()),
          ...ticketSearchRows.map(row => String(row.ID || '').trim()),
        ].filter(Boolean),
      );
      const zoneRowsByKey = new Map<string, DeliveryOrderByZoneRow>();
      const zoneRowsRaw = zoneFeeds.flatMap(rows => rows || []);
      for (const row of zoneRowsRaw) {
        const key = [
          normalizeIdLike(String(row.ID || '')),
          normalizeIdLike(String(row.SALE_ID || '')),
          normalizeIdLike(String(row.TICKET_POSITION || '')),
          toDateKey(String(row.DELIVERY_DATE || '')),
        ].join('|');
        const existing = zoneRowsByKey.get(key);
        if (!existing) {
          zoneRowsByKey.set(key, row);
          continue;
        }

        const existingStage = normalizeStageForOrderCard(
          stageFromExternalStatus(String(existing.STATUS || ''), String(existing.DESIGNED_IND || '')),
        );
        const nextStage = normalizeStageForOrderCard(
          stageFromExternalStatus(String(row.STATUS || ''), String(row.DESIGNED_IND || '')),
        );
        const existingRank = ACTIVE_STAGE_RANK[existingStage] || 0;
        const nextRank = ACTIVE_STAGE_RANK[nextStage] || 0;
        if (nextRank >= existingRank) {
          zoneRowsByKey.set(key, row);
        }
      }
      const zoneRows = Array.from(zoneRowsByKey.values());
      const routeRows = routeFeeds.flatMap(rows => rows || []);
      const messageRowsFromFeed = [...(messageFeedIn?.rows || []), ...(messageFeedOut?.rows || [])].map(toMessageItem);
      const messageRowsFromEvents = events?.tables?.MessageItems || [];
      const externalStageByLookupKey = new Map<string, { stage: StatusStage; reason: string }>();
      const isWithinSourceRange = (deliveryDateRaw: string): boolean => isWithinDateKeys(deliveryDateRaw, sourceDeliveryDateKeys);
      const zoneStageByTicketId = new Map<string, { stage: StatusStage; reason: string }>();
      const zoneDeliveryDateByTicketId = new Map<string, string>();
      const zoneDesignStatusByTicketId = new Map<string, string>();
      const zoneDeliveryStatusByTicketId = new Map<string, string>();

      const zoneTicketIds = Array.from(
        new Set(
          zoneRows
            .map(row => String(row.ID || '').trim())
            .filter(Boolean),
        ),
      );
      if (zoneTicketIds.length > 0) {
        const enrichmentBatchSize = 80;
        for (let offset = 0; offset < zoneTicketIds.length; offset += enrichmentBatchSize) {
          const batch = zoneTicketIds.slice(offset, offset + enrichmentBatchSize);
          const zoneEnrichmentResults = await Promise.allSettled(
            batch.map(async ticketId => {
              const [ticketStatus, lifecycle] = await Promise.all([
                getTicketStatusCached(ticketId),
                getLifecycleByTicketCached(ticketId),
              ]);

              const syntheticOrder = {
                ID: ticketId,
                CATEGORY: '12',
                ORDER_TYPE: 'Delivery',
                USER_REFERENCE: '',
                SUMMARY_TEXT: '',
                SALE_ID: '',
                TICKET_POSITION: '',
                RECIPIENT_NAME: '',
                RECIPIENT_ADDRESS: '',
                RECIPIENT_CITY: '',
                RECIPIENT_STATE: '',
                RECIPIENT_STATE_ABBREV: '',
                RECIPIENT_ZIP: '',
                DELIVERY_DATE: '',
              } as OrderItem;

              const stageInfo = deriveStage(syntheticOrder, ticketStatus, lifecycle, undeliveredIds);
              const normalizedStageInfo = {
                stage: normalizeStageForOrderCard(stageInfo.stage),
                reason: stageInfo.reason,
              };

              return {
                ticketId,
                // Use only explicit delivery date fields; lifecycle message time is not the delivery date.
                deliveryDate: firstNonEmptyText(ticketStatus?.DeliveryDate),
                stageInfo: normalizedStageInfo,
                designStatus: designStatusLabel(ticketStatus, normalizedStageInfo.stage),
                deliveryStatus: deliveryStatusLabel(ticketStatus, lifecycle, normalizedStageInfo.stage, normalizedStageInfo.reason),
              };
            }),
          );

          for (const result of zoneEnrichmentResults) {
            if (result.status !== 'fulfilled') continue;
            zoneStageByTicketId.set(result.value.ticketId, result.value.stageInfo);
            if (toDateKey(result.value.deliveryDate)) {
              zoneDeliveryDateByTicketId.set(result.value.ticketId, result.value.deliveryDate);
            }
            if (result.value.designStatus) {
              zoneDesignStatusByTicketId.set(result.value.ticketId, result.value.designStatus);
            }
            if (result.value.deliveryStatus) {
              zoneDeliveryStatusByTicketId.set(result.value.ticketId, result.value.deliveryStatus);
            }
          }
        }
      }

      const indexExternalStage = (keys: string[], stage: StatusStage, reason: string): void => {
        const next = { stage, reason };
        for (const key of keys) {
          if (!key) continue;
          const existing = externalStageByLookupKey.get(key);
          if (!existing || shouldUseExternalStage(existing, next)) {
            externalStageByLookupKey.set(key, next);
          }
        }
      };

      for (const row of zoneRows) {
        const stage = normalizeStageForOrderCard(
          stageFromExternalStatus(String(row.STATUS || ''), String(row.DESIGNED_IND || '')),
        );
        const reason = row.ZONE_NAME ? `Zone ${String(row.ZONE_NAME)}` : `Zone feed ${String(row.STATUS || 'ACTIVE')}`;
        const keys = stageLookupKeys(
          String(row.ID || ''),
          String(row.SALE_ID || ''),
          String(row.SALE_ID || ''),
          String(row.TICKET_POSITION || ''),
        );
        indexExternalStage(keys, stage, reason);
      }
      for (const row of routeRows) {
        const stage = normalizeStageForOrderCard(stageFromExternalStatus(String(row.STATUS || ''), ''));
        const reason = row.ROUTE_NAME ? `Route ${String(row.ROUTE_NAME)}` : `Route feed ${String(row.STATUS || 'ACTIVE')}`;
        const keys = stageLookupKeys(
          String(row.ID || ''),
          String(row.SALE_ID || ''),
          String(row.SALE_ID || ''),
          String(row.TICKET_POSITION || ''),
        );
        indexExternalStage(keys, stage, reason);
      }
      for (const row of ticketSearchRows) {
        const deliveryStatus = effectiveDeliveryStatusFromTicketSearchRow(row);
        const designStatus = String(row.DESIGN_STATUS || '').trim();
        const designedIndicator = designedIndicatorFromStatusText(designStatus);
        const stage = normalizeStageForOrderCard(
          stageFromExternalStatus(`${deliveryStatus} ${designStatus}`.trim(), designedIndicator),
        );
        const reason = deliveryStatus
          ? `TicketSearch ${deliveryStatus}`
          : (designStatus ? `TicketSearch ${designStatus}` : 'TicketSearch active');
        const keys = stageLookupKeys(
          String(row.ID || ''),
          String(row.SALE_ID || ''),
          String(row.USER_REFERENCE || ''),
          String(row.TICKET_POSITION || ''),
        );
        indexExternalStage(keys, stage, reason);
      }

      const enrichments = await allSettledInBatches(
        orders,
        40,
        async order => {
          const lookupCandidates = orderEnrichmentLookupCandidates(order);
          let ticketStatus: TicketStatusRow | null = null;
          let lifecycle: LifecycleRow | null = null;

          for (const lookupId of lookupCandidates) {
            const [ticketStatusCandidate, lifecycleCandidate] = await Promise.all([
              getTicketStatusCached(lookupId),
              getLifecycleByTicketCached(lookupId),
            ]);

            if (!ticketStatus && ticketStatusCandidate) {
              ticketStatus = ticketStatusCandidate;
            }
            if (!lifecycle && lifecycleCandidate) {
              lifecycle = lifecycleCandidate;
            }

            const hasStatusSignal = hasUsefulTicketStatus(ticketStatusCandidate);
            if ((lifecycleCandidate && hasStatusSignal) || (lifecycle && ticketStatus) || hasStatusSignal) {
              break;
            }
          }

          return { ticketId: order.ID, ticketStatus, lifecycle };
        },
      );

      const byTicket = new Map<string, OrderEnrichment>(
        enrichments
          .filter((result): result is PromiseFulfilledResult<OrderEnrichment> => result.status === 'fulfilled')
          .map(result => [result.value.ticketId, result.value]),
      );
      const statusLabelByTicketId = new Map<string, string>();

      const nextGroups = emptyGroups();
      for (const order of orders) {
        const enriched = byTicket.get(order.ID);
        const stageInfo = deriveStage(order, enriched?.ticketStatus ?? null, enriched?.lifecycle ?? null, undeliveredIds);
        let resolvedStageInfo = stageInfo;
        for (const key of stageLookupKeys(
          String(order.ID || ''),
          String(order.SALE_ID || ''),
          String(order.USER_REFERENCE || ''),
          String(order.TICKET_POSITION || ''),
        )) {
          const hint = externalStageByLookupKey.get(key);
          if (!hint) continue;
          if (shouldUseExternalStage(resolvedStageInfo, hint)) {
            resolvedStageInfo = hint;
          }
        }
        const normalizedStageInfo = {
          stage: normalizeStageForOrderCard(resolvedStageInfo.stage),
          reason: resolvedStageInfo.reason,
        };
        const isMarketplace = hasMarketplaceKeyword(
          String(order.RECIPIENT_NAME || ''),
          String(order.SUMMARY_TEXT || ''),
          String(order.USER_REFERENCE || ''),
          String(order.DELIVERY_INST || ''),
          String(order.SPECIAL_INST || ''),
        );

        const card: BoardCard = {
          ticketId: order.ID,
          userReference: String(order.USER_REFERENCE || ''),
          recipientName: String(order.RECIPIENT_NAME || order.SUMMARY_TEXT || ''),
          addressLine: normalizedStreetLine(order),
          deliveryZip: normalizedPostalCode(order),
          cityStateZip: formatCityStateZip(
            normalizedCity(order),
            normalizedStateAbbrev(order),
            normalizedPostalCode(order),
          ),
          deliveryDate: String(order.DELIVERY_DATE || ''),
          orderType: String(order.ORDER_TYPE || ''),
          stage: normalizedStageInfo.stage,
          stageReason: normalizedStageInfo.reason,
          designStatus: designStatusLabel(enriched?.ticketStatus ?? null, normalizedStageInfo.stage),
          deliveryStatus: deliveryStatusLabel(
            enriched?.ticketStatus ?? null,
            enriched?.lifecycle ?? null,
            normalizedStageInfo.stage,
            normalizedStageInfo.reason,
          ),
          isMarketplace,
        };
        statusLabelByTicketId.set(String(order.ID || '').trim(), friendlyStatusLabel(normalizedStageInfo.stage, normalizedStageInfo.reason));
        if (isWithinSourceRange(card.deliveryDate)) {
          nextGroups[normalizedStageInfo.stage].push(card);
        }
      }

      for (const stage of STAGE_ORDER) {
        nextGroups[stage].sort(orderSortAsc);
      }

      const activeByTicket = new Map<string, BoardCard>();
      const visibleStages = STAGE_ORDER;
      for (const stage of visibleStages) {
        for (const card of nextGroups[stage]) {
          mergeActiveOrderCard(activeByTicket, card, true);
        }
      }

      for (const row of zoneRows) {
        const ticketId = String(row.ID || '').trim();
        if (!ticketId) continue;
        if (pickupOrCodTicketIds.has(ticketId)) continue;
        const userReference = String(row.USER_REFERENCE || '').trim()
          || (String(row.SALE_ID || '').trim() && String(row.TICKET_POSITION || '').trim()
            ? `${String(row.SALE_ID || '').trim()}/${String(row.TICKET_POSITION || '').trim()}`
            : String(row.SALE_ID || '').trim());
        const resolvedZoneDeliveryDate = firstNonEmptyText(
          canonicalTicketSearchDelivery(ticketId, userReference, ''),
          String(row.DELIVERY_DATE || ''),
          String(zoneDeliveryDateByTicketId.get(ticketId) || ''),
        );
        if (!isWithinSourceRange(resolvedZoneDeliveryDate)) continue;
        let stage = stageFromExternalStatus(String(row.STATUS || ''), String(row.DESIGNED_IND || ''));
        let stageReason = row.ZONE_NAME ? `Zone ${String(row.ZONE_NAME)}` : `Zone feed ${String(row.STATUS || 'ACTIVE')}`;
        const stageHint = zoneStageByTicketId.get(ticketId);
        if (stageHint && shouldUseExternalStage({ stage, reason: stageReason }, stageHint)) {
          stage = stageHint.stage;
          stageReason = stageHint.reason || stageReason;
        }
        const normalizedStage = normalizeStageForOrderCard(stage);
        const candidate: BoardCard = {
          ticketId,
          userReference,
          recipientName: String(row.RECIPIENT_NAME || '').trim(),
          addressLine: normalizedStreetLine(row),
          deliveryZip: normalizedPostalCode(row),
          cityStateZip: formatCityStateZip(
            normalizedCity(row),
            normalizedStateAbbrev(row),
            normalizedPostalCode(row),
          ),
          deliveryDate: resolvedZoneDeliveryDate,
          orderType: 'Delivery',
          stage: normalizedStage,
          stageReason,
          designStatus: zoneDesignStatusByTicketId.get(ticketId) || designStatusLabel(null, normalizedStage, String(row.STATUS || '')),
          deliveryStatus: zoneDeliveryStatusByTicketId.get(ticketId)
            || deliveryStatusLabel(null, null, normalizedStage, stageReason, String(row.ROUTE_NAME || ''), String(row.STATUS || '')),
          isMarketplace: hasMarketplaceKeyword(String(row.RECIPIENT_NAME || ''), userReference),
        };
        statusLabelByTicketId.set(ticketId, friendlyStatusLabel(normalizedStage, candidate.stageReason));
        mergeActiveOrderCard(activeByTicket, candidate, true);
      }

      for (const row of routeRows) {
        const ticketId = String(row.ID || '').trim();
        if (!ticketId) continue;
        if (pickupOrCodTicketIds.has(ticketId)) continue;
        const userReference = String(row.SALE_ID || '').trim() && String(row.TICKET_POSITION || '').trim()
          ? `${String(row.SALE_ID || '').trim()}/${String(row.TICKET_POSITION || '').trim()}`
          : String(row.SALE_ID || row.ID || '').trim();
        const resolvedRouteDeliveryDate = firstNonEmptyText(
          canonicalTicketSearchDelivery(ticketId, userReference, ''),
          String(row.DELIVERY_DATE || ''),
        );
        if (!isWithinSourceRange(resolvedRouteDeliveryDate)) continue;
        const stage = normalizeStageForOrderCard(stageFromExternalStatus(String(row.STATUS || ''), ''));
        const candidate: BoardCard = {
          ticketId,
          userReference,
          recipientName: String(row.RECIPIENT_NAME || '').trim(),
          addressLine: normalizedStreetLine(row),
          deliveryZip: normalizedPostalCode(row),
          cityStateZip: formatCityStateZip(
            normalizedCity(row),
            normalizedStateAbbrev(row),
            normalizedPostalCode(row),
          ),
          deliveryDate: resolvedRouteDeliveryDate,
          orderType: 'Route',
          stage,
          stageReason: row.ROUTE_NAME ? `Route ${String(row.ROUTE_NAME)}` : `Route feed ${String(row.STATUS || 'ACTIVE')}`,
          designStatus: designStatusLabel(null, stage, String(row.STATUS || '')),
          deliveryStatus: deliveryStatusLabel(
            null,
            null,
            stage,
            row.ROUTE_NAME ? `Route ${String(row.ROUTE_NAME)}` : `Route feed ${String(row.STATUS || 'ACTIVE')}`,
            String(row.ROUTE_NAME || ''),
            String(row.STATUS || ''),
          ),
          isMarketplace: hasMarketplaceKeyword(String(row.RECIPIENT_NAME || ''), userReference),
        };
        statusLabelByTicketId.set(ticketId, friendlyStatusLabel(stage, candidate.stageReason));
        mergeActiveOrderCard(activeByTicket, candidate, true);
      }
      for (const row of ticketSearchRows) {
        const ticketId = String(row.ID || '').trim();
        if (!ticketId) continue;
        if (pickupOrCodTicketIds.has(ticketId)) continue;
        const deliveryDate = String(row.DELIVERY_DATE || '').trim();
        if (!isWithinSourceRange(deliveryDate)) continue;

        const designStatus = String(row.DESIGN_STATUS || '').trim();
        const deliveryStatus = effectiveDeliveryStatusFromTicketSearchRow(row);
        const statusContext = `${deliveryStatus} ${designStatus}`.trim();
        const userReference = String(row.USER_REFERENCE || '').trim()
          || (String(row.SALE_ID || '').trim() && String(row.TICKET_POSITION || '').trim()
            ? `${String(row.SALE_ID || '').trim()}/${String(row.TICKET_POSITION || '').trim()}`
            : String(row.SALE_ID || row.ID || '').trim());
        let stage = normalizeStageForOrderCard(
          stageFromExternalStatus(statusContext, designedIndicatorFromStatusText(designStatus)),
        );
        let stageReason = deliveryStatus
          ? `TicketSearch ${deliveryStatus}`
          : (designStatus ? `TicketSearch ${designStatus}` : 'TicketSearch active');
        for (const key of stageLookupKeys(
          ticketId,
          String(row.SALE_ID || ''),
          userReference,
          String(row.TICKET_POSITION || ''),
        )) {
          const hint = externalStageByLookupKey.get(key);
          if (!hint) continue;
          if (shouldUseExternalStage({ stage, reason: stageReason }, hint)) {
            stage = normalizeStageForOrderCard(hint.stage);
            stageReason = hint.reason || stageReason;
          }
        }

        const candidate: BoardCard = {
          ticketId,
          userReference,
          recipientName: String(row.RECIPIENT_NAME || '').trim(),
          addressLine: normalizedStreetLine(row),
          deliveryZip: normalizedPostalCode(row),
          cityStateZip: formatCityStateZip(
            normalizedCity(row),
            normalizedStateAbbrev(row),
            normalizedPostalCode(row),
          ),
          deliveryDate,
          orderType: String(row.ORDER_TYPE || 'Delivery').trim() || 'Delivery',
          stage,
          stageReason,
          designStatus: designStatus || designStatusLabel(null, stage, statusContext),
          deliveryStatus: deliveryStatus || deliveryStatusLabel(null, null, stage, stageReason, '', statusContext),
          isMarketplace: hasMarketplaceKeyword(String(row.RECIPIENT_NAME || ''), userReference),
        };
        statusLabelByTicketId.set(ticketId, friendlyStatusLabel(stage, stageReason));
        mergeActiveOrderCard(activeByTicket, candidate, true);
      }

      const cardsMissingZip = Array.from(activeByTicket.values())
        .map(card => String(card.ticketId || '').trim())
        .filter(ticketId => {
          if (!ticketId) return false;
          const card = activeByTicket.get(ticketId);
          return !!card && !String(card.deliveryZip || '').trim();
        });
      const ticketIdsNeedingZipLookup = Array.from(new Set(
        cardsMissingZip.filter(ticketId => !orderDetailZipByTicketRef.current.has(ticketId)),
      ));

      if (ticketIdsNeedingZipLookup.length > 0) {
        const zipLookupResults = await allSettledInBatches(
          ticketIdsNeedingZipLookup,
          26,
          async ticketId => {
            const details = await getOrderDetailsCached(ticketId);
            const zip = details ? normalizedPostalCode(details) : '';
            return { ticketId, zip };
          },
        );
        for (const lookup of zipLookupResults) {
          if (lookup.status !== 'fulfilled') continue;
          const ticketId = String(lookup.value.ticketId || '').trim();
          if (!ticketId) continue;
          const zip = String(lookup.value.zip || '').trim();
          if (zip) {
            orderDetailZipByTicketRef.current.set(ticketId, zip);
          }
        }
      }

      for (const ticketId of cardsMissingZip) {
        const cachedZip = String(orderDetailZipByTicketRef.current.get(ticketId) || '').trim();
        if (!cachedZip) continue;
        const existing = activeByTicket.get(ticketId);
        if (!existing || String(existing.deliveryZip || '').trim()) continue;
        activeByTicket.set(ticketId, {
          ...existing,
          deliveryZip: cachedZip,
        });
      }

      const referenceById = new Map<string, OrderReferenceEntry>();
      const mergeOrderReference = (current: OrderReferenceEntry, incoming: OrderReferenceEntry): OrderReferenceEntry => {
        const merged: OrderReferenceEntry = { ...current };

        if (incoming.RECIPIENT_NAME) merged.RECIPIENT_NAME = incoming.RECIPIENT_NAME;
        if (incoming.SUMMARY_TEXT) merged.SUMMARY_TEXT = incoming.SUMMARY_TEXT;
        if (incoming.DELIVERY_DATE) merged.DELIVERY_DATE = incoming.DELIVERY_DATE;
        if (incoming.DELIVERY_CITY_STATE_ZIP) merged.DELIVERY_CITY_STATE_ZIP = incoming.DELIVERY_CITY_STATE_ZIP;
        if (incoming.DELIVERY_ZIP) merged.DELIVERY_ZIP = incoming.DELIVERY_ZIP;
        if (incoming.ORDER_AMOUNT) merged.ORDER_AMOUNT = incoming.ORDER_AMOUNT;

        const currentOrderId = extractOrderIdForDisplay(current.SALE_ID, current.USER_REFERENCE, current.ID);
        const incomingOrderId = extractOrderIdForDisplay(incoming.SALE_ID, incoming.USER_REFERENCE, incoming.ID);

        if (incoming.SALE_ID && (!current.SALE_ID || current.SALE_ID === current.ID || currentOrderId !== incomingOrderId)) {
          merged.SALE_ID = incoming.SALE_ID;
        }

        const currentHasPositionRef = String(current.USER_REFERENCE || '').includes('/');
        const incomingHasPositionRef = String(incoming.USER_REFERENCE || '').includes('/');
        if (incoming.USER_REFERENCE && (!current.USER_REFERENCE || (!currentHasPositionRef && incomingHasPositionRef))) {
          merged.USER_REFERENCE = incoming.USER_REFERENCE;
        }

        if (incoming.STAGE_LABEL) merged.STAGE_LABEL = incoming.STAGE_LABEL;
        return merged;
      };
      const addOrderReference = (entry: OrderReferenceEntry): void => {
        const key = String(entry.ID || '').trim()
          || `${normalizeText(entry.RECIPIENT_NAME)}|${toDateKey(entry.DELIVERY_DATE)}|${String(entry.USER_REFERENCE || entry.SALE_ID || '').trim()}`;
        const existing = referenceById.get(key);
        if (!existing) {
          referenceById.set(key, entry);
          return;
        }
        referenceById.set(key, mergeOrderReference(existing, entry));
      };
      for (const order of orders) {
        const orderZip = normalizedPostalCode(order);
        addOrderReference({
          ID: String(order.ID || ''),
          RECIPIENT_NAME: String(order.RECIPIENT_NAME || ''),
          SUMMARY_TEXT: String(order.SUMMARY_TEXT || ''),
          DELIVERY_DATE: String(order.DELIVERY_DATE || ''),
          DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
            normalizedCity(order),
            normalizedStateAbbrev(order),
            orderZip,
          ),
          DELIVERY_ZIP: orderZip,
          ORDER_AMOUNT: normalizedOrderAmount(order),
          USER_REFERENCE: String(order.USER_REFERENCE || ''),
          SALE_ID: String(order.SALE_ID || ''),
          STAGE_LABEL: statusLabelByTicketId.get(String(order.ID || '').trim()) || '',
        });
      }
      for (const row of zoneRows) {
        const rowZip = normalizedPostalCode(row);
        addOrderReference({
          ID: String(row.ID || ''),
          RECIPIENT_NAME: String(row.RECIPIENT_NAME || ''),
          SUMMARY_TEXT: String(row.RECIPIENT_NAME || ''),
          DELIVERY_DATE: String(row.DELIVERY_DATE || ''),
          DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
            normalizedCity(row),
            normalizedStateAbbrev(row),
            rowZip,
          ),
          DELIVERY_ZIP: rowZip,
          ORDER_AMOUNT: '',
          USER_REFERENCE: String(row.SALE_ID || ''),
          SALE_ID: String(row.SALE_ID || ''),
          STAGE_LABEL: statusLabelByTicketId.get(String(row.ID || '').trim()) || '',
        });
      }
      for (const row of routeRows) {
        const rowZip = normalizedPostalCode(row);
        addOrderReference({
          ID: String(row.ID || ''),
          RECIPIENT_NAME: String(row.RECIPIENT_NAME || ''),
          SUMMARY_TEXT: String(row.RECIPIENT_NAME || ''),
          DELIVERY_DATE: String(row.DELIVERY_DATE || ''),
          DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
            normalizedCity(row),
            normalizedStateAbbrev(row),
            rowZip,
          ),
          DELIVERY_ZIP: rowZip,
          ORDER_AMOUNT: '',
          USER_REFERENCE: String(row.SALE_ID || ''),
          SALE_ID: String(row.SALE_ID || ''),
          STAGE_LABEL: statusLabelByTicketId.get(String(row.ID || '').trim()) || '',
        });
      }
      for (const row of ticketSearchRows) {
        const rowZip = normalizedPostalCode(row);
        addOrderReference({
          ID: String(row.ID || ''),
          RECIPIENT_NAME: String(row.RECIPIENT_NAME || ''),
          SUMMARY_TEXT: String(row.RECIPIENT_NAME || ''),
          DELIVERY_DATE: String(row.DELIVERY_DATE || ''),
          DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
            normalizedCity(row),
            normalizedStateAbbrev(row),
            rowZip,
          ),
          DELIVERY_ZIP: rowZip,
          ORDER_AMOUNT: normalizedOrderAmount(row),
          USER_REFERENCE: String(row.USER_REFERENCE || row.SALE_ID || ''),
          SALE_ID: String(row.SALE_ID || ''),
          STAGE_LABEL: statusLabelByTicketId.get(String(row.ID || '').trim()) || '',
        });
      }

      const messageByKey = new Map<string, MessageItem>();
      const eventMessageKeys = new Set<string>();
      for (const message of messageRowsFromEvents) {
        const key = messageMergeKey(message);
        eventMessageKeys.add(key);
        const existing = messageByKey.get(key);
        messageByKey.set(key, existing ? mergeMessageFields(existing, message) : message);
      }
      for (const message of messageRowsFromFeed) {
        const key = messageMergeKey(message);
        const existing = messageByKey.get(key);
        messageByKey.set(key, existing ? mergeMessageFields(existing, message) : message);
      }
      const mergedMessageRows = Array.from(messageByKey.values());
      const displayMessageRows = Array.from(eventMessageKeys)
        .map(key => messageByKey.get(key))
        .filter((message): message is MessageItem => Boolean(message))
        .filter(message => isInboundIntakeMessage(message));
      const hasMessageThreadCoverage = messageRowsFromFeed.length > 0;
      const inboundIntakeMessages = displayMessageRows.filter(message => isInboundIntakeMessage(message));

      const askMessages = inboundIntakeMessages.filter(message => isAskMessage(message));
      const askStatusByOrderNumber = new Map<string, string>();
      const askDetailTargetsById = new Map<string, MessageItem>();
      for (const message of askMessages) {
        if (inferOrderIdFromMessage(message)) continue;
        const messageId = String(message.ID || '').trim();
        if (!messageId) continue;
        askDetailTargetsById.set(messageId, message);
      }
      const askDetailTargets = Array.from(askDetailTargetsById.values()).slice(0, 120);

      if (askDetailTargets.length > 0) {
        const askDetailResults = await allSettledInBatches(
          askDetailTargets,
          24,
          async message => {
            const messageId = String(message.ID || '').trim();
            if (!messageId) return null;
            const detail = await getMessageDetailCached(messageId, {
              mercID: String(message.MERCURY_NUM || '').trim(),
              isCanadian: false,
            });
            if (!detail) return null;

            const detailRow = detail as unknown as Record<string, unknown>;
            const ticketId = firstNonEmptyText(
              detailRow.TICKET_ID as string | undefined,
              detailRow.TICKETID as string | undefined,
              detailRow.TICKET_NUM as string | undefined,
              detailRow.ITEM_ID as string | undefined,
            );
            const saleId = firstNonEmptyText(
              detailRow.SALE_ID as string | undefined,
              detailRow.SALEID as string | undefined,
            );
            const userReference = firstNonEmptyText(
              detailRow.USER_REFERENCE as string | undefined,
              detailRow.USERREFERENCE as string | undefined,
              detailRow.USER_REF as string | undefined,
            );
            const inferredOrderId = extractOrderIdForDisplay(saleId, userReference, ticketId);
            const msgDateFromDetail = firstNonEmptyText(
              detailRow.MSG_DATETIME as string | undefined,
              detailRow.MSG_DATE_TIME as string | undefined,
              detailRow.MSG_DATE as string | undefined,
            );
            const deliveryFromDetail = firstNonEmptyText(
              detailRow.REQ_DELIVERY_DATE as string | undefined,
              detailRow.DELIVERY_DATE as string | undefined,
            );
            const mercNum = firstNonEmptyText(
              detailRow.MERC_ID as string | undefined,
              detailRow.MERCURY_NUM as string | undefined,
            );
            const recipientFromDetail = firstNonEmptyText(
              detailRow.RECIPIENT_NAME as string | undefined,
            );

            return {
              message,
              ticketId,
              saleId,
              userReference,
              inferredOrderId,
              msgDateFromDetail,
              deliveryFromDetail,
              mercNum,
              recipientFromDetail,
            };
          },
        );

        for (const result of askDetailResults) {
          if (result.status !== 'fulfilled' || !result.value) continue;
          const {
            message,
            ticketId,
            saleId,
            userReference,
            inferredOrderId,
            msgDateFromDetail,
            deliveryFromDetail,
            mercNum,
            recipientFromDetail,
          } = result.value;
          if (ticketId && !String(message.TICKET_NUM || '').trim()) {
            message.TICKET_NUM = ticketId;
          }
          if (saleId && !String(message.SALE_ID || '').trim()) {
            message.SALE_ID = saleId;
          }
          if (userReference && !String(message.USER_REFERENCE || '').trim()) {
            message.USER_REFERENCE = userReference;
          }
          if (inferredOrderId && !String(message.ORDER_ID || '').trim()) {
            message.ORDER_ID = inferredOrderId;
          }
          if (msgDateFromDetail && !String(message.MSG_DATE || '').trim()) {
            message.MSG_DATE = msgDateFromDetail;
          }
          if (deliveryFromDetail && !String(message.DELIVERY_DATE || '').trim()) {
            message.DELIVERY_DATE = deliveryFromDetail;
          }
          if (mercNum && !String(message.MERCURY_NUM || '').trim()) {
            message.MERCURY_NUM = mercNum;
          }
          if (recipientFromDetail && !String(message.RECIPIENT_NAME || '').trim()) {
            message.RECIPIENT_NAME = recipientFromDetail;
          }
        }
      }

      const serviceMsgCandidates = Array.from(
        new Set(
          askMessages
            .map(message => String(message.MERCURY_NUM || '').trim())
            .filter(Boolean),
        ),
      ).slice(0, serviceMsgLimit);

      if (serviceMsgCandidates.length > 0) {
        const serviceMsgResults = await allSettledInBatches(
          serviceMsgCandidates,
          serviceMsgBatchSize,
          async serviceMsg => {
            const lifecycleByServiceMsg = await getLifecycleByServiceMsgCached(serviceMsg);
            const ticketId = String(lifecycleByServiceMsg?.TICKET_ID || '').trim();
            if (!ticketId) return null;

            const [details, ticketStatus, lifecycleLatest] = await Promise.all([
              getOrderDetailsCached(ticketId),
              getTicketStatusCached(ticketId),
              getLifecycleByTicketCached(ticketId),
            ]);

            const statusRaw = String(lifecycleLatest?.STATUS_CD || ticketStatus?.DeliveryStatus || '');
            const statusDesc = String(lifecycleLatest?.STATUS_CD_DESC || lifecycleLatest?.STATUS_TEXT || ticketStatus?.DesignerStatus || '');
            const statusContext = `${statusRaw} ${statusDesc}`.trim();
            const lookupStage = normalizeStageForOrderCard(
              stageFromExternalStatus(statusContext, designedIndicatorFromStatusText(statusDesc)),
            );
            const stageLabel = friendlyStatusLabel(lookupStage, statusContext);

            const saleId = String(details?.SALE_ID || '').trim();
            const userReference = String(details?.USER_REFERENCE || '').trim();
            const orderId = extractOrderIdForDisplay(saleId, userReference, ticketId);
            const detailZip = normalizedPostalCode(details);

            return {
              serviceMsg,
              ticketId,
              orderId,
              entry: {
                ID: String(details?.ID || ticketId || '').trim(),
                RECIPIENT_NAME: String(details?.RECIPIENT_NAME || '').trim(),
                SUMMARY_TEXT: String(details?.SUMMARY_TEXT || details?.RECIPIENT_NAME || '').trim(),
                DELIVERY_DATE: String(details?.DELIVERY_DATE || '').trim(),
                DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
                  normalizedCity(details),
                  normalizedStateAbbrev(details),
                  detailZip,
                ),
                DELIVERY_ZIP: detailZip,
                ORDER_AMOUNT: normalizedOrderAmount(details),
                USER_REFERENCE: userReference,
                SALE_ID: saleId || orderId,
                STAGE_LABEL: stageLabel,
              },
            };
          },
        );

        const orderIdByServiceMsg = new Map<string, string>();
        const ticketIdByServiceMsg = new Map<string, string>();

        for (const result of serviceMsgResults) {
          if (result.status !== 'fulfilled' || !result.value) continue;
          addOrderReference(result.value.entry);
          if (result.value.orderId) orderIdByServiceMsg.set(result.value.serviceMsg, result.value.orderId);
          if (result.value.ticketId) ticketIdByServiceMsg.set(result.value.serviceMsg, result.value.ticketId);
        }

        for (const message of askMessages) {
          const serviceMsg = String(message.MERCURY_NUM || '').trim();
          if (!serviceMsg) continue;
          const mappedOrderId = orderIdByServiceMsg.get(serviceMsg) || '';
          const mappedTicketId = ticketIdByServiceMsg.get(serviceMsg) || '';
          if (mappedOrderId && !String(message.ORDER_ID || '').trim()) {
            message.ORDER_ID = mappedOrderId;
          }
          if (mappedTicketId && !String(message.TICKET_NUM || '').trim()) {
            message.TICKET_NUM = mappedTicketId;
          }
        }
      }

      const unresolvedAskBuckets = new Map<string, { recipientName: string; delivDate: string; targets: MessageItem[] }>();
      for (const message of askMessages) {
        if (inferOrderIdFromMessage(message)) continue;
        const recipientName = String(message.RECIPIENT_NAME || message.SUMMARY_TEXT || '').trim();
        const delivDate = toDateKey(String(message.DELIVERY_DATE || message.MSG_DATE || ''));
        if (!recipientName || !delivDate) continue;
        const key = `${normalizeText(recipientName)}|${delivDate}`;
        const existing = unresolvedAskBuckets.get(key);
        if (existing) {
          existing.targets.push(message);
        } else {
          unresolvedAskBuckets.set(key, { recipientName, delivDate, targets: [message] });
        }
      }

      const unresolvedAskQueries = Array.from(unresolvedAskBuckets.values()).slice(0, 120);
      const unresolvedAskQueriesLimited = unresolvedAskQueries.slice(0, unresolvedAskLimit);
      if (unresolvedAskQueriesLimited.length > 0) {
        const unresolvedAskResults = await allSettledInBatches(
          unresolvedAskQueriesLimited,
          unresolvedAskBatchSize,
          async query => {
            const lookup = await getMessageListCached({
              maxRows: 220,
              msgDirection: 0,
              recipientName: query.recipientName,
              delivDate: query.delivDate,
            });
            return { query, rows: lookup?.rows || [] };
          },
        );

        for (const result of unresolvedAskResults) {
          if (result.status !== 'fulfilled') continue;
          const { query, rows } = result.value;
          const queryRecipientNorm = normalizeText(query.recipientName);
          const queryRecipientTokens = tokenizeRecipient(query.recipientName);
          const ranked = new Map<string, { orderId: string; ticketNum: string; score: number }>();

          for (const row of rows) {
            const candidateMessage = toMessageItem(row);
            const candidateOrderId = inferOrderIdFromMessage(candidateMessage);
            const candidateTicketNum = String(candidateMessage.TICKET_NUM || '').trim();
            if (!candidateOrderId && !candidateTicketNum) continue;

            const candidateRecipientRaw = String(candidateMessage.RECIPIENT_NAME || candidateMessage.SUMMARY_TEXT || '').trim();
            const candidateRecipientNorm = normalizeText(candidateRecipientRaw);
            const candidateRecipientTokens = tokenizeRecipient(candidateRecipientRaw);
            const recipientScore = recipientSimilarityScore(
              queryRecipientNorm,
              queryRecipientTokens,
              candidateRecipientNorm,
              candidateRecipientTokens,
            );

            const candidateDateKey = toDateKey(String(candidateMessage.DELIVERY_DATE || candidateMessage.MSG_DATE || ''));
            let dateScore = 0;
            if (candidateDateKey && query.delivDate) {
              if (candidateDateKey === query.delivDate) {
                dateScore = 34;
              } else {
                const deltaDays = Math.abs(
                  toEpoch(`${candidateDateKey}T00:00:00`) - toEpoch(`${query.delivDate}T00:00:00`),
                ) / (24 * 60 * 60 * 1000);
                if (deltaDays <= 1) {
                  dateScore = 22;
                } else if (deltaDays <= 3) {
                  dateScore = 12;
                } else {
                  dateScore = -6;
                }
              }
            }

            const idCoverageScore = (candidateOrderId ? 40 : 0) + (candidateTicketNum ? 28 : 0) + (candidateOrderId && candidateTicketNum ? 14 : 0);
            const score = recipientScore + dateScore + idCoverageScore;
            const key = `${candidateOrderId}|${candidateTicketNum}`;
            const existing = ranked.get(key);
            if (!existing || score > existing.score) {
              ranked.set(key, { orderId: candidateOrderId, ticketNum: candidateTicketNum, score });
            }
          }

          const best = Array.from(ranked.values()).sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.orderId !== b.orderId) return a.orderId.localeCompare(b.orderId);
            return a.ticketNum.localeCompare(b.ticketNum);
          })[0];
          if (!best?.orderId && !best?.ticketNum) continue;

          for (const target of query.targets) {
            if (best.orderId && !String(target.ORDER_ID || '').trim()) {
              target.ORDER_ID = best.orderId;
            }
            if (best.ticketNum && !String(target.TICKET_NUM || '').trim()) {
              target.TICKET_NUM = best.ticketNum;
            }
          }
        }
      }

      const askOrderNumbers = Array.from(
        new Set(
          askMessages
            .map(message => String(inferOrderIdFromMessage(message) || '').trim().split('/')[0] || '')
            .filter(value => /^\d{5,12}$/.test(value)),
        ),
      ).slice(0, askOrderStatusLimit);

      if (askOrderNumbers.length > 0) {
        const askOrderStatusResults = await allSettledInBatches(
          askOrderNumbers,
          askOrderStatusBatchSize,
          async orderNumber => {
            const lookup = await fetchTicketSearch({
              notDelivered: false,
              includeDelivered: true,
              orderNumber,
            });
            const rows = lookup?.rows || [];
            if (!rows.length) return null;

            const normalizedOrder = normalizeIdLike(orderNumber);
            const matchingRows = rows.filter(row => {
              const saleId = normalizeIdLike(String(row.SALE_ID || ''));
              const userReference = normalizeIdLike(String(row.USER_REFERENCE || ''));
              const displayOrderHead = normalizeIdLike(
                extractOrderIdForDisplay(
                  String(row.SALE_ID || ''),
                  String(row.USER_REFERENCE || ''),
                  String(row.ID || ''),
                ),
              );
              return (
                saleId === normalizedOrder
                || displayOrderHead === normalizedOrder
                || userReference === normalizedOrder
                || userReference.startsWith(`${normalizedOrder}/`)
              );
            });

            const pool = matchingRows.length ? matchingRows : rows;
            const scored = pool
              .map(row => {
                const deliveryStatus = effectiveDeliveryStatusFromTicketSearchRow(row);
                const designStatus = String(row.DESIGN_STATUS || '').trim();
                const stage = normalizeStageForOrderCard(
                  stageFromExternalStatus(
                    `${deliveryStatus} ${designStatus}`.trim(),
                    designedIndicatorFromStatusText(designStatus),
                  ),
                );
                return {
                  row,
                  stage,
                  stageRank: ACTIVE_STAGE_RANK[stage] || 0,
                  deliveryEpoch: deliveryDateSortEpoch(String(row.DELIVERY_DATE || '')),
                  statusContext: `${deliveryStatus} ${designStatus}`.trim(),
                };
              })
              .sort((a, b) => {
                if (b.stageRank !== a.stageRank) return b.stageRank - a.stageRank;
                if (b.deliveryEpoch !== a.deliveryEpoch) return b.deliveryEpoch - a.deliveryEpoch;
                return String(a.row.ID || '').localeCompare(String(b.row.ID || ''));
              });

            const best = scored[0];
            if (!best) return null;

            const stageLabel = friendlyStatusLabel(best.stage, best.statusContext || `TicketSearch ${orderNumber}`);
            const rowZip = normalizedPostalCode(best.row);
            const entry: OrderReferenceEntry = {
              ID: String(best.row.ID || '').trim(),
              RECIPIENT_NAME: String(best.row.RECIPIENT_NAME || '').trim(),
              SUMMARY_TEXT: String(best.row.RECIPIENT_NAME || '').trim(),
              DELIVERY_DATE: String(best.row.DELIVERY_DATE || '').trim(),
              DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
                normalizedCity(best.row),
                normalizedStateAbbrev(best.row),
                rowZip,
              ),
              DELIVERY_ZIP: rowZip,
              ORDER_AMOUNT: normalizedOrderAmount(best.row),
              USER_REFERENCE: String(best.row.USER_REFERENCE || '').trim(),
              SALE_ID: String(best.row.SALE_ID || orderNumber).trim(),
              STAGE_LABEL: stageLabel,
            };

            return { orderNumber, stageLabel, entry };
          },
        );

        for (const result of askOrderStatusResults) {
          if (result.status !== 'fulfilled' || !result.value) continue;
          const normalizedOrder = normalizeIdLike(String(result.value.orderNumber || ''));
          if (normalizedOrder && result.value.stageLabel) {
            askStatusByOrderNumber.set(normalizedOrder, result.value.stageLabel);
          }
          addOrderReference(result.value.entry);
        }
      }

      const intakeLookupTicketIds = Array.from(
        new Set(
          inboundIntakeMessages
            .flatMap(message => messageLookupTicketCandidates(message))
        ),
      ).slice(0, intakeLookupLimit);

      if (intakeLookupTicketIds.length > 0) {
        const intakeLookupResults = await allSettledInBatches(
          intakeLookupTicketIds,
          intakeLookupBatchSize,
          async ticketId => {
            const [details, ticketStatus, lifecycle] = await Promise.all([
              getOrderDetailsCached(ticketId),
              getTicketStatusCached(ticketId),
              getLifecycleByTicketCached(ticketId),
            ]);

            const statusRaw = String(lifecycle?.STATUS_CD || ticketStatus?.DeliveryStatus || '');
            const statusDesc = String(lifecycle?.STATUS_CD_DESC || lifecycle?.STATUS_TEXT || ticketStatus?.DesignerStatus || '');
            const statusContext = `${statusRaw} ${statusDesc}`.trim();
            const lookupStage = normalizeStageForOrderCard(
              stageFromExternalStatus(statusContext, designedIndicatorFromStatusText(statusDesc)),
            );
            const stageLabel = friendlyStatusLabel(lookupStage, statusContext);

            const saleId = String(details?.SALE_ID || '').trim();
            const userReference = String(details?.USER_REFERENCE || '').trim();
            const orderNumber = extractOrderIdForDisplay(saleId, userReference, ticketId);
            const detailZip = normalizedPostalCode(details);

            return {
              ID: String(details?.ID || ticketId || '').trim(),
              RECIPIENT_NAME: String(details?.RECIPIENT_NAME || '').trim(),
              SUMMARY_TEXT: String(details?.SUMMARY_TEXT || details?.RECIPIENT_NAME || '').trim(),
              DELIVERY_DATE: String(details?.DELIVERY_DATE || '').trim(),
              DELIVERY_CITY_STATE_ZIP: formatCityStateZip(
                normalizedCity(details),
                normalizedStateAbbrev(details),
                detailZip,
              ),
              DELIVERY_ZIP: detailZip,
              ORDER_AMOUNT: normalizedOrderAmount(details),
              USER_REFERENCE: userReference,
              SALE_ID: saleId || orderNumber,
              STAGE_LABEL: stageLabel,
            };
          },
        );

        for (const lookup of intakeLookupResults) {
          if (lookup.status !== 'fulfilled') continue;
          const enrichedOrder = lookup.value;
          if (!enrichedOrder.ID) continue;
          addOrderReference(enrichedOrder);
        }
      }

      const orderReferencePool = Array.from(referenceById.values());
      const activeOrderLookupKeys = new Set<string>();
      for (const card of activeByTicket.values()) {
        const ticketKey = normalizeIdLike(card.ticketId);
        const userRefKey = normalizeIdLike(card.userReference);
        const userRefHeadKey = normalizeIdLike(String(card.userReference || '').split('/')[0] || '');
        if (ticketKey) activeOrderLookupKeys.add(ticketKey);
        if (userRefKey) activeOrderLookupKeys.add(userRefKey);
        if (userRefHeadKey) activeOrderLookupKeys.add(userRefHeadKey);
      }

      const pending = buildPendingIntakeTickets(
        displayMessageRows,
        mergedMessageRows,
        orderReferencePool,
        seenTicketIdsRef.current,
        flashUntilRef.current,
        hasMessageThreadCoverage,
        {
          flashMs: config.flashMs,
          askStaleMs,
          activeOrderLookupKeys,
          config,
        },
      );
      const pendingWithStatus = pending.map(ticket => {
        if (ticket.kind !== 'ask') return { ...ticket };
        const orderKey = normalizeIdLike(String(ticket.relatedOrderNumber || ''));
        if (!orderKey) return { ...ticket };
        const statusOverride = askStatusByOrderNumber.get(orderKey) || '';
        if (!statusOverride) return { ...ticket };
        return {
          ...ticket,
          relatedOrderStatus: statusOverride,
        };
      });

      const pendingWithDistance = pendingWithStatus.map(ticket => ({ ...ticket }));
      const pendingDistanceLookupPlans = new Map<string, { ticket: IntakeTicketCard; indexes: number[] }>();
      for (const [index, ticket] of pendingWithDistance.entries()) {
        if (ticket.kind !== 'uncreated') continue;
        const lookupKey = pendingDistanceLookupKey(ticket);
        if (!lookupKey) continue;
        const cachedDistanceLabel = pendingDistanceByLookupKeyRef.current.get(lookupKey) || '';
        if (cachedDistanceLabel) {
          ticket.distanceMilesLabel = cachedDistanceLabel;
          continue;
        }
        const existingPlan = pendingDistanceLookupPlans.get(lookupKey);
        if (existingPlan) {
          existingPlan.indexes.push(index);
        } else {
          pendingDistanceLookupPlans.set(lookupKey, {
            ticket,
            indexes: [index],
          });
        }
      }

      if (pendingDistanceLookupPlans.size > 0) {
        const lookupEntries = Array.from(pendingDistanceLookupPlans.entries());
        const distanceResults = await allSettledInBatches(
          lookupEntries,
          10,
          async ([lookupKey, plan]) => {
            const ticket = plan.ticket;
            const ticketId = String(ticket.relatedTicketId || '').trim();
            const addressLine1 = String(ticket.destinationAddressLine || '').trim();
            const city = String(ticket.destinationCity || '').trim();
            const state = String(ticket.destinationState || '').trim();
            const postalCode = String(ticket.destinationZip || '').trim();
            if (!ticketId && !addressLine1 && !city && !postalCode) {
              return { lookupKey, distanceMilesLabel: '' };
            }
            let estimate: DistanceEstimateResponse | null = null;
            try {
              estimate = await fetchDistanceEstimate({
                ticketId,
                addressLine1,
                city,
                state,
                postalCode,
                country: 'US',
              });
            } catch {
              estimate = null;
            }
            return {
              lookupKey,
              distanceMilesLabel: formatDistanceMilesLabel(estimate?.distance_miles),
            };
          },
        );
        for (const result of distanceResults) {
          if (result.status !== 'fulfilled') continue;
          const lookupKey = String(result.value.lookupKey || '').trim();
          const distanceMilesLabel = String(result.value.distanceMilesLabel || '').trim();
          if (!lookupKey || !distanceMilesLabel) continue;
          pendingDistanceByLookupKeyRef.current.set(lookupKey, distanceMilesLabel);
          const plan = pendingDistanceLookupPlans.get(lookupKey);
          if (!plan) continue;
          for (const index of plan.indexes) {
            const ticket = pendingWithDistance[index];
            if (!ticket) continue;
            ticket.distanceMilesLabel = distanceMilesLabel;
          }
        }
      }

      const unresolvedAsks = pendingWithDistance.filter(ticket => ticket.kind === 'ask' && !ticket.relatedOrderNumber && ticket.askDebugSummary);
      if (askDebugEnabled) {
        const activeLogIds = new Set<string>();
        for (const ticket of unresolvedAsks) {
          activeLogIds.add(ticket.id);
          const signature = `${ticket.askDebugSummary}|${ticket.askDebugDetails.join('|')}`;
          if (unresolvedAskLogRef.current.get(ticket.id) === signature) continue;
          unresolvedAskLogRef.current.set(ticket.id, signature);
          // Temporary deep-trace console output for unresolved ASK cards.
          console.warn('[ASK LINK DEBUG] Unresolved ASK linkage', {
            messageId: ticket.id,
            recipient: ticket.recipientName,
            messageKeys: ticket.askMessageKeys,
            candidateFailures: ticket.askDebugDetails,
            summary: ticket.askDebugSummary,
          });
        }
        for (const cachedId of Array.from(unresolvedAskLogRef.current.keys())) {
          if (!activeLogIds.has(cachedId)) {
            unresolvedAskLogRef.current.delete(cachedId);
          }
        }
      } else if (unresolvedAskLogRef.current.size > 0) {
        unresolvedAskLogRef.current.clear();
      }

      setGroups(nextGroups);
      const reconciledActiveOrders = Array.from(activeByTicket.values())
        .map(card => ({
          ...card,
          // Prefer authoritative ticket-status delivery dates first, then keep
          // the card's current date, and only then fall back to ticket-search
          // canonicalization.
          deliveryDate: firstNonEmptyText(
            zoneDeliveryDateByTicketId.get(card.ticketId) || '',
            card.deliveryDate,
            canonicalTicketSearchDelivery(card.ticketId, card.userReference, ''),
          ),
        }))
        .filter(card => {
          const ticketKey = normalizeIdLike(card.ticketId);
          const refKey = normalizeIdLike(card.userReference);
          if (futureTicketSearchIds.has(ticketKey)) return false;
          if (futureTicketSearchRefs.has(refKey)) return false;
          return true;
        })
        .sort(activeOrderSort);
      const localOnlyActiveOrders = reconciledActiveOrders.filter(card => (
        isLocalOrderType(card.orderType) && !isWireOrderType(card.orderType)
      ));
      const nextAudioAlertKinds = buildAudioAlertKindMap(pendingWithDistance, localOnlyActiveOrders, currentLocalDateKey());
      const nextAudioAlertKeys = new Set(nextAudioAlertKinds.keys());
      if (!audioAlertSnapshotReadyRef.current) {
        alertedItemKeysRef.current = nextAudioAlertKeys;
        audioAlertSnapshotReadyRef.current = true;
      } else {
        const newAlertCounts = countNewAudioAlertsByKind(alertedItemKeysRef.current, nextAudioAlertKinds);
        const marketplaceDings = clampInteger(config.marketplaceDings, 1, 9, DEFAULT_MARKETPLACE_DINGS);
        const todayDings = clampInteger(config.todayDings, 1, 9, DEFAULT_TODAY_DINGS);
        const marketplaceDingCount = newAlertCounts.marketplaceCount * marketplaceDings;
        const todayDingCount = newAlertCounts.todayCount * todayDings;
        alertedItemKeysRef.current = nextAudioAlertKeys;
        if (audioAlertsEnabledRef.current) {
          let remainingDings = 12;
          const marketplaceQueueCount = Math.max(0, Math.min(remainingDings, marketplaceDingCount));
          remainingDings -= marketplaceQueueCount;
          const todayQueueCount = Math.max(0, Math.min(remainingDings, todayDingCount));

          if (marketplaceQueueCount > 0) {
            queueAlertDings(marketplaceQueueCount, {
              configOverride: buildSoundConfigForAlertKind(config, 'marketplace'),
            });
          }
          if (todayQueueCount > 0) {
            queueAlertDings(todayQueueCount, {
              configOverride: buildSoundConfigForAlertKind(config, 'today'),
            });
          }
        }
      }
      // Progress/counting should use all selected-day orders, including non-local order types.
      setAllActiveOrders(reconciledActiveOrders);
      // All SALE_DATEs for the selected delivery date — bucketed by hour to build the intake chart.
      // Mercury always returns full ISO datetime strings, so getHours() gives the correct local hour.
      const selectedKey = selectedDateKeyRef.current;
      const saleDatesForChart = ticketSearchRows
        .filter(r => toDateKey(String(r.DELIVERY_DATE || '')) === selectedKey && !isWireOutOrderType(String(r.ORDER_TYPE || '')))
        .map(r => String(r.SALE_DATE || '').trim())
        .filter(Boolean);
      setTodaySaleDates(saleDatesForChart);

      // Financial KPIs for the selected delivery date
      const todayDeliveryRows = ticketSearchRows.filter(r => toDateKey(String(r.DELIVERY_DATE || '')) === selectedKey);
      const localAndWireInRows = todayDeliveryRows.filter(r => !isWireOutOrderType(String(r.ORDER_TYPE || '')));
      const wireInRows = todayDeliveryRows.filter(r => {
        const ot = String(r.ORDER_TYPE || '').trim();
        return ot === '103' || ot === 'Wire In' || /wire[\s-]?in\b/i.test(ot);
      });
      const localRevenue = localAndWireInRows.reduce((sum, r) => sum + (parseFloat(String(r.TOTAL || '0')) || 0), 0);
      const localAmounts = localAndWireInRows.map(r => parseFloat(String(r.TOTAL || '0')) || 0).filter(n => n > 0);
      setTodayFinancials({
        revenue: localRevenue,
        avgTicket: localAmounts.length ? localRevenue / localAmounts.length : 0,
        largestOrder: localAmounts.length ? Math.max(...localAmounts) : 0,
        wireInCount: wireInRows.length,
        wireInRevenue: wireInRows.reduce((sum, r) => sum + (parseFloat(String(r.TOTAL || '0')) || 0), 0),
      });

      setPendingTickets(pendingWithDistance);
      setLastUpdated(new Date().toLocaleTimeString());
      hasCompletedInitialPollRef.current = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      if (trackActivePaneSpinner) {
        activePaneSpinnerInFlightRef.current = Math.max(0, activePaneSpinnerInFlightRef.current - 1);
        if (activePaneSpinnerInFlightRef.current === 0) {
          activePaneSpinnerRequestedRef.current = false;
          setIsRefreshingActiveOrders(false);
        }
      }
      setLoading(false);
    }
  }, [askStaleMs, config, queueAlertDings, sourceDeliveryDateKeys, sourceRangeWindows]);

  const runPoll = useCallback(async () => {
    if (pollInFlightRef.current) {
      pollQueuedRef.current = true;
      return;
    }

    pollInFlightRef.current = true;
    try {
      do {
        pollQueuedRef.current = false;
        await pollBoard();
      } while (pollQueuedRef.current);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [pollBoard]);

  useEffect(() => {
    let timeoutId: number | null = null;
    const syncTodayAnchor = (): void => {
      const nextKey = currentLocalDateKey();
      setTodayAnchorKey(previous => (previous === nextKey ? previous : nextKey));
    };

    const scheduleTopOfHourCheck = (): void => {
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      const delayMs = Math.max(1000, nextHour.getTime() - now.getTime());
      timeoutId = window.setTimeout(() => {
        syncTodayAnchor();
        scheduleTopOfHourCheck();
      }, delayMs);
    };

    syncTodayAnchor();
    scheduleTopOfHourCheck();
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    const tickMs = config.clockShowNanoseconds ? 50 : 1000;
    const timer = window.setInterval(() => {
      setTickerNow(new Date());
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [config.clockShowNanoseconds]);

  useEffect(() => {
    setWorkflowBaseUrlOverride(config.mercuryBaseUrl);
  }, [config.mercuryBaseUrl]);

  useEffect(() => {
    const pollMs = clampInteger(config.pollMs, 15000, 60000, DEFAULT_POLL_MS);
    void runPoll();
    const timer = window.setInterval(() => {
      void runPoll();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [config.pollMs, runPoll]);

  useEffect(() => {
    audioAlertsEnabledRef.current = isAudioAlertsEnabled;
  }, [isAudioAlertsEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(AUDIO_ALERTS_STORAGE_KEY, isAudioAlertsEnabled ? '1' : '0');
    } catch {
      // localStorage unavailable (private mode, policy, etc)
    }
  }, [isAudioAlertsEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DASHBOARD_CLIENT_CONFIG_STORAGE_KEY, JSON.stringify(sanitizeClientConfig(config)));
    } catch {
      // localStorage unavailable (private mode, policy, etc)
    }
  }, [config]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const serverConfigRaw = await fetchDashboardServerConfig();
      if (disposed || !serverConfigRaw) return;
      setConfig(previous => sanitizeDashboardConfig({
        ...previous,
        ...sanitizeServerBackedConfig(serverConfigRaw as Partial<DashboardUserConfig>),
      }));
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!configMessage) return;
    const timer = window.setTimeout(() => {
      setConfigMessage('');
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [configMessage]);

  useEffect(() => {
    if (!config.tickerModules.includes('weather')) return;

    let disposed = false;
    let activeController: AbortController | null = null;

    const refreshWeather = async (): Promise<void> => {
      if (activeController) {
        activeController.abort();
      }
      const controller = new AbortController();
      activeController = controller;
      try {
        const snapshot = await prefetchWeatherTicker(config.tickerWeatherZip, controller.signal);
        if (!disposed && snapshot) {
          setWeatherTickerSnapshot(snapshot);
        }
      } catch {
        // Keep the last successful snapshot visible; do not surface loading/errors in the ticker.
      }
    };

    void refreshWeather();
    const timer = window.setInterval(() => {
      void refreshWeather();
    }, 15 * 60 * 1000);

    return () => {
      disposed = true;
      if (activeController) activeController.abort();
      window.clearInterval(timer);
    };
  }, [config.tickerModules, config.tickerWeatherZip]);

  useEffect(() => {
    if (!enabledPages.some(page => page.id === currentPageId)) {
      setCurrentPageId(enabledPages[0]?.id || 'alerts_active');
    }
  }, [currentPageId, enabledPages]);

  useEffect(() => {
    if (!config.pageAutoRotateEnabled) return;
    if (!hasMultiplePages) return;
    if (isConfigOpen) return;

    const intervalMs = clampInteger(
      config.pageAutoRotateIntervalSec * 1000,
      5000,
      300000,
      DEFAULT_PAGE_AUTO_ROTATE_INTERVAL_SEC * 1000,
    );
    const timer = window.setInterval(() => {
      setCurrentPageId(previous => {
        const currentIndex = enabledPages.findIndex(page => page.id === previous);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = (safeIndex + 1) % enabledPages.length;
        return enabledPages[nextIndex].id;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [
    config.pageAutoRotateEnabled,
    config.pageAutoRotateIntervalSec,
    enabledPages,
    hasMultiplePages,
    isConfigOpen,
  ]);

  useEffect(() => {
    if (currentPageId !== 'weather') {
      setWeatherForecastLoading(false);
      return;
    }
    let disposed = false;
    let activeController: AbortController | null = null;
    let retryTimer: number | null = null;

    const clearRetryTimer = (): void => {
      if (retryTimer === null) return;
      window.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const scheduleRetry = (): void => {
      if (disposed || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void refresh();
      }, WEATHER_FORECAST_RETRY_MS);
    };

    const refresh = async (): Promise<void> => {
      if (disposed) return;
      if (activeController) {
        activeController.abort();
      }
      const controller = new AbortController();
      activeController = controller;
      setWeatherForecastLoading(true);
      try {
        const data = await fetchWeatherForecast(config.tickerWeatherZip, controller.signal);
        if (disposed || controller.signal.aborted) return;
        if (data) {
          clearRetryTimer();
          setWeatherForecastData(data);
          setWeatherForecastZip(config.tickerWeatherZip);
        } else {
          scheduleRetry();
        }
      } catch {
        if (!controller.signal.aborted) scheduleRetry();
      } finally {
        if (!disposed && activeController === controller) {
          activeController = null;
          setWeatherForecastLoading(false);
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), WEATHER_FORECAST_REFRESH_MS);

    return () => {
      disposed = true;
      clearRetryTimer();
      if (activeController) activeController.abort();
      window.clearInterval(timer);
    };
  }, [currentPageId, config.tickerWeatherZip]);

  // Fetch RainViewer radar frames when on weather page; refresh every 5 min
  useEffect(() => {
    if (currentPageId !== 'weather') {
      setRadarFrames([]);
      setRadarFrameIdx(0);
      return;
    }
    let disposed = false;
    const refresh = async () => {
      const frames = await fetchRadarFrames();
      if (!disposed && frames.length > 0) {
        setRadarFrames(frames);
        setRadarFrameIdx(0);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentPageId]);

  useEffect(() => {
    if (!isConfigOpen || configTab !== 'server') {
      setShopAddressSuggestions([]);
      setShopAddressSuggestionError('');
      setIsShopAddressSuggesting(false);
      return;
    }
    const query = editingConfig.shopAddress.trim();
    if (query.length < 3) {
      setShopAddressSuggestions([]);
      setShopAddressSuggestionError('');
      setIsShopAddressSuggesting(false);
      return;
    }
    if (editingConfig.shopAddressLatitude !== null && editingConfig.shopAddressLongitude !== null) {
      setShopAddressSuggestions([]);
      setShopAddressSuggestionError('');
      setIsShopAddressSuggesting(false);
      return;
    }

    let disposed = false;
    setIsShopAddressSuggesting(true);
    const timer = window.setTimeout(() => {
      void fetchAddressSuggestions(query)
        .then(suggestions => {
          if (disposed) return;
          setShopAddressSuggestions(suggestions);
          setShopAddressSuggestionError('');
        })
        .catch(() => {
          if (disposed) return;
          setShopAddressSuggestions([]);
          setShopAddressSuggestionError('Address lookup unavailable.');
        })
        .finally(() => {
          if (!disposed) setIsShopAddressSuggesting(false);
        });
    }, 250);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    configTab,
    editingConfig.shopAddress,
    editingConfig.shopAddressLatitude,
    editingConfig.shopAddressLongitude,
    isConfigOpen,
  ]);

  useEffect(() => {
    if (currentPageId !== 'delivery_map') {
      setDeliveryMapLoading(false);
      setDeliveryMapError('');
      return;
    }
    let disposed = false;
    const lookupKeys = selectedDayDeliveryMapOrders
      .map(card => deliveryMapLookupKey(card))
      .filter(Boolean);
    if (!lookupKeys.length) {
      setDeliveryMapPins([]);
      setDeliveryMapLoading(false);
      setDeliveryMapError('');
      return;
    }

    const resolvePins = async () => {
      setDeliveryMapLoading(true);
      setDeliveryMapError('');
      const pins: Array<Omit<DeliveryMapPin, 'xPercent' | 'yPercent'>> = [];
      const geocodeFailures: string[] = [];
      const noMatchQueries: string[] = [];
      const geocodeOrigin = deliveryMapOrigin;
      const geocodeCacheSuffix = geocodeOrigin
        ? `|near:${geocodeOrigin.latitude.toFixed(4)},${geocodeOrigin.longitude.toFixed(4)}`
        : '';

      for (const card of selectedDayDeliveryMapOrders) {
        if (disposed) return;
        const lookupKey = deliveryMapLookupKey(card);
        if (!lookupKey) continue;
        const geocodeCacheKey = `${lookupKey}${geocodeCacheSuffix}`;
        if (deliveryMapGeocodeCacheRef.current.has(geocodeCacheKey)) {
          const cached = deliveryMapGeocodeCacheRef.current.get(geocodeCacheKey);
          if (cached) pins.push(cached);
          continue;
        }

        try {
          const addressQuery = deliveryMapAddressQuery(card);
          const suggestions = await fetchAddressSuggestions(addressQuery);
          const match = pickDeliveryMapAddressSuggestion(suggestions, geocodeOrigin);
          if (!match) {
            deliveryMapGeocodeCacheRef.current.set(geocodeCacheKey, null);
            noMatchQueries.push(addressQuery);
            continue;
          }
          const pin = {
            id: card.ticketId || card.userReference || lookupKey,
            label: card.recipientName || card.userReference || 'Delivery',
            orderRef: card.userReference || card.ticketId || '',
            statusLabel: singleStatusPill(card).label,
            deliveryDate: formatDateOnly(card.deliveryDate) || selectedDayCountLabel,
            address: match.address || deliveryMapAddressQuery(card),
            latitude: match.latitude,
            longitude: match.longitude,
          };
          deliveryMapGeocodeCacheRef.current.set(geocodeCacheKey, pin);
          pins.push(pin);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          geocodeFailures.push(reason);
          deliveryMapGeocodeCacheRef.current.set(geocodeCacheKey, null);
        }
      }

      if (disposed) return;
      setDeliveryMapPins(pins);
      setSelectedDeliveryMapPinId('');
      if (pins.length) {
        setDeliveryMapError('');
      } else if (geocodeFailures.length) {
        setDeliveryMapError(`Unable to geocode delivery addresses. ${geocodeFailures[0]}`);
      } else if (noMatchQueries.length) {
        setDeliveryMapError(`Mapbox returned no matches for ${noMatchQueries.length} delivery address${noMatchQueries.length === 1 ? '' : 'es'}. First query: ${noMatchQueries[0]}`);
      } else {
        setDeliveryMapError('Unable to geocode delivery addresses for this date.');
      }
      setDeliveryMapLoading(false);
    };

    void resolvePins();
    return () => {
      disposed = true;
    };
  }, [currentPageId, deliveryMapOrigin, selectedDateKey, selectedDayDeliveryMapOrders]);

  // Advance radar animation frame
  useEffect(() => {
    if (radarFrames.length === 0) return;
    const timer = window.setInterval(() => {
      setRadarFrameIdx(prev => (prev + 1) % radarFrames.length);
    }, 800);
    return () => window.clearInterval(timer);
  }, [radarFrames.length]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DASHBOARD_MODE_STORAGE_KEY, isDashboardMode ? '1' : '0');
    } catch {
      // localStorage unavailable (private mode, policy, etc)
    }
  }, [isDashboardMode]);

  useEffect(() => {
    if (!isAutoScrollEnabled) return;

    const pxPerSecond = 10;
    const pauseMs = 1400;
    const state = new Map<HTMLDivElement, { dir: 1 | -1; pauseUntil: number; lastTs: number; carry: number }>();

    let rafId = 0;
    const tick = (ts: number) => {
      const targets = [pendingListRef.current, activeListRef.current].filter(
        (item): item is HTMLDivElement => Boolean(item),
      );

      for (const el of targets) {
        let s = state.get(el);
        if (!s) {
          s = { dir: 1, pauseUntil: 0, lastTs: 0, carry: 0 };
          state.set(el, s);
        }

        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxScroll <= 2) {
          s.lastTs = ts;
          s.carry = 0;
          continue;
        }

        if (s.lastTs === 0) {
          s.lastTs = ts;
          continue;
        }

        const dt = Math.min(64, Math.max(0, ts - s.lastTs));
        s.lastTs = ts;

        if (ts < s.pauseUntil) continue;

        const rawDelta = ((pxPerSecond * dt) / 1000) * s.dir + s.carry;
        const wholeDelta = rawDelta >= 0 ? Math.floor(rawDelta) : Math.ceil(rawDelta);
        s.carry = rawDelta - wholeDelta;

        if (wholeDelta === 0) continue;

        let nextTop = el.scrollTop + wholeDelta;
        if (nextTop >= maxScroll) {
          nextTop = maxScroll;
          s.dir = -1;
          s.pauseUntil = ts + pauseMs;
          s.carry = 0;
        } else if (nextTop <= 0) {
          nextTop = 0;
          s.dir = 1;
          s.pauseUntil = ts + pauseMs;
          s.carry = 0;
        }
        el.scrollTop = nextTop;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isAutoScrollEnabled]);

  useEffect(() => {
    return () => {
      const audioContext = audioContextRef.current;
      if (!audioContext) return;
      void audioContext.close().catch(() => {
        // ignore close errors on teardown
      });
      audioContextRef.current = null;
    };
  }, []);


  const uncreatedTicketCount = useMemo(
    () => pendingTickets.filter(ticket => ticket.kind === 'uncreated').length,
    [pendingTickets],
  );
  const staleAskTicketCount = useMemo(
    () => pendingTickets.filter(ticket => ticket.isStaleAsk).length,
    [pendingTickets],
  );
  const marketplacePendingTicketCount = useMemo(
    () => pendingTickets.filter(ticket => ticket.isMarketplace).length,
    [pendingTickets],
  );
  const selectedDayExceptionCount = useMemo(
    () => allActiveOrders.filter(card => (
      toDateKey(card.deliveryDate) === selectedDateKey
      && isExceptionStatusReason(`${card.stageReason} ${card.deliveryStatus}`)
    )).length,
    [allActiveOrders, selectedDateKey],
  );

  const todayStageCounts = useMemo(() => {
    const todayOrders = allActiveOrders.filter(card => toDateKey(card.deliveryDate) === selectedDateKey && !isWireOutOrderType(card.orderType));
    const exceptions = todayOrders.filter(c => isExceptionStatusReason(`${c.stageReason} ${c.deliveryStatus}`)).length;
    const delivered = todayOrders.filter(c => c.stage === 'delivered_or_exception' && !isExceptionStatusReason(`${c.stageReason} ${c.deliveryStatus}`)).length;
    const onTruck = todayOrders.filter(c => c.stage === 'on_truck' && !isCanceledOrder(c)).length;
    const staged = todayOrders.filter(c => c.stage === 'saved_or_staged' && !isCanceledOrder(c)).length;
    const designed = todayOrders.filter(c => c.stage === 'designed' && !isCanceledOrder(c)).length;
    const queued = todayOrders.filter(c => (c.stage === 'queued_not_designed' || c.stage === 'incoming') && !isCanceledOrder(c)).length;
    const marketplace = todayOrders.filter(c => c.isMarketplace).length;
    const canceled = todayOrders.filter(c => isCanceledOrder(c)).length;
    return { queued, designed, staged, onTruck, delivered, exceptions, marketplace, canceled, total: todayOrders.length };
  }, [allActiveOrders, selectedDateKey]);



  const hourlyOrderCounts = useMemo(() => {
    const counts = new Array(24).fill(0) as number[];
    for (const d of todaySaleDates) {
      const ms = Date.parse(d);
      if (isNaN(ms)) continue;
      counts[new Date(ms).getHours()]++;
    }
    return counts;
  }, [todaySaleDates]);

  useEffect(() => {
    const fetchLastYear = async () => {
      try {
        const selected = localDateFromDateKey(selectedDateKey) ?? new Date();
        const ly = new Date(selected.getFullYear() - 1, selected.getMonth(), selected.getDate());
        const lyNext = new Date(ly.getFullYear(), ly.getMonth(), ly.getDate() + 1);
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        // Mercury ToDate is exclusive — pass the following day so the target date is included
        const result = await fetchTicketSearch({ fromDate: fmt(ly), toDate: fmt(lyNext), includeDelivered: true, notDelivered: false });
        const rows = (result.rows ?? []).filter(r => !isWireOutOrderType(String(r.ORDER_TYPE || '')));
        const dates = rows.map(r => String(r.SALE_DATE || '').trim()).filter(Boolean);
        setLastYearSaleDates(dates);
        const totals = rows.map(r => parseFloat(String(r.TOTAL || '0')) || 0).filter(n => n > 0);
        const revenue = totals.reduce((s, n) => s + n, 0);
        setLastYearStats({ count: rows.length, revenue, avgTicket: totals.length ? revenue / totals.length : 0 });
      } catch { /* silently ignore */ }
    };
    void fetchLastYear();
  }, [selectedDateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleWeatherForecastData = weatherForecastZip === config.tickerWeatherZip
    ? weatherForecastData
    : null;

  const weatherChartData = useMemo(() => {
    if (!visibleWeatherForecastData || visibleWeatherForecastData.hourly.length === 0) return null;
    const { hourly } = visibleWeatherForecastData;
    const temps = hourly.map(h => h.temp);
    const minTemp = Math.min(...temps) - 5;
    const maxTemp = Math.max(...temps) + 5;
    const tempRange = maxTemp - minTemp || 1;
    const W = 900, H = 230, ML = 48, MR = 12, MT = 16, MB = 60;
    const PW = W - ML - MR;
    const PH = H - MT - MB;
    const n = hourly.length;
    const xOf = (i: number) => ML + (i / Math.max(1, n - 1)) * PW;
    const yOf = (t: number) => MT + (1 - (t - minTemp) / tempRange) * PH;
    const points = hourly.map((h, i) => ({ x: xOf(i), y: yOf(h.temp), h }));
    const tempPolyline = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPolygon = [
      `${xOf(0).toFixed(1)},${(MT + PH).toFixed(1)}`,
      tempPolyline,
      `${xOf(n - 1).toFixed(1)},${(MT + PH).toFixed(1)}`,
    ].join(' ');
    const barW = Math.max(6, (PW / Math.max(1, n)) * 0.45);
    return { W, H, ML, MR, MT, MB, PW, PH, n, xOf, yOf, points, tempPolyline, areaPolygon, barW, minTemp, maxTemp, tempRange };
  }, [visibleWeatherForecastData]);

  const chartLineData = useMemo(() => {
    const currentHour = new Date().getHours();

    const lastYearCounts = new Array(24).fill(0) as number[];
    for (const d of lastYearSaleDates) {
      const ms = Date.parse(d);
      if (isNaN(ms)) continue;
      lastYearCounts[new Date(ms).getHours()]++;
    }

    const counts = hourlyOrderCounts as number[];
    const yMaxCumulative = Math.max(todaySaleDates.length, lastYearSaleDates.length, 1);
    const yMaxHourly = Math.max(...counts, ...lastYearCounts, 1);

    type CumulativePoint = { hour: number; x: number; y: number; cumulative: number };
    type HourlyPoint = { hour: number; x: number; y: number; count: number };

    const xForHour = (hour: number) =>
      CHART_ML + Math.round((hour / 23) * CHART_PW);

    const buildCumulativePoints = (countsByHour: number[], maxHour: number): CumulativePoint[] => {
      let running = 0;
      const pts: CumulativePoint[] = [];
      for (let h = 0; h <= Math.min(maxHour, 23); h++) {
        running += countsByHour[h] ?? 0;
        const x = xForHour(h);
        const y = CHART_MT + Math.round(CHART_PH * (1 - running / yMaxCumulative));
        pts.push({ hour: h, x, y, cumulative: running });
      }
      return pts;
    };

    const buildHourlyPoints = (countsByHour: number[], maxHour: number): HourlyPoint[] => {
      const pts: HourlyPoint[] = [];
      for (let h = 0; h <= Math.min(maxHour, 23); h++) {
        const count = countsByHour[h] ?? 0;
        const x = xForHour(h);
        // Use cumulative scale so both lines share one Y axis
        const y = CHART_MT + Math.round(CHART_PH * (1 - count / yMaxCumulative));
        pts.push({ hour: h, x, y, count });
      }
      return pts;
    };

    const todayCumulativePoints = buildCumulativePoints(counts, currentHour);
    const fullDayCumulativePoints = buildCumulativePoints(counts, 23);
    const todayHourlyPoints = buildHourlyPoints(counts, currentHour);
    const fullDayHourlyPoints = buildHourlyPoints(counts, 23);

    return { todayCumulativePoints, fullDayCumulativePoints, todayHourlyPoints, fullDayHourlyPoints, yMaxCumulative, yMaxHourly };
  }, [hourlyOrderCounts, todaySaleDates.length, lastYearSaleDates]); // eslint-disable-line react-hooks/exhaustive-deps

  const newOrdersPulse = useMemo(() => {
    const windowMs = NEW_ORDER_PULSE_WINDOW_MINUTES * 60 * 1000;
    const nowEpoch = tickerNow.getTime();
    const currentWindowStart = nowEpoch - windowMs;
    const previousWindowStart = currentWindowStart - windowMs;

    let currentCount = 0;
    let previousCount = 0;

    for (const ticket of pendingTickets) {
      if (ticket.kind !== 'uncreated') continue;
      const messageEpoch = toEpoch(ticket.messageDate);
      if (!messageEpoch) continue;

      if (messageEpoch >= currentWindowStart && messageEpoch <= nowEpoch) {
        currentCount += 1;
        continue;
      }
      if (messageEpoch >= previousWindowStart && messageEpoch < currentWindowStart) {
        previousCount += 1;
      }
    }

    return {
      currentCount,
      previousCount,
    };
  }, [pendingTickets, tickerNow]);

  const todayLabel = useMemo(() => {
    const startLabel = includeNextDay ? formatHeaderDateShort(selectedDate) : formatHeaderDateFullYear(selectedDate);
    if (!includeNextDay) return startLabel;
    const nextDate = new Date(selectedDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const endLabel = formatHeaderDateShort(nextDate);
    return `${startLabel} - ${endLabel}`;
  }, [selectedDate, includeNextDay]);

  const tickerHourLabel = useMemo(() => {
    const hours24 = tickerNow.getHours();
    if (config.clockFormat === '24h') {
      return String(hours24).padStart(2, '0');
    }
    const hours12 = hours24 % 12 || 12;
    return String(hours12).padStart(2, '0');
  }, [config.clockFormat, tickerNow]);
  const tickerMinuteLabel = useMemo(
    () => String(tickerNow.getMinutes()).padStart(2, '0'),
    [tickerNow],
  );
  const tickerSecondLabel = useMemo(
    () => String(tickerNow.getSeconds()).padStart(2, '0'),
    [tickerNow],
  );
  const tickerMeridiemLabel = useMemo(
    () => (config.clockFormat === '24h' ? '' : (tickerNow.getHours() >= 12 ? 'PM' : 'AM')),
    [config.clockFormat, tickerNow],
  );
  const tickerSeparatorsVisible = config.clockFlashColons ? tickerNow.getSeconds() % 2 === 0 : true;
  const tickerNanosecondsLabel = useMemo(() => {
    if (!config.clockShowNanoseconds) return '';
    const fractionalMs = performance.now() % 1000;
    const nanos = Math.floor(fractionalMs * 1_000_000);
    return String(nanos).padStart(9, '0');
  }, [config.clockShowNanoseconds, tickerNow]);
  const tickerDateLabel = useMemo(
    () => tickerNow.toLocaleDateString([], {
      month: '2-digit',
      day: '2-digit',
      year: '2-digit',
    }),
    [tickerNow],
  );
  const tickerScrollDurationStyle = useMemo(
    () => ({ '--ticker-scroll-duration': `${config.tickerScrollDurationSec}s` } as CSSProperties),
    [config.tickerScrollDurationSec],
  );
  const tickerItems = useMemo(() => buildTickerItems({
    enabledModuleIds: config.tickerModules,
    weatherZip: config.tickerWeatherZip,
    weatherSnapshot: weatherTickerSnapshot,
    storeHours: config.storeHours,
    completion: {
      dayLabel: selectedDayCountLabel,
      completed: selectedDayOrderCompleted,
      total: selectedDayOrderTotal,
      percent: selectedDayCompletionPercent,
    },
    intake: {
      pendingCount: pendingTickets.length,
      newOrderCount: uncreatedTicketCount,
      staleAskCount: staleAskTicketCount,
      marketplaceCount: marketplacePendingTicketCount,
    },
    exceptionWatch: {
      dayLabel: selectedDayCountLabel,
      exceptionCount: selectedDayExceptionCount,
    },
    newOrders: {
      windowMinutes: NEW_ORDER_PULSE_WINDOW_MINUTES,
      count: newOrdersPulse.currentCount,
      previousCount: newOrdersPulse.previousCount,
    },
  }), [
    config.tickerModules,
    config.tickerWeatherZip,
    config.storeHours,
    weatherTickerSnapshot,
    selectedDayCountLabel,
    selectedDayOrderCompleted,
    selectedDayOrderTotal,
    selectedDayCompletionPercent,
    pendingTickets.length,
    uncreatedTicketCount,
    staleAskTicketCount,
    marketplacePendingTicketCount,
    selectedDayExceptionCount,
    newOrdersPulse,
  ]);
  const feedErrorLabel = useMemo(() => {
    const detail = String(error || '').trim();
    if (!detail) return '';
    if (detail.toLowerCase().startsWith('feed error:')) return `⚠️ ${detail}`;
    return `⚠️ Feed error: ${detail}`;
  }, [error]);
  const tickerErrorText = useMemo(
    () => feedErrorLabel,
    [feedErrorLabel],
  );
  const tickerScrollText = useMemo(
    () => tickerErrorText || buildTickerScrollText(tickerItems),
    [tickerErrorText, tickerItems],
  );

  const toggleDashboardMode = useCallback(async () => {
    const nextMode = !isDashboardMode;
    setIsDashboardMode(nextMode);

    const canFullscreen = typeof document !== 'undefined' && 'fullscreenEnabled' in document && document.fullscreenEnabled;
    if (!canFullscreen) return;

    try {
      if (!nextMode) {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        return;
      }

      if (!document.fullscreenElement) {
        const target = appRef.current || document.documentElement;
        await target.requestFullscreen();
      }
    } catch {
      // Keep persisted dashboard mode state even if fullscreen API is blocked.
    }
  }, [isDashboardMode]);

  const goToPreviousPage = useCallback(() => {
    if (!hasMultiplePages) return;
    setCurrentPageId(previous => {
      const currentIndex = enabledPages.findIndex(page => page.id === previous);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (safeIndex - 1 + enabledPages.length) % enabledPages.length;
      return enabledPages[nextIndex].id;
    });
  }, [enabledPages, hasMultiplePages]);

  const goToNextPage = useCallback(() => {
    if (!hasMultiplePages) return;
    setCurrentPageId(previous => {
      const currentIndex = enabledPages.findIndex(page => page.id === previous);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (safeIndex + 1) % enabledPages.length;
      return enabledPages[nextIndex].id;
    });
  }, [enabledPages, hasMultiplePages]);

  const togglePageAutoRotate = useCallback(() => {
    setConfig(previous => sanitizeDashboardConfig({
      ...previous,
      pageAutoRotateEnabled: !previous.pageAutoRotateEnabled,
    }));
  }, []);

  return (
    <div className={`app${isDashboardMode ? ' app--dashboard' : ''}${error ? ' app--with-error' : ''}`} ref={appRef}>
      <div className="app__version-badge" title={`Dashboard version ${APP_VERSION_LABEL}`}>
        {APP_VERSION_LABEL}
      </div>
      <header className="app__header">
        <div className="app__title">
          <div className="app__logo-wrap">
            <img className="app__logo" src={customLogoSrc} alt="Shop logo" />
          </div>
          <div className="app__title-text">
            <h1>{dashboardTitle}</h1>
            <div className="app__today-wrap">
              <button
                type="button"
                className="app__date-nav"
                onClick={() => {
                  if (isRefreshingActiveOrders || loading) return;
                  requestActiveOrdersRefreshSpinner();
                  setDateOffsetDays(previous => previous - 1);
                }}
                aria-label="Previous day"
                disabled={isRefreshingActiveOrders || loading}
              >
                <FontAwesomeIcon icon={faChevronLeft} />
              </button>
              <div className="app__today">{todayLabel}</div>
              <label className="app__date-nav app__date-nav--native-picker" aria-label="Pick day">
                <FontAwesomeIcon icon={faCalendarDay} />
                <input
                  type="date"
                  className="app__date-nav-input"
                  value={selectedDateKey}
                  disabled={isRefreshingActiveOrders || loading}
                  onChange={(event) => setSelectedDateByKey(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="app__date-nav"
                onClick={() => {
                  if (isRefreshingActiveOrders || loading) return;
                  requestActiveOrdersRefreshSpinner();
                  setDateOffsetDays(previous => previous + 1);
                }}
                aria-label="Next day"
                disabled={isRefreshingActiveOrders || loading}
              >
                <FontAwesomeIcon icon={faChevronRight} />
              </button>
            </div>
          </div>
        </div>
        <div className="app__controls app__controls--compact">
              <button
                type="button"
                aria-pressed={includeNextDay}
                className={`app__control-btn app__control-btn--toggle${includeNextDay ? ' app__control-btn--toggle-active' : ''}`}
                onClick={() => {
                  setIncludeNextDay(previous => !previous);
                }}
              >
                <span className="app__control-icon" aria-hidden="true">
                  <FontAwesomeIcon icon={faCalendarDay} />
                </span>
                <span className="app__control-label">
                  <span className="app__control-line">Include</span>
                  <span className="app__control-line">next day</span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={showCompleted}
                className={`app__control-btn app__control-btn--toggle${showCompleted ? ' app__control-btn--toggle-active' : ''}`}
                onClick={() => {
                  requestActiveOrdersRefreshSpinner();
                  setShowCompleted(previous => !previous);
                }}
              >
                <span className="app__control-icon" aria-hidden="true">
                  <FontAwesomeIcon icon={faCircleCheck} />
                </span>
                <span className="app__control-label">
                  <span className="app__control-line">Show</span>
                  <span className="app__control-line">completed</span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={isAudioAlertsEnabled}
                className={`app__control-btn app__control-btn--toggle${isAudioAlertsEnabled ? ' app__control-btn--toggle-active' : ''}`}
                onClick={() => {
                  setIsAudioAlertsEnabled(previous => {
                    const nextEnabled = !previous;
                    if (nextEnabled) {
                      void playAlertSound();
                    }
                    return nextEnabled;
                  });
                }}
              >
                <span className="app__control-icon" aria-hidden="true">
                  <FontAwesomeIcon icon={faVolumeHigh} />
                </span>
                <span className="app__control-label">
                  <span className="app__control-line">Audio</span>
                  <span className="app__control-line">alerts</span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={isAutoScrollEnabled}
                className={`app__control-btn app__control-btn--toggle${isAutoScrollEnabled ? ' app__control-btn--toggle-active' : ''}`}
                onClick={() => {
                  setIsAutoScrollEnabled(previous => !previous);
                }}
              >
                <span className="app__control-icon" aria-hidden="true">
                  <FontAwesomeIcon icon={faScroll} />
                </span>
                <span className="app__control-label">
                  <span className="app__control-line">Auto-scroll</span>
                  <span className="app__control-line">enabled</span>
                </span>
              </button>
              {isDashboardMode ? (
                <button
                  type="button"
                  className="app__control-btn"
                  onClick={openConfigPage}
                  title="Open dashboard configuration"
                >
                  <span className="app__control-icon" aria-hidden="true">
                    <FontAwesomeIcon icon={faGear} />
                  </span>
                  <span className="app__control-label">
                    <span className="app__control-line">Config</span>
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className="app__control-btn app__control-btn--primary"
                onClick={() => void toggleDashboardMode()}
              >
                <span className="app__control-icon" aria-hidden="true">
                  <FontAwesomeIcon icon={isDashboardMode ? faXmark : faUpRightAndDownLeftFromCenter} />
                </span>
                <span className="app__control-label">
                  {isDashboardMode ? (
                    <>
                      <span className="app__control-line">Exit</span>
                      <span className="app__control-line">Fullscreen</span>
                    </>
                  ) : (
                    <>
                      <span className="app__control-line">Fullscreen</span>
                    </>
                  )}
                </span>
              </button>
          </div>
      </header>

      {isConfigOpen ? (
        <div className="app__config-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) cancelConfigChanges(); }}>
          <section className="app__config-page">
            <div className="app__config-header">
              <div className="app__config-header-left">
                <div className="app__config-title">
                  <FontAwesomeIcon icon={faGear} />
                  Dashboard Configuration
                </div>
                <div className="app__config-tabs" role="tablist" aria-label="Configuration sections">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={configTab === 'server'}
                    className={`app__config-tab app__config-tab--server${configTab === 'server' ? ' app__config-tab--active' : ''}`}
                    onClick={() => setConfigTab('server')}
                  >
                    Server Settings
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={configTab === 'client'}
                    className={`app__config-tab app__config-tab--client${configTab === 'client' ? ' app__config-tab--active' : ''}`}
                    onClick={() => setConfigTab('client')}
                  >
                    Client Settings
                  </button>
                </div>
              </div>
              <button type="button" className="app__config-close-btn" onClick={cancelConfigChanges} aria-label="Close settings">
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>

            <div className="app__config-body">
              {configMessage ? <div className="app__config-message">{configMessage}</div> : null}

              {configTab === 'server' ? (
              <>
            <section className="app__config-section app__config-section--server">
              <h3 className="app__config-section-title">Feed and Timing</h3>
              <div className="app__config-grid">
                <label className="app__config-row">
                  <span>Poll interval (ms)</span>
                  <input
                    type="number"
                    min={15000}
                    max={60000}
                    value={editingConfig.pollMs}
                    onChange={(event) => updateConfigNumber('pollMs', event.target.value)}
                  />
                </label>
                <label className="app__config-row">
                  <span>Flash duration (ms)</span>
                  <input
                    type="number"
                    min={10000}
                    max={600000}
                    value={editingConfig.flashMs}
                    onChange={(event) => updateConfigNumber('flashMs', event.target.value)}
                  />
                </label>
                <label className="app__config-row">
                  <span>Message stale threshold (hours)</span>
                  <input
                    type="number"
                    min={1}
                    max={72}
                    value={editingConfig.askStaleHours}
                    onChange={(event) => updateConfigNumber('askStaleHours', event.target.value)}
                  />
                </label>
                <label className="app__config-row">
                  <span>Delivery-service alert repeats</span>
                  <input
                    type="number"
                    min={1}
                    max={9}
                    value={editingConfig.marketplaceDings}
                    onChange={(event) => updateConfigNumber('marketplaceDings', event.target.value)}
                  />
                </label>
                <label className="app__config-row">
                  <span>Regular-order alert repeats</span>
                  <input
                    type="number"
                    min={1}
                    max={9}
                    value={editingConfig.todayDings}
                    onChange={(event) => updateConfigNumber('todayDings', event.target.value)}
                  />
                </label>
                <label className="app__config-row">
                  <span>Alert repeat interval (ms)</span>
                  <input
                    type="number"
                    min={250}
                    max={2500}
                    value={editingConfig.dingGapMs}
                    onChange={(event) => updateConfigNumber('dingGapMs', event.target.value)}
                  />
                </label>
                <label className="app__config-row">
                  <span>Page auto-rotate interval (sec)</span>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={editingConfig.pageAutoRotateIntervalSec}
                    onChange={(event) => updateConfigNumber('pageAutoRotateIntervalSec', event.target.value)}
                  />
                </label>
                <label className="app__config-row app__config-toggle-row">
                  <span>Enable page auto-rotate by default</span>
                  <input
                    type="checkbox"
                    checked={editingConfig.pageAutoRotateEnabled}
                    onChange={(event) => {
                      setConfigDraft(previous => sanitizeDashboardConfig({
                        ...(previous || config),
                        pageAutoRotateEnabled: event.target.checked,
                      }));
                    }}
                  />
                </label>
              </div>
            </section>

            <section className="app__config-section app__config-section--server">
              <h3 className="app__config-section-title">Pages</h3>
              <div className="app__config-grid">
                <div className="app__config-row app__config-row--full">
                  <span>Enabled dashboard pages</span>
                  <div className="app__config-module-list">
                    {DASHBOARD_PAGE_DEFINITIONS.map((pageDefinition, pageIndex) => {
                      const isEnabled = editingConfig.enabledPageIds.includes(pageDefinition.id);
                      return (
                        <div key={pageDefinition.id} className="app__config-module-card app__config-module-card--page">
                          <label className="app__config-page-toggle">
                            <input
                              type="checkbox"
                              checked={isEnabled}
                              onChange={(event) => toggleEnabledPageInDraft(pageDefinition.id, event.target.checked)}
                            />
                            <span className="app__config-module-copy">
                              <strong>{`Page ${pageIndex + 1}`}</strong>
                              <span>{pageDescription(pageDefinition.id)}</span>
                            </span>
                          </label>
                          <button
                            type="button"
                            className="app__config-page-settings-btn"
                            onClick={() => {
                              setTickerModuleSettingsId('');
                              setPageSettingsPageId(pageDefinition.id);
                            }}
                            title={`${pageDescription(pageDefinition.id)} settings`}
                            aria-label={`${pageDescription(pageDefinition.id)} settings`}
                          >
                            <FontAwesomeIcon icon={faGear} />
                          </button>
                          <span className="app__config-page-preview" aria-hidden="true">{renderPagePreviewSvg(pageDefinition.id)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>

            <section className="app__config-section app__config-section--server">
              <h3 className="app__config-section-title">Ticker</h3>
              <div className="app__config-subsection-grid">
                <div className="app__config-subsection app__config-subsection--full">
                  <h4 className="app__config-subsection-title">Scroll & Clock</h4>
                  <div className="app__config-grid">
                    <div className="app__config-row app__config-row--full">
                      <span>Ticker scroll speed</span>
                      <input
                        type="range"
                        min={8}
                        max={80}
                        step={1}
                        value={editingConfig.tickerScrollDurationSec}
                        onChange={(event) => updateConfigNumber('tickerScrollDurationSec', event.target.value)}
                      />
                      <input
                        type="number"
                        min={8}
                        max={80}
                        value={editingConfig.tickerScrollDurationSec}
                        onChange={(event) => updateConfigNumber('tickerScrollDurationSec', event.target.value)}
                      />
                      <div className="app__config-help">Seconds per full loop. Lower is faster, higher is slower.</div>
                    </div>
                    <label className="app__config-row">
                      <span>Clock format</span>
                      <select
                        value={editingConfig.clockFormat}
                        onChange={(event) => {
                          setConfigDraft(previous => sanitizeDashboardConfig({
                            ...(previous || config),
                            clockFormat: normalizeClockFormat(event.target.value),
                          }));
                        }}
                      >
                        <option value="12h">12-hour</option>
                        <option value="24h">24-hour</option>
                      </select>
                    </label>
                    <label className="app__config-row app__config-toggle-row">
                      <span>Flash clock colons</span>
                      <input
                        type="checkbox"
                        checked={editingConfig.clockFlashColons}
                        onChange={(event) => {
                          setConfigDraft(previous => sanitizeDashboardConfig({
                            ...(previous || config),
                            clockFlashColons: event.target.checked,
                          }));
                        }}
                      />
                    </label>
                    <label className="app__config-row app__config-toggle-row">
                      <span>Nanosecond time display</span>
                      <input
                        type="checkbox"
                        checked={editingConfig.clockShowNanoseconds}
                        onChange={(event) => {
                          setConfigDraft(previous => sanitizeDashboardConfig({
                            ...(previous || config),
                            clockShowNanoseconds: event.target.checked,
                          }));
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div className="app__config-subsection app__config-subsection--full">
                  <h4 className="app__config-subsection-title">Modules</h4>
                  <div className="app__config-module-list">
                    {TICKER_MODULE_DEFINITIONS.map(moduleDefinition => {
                      const isEnabled = editingConfig.tickerModules.includes(moduleDefinition.id);
                      return (
                        <div key={moduleDefinition.id} className="app__config-module-card app__config-module-card--settings">
                          <label className="app__config-page-toggle">
                            <input
                              type="checkbox"
                              checked={isEnabled}
                              onChange={(event) => toggleTickerModuleInDraft(moduleDefinition.id, event.target.checked)}
                            />
                            <span className="app__config-module-copy">
                              <strong>{moduleDefinition.label}</strong>
                              <span>{moduleDefinition.description}</span>
                            </span>
                          </label>
                          <button
                            type="button"
                            className="app__config-page-settings-btn"
                            onClick={() => {
                              setPageSettingsPageId('');
                              setTickerModuleSettingsId(moduleDefinition.id);
                            }}
                            title={`${moduleDefinition.label} settings`}
                            aria-label={`${moduleDefinition.label} settings`}
                          >
                            <FontAwesomeIcon icon={faGear} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>

            <section className="app__config-section app__config-section--server">
              <h3 className="app__config-section-title">Shop</h3>
              <div className="app__config-subsection-grid">
                <div className="app__config-subsection app__config-subsection--full">
                  <h4 className="app__config-subsection-title">Identity & Branding</h4>
                  <label className="app__config-row">
                    <span>Store name</span>
                    <input
                      type="text"
                      maxLength={80}
                      value={editingConfig.shopName}
                      placeholder="Store name"
                      onChange={(event) => {
                        setConfigDraft(previous => sanitizeDashboardConfig({
                          ...(previous || config),
                          shopName: event.target.value,
                        }));
                      }}
                    />
                  </label>
                  <div className="app__config-row">
                    <span>Shop logo image</span>
                    <div className="app__config-inline-actions">
                      <input
                        ref={logoUploadRef}
                        type="file"
                        accept="image/*"
                        onChange={(event) => {
                          void handleLogoUpload(event);
                        }}
                      />
                      <button type="button" className="app__control-btn" onClick={clearCustomLogo}>
                        Reset logo
                      </button>
                    </div>
                    <div className="app__config-branding-preview">
                      <div className="app__config-branding-preview-label">
                        {editingConfig.customLogoDataUrl ? 'Custom logo is active' : 'Using default logo'}
                      </div>
                      <div className="app__config-branding-preview-frame">
                        <img
                          src={editingConfig.customLogoDataUrl || '/olivers.png'}
                          alt="Configured shop logo preview"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="app__config-subsection">
                  <h4 className="app__config-subsection-title">Address</h4>
                  <label className="app__config-row">
                    <span>Store address</span>
                    <div className="app__config-address-field">
                      <input
                        type="text"
                        maxLength={180}
                        value={editingConfig.shopAddress}
                        placeholder="Store address"
                        autoComplete="off"
                        onChange={(event) => {
                          setConfigDraft(previous => sanitizeDashboardConfig({
                            ...(previous || config),
                            shopAddress: event.target.value,
                            shopAddressLatitude: null,
                            shopAddressLongitude: null,
                          }));
                        }}
                      />
                      {shopAddressSuggestions.length ? (
                        <div className="app__config-address-suggestions">
                          {shopAddressSuggestions.map((suggestion, index) => (
                            <button
                              key={`${suggestion.id || suggestion.address}-${index}`}
                              type="button"
                              className="app__config-address-suggestion"
                              onClick={() => selectShopAddressSuggestion(suggestion)}
                            >
                              {suggestion.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    {isShopAddressSuggesting ? <div className="app__config-help">Searching addresses...</div> : null}
                    {shopAddressSuggestionError ? <div className="app__config-help">{shopAddressSuggestionError}</div> : null}
                    {shopMapUrl ? (
                      <div className="app__config-map-preview">
                        <img src={shopMapUrl} alt="Validated shop address map" />
                      </div>
                    ) : (
                      <div className="app__config-map-empty">
                        <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden="true" />
                        <span>Choose a suggested address to preview the shop map.</span>
                      </div>
                    )}
                  </label>
                </div>
              </div>
            </section>

            <section className="app__config-section app__config-section--server">
              <h3 className="app__config-section-title">Order Gating</h3>
              <div className="app__config-subsection-grid">
                <div className="app__config-subsection">
                  <h4 className="app__config-subsection-title">Price Gate</h4>
                  <div className="app__config-grid">
                    <label className="app__config-row">
                      <span>Currency symbol</span>
                      <input
                        type="text"
                        maxLength={3}
                        value={editingConfig.currencySymbol}
                        placeholder="$"
                        onChange={(event) => {
                          const nextValue = event.target.value.slice(0, 3) || '$';
                          setConfigDraft(previous => sanitizeDashboardConfig({
                            ...(previous || config),
                            currencySymbol: nextValue,
                          }));
                        }}
                      />
                    </label>
                    <label className="app__config-row">
                      <span>Minimum order threshold ({editingConfig.currencySymbol})</span>
                      <input
                        type="number"
                        min={0}
                        max={9999}
                        value={editingConfig.minOrderThreshold}
                        onChange={(event) => updateConfigNumber('minOrderThreshold', event.target.value)}
                      />
                    </label>
                    <label className="app__config-row">
                      <span>Threshold padding ({editingConfig.currencySymbol})</span>
                      <input
                        type="number"
                        min={0}
                        max={25}
                        step={0.25}
                        value={editingConfig.minOrderPadding}
                        onChange={(event) => updateConfigNumber('minOrderPadding', event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="app__config-help">Incoming orders below the minimum after padding are marked as reject candidates; orders inside the padding buffer are marked for review. Set the minimum to 0 to disable price gating.</div>
                </div>

                <div className="app__config-subsection">
                  <h4 className="app__config-subsection-title">ZIP Gate</h4>
                  <div className="app__config-grid">
                    <label className="app__config-row">
                      <span>ZIP gate mode</span>
                      <select
                        value={editingConfig.zipGateMode}
                        onChange={(event) => {
                          setConfigDraft(previous => sanitizeDashboardConfig({
                            ...(previous || config),
                            zipGateMode: normalizeZipGateMode(event.target.value),
                          }));
                        }}
                      >
                        <option value="watchlist">Flag listed ZIPs</option>
                        <option value="allowlist">Require listed ZIPs</option>
                      </select>
                    </label>
                    <label className="app__config-row app__config-row--full">
                      <span>ZIP gate list</span>
                      <textarea
                        rows={3}
                        value={editingConfig.gateZipCodes.join('\n')}
                        placeholder="15212&#10;15237"
                        onChange={(event) => updateGateZipCodes(event.target.value)}
                      />
                    </label>
                  </div>
                </div>

                <div className="app__config-subsection app__config-subsection--full">
                  <h4 className="app__config-subsection-title">Sender Gate</h4>
                  <div className="app__config-row">
                    <span>Sender reject/watch list</span>
                    <div className="app__config-rule-list">
                      {editingConfig.blockedSenderRules.length ? (
                        editingConfig.blockedSenderRules.map(rule => (
                          <div className="app__config-rule-row" key={rule.id}>
                            <label className="app__config-rule-enabled" title="Enable sender rule">
                              <input
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={(event) => updateSenderGateRule(rule.id, { enabled: event.target.checked })}
                              />
                            </label>
                            <input
                              type="text"
                              value={rule.pattern}
                              placeholder="Sender name or service"
                              onChange={(event) => updateSenderGateRule(rule.id, { pattern: event.target.value })}
                            />
                            <select
                              value={rule.matchMode}
                              onChange={(event) => updateSenderGateRule(rule.id, { matchMode: normalizeSenderGateMatchMode(event.target.value) })}
                            >
                              <option value="contains">Contains</option>
                              <option value="exact">Exact</option>
                            </select>
                            <input
                              type="text"
                              value={rule.label}
                              placeholder="Badge label"
                              onChange={(event) => updateSenderGateRule(rule.id, { label: event.target.value })}
                            />
                            <button
                              type="button"
                              className="app__config-icon-btn"
                              onClick={() => removeSenderGateRule(rule.id)}
                              title="Remove sender rule"
                              aria-label="Remove sender rule"
                            >
                              <FontAwesomeIcon icon={faTrash} />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="app__config-help">No sender rules configured.</div>
                      )}
                    </div>
                    <div className="app__config-inline-actions">
                      <button type="button" className="app__control-btn" onClick={addSenderGateRule}>
                        <FontAwesomeIcon icon={faPlus} /> Add sender rule
                      </button>
                    </div>
                    <div className="app__config-help">Sender rules inspect sending florist name, shop code, member code, Mercury number, and wire service. Matches are visual reject candidates only.</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="app__config-section app__config-section--server">
              <h3 className="app__config-section-title">API / Mercury (Advanced)</h3>
              <div className="app__config-grid">
                <label className="app__config-row">
                  <span>Dashboard API route</span>
                  <input type="text" value="same-origin (/api)" readOnly />
                </label>
                <label className="app__config-row app__config-row--full">
                  <span>Mercury base URL (optional)</span>
                  <input
                    type="text"
                    value={editingConfig.mercuryBaseUrl}
                    placeholder="http://127.0.0.1:17344"
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setConfigDraft(previous => sanitizeDashboardConfig({
                        ...(previous || config),
                        mercuryBaseUrl: nextValue,
                      }));
                    }}
                  />
                </label>
              </div>
            </section>

              </>
              ) : null}

              {configTab === 'client' ? (
              <>
          <section className="app__config-section">
            <h3 className="app__config-section-title">Audio Alert Settings</h3>
            <div className="app__config-grid">
              <div className="app__config-audio-group app__config-row--full">
                <h4 className="app__config-audio-group-title">Regular Orders</h4>
                <div className="app__config-audio-group-grid">
                  <label className="app__config-row">
                    <span>Sound preset</span>
                    <select
                      value={editingConfig.soundPreset}
                      onChange={(event) => {
                        const nextPreset = normalizeSoundPreset(event.target.value);
                        setConfigDraft(previous => sanitizeDashboardConfig({
                          ...(previous || config),
                          soundPreset: nextPreset,
                        }));
                      }}
                    >
                      <option value="alarm_pulse">Alarm Pulse (default)</option>
                      <option value="classic_ding">Classic Ding</option>
                      <option value="bright_beep">Bright Beep</option>
                      <option value="custom_upload">Custom Uploaded Sound</option>
                    </select>
                  </label>
                  <div className="app__config-row">
                    <span>Audio file</span>
                    <div className="app__config-inline-actions">
                      <input
                        ref={soundUploadRef}
                        type="file"
                        accept=".wav,.mp3,.ogg,.m4a,audio/*"
                        onChange={(event) => {
                          void handleCustomSoundUpload(event);
                        }}
                      />
                      <button type="button" className="app__control-btn" onClick={clearCustomSound}>
                        Clear sound
                      </button>
                      <button
                        type="button"
                        className="app__control-btn"
                        onClick={() => queueAlertDings(1, { configOverride: editingConfig })}
                      >
                        <FontAwesomeIcon icon={faPlay} />
                        Test
                      </button>
                    </div>
                    <div className="app__config-help">Accepted formats: .wav, .mp3, .ogg, .m4a. Max 4 MB. Short clips are recommended.</div>
                  </div>
                </div>
              </div>
              <div className="app__config-audio-group app__config-row--full">
                <h4 className="app__config-audio-group-title">Delivery Service</h4>
                <div className="app__config-audio-group-grid">
                  <label className="app__config-row">
                    <span>Sound preset</span>
                    <select
                      value={editingConfig.marketplaceSoundPreset}
                      onChange={(event) => {
                        const nextPreset = normalizeSoundPreset(event.target.value);
                        setConfigDraft(previous => sanitizeDashboardConfig({
                          ...(previous || config),
                          marketplaceSoundPreset: nextPreset,
                        }));
                      }}
                    >
                      <option value="alarm_pulse">Alarm Pulse (default)</option>
                      <option value="classic_ding">Classic Ding</option>
                      <option value="bright_beep">Bright Beep</option>
                      <option value="custom_upload">Custom Uploaded Sound</option>
                    </select>
                  </label>
                  <div className="app__config-row">
                    <span>Audio file</span>
                    <div className="app__config-inline-actions">
                      <input
                        ref={marketplaceSoundUploadRef}
                        type="file"
                        accept=".wav,.mp3,.ogg,.m4a,audio/*"
                        onChange={(event) => {
                          void handleMarketplaceCustomSoundUpload(event);
                        }}
                      />
                      <button type="button" className="app__control-btn" onClick={clearMarketplaceCustomSound}>
                        Clear sound
                      </button>
                      <button
                        type="button"
                        className="app__control-btn"
                        onClick={() => queueAlertDings(1, {
                          configOverride: buildSoundConfigForAlertKind(editingConfig, 'marketplace'),
                        })}
                      >
                        <FontAwesomeIcon icon={faPlay} />
                        Test
                      </button>
                    </div>
                    <div className="app__config-help">Accepted formats: .wav, .mp3, .ogg, .m4a. Max 4 MB. Short clips are recommended.</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

              </>
              ) : null}
            </div>

            {pageSettingsPageId ? (
              <div
                className="app__page-settings-overlay"
                onClick={(event) => {
                  if (event.target === event.currentTarget) setPageSettingsPageId('');
                }}
              >
                <section className="app__page-settings-dialog" aria-label={`${pageDescription(pageSettingsPageId)} settings`}>
                  <div className="app__page-settings-header">
                    <div className="app__page-settings-title">
                      <FontAwesomeIcon icon={faGear} />
                      {pageDescription(pageSettingsPageId)} Settings
                    </div>
                    <button
                      type="button"
                      className="app__config-close-btn"
                      onClick={() => setPageSettingsPageId('')}
                      aria-label="Close page settings"
                    >
                      <FontAwesomeIcon icon={faXmark} />
                    </button>
                  </div>
                  <div className="app__page-settings-body">
                    {pageSettingsPageId === 'delivery_map' ? (
                      <section className="app__config-section">
                        <h3 className="app__config-section-title">Map View</h3>
                        <div className="app__config-grid">
                          <label className="app__config-row">
                            <span>Base zoom when one stop is mapped</span>
                            <input
                              type="number"
                              min={8}
                              max={18}
                              value={editingConfig.deliveryMapInitialZoom}
                              onChange={(event) => updateConfigNumber('deliveryMapInitialZoom', event.target.value)}
                            />
                          </label>
                          <label className="app__config-row">
                            <span>Minimum auto zoom</span>
                            <input
                              type="number"
                              min={8}
                              max={18}
                              value={editingConfig.deliveryMapMinZoom}
                              onChange={(event) => updateConfigNumber('deliveryMapMinZoom', event.target.value)}
                            />
                          </label>
                          <label className="app__config-row">
                            <span>Maximum auto zoom</span>
                            <input
                              type="number"
                              min={8}
                              max={18}
                              value={editingConfig.deliveryMapMaxZoom}
                              onChange={(event) => updateConfigNumber('deliveryMapMaxZoom', event.target.value)}
                            />
                          </label>
                          <label className="app__config-row">
                            <span>Auto zoom adjustment</span>
                            <input
                              type="number"
                              min={-4}
                              max={4}
                              value={editingConfig.deliveryMapZoomAdjustment}
                              onChange={(event) => updateConfigNumber('deliveryMapZoomAdjustment', event.target.value)}
                            />
                          </label>
                          <label className="app__config-row">
                            <span>Map edge padding (px)</span>
                            <input
                              type="number"
                              min={40}
                              max={260}
                              value={editingConfig.deliveryMapPadding}
                              onChange={(event) => updateConfigNumber('deliveryMapPadding', event.target.value)}
                            />
                          </label>
                        </div>
                        <div className="app__config-help">
                          The map fits remaining delivery pins plus the configured shop address, so it can zoom in as stops are completed while still keeping the Pittsburgh shop area in view.
                        </div>
                      </section>
                    ) : pageSettingsPageId === 'weather' ? (
                      <section className="app__config-section">
                        <h3 className="app__config-section-title">Weather Location</h3>
                        <div className="app__config-grid">
                          <label className="app__config-row">
                            <span>Weather ZIP code</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={5}
                              value={configWeatherZipDraft}
                              onChange={(event) => {
                                setConfigWeatherZipDraft(event.target.value.replace(/\D/g, '').slice(0, 5));
                              }}
                            />
                          </label>
                        </div>
                      </section>
                    ) : (
                      <div className="app__page-settings-empty">
                        No page-specific settings for this page yet.
                      </div>
                    )}
                  </div>
                  <div className="app__page-settings-actions">
                    <button type="button" className="app__control-btn" onClick={() => setPageSettingsPageId('')}>
                      Done
                    </button>
                  </div>
                </section>
              </div>
            ) : null}

            {tickerModuleSettingsId ? (() => {
              const tickerModuleDefinition = TICKER_MODULE_DEFINITIONS.find(definition => definition.id === tickerModuleSettingsId);
              const tickerModuleLabel = tickerModuleDefinition?.label || 'Ticker Module';
              return (
                <div
                  className="app__page-settings-overlay"
                  onClick={(event) => {
                    if (event.target === event.currentTarget) setTickerModuleSettingsId('');
                  }}
                >
                  <section className="app__page-settings-dialog" aria-label={`${tickerModuleLabel} ticker settings`}>
                    <div className="app__page-settings-header">
                      <div className="app__page-settings-title">
                        <FontAwesomeIcon icon={faGear} />
                        {tickerModuleLabel} Ticker Settings
                      </div>
                      <button
                        type="button"
                        className="app__config-close-btn"
                        onClick={() => setTickerModuleSettingsId('')}
                        aria-label="Close ticker module settings"
                      >
                        <FontAwesomeIcon icon={faXmark} />
                      </button>
                    </div>
                    <div className="app__page-settings-body">
                      {tickerModuleSettingsId === 'weather' ? (
                        <section className="app__config-section">
                          <h3 className="app__config-section-title">Weather Location</h3>
                          <div className="app__config-grid">
                            <label className="app__config-row">
                              <span>Weather ZIP code</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                maxLength={5}
                                value={configWeatherZipDraft}
                                onChange={(event) => {
                                  setConfigWeatherZipDraft(event.target.value.replace(/\D/g, '').slice(0, 5));
                                }}
                              />
                            </label>
                          </div>
                        </section>
                      ) : tickerModuleSettingsId === 'store_hours' ? (
                        <section className="app__config-section">
                          <h3 className="app__config-section-title">Store Hours</h3>
                          <div className="app__config-grid">
                            <label className="app__config-row app__config-toggle-row">
                              <span>Monday-Friday open</span>
                              <input
                                type="checkbox"
                                checked={editingConfig.storeHours.monFriEnabled}
                                onChange={(event) => updateStoreHours({ monFriEnabled: event.target.checked })}
                              />
                            </label>
                            <label className="app__config-row">
                              <span>Monday-Friday opens</span>
                              <input
                                type="time"
                                value={editingConfig.storeHours.monFriOpen}
                                onChange={(event) => updateStoreHours({ monFriOpen: event.target.value })}
                                disabled={!editingConfig.storeHours.monFriEnabled}
                              />
                            </label>
                            <label className="app__config-row">
                              <span>Monday-Friday closes</span>
                              <input
                                type="time"
                                value={editingConfig.storeHours.monFriClose}
                                onChange={(event) => updateStoreHours({ monFriClose: event.target.value })}
                                disabled={!editingConfig.storeHours.monFriEnabled}
                              />
                            </label>
                            <label className="app__config-row app__config-toggle-row">
                              <span>Saturday open</span>
                              <input
                                type="checkbox"
                                checked={editingConfig.storeHours.saturdayEnabled}
                                onChange={(event) => updateStoreHours({ saturdayEnabled: event.target.checked })}
                              />
                            </label>
                            <label className="app__config-row">
                              <span>Saturday opens</span>
                              <input
                                type="time"
                                value={editingConfig.storeHours.saturdayOpen}
                                onChange={(event) => updateStoreHours({ saturdayOpen: event.target.value })}
                                disabled={!editingConfig.storeHours.saturdayEnabled}
                              />
                            </label>
                            <label className="app__config-row">
                              <span>Saturday closes</span>
                              <input
                                type="time"
                                value={editingConfig.storeHours.saturdayClose}
                                onChange={(event) => updateStoreHours({ saturdayClose: event.target.value })}
                                disabled={!editingConfig.storeHours.saturdayEnabled}
                              />
                            </label>
                            <label className="app__config-row app__config-toggle-row">
                              <span>Sunday open</span>
                              <input
                                type="checkbox"
                                checked={editingConfig.storeHours.sundayEnabled}
                                onChange={(event) => updateStoreHours({ sundayEnabled: event.target.checked })}
                              />
                            </label>
                            <label className="app__config-row">
                              <span>Sunday opens</span>
                              <input
                                type="time"
                                value={editingConfig.storeHours.sundayOpen}
                                onChange={(event) => updateStoreHours({ sundayOpen: event.target.value })}
                                disabled={!editingConfig.storeHours.sundayEnabled}
                              />
                            </label>
                            <label className="app__config-row">
                              <span>Sunday closes</span>
                              <input
                                type="time"
                                value={editingConfig.storeHours.sundayClose}
                                onChange={(event) => updateStoreHours({ sundayClose: event.target.value })}
                                disabled={!editingConfig.storeHours.sundayEnabled}
                              />
                            </label>
                          </div>
                        </section>
                      ) : (
                        <div className="app__page-settings-empty">
                          No module-specific settings for this ticker module yet.
                        </div>
                      )}
                    </div>
                    <div className="app__page-settings-actions">
                      <button type="button" className="app__control-btn" onClick={() => setTickerModuleSettingsId('')}>
                        Done
                      </button>
                    </div>
                  </section>
                </div>
              );
            })() : null}

            <div className="app__config-actions">
              <button type="button" className="app__control-btn" onClick={cancelConfigChanges}>
                Cancel
              </button>
              <button type="button" className="app__control-btn" onClick={resetConfigDefaults}>
                Reset defaults
              </button>
              <button
                type="button"
                className="app__control-btn app__control-btn--primary"
                onClick={saveConfigChanges}
                disabled={!hasConfigChanges}
              >
                <FontAwesomeIcon icon={faFloppyDisk} />
                Save Config
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {feedErrorLabel ? <div className="app__error">{feedErrorLabel}</div> : null}

      {!isDashboardMode ? (
        <div className="app__rotation">
          <div className="app__rotation-main">
            <div className="app__rotation-chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="app__rotation-arrow"
                title="Previous page"
                style={{ border: 'none', background: 'none', padding: 0, marginRight: 4, cursor: hasMultiplePages ? 'pointer' : 'default', fontSize: 16, lineHeight: 1 }}
                aria-label="Previous page"
                onClick={goToPreviousPage}
                disabled={!hasMultiplePages}
              >
                <FontAwesomeIcon icon={faChevronLeft} />
              </button>
              <span>{`Page ${currentPageIndex + 1}/${enabledPages.length}: ${activePage?.label || 'Page'}`}</span>
              <button
                type="button"
                className="app__rotation-arrow"
                title="Next page"
                style={{ border: 'none', background: 'none', padding: 0, marginLeft: 4, cursor: hasMultiplePages ? 'pointer' : 'default', fontSize: 16, lineHeight: 1 }}
                aria-label="Next page"
                onClick={goToNextPage}
                disabled={!hasMultiplePages}
              >
                <FontAwesomeIcon icon={faChevronRight} />
              </button>
            </div>
            <button
              type="button"
              className={`app__control-btn app__control-btn--toggle${config.pageAutoRotateEnabled ? ' app__control-btn--toggle-active' : ''}`}
              onClick={togglePageAutoRotate}
              title="Toggle auto page rotation"
              aria-pressed={config.pageAutoRotateEnabled}
              disabled={!hasMultiplePages}
            >
              <FontAwesomeIcon icon={faScroll} />
              {config.pageAutoRotateEnabled ? 'Auto Rotate: On' : 'Auto Rotate: Off'}
            </button>
            <button
              type="button"
              className="app__control-btn"
              onClick={openConfigPage}
              title="Open dashboard configuration"
            >
              <FontAwesomeIcon icon={faGear} /> Config
            </button>
          </div>
        </div>
      ) : null}

      <main className={`board-page${error ? ' board-page--disabled' : ''}${selectedDeliveryMapPin ? ' board-page--popup-open' : ''}`}>
        {loading ? (
          <div className="board-loading-overlay" role="status" aria-live="polite" aria-label="Loading board">
            <span className="board-loading-overlay__spinner" aria-hidden="true" />
            <span className="board-loading-overlay__label">Loading Orders</span>
          </div>
        ) : null}
        {activePage?.id === 'alerts_active' ? (
        <div className="board-lanes board-lanes--two">
            <section className="lane lane--critical">
              <header className="lane__header">
                <h2>New Orders + Unanswered Messages</h2>
                <span className="lane__count">{pendingTickets.length}</span>
              </header>
              <div className="lane__cards" ref={pendingListRef}>
                {pendingTickets.length === 0 ? (
                  <div className="lane__empty">
                    <FontAwesomeIcon className="lane__empty-icon" icon={faInbox} />
                    <span className="lane__empty-text">No pending intake tickets right now.</span>
                  </div>
                ) : (
                  pendingTickets.map(ticket => {
                    const intakeBadge = intakeBadgeForTicket(ticket);
                    const showSourceBadge = shouldShowSourceBadge(ticket);
                    const showNewOrderTotalPill = ticket.kind === 'uncreated';
                    const showInlineDisplayRef = Boolean(ticket.displayRef) && !ticket.relatedOrderNumber;
                    const destinationLabelText = ticket.destinationLabel || '--';
                    const deliveryDateText = formatDateOnly(ticket.deliveryDate) || '--';
                    const displayRecipientName = formatDisplayRecipientName(
                      ticket.recipientName || ticket.summary || 'Incoming Ticket',
                    );
                    const gateResults = ticket.gateResults || [];
                    const hasRejectGate = gateResults.some(result => result.severity === 'reject');
                    const hasReviewGate = gateResults.length > 0 && !hasRejectGate;
                    const gateTitle = gateResults.map(result => `${result.label}: ${result.detail}`).join('\n');
                    return (
                      <article
                        key={ticket.id}
                        className={`ticket-card${ticket.kind === 'uncreated' && ticket.messageTypeKey === 'unknown' ? ' ticket-card--uncreated' : ''}${ticket.isFlashing ? ' ticket-card--flash' : ''}${ticket.isMarketplace ? ' ticket-card--marketplace' : ''}${ticket.isStaleAsk ? ' ticket-card--ask-stale' : ''}${hasRejectGate ? ' ticket-card--gate-reject' : ''}${hasReviewGate ? ' ticket-card--gate-review' : ''}`}
                        title={gateTitle || undefined}
                      >
                        <header className="ticket-card__header">
                          <div className="ticket-card__kind-pills">
                            <span className={`badge ${intakeBadge.className}`}>
                              {intakeBadge.label}
                            </span>
                            {showSourceBadge ? (
                              <span className="badge badge--source">{sourcePillLabel(ticket.wireService)}</span>
                            ) : null}
                            {showNewOrderTotalPill ? (
                              <span className="badge badge--total">{ticket.orderAmount || '--'}</span>
                            ) : null}
                            {gateResults.slice(0, 3).map(result => (
                              <span
                                key={result.key}
                                className={`badge ${result.severity === 'reject' ? 'badge--gate-reject' : 'badge--gate-review'}`}
                                title={result.detail}
                              >
                                <FontAwesomeIcon icon={faTriangleExclamation} className="badge__icon" />
                                {result.label}
                              </span>
                            ))}
                            {gateResults.length > 3 ? (
                              <span className="badge badge--gate-review" title={gateTitle}>
                                +{gateResults.length - 3}
                              </span>
                            ) : null}
                            {ticket.distanceMilesLabel ? (
                              <span className="badge badge--distance">{ticket.distanceMilesLabel}</span>
                            ) : null}
                          </div>
                          <div className="ticket-card__pills">
                            {ticket.relatedOrderNumber ? (
                              <span className="badge badge--linked">ORDER {ticket.relatedOrderNumber}</span>
                            ) : null}
                            {ticket.relatedOrderStatus ? (() => {
                              const statusText = String(ticket.relatedOrderStatus || '').trim();
                              const statusDisplayText = statusText.toUpperCase();
                              const semantic = deliverySemanticFromStatusText(statusText);
                              const shouldHideLinkedStatus = ticket.kind === 'uncreated' && semantic === 'queued';
                              if (shouldHideLinkedStatus) return null;
                              const badgeClass = linkedOrderStatusBadgeClass(statusText);
                              const statusIcon = semantic === 'exception'
                                ? faTriangleExclamation
                                : (semantic === 'delivered' ? faTruck : (semantic === 'queued' ? faClock : null));
                              return (
                                <span className={`badge ${badgeClass}`}>
                                  {statusIcon ? <FontAwesomeIcon icon={statusIcon} className="badge__icon" /> : null}
                                  {statusDisplayText}
                                </span>
                              );
                            })() : null}
                            {askDebugEnabled && ticket.kind === 'ask' && !ticket.relatedOrderNumber && ticket.askDebugSummary ? (
                              <span
                                className="badge badge--debug"
                                title={[
                                  ticket.askDebugSummary,
                                  ticket.askMessageKeys.length ? `Keys: ${ticket.askMessageKeys.join(', ')}` : 'Keys: none',
                                  ...ticket.askDebugDetails,
                                ].join('\n')}
                              >
                                ASK DEBUG
                              </span>
                            ) : null}
                            {ticket.isStaleAsk ? <span className="badge badge--stale-ask">{Math.max(1, config.askStaleHours)}h+ Stale</span> : null}
                          </div>
                        </header>
                        <div className="ticket-card__main-row">
                          <div className="ticket-card__name">
                            {displayRecipientName}
                            {showInlineDisplayRef ? ` - ${ticket.displayRef}` : ''}
                          </div>
                          <div className="ticket-card__delivery-inline">
                            <span className="ticket-card__delivery-destination">{destinationLabelText}</span>
                            <span className="ticket-card__delivery-date">{deliveryDateText}</span>
                          </div>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>

            <section className="lane lane--with-progress">
              <header className="lane__header">
                <div className="lane__title-block">
                  <h2 className="lane__title-inline">
                    <span>{showCompleted ? 'Orders (Including Completed)' : 'Active Orders'}</span>
                    {isRefreshingActiveOrders ? <span className="lane__spinner" aria-hidden="true" /> : null}
                  </h2>
                  <div className="lane__submeta">
                    <span>{selectedDayCountLabel}: {visibleTodayCount}</span>
                    <span>Next day: {nextDaySummaryCount}</span>
                  </div>
                </div>
                <div className="lane__header-actions">
                  <div className={`lane__search${isActiveSearchOpen ? ' lane__search--open' : ''}`}>
                    <button
                      type="button"
                      className="lane__search-toggle"
                      aria-label={isActiveSearchOpen ? 'Close active order search' : 'Open active order search'}
                      title={isActiveSearchOpen ? 'Close search' : 'Search active orders'}
                      onClick={() => {
                        if (activeOrderSearchQuery) {
                          setActiveOrderSearchQuery('');
                          return;
                        }
                        if (isActiveSearchOpen) {
                          setIsActiveSearchOpen(false);
                          return;
                        }
                        setIsActiveSearchOpen(true);
                      }}
                    >
                      <FontAwesomeIcon icon={activeOrderSearchQuery ? faXmark : faMagnifyingGlass} />
                    </button>
                    {isActiveSearchOpen ? (
                      <input
                        className="lane__search-input"
                        type="text"
                        value={activeOrderSearchQuery}
                        onChange={(event) => setActiveOrderSearchQuery(event.target.value)}
                        placeholder="Filter active orders"
                        aria-label="Filter active orders"
                      />
                    ) : null}
                  </div>
                  <span className="lane__count">{filteredActiveOrders.length}</span>
                </div>
              </header>
              <div className="lane__cards lane__cards--two-col" ref={activeListRef}>
                {filteredActiveOrders.length === 0 ? (
                  <div className="lane__empty">
                    <FontAwesomeIcon className="lane__empty-icon" icon={faTruck} />
                    <span className="lane__empty-text">
                      {normalizedActiveOrderSearchQuery ? 'No active orders match this filter.' : 'No active orders at the moment.'}
                    </span>
                  </div>
                ) : (
                  filteredActiveOrders.map(card => {
                    const statusPill = singleStatusPill(card);
                    const footerZip = deriveCardFooterZip(card);
                    const pickupSale = isPickupOrCodOrderType(card.orderType)
                      || hasPickupKeyword(card.addressLine, card.recipientName)
                      // Fallback: no recipient, no address, no city → store pickup.
                      // Intentionally includes "Wire In" orders: wire-ins always have recipient data;
                      // a wire-in with empty name/address/city is a customer picking up at the store.
                      || (!card.recipientName.trim() && !card.addressLine.trim() && !card.cityStateZip.trim()
                          && !isLocalOrderType(card.orderType));
                    const displayRecipientName = pickupSale
                      ? 'PICKUP'
                      : formatDisplayRecipientName(card.recipientName || 'Unknown Recipient');
                    return (
                      <article
                        key={card.ticketId}
                        className={`order-card order-card--state-${statusPill.theme}${card.isMarketplace ? ' order-card--marketplace' : ''}`}
                      >
                        <header className="order-card__header">
                          <span className="order-card__ref">{card.userReference || card.ticketId}</span>
                          <div className="order-card__pills">
                            <span className={`badge badge--stage badge--state-${statusPill.theme}`}>
                              {statusPill.label}
                            </span>
                            {pickupSale ? <span className="badge">Pickup</span> : null}
                          </div>
                        </header>
                        <div className="order-card__name">{displayRecipientName}</div>
                        {pickupSale ? null : <div className="order-card__meta">{card.addressLine || 'No street address'}</div>}
                        {pickupSale ? null : <div className="order-card__meta">{card.cityStateZip || 'No city/state/zip'}</div>}
                        <footer className="order-card__footer">
                          <span className="order-card__footer-item">{formatDateOnly(card.deliveryDate) || '--'}</span>
                          {footerZip ? <span className="order-card__footer-item">{footerZip}</span> : null}
                        </footer>
                      </article>
                    );
                  })
                )}
              </div>
              <footer className="lane__progress">
                <div className="lane__progress-meta" style={{ marginBottom: 0 }}>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      className="lane__progress-track"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={selectedDayCompletionPercent}
                      aria-label="Selected day order completion"
                      style={{ flex: 1 }}
                    >
                      <div
                        className={`lane__progress-fill${selectedDayCompletionIsComplete ? ' lane__progress-fill--complete' : ''}`}
                        style={{ width: `${selectedDayCompletionPercent}%` }}
                      />
                    </div>
                    <span style={{ minWidth: 44, textAlign: 'right', fontSize: '1.08em', fontWeight: 800 }}>{selectedDayCompletionPercent}%</span>
                  </div>
                </div>
              </footer>
            </section>
          </div>
        ) : activePage?.id === 'page2' ? (
          <div className="page2">
            {isRefreshingActiveOrders ? (
              <div className="board-loading-overlay board-loading-overlay--inline" role="status" aria-live="polite" aria-label="Loading order data">
                <span className="board-loading-overlay__spinner" aria-hidden="true" />
                <span className="board-loading-overlay__label">Loading Orders</span>
              </div>
            ) : null}
            {/* Row 1: Order Status (left) + Financials (right) side-by-side panes */}
            <div className="page2__kpi-panes">

              {/* Left pane — Order Status */}
              <div className="page2__kpi-pane">
                <div className="page2__pane-title">Order Status</div>
                <div className="page2__pane-grid page2__pane-grid--status">
                  {/* Delivered — spans all 3 cols */}
                  <div className="page2__cell page2__cell--span page2__cell--delivered">
                    <span className="page2__cell-value">
                      {todayStageCounts.delivered}
                      {selectedDayOrderTotal > 0 && <span className="page2__cell-denom">/{selectedDayOrderTotal}</span>}
                    </span>
                    <span className="page2__cell-label">Delivered</span>
                  </div>
                  {/* Row 2 */}
                  <div className="page2__cell page2__cell--on-truck">
                    <span className="page2__cell-value">{todayStageCounts.queued + todayStageCounts.designed + todayStageCounts.staged + todayStageCounts.onTruck}</span>
                    <span className="page2__cell-label">In Progress</span>
                  </div>
                  <div className={`page2__cell${todayStageCounts.exceptions > 0 ? ' page2__cell--exception' : ''}`}>
                    <span className="page2__cell-value">{todayStageCounts.exceptions}</span>
                    <span className="page2__cell-label">Exceptions</span>
                  </div>
                  <div className={`page2__cell${todayStageCounts.canceled > 0 ? ' page2__cell--canceled' : ''}`}>
                    <span className="page2__cell-value">{todayStageCounts.canceled}</span>
                    <span className="page2__cell-label">Canceled</span>
                  </div>
                  {/* Row 3 */}
                  <div className={`page2__cell${todayStageCounts.marketplace > 0 ? ' page2__cell--marketplace' : ''}`}>
                    <span className="page2__cell-value">{todayStageCounts.marketplace}</span>
                    <span className="page2__cell-label">Marketplace</span>
                  </div>
                  <div className="page2__cell page2__cell--next-day">
                    <span className="page2__cell-value">{nextDaySummaryCount}</span>
                    <span className="page2__cell-label">Next Day</span>
                  </div>
                  <div className={`page2__cell page2__cell--completion${selectedDayCompletionIsComplete ? ' page2__cell--delivered' : ''}`}>
                    <span className="page2__cell-value">{selectedDayCompletionPercent}%</span>
                    <span className="page2__cell-label">{selectedDayOrderCompleted}/{selectedDayOrderTotal} Complete</span>
                    <div className="page2__cell-progress">
                      <div
                        className={`page2__cell-progress-fill${selectedDayCompletionIsComplete ? ' page2__cell-progress-fill--complete' : ''}`}
                        style={{ width: `${selectedDayCompletionPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right pane — Financials */}
              <div className="page2__kpi-pane">
                <div className="page2__pane-title">
                  Financials
                  <button
                    type="button"
                    className={`page2__mask-toggle${financialsMasked ? ' page2__mask-toggle--active' : ''}`}
                    onClick={() => setFinancialsMasked(v => !v)}
                    title={financialsMasked ? 'Unmask financials' : 'Mask financials'}
                  >
                    {financialsMasked ? 'Unmask' : 'Mask'}
                  </button>
                </div>
                <div className="page2__pane-grid page2__pane-grid--financials">
                  {/* Quadrant: 2×2 equal cells */}
                  <div className="page2__cell page2__cell--revenue">
                    <span className="page2__cell-value page2__cell-value--currency">
                      {todayFinancials.revenue > 0
                        ? financialsMasked ? '$##,###' : `$${todayFinancials.revenue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                        : '—'}
                    </span>
                    <span className="page2__cell-label">
                      Revenue
                      {lastYearStats && lastYearStats.revenue > 0 && todayFinancials.revenue > 0 && (() => {
                        const pct = Math.round(((todayFinancials.revenue - lastYearStats.revenue) / lastYearStats.revenue) * 100);
                        return <span className={`kpi-card__yoy${pct >= 0 ? ' kpi-card__yoy--up' : ' kpi-card__yoy--down'}`}><FontAwesomeIcon icon={pct >= 0 ? faArrowUp : faArrowDown} className="kpi-card__yoy-arrow" />{pct >= 0 ? `+${pct}%` : `${pct}%`} YoY</span>;
                      })()}
                    </span>
                  </div>
                  <div className="page2__cell page2__cell--avg">
                    <span className="page2__cell-value page2__cell-value--currency">
                      {todayFinancials.avgTicket > 0
                        ? financialsMasked ? '$###' : `$${todayFinancials.avgTicket.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                        : '—'}
                    </span>
                    <span className="page2__cell-label">
                      Avg Ticket
                      {lastYearStats && lastYearStats.avgTicket > 0 && todayFinancials.avgTicket > 0 && (() => {
                        const pct = Math.round(((todayFinancials.avgTicket - lastYearStats.avgTicket) / lastYearStats.avgTicket) * 100);
                        return <span className={`kpi-card__yoy${pct >= 0 ? ' kpi-card__yoy--up' : ' kpi-card__yoy--down'}`}><FontAwesomeIcon icon={pct >= 0 ? faArrowUp : faArrowDown} className="kpi-card__yoy-arrow" />{pct >= 0 ? `+${pct}%` : `${pct}%`} YoY</span>;
                      })()}
                    </span>
                  </div>
                  <div className="page2__cell page2__cell--largest">
                    <span className="page2__cell-value page2__cell-value--currency">
                      {todayFinancials.largestOrder > 0
                        ? financialsMasked ? '$###.##' : `$${todayFinancials.largestOrder.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '—'}
                    </span>
                    <span className="page2__cell-label">Largest Order</span>
                  </div>
                  <div className="page2__cell">
                    <span className="page2__cell-value">
                      {todayFinancials.wireInCount}
                      {todayFinancials.wireInCount > 0 && todayFinancials.wireInRevenue > 0 && (
                        <span className="page2__cell-denom">
                          {financialsMasked ? ' · $##,###' : ` · $${todayFinancials.wireInRevenue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
                        </span>
                      )}
                    </span>
                    <span className="page2__cell-label">
                      Wire-In
                      {lastYearStats && (() => {
                        const pct = lastYearStats.count > 0 ? Math.round(((selectedDayOrderTotal - lastYearStats.count) / lastYearStats.count) * 100) : null;
                        return pct !== null
                          ? <span className={`kpi-card__yoy${pct >= 0 ? ' kpi-card__yoy--up' : ' kpi-card__yoy--down'}`}><FontAwesomeIcon icon={pct >= 0 ? faArrowUp : faArrowDown} className="kpi-card__yoy-arrow" />{pct >= 0 ? `+${pct}%` : `${pct}%`} orders YoY</span>
                          : null;
                      })()}
                    </span>
                  </div>
                </div>
              </div>

            </div>

            {/* Row 3: Order intake chart — fills remaining space */}
            <div className="page2__chart-panel">
              <div className="page2__chart-header">
                <span className="page2__chart-title">Order Intake</span>
                <span className="page2__chart-legend">
                  <span className="page2__chart-legend-item">
                    <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="#4caf86" strokeWidth="2" strokeDasharray="4 2" /><circle cx="12" cy="5" r="3" fill="#4caf86" /></svg>
                    Per Hour
                  </span>
                  <span className="page2__chart-legend-item">
                    <svg width="36" height="10">
                      <line x1="0" y1="5" x2="18" y2="5" stroke="#1a5585" strokeWidth="2.5" />
                      <line x1="18" y1="5" x2="36" y2="5" stroke="#6db0ef" strokeWidth="2.5" strokeDasharray="4 2" />
                      <circle cx="18" cy="5" r="3" fill="#1a5585" stroke="#fff" strokeWidth="1" />
                    </svg>
                    Cumulative
                  </span>
                  {lastYearSaleDates.length > 0 && (
                    <span className="page2__chart-legend-item">
                      <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="#c8a800" strokeWidth="2" strokeDasharray="4 3" /></svg>
                      {new Date().getFullYear() - 1} Total
                    </span>
                  )}
                </span>
              </div>
              <div className="page2__chart-body">
              {chartLineData.todayCumulativePoints.every(p => p.cumulative === 0) && !lastYearSaleDates.length ? (
                <div className="page2__chart-empty">No orders recorded yet today</div>
              ) : (
                <svg
                  viewBox={`0 0 ${CHART_VW} ${CHART_VH}`}
                  width="100%"
                  height="100%"
                  preserveAspectRatio="none"
                  aria-label="Orders placed today by hour and cumulative"
                  className="page2__chart-svg"
                >
                  {/* Horizontal gridlines + left y-axis labels (cumulative scale) */}
                  {[0, 0.25, 0.5, 0.75, 1].map(f => {
                    const y = CHART_MT + Math.round(CHART_PH * (1 - f));
                    const val = Math.round(chartLineData.yMaxCumulative * f);
                    return (
                      <g key={f}>
                        <line x1={CHART_ML} y1={y} x2={CHART_ML + CHART_PW} y2={y} stroke={f === 0 ? '#9ea8b7' : '#dde4ec'} strokeWidth={f === 0 ? 1.5 : 1} />
                        <text x={CHART_ML - 5} y={y} fontSize="11" fill="#6a7e96" textAnchor="end" dominantBaseline="middle">{val}</text>
                      </g>
                    );
                  })}
                  {/* X-axis: every 2 hours, midnight to midnight */}
                  {CHART_VISIBLE_HOURS.filter(h => h % 2 === 0).map(hour => {
                    const x = CHART_ML + Math.round((hour / 23) * CHART_PW);
                    const label = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`;
                    const isActive = chartLineData.todayHourlyPoints.some(p => p.hour === hour && p.count > 0);
                    return (
                      <text key={hour} x={x} y={CHART_MT + CHART_PH + 17} fontSize="10" textAnchor="middle" fill={isActive ? '#334e6e' : '#b0bec8'} fontWeight={isActive ? '600' : '400'}>
                        {label}
                      </text>
                    );
                  })}
                  {/* Last year total — horizontal reference line */}
                  {lastYearSaleDates.length > 0 && (() => {
                    const lyTotal = lastYearSaleDates.length;
                    const lyYear = new Date().getFullYear() - 1;
                    const lyY = CHART_MT + Math.round(CHART_PH * (1 - lyTotal / chartLineData.yMaxCumulative));
                    const clampedY = Math.max(lyY, CHART_MT + 1);
                    return (
                      <g>
                        <line x1={CHART_ML} y1={clampedY} x2={CHART_ML + CHART_PW} y2={clampedY} stroke="#c8a800" strokeWidth="1.5" strokeDasharray="6 4" />
                        <text x={CHART_ML + CHART_PW + 4} y={clampedY - 5} fontSize="11" fill="#7a5800" dominantBaseline="auto" fontWeight="700" stroke="white" strokeWidth="3" paintOrder="stroke">
                          {lyTotal}
                        </text>
                        <text x={CHART_ML + CHART_PW + 4} y={clampedY + 4} fontSize="9" fill="#a07820" dominantBaseline="hanging" fontWeight="600" stroke="white" strokeWidth="2.5" paintOrder="stroke">
                          ({lyYear})
                        </text>
                      </g>
                    );
                  })()}
                  {/* Current time — vertical red marker */}
                  {(() => {
                    const nowFrac = tickerNow.getHours() + tickerNow.getMinutes() / 60;
                    const nowX = CHART_ML + Math.round((nowFrac / 23) * CHART_PW);
                    return (
                      <line
                        x1={nowX} y1={CHART_MT}
                        x2={nowX} y2={CHART_MT + CHART_PH}
                        stroke="#e53935"
                        strokeWidth="1.5"
                        strokeDasharray="3 2"
                        opacity="0.7"
                      />
                    );
                  })()}
                  {/* Today hourly line — solid green for past/now, dashed light green for future */}
                  {(() => {
                    const nowHour = tickerNow.getHours();
                    const pastNowPts = chartLineData.todayHourlyPoints;
                    const futurePts = chartLineData.fullDayHourlyPoints.filter(p => p.hour > nowHour);
                    // Bridge: last past/now point + first future so the line is continuous
                    const bridgePt = pastNowPts.length > 0 && futurePts.length > 0
                      ? [pastNowPts[pastNowPts.length - 1], futurePts[0]]
                      : null;
                    return (
                      <>
                        {/* Future hours: dashed light green */}
                        {futurePts.length > 0 && bridgePt && (
                          <polyline
                            points={[...bridgePt, ...futurePts.slice(1)].map(p => `${p.x},${p.y}`).join(' ')}
                            fill="none" stroke="#a8d5b8" strokeWidth="2"
                            strokeDasharray="5 3"
                            strokeLinejoin="round" strokeLinecap="round"
                          />
                        )}
                        {/* Past/now hours: solid green */}
                        {pastNowPts.length > 1 && (
                          <polyline
                            points={pastNowPts.map(p => `${p.x},${p.y}`).join(' ')}
                            fill="none" stroke="#4caf86" strokeWidth="2"
                            strokeLinejoin="round" strokeLinecap="round"
                          />
                        )}
                      </>
                    );
                  })()}
                  {chartLineData.todayHourlyPoints.filter(p => p.count > 0).map(p => {
                    const labelY = Math.min(p.y + 14, CHART_MT + CHART_PH - 3);
                    return (
                      <g key={`hr-${p.hour}`}>
                        <circle cx={p.x} cy={p.y} r={3.5} fill="#4caf86" stroke="#fff" strokeWidth="1.5" />
                        <text x={p.x} y={labelY} fontSize="10" textAnchor="middle" dominantBaseline="auto" fill="#2e8a60" fontWeight="700" stroke="white" strokeWidth="3" paintOrder="stroke">
                          {p.count}
                        </text>
                      </g>
                    );
                  })}
                  {/* Cumulative line — dark blue up to now, dashed light blue for future */}
                  {(() => {
                    const nowHour = tickerNow.getHours();
                    const allPts = chartLineData.todayCumulativePoints;
                    // Past+current = everything up to and including the current hour (dark blue)
                    const pastPts = allPts.filter(p => p.hour <= nowHour);
                    const anchorPt = pastPts[pastPts.length - 1];
                    // Future: full-day points strictly after current hour (dashed light blue)
                    const futurePts = chartLineData.fullDayCumulativePoints.filter(p => p.hour > nowHour);
                    const futureBridge = anchorPt && futurePts.length > 0
                      ? [anchorPt, ...futurePts]
                      : null;
                    return (
                      <>
                        {/* Future hours: dashed light blue — orders already on the books ahead */}
                        {futureBridge && futureBridge.length > 1 && (
                          <polyline
                            points={futureBridge.map(p => `${p.x},${p.y}`).join(' ')}
                            fill="none" stroke="#6db0ef" strokeWidth="2"
                            strokeDasharray="6 3"
                            strokeLinejoin="round" strokeLinecap="round"
                            opacity="0.7"
                          />
                        )}
                        {/* Past + current hour: dark blue — grows as the red line advances */}
                        {pastPts.length > 1 && (
                          <polyline
                            points={pastPts.map(p => `${p.x},${p.y}`).join(' ')}
                            fill="none" stroke="#1a5585" strokeWidth="2.5"
                            strokeLinejoin="round" strokeLinecap="round"
                          />
                        )}
                      </>
                    );
                  })()}
                  {chartLineData.todayCumulativePoints.filter(p => p.cumulative > 0).map((p, idx, arr) => {
                    const nowHour = tickerNow.getHours();
                    const isLast = idx === arr.length - 1;
                    const isPastOrNow = p.hour <= nowHour;
                    const showLabel = isLast || (idx > 0 && arr[idx - 1].cumulative !== p.cumulative);
                    const labelY = Math.max(p.y - 9, CHART_MT + 13);
                    const dotColor = isPastOrNow ? '#1a5585' : '#6db0ef';
                    return (
                      <g key={`cum-${p.hour}`}>
                        <circle cx={p.x} cy={p.y} r={isLast ? 5 : 3.5} fill={dotColor} stroke="#fff" strokeWidth="1.5" />
                        {showLabel && (
                          <text x={p.x} y={labelY} fontSize={isLast ? '13' : '11'} textAnchor="middle" dominantBaseline="auto" fill={dotColor} fontWeight={isLast ? '800' : '600'} stroke="white" strokeWidth="3" paintOrder="stroke">
                            {p.cumulative}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}
              </div>
            </div>

          </div>
        ) : activePage?.id === 'delivery_map' ? (
          <div className="delivery-map-page">
            {(isRefreshingActiveOrders || deliveryMapLoading) ? (
              <div className="board-loading-overlay board-loading-overlay--inline" role="status" aria-live="polite" aria-label="Loading delivery map">
                <span className="board-loading-overlay__spinner" aria-hidden="true" />
                <span className="board-loading-overlay__label">Loading Map</span>
              </div>
            ) : null}
            <div className="delivery-map-page__panel">
              <div className="delivery-map-page__header">
                <span>Delivery Map</span>
                <span>
                  {selectedDayCountLabel}: {positionedDeliveryMapPins.length}/{selectedDayDeliveryMapOrders.length} mapped
                  {deliveryMapViewport ? ` - auto-centered zoom ${deliveryMapViewport.zoom}` : ''}
                </span>
              </div>
              {deliveryMapUrl && positionedDeliveryMapPins.length ? (
                <div className="delivery-map-page__body">
                  <div
                    ref={deliveryMapFullscreenRef}
                    className="delivery-map-page__map"
                    onClick={() => {
                      setSelectedDeliveryMapPinId('');
                      setHoveredDeliveryMapPinId('');
                    }}
                  >
                    <div className="delivery-map-page__map-controls" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="delivery-map-page__map-control-btn"
                        onClick={() => updateDeliveryMapClientZoomAdjustment(1)}
                        disabled={effectiveDeliveryMapZoomAdjustment >= 4}
                        title={`Increase map zoom for this screen (${effectiveDeliveryMapZoomAdjustment})`}
                        aria-label="Increase map zoom"
                      >
                        <FontAwesomeIcon icon={faPlus} />
                      </button>
                      <button
                        type="button"
                        className="delivery-map-page__map-control-btn"
                        onClick={() => updateDeliveryMapClientZoomAdjustment(-1)}
                        disabled={effectiveDeliveryMapZoomAdjustment <= -4}
                        title={`Decrease map zoom for this screen (${effectiveDeliveryMapZoomAdjustment})`}
                        aria-label="Decrease map zoom"
                      >
                        <FontAwesomeIcon icon={faMinus} />
                      </button>
                      <button
                        type="button"
                        className="delivery-map-page__map-control-btn"
                        onClick={fitDeliveryMapToPins}
                        disabled={effectiveDeliveryMapZoomAdjustment === 0}
                        title="Fit all map pins on this screen"
                        aria-label="Fit all map pins"
                      >
                        <FontAwesomeIcon icon={faDownLeftAndUpRightToCenter} />
                      </button>
                      <button
                        type="button"
                        className="delivery-map-page__map-control-btn"
                        onClick={toggleDeliveryMapFullscreen}
                        title="Expand delivery map"
                        aria-label="Expand delivery map"
                      >
                        <FontAwesomeIcon icon={faUpRightAndDownLeftFromCenter} />
                      </button>
                    </div>
                    <img src={deliveryMapUrl} alt={`Delivery map for ${selectedDayCountLabel}`} />
                    {positionedDeliveryMapPins.map((pin, index) => (
                      <button
                        key={`${pin.id}-${index}`}
                        type="button"
                        className={`delivery-map-page__pin${activeDeliveryMapPinId === pin.id ? ' delivery-map-page__pin--active' : ''}`}
                        style={{ left: `${pin.xPercent}%`, top: `${pin.yPercent}%` }}
                        title={`${pin.label}\n${pin.address}`}
                        aria-label={`${pin.label}, ${pin.address}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setHoveredDeliveryMapPinId('');
                          setSelectedDeliveryMapPinId(previous => previous === pin.id ? '' : pin.id);
                        }}
                      >
                        <span>{index + 1}</span>
                      </button>
                    ))}
                    {selectedDeliveryMapPin ? (
                      <div
                        className="delivery-map-page__popup"
                        style={{
                          left: `${Math.max(18, Math.min(82, selectedDeliveryMapPin.xPercent))}%`,
                          top: `${Math.max(18, Math.min(76, selectedDeliveryMapPin.yPercent))}%`,
                        }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="delivery-map-page__popup-close"
                          aria-label="Close delivery details"
                          onClick={() => {
                            setSelectedDeliveryMapPinId('');
                            setHoveredDeliveryMapPinId('');
                          }}
                        >
                          <FontAwesomeIcon icon={faXmark} />
                        </button>
                        <div className="delivery-map-page__popup-title">{selectedDeliveryMapPin.label}</div>
                        {selectedDeliveryMapPin.orderRef ? (
                          <div className="delivery-map-page__popup-row">
                            <strong>Order</strong>
                            <span>{selectedDeliveryMapPin.orderRef}</span>
                          </div>
                        ) : null}
                        <div className="delivery-map-page__popup-row">
                          <strong>Status</strong>
                          <span>{selectedDeliveryMapPin.statusLabel}</span>
                        </div>
                        <div className="delivery-map-page__popup-row">
                          <strong>Date</strong>
                          <span>{selectedDeliveryMapPin.deliveryDate}</span>
                        </div>
                        <div className="delivery-map-page__popup-address">{selectedDeliveryMapPin.address}</div>
                      </div>
                    ) : null}
                  </div>
                  <aside className="delivery-map-page__legend" aria-label="Delivery map key">
                    <div className="delivery-map-page__legend-header">
                      <span>Map Key</span>
                      <span>{positionedDeliveryMapPins.length}</span>
                    </div>
                    <div className="delivery-map-page__legend-list">
                      {positionedDeliveryMapPins.map((pin, index) => (
                        <button
                          key={`legend-${pin.id}-${index}`}
                          type="button"
                          className={`delivery-map-page__legend-row${activeDeliveryMapPinId === pin.id ? ' delivery-map-page__legend-row--active' : ''}`}
                          onMouseEnter={() => setHoveredDeliveryMapPinId(pin.id)}
                          onMouseLeave={() => setHoveredDeliveryMapPinId('')}
                          onFocus={() => setHoveredDeliveryMapPinId(pin.id)}
                          onBlur={() => setHoveredDeliveryMapPinId('')}
                          onClick={() => {
                            setHoveredDeliveryMapPinId('');
                            setSelectedDeliveryMapPinId(previous => previous === pin.id ? '' : pin.id);
                          }}
                          title={`${pin.label}\n${pin.address}`}
                          aria-label={`Map item ${index + 1}, order ${pin.orderRef || pin.id}`}
                        >
                          <span className="delivery-map-page__legend-number">{index + 1}</span>
                          <span className="delivery-map-page__legend-copy">
                            <strong>{pin.orderRef || pin.id}</strong>
                            <span>{pin.label}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </aside>
                </div>
              ) : (
                <div className="delivery-map-page__empty">
                  <FontAwesomeIcon icon={faTruck} aria-hidden="true" />
                  <span>{deliveryMapError || 'No mappable deliveries for the selected date.'}</span>
                </div>
              )}
            </div>
          </div>
        ) : activePage?.id === 'weather' ? (
          <div className="weather-page">
            {weatherForecastLoading && !visibleWeatherForecastData ? (
              <div className="weather-page__loading">
                <span className="board-loading-overlay__spinner" aria-hidden="true" />
                <span>Loading weather…</span>
              </div>
            ) : !visibleWeatherForecastData ? (
              <div className="weather-page__error">
                Unable to load weather data. Retrying shortly; check the ZIP code in Settings if this keeps happening.
              </div>
            ) : (() => {
              const { current, today, tomorrow, hourly, location } = visibleWeatherForecastData;
              const curDisplay = weatherCodeDisplay(current.weatherCode, current.isDay);
              const todayDisplay = weatherCodeDisplay(today.weatherCode, true);
              const tomorrowDisplay = weatherCodeDisplay(tomorrow.weatherCode, true);
              const windDir = degreesToCompass(current.windDirection);
              const ccefSrc = (code: number, isDay: boolean) => `/weather-icons/ccef/${ccefIconName(code, isDay)}`;
              const cd = weatherChartData;
              return (
                <>
                  <div className="weather-page__main">
                    {/* Conditions panel: header cap + inner card grid */}
                    <div className="weather-page__conditions-panel">
                      <div className="weather-page__panel-title">Current Condition + Forecast</div>
                      <div className="weather-page__conditions-sections">
                        {/* Left pane — current conditions, full height */}
                        <div className="wx-section wx-section--current">
                          <div className="wx-section__location">{location.label}</div>
                          <div className="wx-section__current-body">
                            <img className="wx-section__icon-lg" src={ccefSrc(current.weatherCode, current.isDay)} alt={curDisplay.label} />
                            <div className="wx-section__current-text">
                              <div className="wx-section__temp">{current.temp}°F</div>
                              <div className="wx-section__condition">{curDisplay.label}</div>
                              <ul className="wx-section__details">
                                <li>Feels like {current.feelsLike}°</li>
                                <li>Humidity {current.humidity}%</li>
                                <li>Wind {current.windSpeed} mph {windDir}</li>
                                {current.precipitation > 0 && <li>Precip {current.precipitation}"</li>}
                              </ul>
                            </div>
                          </div>
                        </div>
                        {/* Vertical divider between left and right panes */}
                        <div className="wx-section-divider wx-section-divider--vertical" />
                        {/* Right pane — Today on top, Tomorrow on bottom */}
                        <div className="wx-section__right-col">
                          <div className="wx-section wx-section--forecast">
                            <div className="wx-section__forecast-inner">
                              <div className="wx-section__forecast-text">
                                <div className="wx-section__day-label">Today</div>
                                <div className="wx-section__hi-lo">
                                  <span className="wx-section__hi">H {today.high}°</span>
                                  <span className="wx-section__lo">L {today.low}°</span>
                                </div>
                                <div className="wx-section__condition">{todayDisplay.label}</div>
                                <ul className="wx-section__details">
                                  <li>💧 {today.precipProbability}% chance of rain</li>
                                  {today.precipSum > 0 && <li>{today.precipSum}" precip</li>}
                                </ul>
                              </div>
                              <img className="wx-section__icon-md" src={ccefSrc(today.weatherCode, true)} alt={todayDisplay.label} />
                            </div>
                          </div>
                          {/* Horizontal divider between Today and Tomorrow */}
                          <div className="wx-section-divider" />
                          <div className="wx-section wx-section--forecast">
                            <div className="wx-section__forecast-inner">
                              <div className="wx-section__forecast-text">
                                <div className="wx-section__day-label">Tomorrow</div>
                                <div className="wx-section__hi-lo">
                                  <span className="wx-section__hi">H {tomorrow.high}°</span>
                                  <span className="wx-section__lo">L {tomorrow.low}°</span>
                                </div>
                                <div className="wx-section__condition">{tomorrowDisplay.label}</div>
                                <ul className="wx-section__details">
                                  <li>💧 {tomorrow.precipProbability}% chance of rain</li>
                                  {tomorrow.precipSum > 0 && <li>{tomorrow.precipSum}" precip</li>}
                                </ul>
                              </div>
                              <img className="wx-section__icon-md" src={ccefSrc(tomorrow.weatherCode, true)} alt={tomorrowDisplay.label} />
                            </div>
                          </div>
                        </div>
                      </div>{/* end conditions-sections */}
                    </div>{/* end conditions-panel */}
                    <div className="weather-page__radar-panel">
                      <div className="weather-page__panel-title">
                        {`Radar — ${location.label}`}
                        {radarFrames.length > 0 && (
                          <span className="weather-page__radar-frame-indicator">
                            {` ${radarFrameIdx + 1}/${radarFrames.length}`}
                          </span>
                        )}
                      </div>
                      {(() => {
                        const zoom = 8;
                        const { x: cx, y: cy } = latLonToTile(location.lat, location.lon, zoom);
                        // 3×2 tile grid centered on location — landscape-friendly, cells closer to square
                        const tiles = [
                          { tx: cx - 1, ty: cy - 1 }, { tx: cx, ty: cy - 1 }, { tx: cx + 1, ty: cy - 1 },
                          { tx: cx - 1, ty: cy },     { tx: cx, ty: cy },     { tx: cx + 1, ty: cy },
                        ];
                        const currentFrame = radarFrames[radarFrameIdx];
                        return (
                          <div className="weather-page__radar-map">
                            {tiles.map(({ tx, ty }) => {
                              // RainViewer free API caps at zoom 7; use the zoom-7 parent tile
                              // and CSS offset to show the correct quadrant at zoom-8 detail
                              const rx = Math.floor(tx / 2);
                              const ry = Math.floor(ty / 2);
                              const qx = tx % 2;
                              const qy = ty % 2;
                              return (
                              <div key={`${tx}-${ty}`} className="weather-page__radar-cell">
                                <img
                                  className="weather-page__radar-base"
                                  src={`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`}
                                  alt=""
                                />
                                {currentFrame && (
                                  <img
                                    key={currentFrame.timestamp}
                                    className="weather-page__radar-overlay"
                                    src={`${currentFrame.host}${currentFrame.tilePath}/512/7/${rx}/${ry}/2/1_1.png`}
                                    alt=""
                                    style={{ width: '200%', height: '200%', left: `${-qx * 100}%`, top: `${-qy * 100}%` }}
                                  />
                                )}
                              </div>
                              );
                            })}
                            <div className="weather-page__radar-attrib">© OpenStreetMap · RainViewer</div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  {/* Hourly forecast chart — full width at bottom */}
                  <div className="weather-page__hourly-panel">
                    <div className="weather-page__panel-title">Hourly Forecast</div>
                    {cd ? (
                      <svg
                        viewBox={`0 0 ${cd.W} ${cd.H}`}
                        width="100%"
                        height="100%"
                        preserveAspectRatio="none"
                        className="weather-page__chart-svg"
                        aria-label="Hourly temperature and precipitation forecast"
                      >
                        <defs>
                          <linearGradient id="wxTempGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#e05010" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="#5090c8" stopOpacity="0.05" />
                          </linearGradient>
                        </defs>
                        {[0, 0.25, 0.5, 0.75, 1].map(f => (
                          <line key={`gl-${f}`}
                            x1={cd.ML} y1={cd.MT + f * cd.PH}
                            x2={cd.ML + cd.PW} y2={cd.MT + f * cd.PH}
                            stroke="#8090a0" strokeWidth="0.5" strokeDasharray="4 4" opacity="0.4"
                          />
                        ))}
                        {hourly.map((h, i) => {
                          const barH = (h.precipProbability / 100) * cd.PH;
                          return (
                            <rect key={`pb-${i}`}
                              x={cd.xOf(i) - cd.barW / 2}
                              y={cd.MT + cd.PH - barH}
                              width={cd.barW}
                              height={barH}
                              fill="#5090c8"
                              opacity="0.22"
                              rx="2"
                            />
                          );
                        })}
                        <polygon points={cd.areaPolygon} fill="url(#wxTempGrad)" />
                        <polyline
                          points={cd.tempPolyline}
                          fill="none"
                          stroke="#e05010"
                          strokeWidth="2.5"
                          strokeLinejoin="round"
                        />
                        {cd.points.map((p, i) => {
                          const isEdge = i === 0 || i === cd.n - 1;
                          const showLabel = isEdge || i % Math.ceil(cd.n / 6) === 0;
                          return (
                            <g key={`dt-${i}`}>
                              <circle cx={p.x} cy={p.y} r={isEdge ? 4.5 : 3} fill={isEdge ? '#b03000' : '#e05010'} stroke="#fff" strokeWidth="1.5" />
                              {showLabel && (
                                <text x={p.x} y={Math.max(p.y - 7, cd.MT + 11)}
                                  fontSize="11" textAnchor="middle" fill="#982800"
                                  fontWeight="700" stroke="white" strokeWidth="3" paintOrder="stroke"
                                >
                                  {p.h.temp}°
                                </text>
                              )}
                            </g>
                          );
                        })}
                        {hourly.map((h, i) => {
                          const cx = cd.xOf(i);
                          const period = h.hour >= 12 ? 'pm' : 'am';
                          const displayH = h.hour % 12 || 12;
                          const iconFile = ccefIconName(h.weatherCode, h.hour >= 6 && h.hour < 20);
                          const iconSize = 28;
                          return (
                            <g key={`hl-${i}`}>
                              <image
                                href={`/weather-icons/ccef/${iconFile}`}
                                x={cx - iconSize / 2} y={cd.H - cd.MB + 2}
                                width={iconSize} height={iconSize}
                              />
                              <text x={cx} y={cd.H - 4}
                                fontSize="11" textAnchor="middle" fill="#4a6080" fontWeight="600"
                              >
                                {`${displayH}${period}`}
                              </text>
                            </g>
                          );
                        })}
                        {[0, 0.5, 1].map(f => {
                          const t = Math.round(cd.minTemp + f * cd.tempRange);
                          return (
                            <text key={`tl-${f}`}
                              x={cd.ML - 5} y={cd.MT + (1 - f) * cd.PH + 4}
                              fontSize="11" textAnchor="end" fill="#807060" fontWeight="600"
                            >
                              {t}°
                            </text>
                          );
                        })}
                        <rect x={cd.ML + cd.PW - 80} y={cd.MT + 2} width="12" height="10" fill="#5090c8" opacity="0.3" rx="2" />
                        <text x={cd.ML + cd.PW - 64} y={cd.MT + 10} fontSize="10" fill="#4070a0">Precip %</text>
                      </svg>
                    ) : (
                      <div className="weather-page__chart-empty">No hourly data</div>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        ) : null}
      </main>

      <div className="app__ticker" aria-label="Dashboard ticker">
        <div className="app__ticker-clock" aria-label="Current time and date">
          <span className="app__ticker-time" aria-label={`${tickerHourLabel}:${tickerMinuteLabel}:${tickerSecondLabel}`}>
            <span className="app__ticker-time-part">{tickerHourLabel}</span>
            <span className={`app__ticker-separator${tickerSeparatorsVisible ? '' : ' app__ticker-separator--hidden'}`}>:</span>
            <span className="app__ticker-time-part">{tickerMinuteLabel}</span>
            <span className={`app__ticker-separator${tickerSeparatorsVisible ? '' : ' app__ticker-separator--hidden'}`}>:</span>
            <span className="app__ticker-time-part app__ticker-time-part--seconds">{tickerSecondLabel}</span>
            {tickerNanosecondsLabel ? <span className="app__ticker-time-part app__ticker-time-part--nanos">.{tickerNanosecondsLabel}</span> : null}
            {tickerMeridiemLabel ? <span className="app__ticker-meridiem">{tickerMeridiemLabel}</span> : null}
          </span>
          <span className="app__ticker-date">{tickerDateLabel}</span>
        </div>
        <div className="app__ticker-track" aria-hidden="true" style={tickerScrollDurationStyle}>
          <span className="app__ticker-copy">{loading ? LOADING_TICKER_TEXT : tickerScrollText}</span>
          <span className="app__ticker-copy">{loading ? LOADING_TICKER_TEXT : tickerScrollText}</span>
        </div>
      </div>
    </div>
  );
}
