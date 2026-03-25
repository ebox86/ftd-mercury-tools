// ==UserScript==
// @name         MercuryHQ - Single Request Barcode
// @namespace    https://ebox86.com/
// @version      0.4.06
// @description  Adds a barcode-assisted delivery request tab to MercuryHQ and prepopulates the Single Request form from Mercury services.
// @author       Evan
// @match        https://mercuryhq.com/create-delivery-service-request*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    apiProtocol: 'http',
    apiHost: '192.168.1.50',
    apiBasePath: '/WsMercuryWebAPI',
    soapNamespace: 'http://localhost/webservices',
    fixedCountry: 'United States',
    olcByTicketPath: '/OrderLifeCycle.asmx/OLCGetByTicket',
    defaultDeliveryInstruction: 'LEAVE AT DOOR IF NOT AVAILABLE',
    defaultPhone: '4122810350',
    oposBridge: {
      enabled: true,
      url: 'http://127.0.0.1:17331',
      pollIntervalMs: 250,
      autoLookupOnScan: true,
      leaseMs: 9000,
      leaseKeepAliveMs: 2500,
      allowKeyboardWedgeFallback: false,
    },
    debug: true,
    labels: {
      newTab: 'Single Request - Autocomplete',
      manualTab: 'Single Request - Manual',
      defaultsTab: 'Default Request Configuration',
      modalTitle: 'Enter Order ID or scan ticket',
      modalPlaceholder: 'Scan or type ticket number',
      configScreenTitle: 'Default Request Configuration',
    },
    selectors: {
      singleRequestTab: '[data-testid="Single Request-tab"]',
      bulkRequestTab: '[data-testid="Bulk Request-tab"]',
      formInputs: {
        assignment: '[data-testid="web_picker_assignment_deliveryService"]',
        deliveryDate: '[data-testid="deliveryDate"]',
        pickUpDateTime: '[data-testid="pickUpDateTime"]',
        referenceNumber: '[data-testid="referenceNumber"]',
        NoOfItems: '[data-testid="NoOfItems"]',
        totalItemValue: '[data-testid="totalItemValue"]',
        itemDescription: '[data-testid="itemDescription"]',
        recipient_name: '[data-testid="recipient_name"]',
        lastName: '[data-testid="lastName"]',
        phone: '[data-testid="phone"]',
        addressLine1: '[data-testid="addressLine1"]',
        addressLine2: '[data-testid="addressLine2"]',
        city: '[data-testid="city"]',
        state: '[data-testid^="web_picker_state_"]',
        zip: '[data-testid="zip"]',
        country: '[data-testid="web_picker_country_US"]',
        locationType: '[data-testid^="web_picker_locationType_"]',
        locationName: '[data-testid="locationName"]',
        specialDeliveryInstructions: '[data-testid="specialDeliveryInstructions"]',
        undeliverableAction: '[data-testid^="web_picker_undeliverableAction_"]',
      },
    },
  };

  const STORAGE_KEYS = {
    requestDefaults: 'mhq-default-request-config-v1',
  };

  const DEFAULT_REQUEST_CONFIG = Object.freeze({
    defaultApiHost: CONFIG.apiHost,
    defaultDeliveryInstruction: CONFIG.defaultDeliveryInstruction,
    defaultPhone: CONFIG.defaultPhone,
    defaultItemDescription: 'FLORAL',
    defaultUndeliverableAction: 'Leave at Location',
    defaultFuturePickupTime: '8:00 AM',
    defaultCountry: CONFIG.fixedCountry,
    defaultLocationType: 'Residence',
  });

  const state = {
    mounted: false,
    activeMode: 'normal',
    submitWatchStop: null,
    lastSubmitHandledAt: 0,
    addressVerificationCommitToken: 0,
    deliveryInstructionPreset: '',
    deliveryMenuCleanup: null,
    requestDefaults: { ...DEFAULT_REQUEST_CONFIG },
    configHiddenRoot: null,
    configHiddenRootDisplay: '',
    configHiddenButtons: [],
    cancelResetHooksBound: false,
    formBaseline: null,
    bridgeFlushChain: Promise.resolve(),
    bridgeLeaseChain: Promise.resolve(),
    scanModalClose: null,
    scanModalNonce: 0,
  };

  function log(...args) {
    if (CONFIG.debug) console.log('[MHQ Barcode]', ...args);
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function sanitizeApiHostInput(rawHost) {
    const fallback = String(DEFAULT_REQUEST_CONFIG.defaultApiHost || CONFIG.apiHost || '').trim();
    const base = String(rawHost == null ? fallback : rawHost).trim();
    if (!base) return fallback;
    const cleaned = base
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/\/+.*$/, '')
      .trim();
    // Ignore legacy shorthand values like "1.50" and fall back to full host/IP.
    if (/^\d{1,3}\.\d{1,3}(?::\d{1,5})?$/.test(cleaned)) return fallback;
    return cleaned;
  }

  function getConfiguredApiHost() {
    const fromConfig = sanitizeApiHostInput(getRequestDefault('defaultApiHost'));
    const fallback = sanitizeApiHostInput(CONFIG.apiHost);
    return fromConfig || fallback;
  }

  function buildApiUrl(path = '') {
    const protocol = String(CONFIG.apiProtocol || 'http').replace(/:$/, '');
    const host = String(getConfiguredApiHost() || '')
      .trim()
      .replace(/\/+$/, '');
    const basePath = String(CONFIG.apiBasePath || '')
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    const suffix = String(path || '').trim().replace(/^\/+/, '');

    if (!host) throw new Error('A valid API host is required. Set Server IP/Host in Default Request Configuration.');

    const baseSegment = basePath ? `/${basePath}` : '';
    const suffixSegment = suffix ? `/${suffix}` : '';
    return `${protocol}://${host}${baseSegment}${suffixSegment}`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function escapeXml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  function normalizeSoapNamespace(rawNamespace, { trailingSlash = false } = {}) {
    const base = String(rawNamespace || 'http://localhost/webservices').trim().replace(/\/+$/, '');
    return trailingSlash ? `${base}/` : base;
  }

  function getSoapNamespaceVariants() {
    const base = normalizeSoapNamespace(CONFIG.soapNamespace, { trailingSlash: false });
    return uniqueNonEmpty([base, normalizeSoapNamespace(base, { trailingSlash: true })]);
  }

  function buildSoapAction(methodName, namespaceOverride = '') {
    const ns = normalizeSoapNamespace(namespaceOverride || CONFIG.soapNamespace, { trailingSlash: false });
    return `"${ns}/${methodName}"`;
  }

  function buildSoapEnvelope(methodName, params = {}, namespaceOverride = '') {
    const ns = normalizeSoapNamespace(namespaceOverride || CONFIG.soapNamespace, { trailingSlash: true });
    const payload = Object.entries(params)
      .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
      .join('');
    return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${methodName} xmlns="${escapeXml(ns)}">${payload}</${methodName}></soap:Body></soap:Envelope>`;
  }

  function sanitizeRequestDefaults(input = {}) {
    const safe = {};
    for (const [key, fallback] of Object.entries(DEFAULT_REQUEST_CONFIG)) {
      const value = input?.[key];
      safe[key] = value == null ? String(fallback) : String(value);
    }

    // Keep stored values aligned with supported Mercury options.
    const location = String(safe.defaultLocationType || '').trim().toLowerCase();
    if (location === 'business') safe.defaultLocationType = 'Office';
    if (!['residence', 'office', 'funeral home', 'other'].includes(String(safe.defaultLocationType || '').trim().toLowerCase())) {
      safe.defaultLocationType = DEFAULT_REQUEST_CONFIG.defaultLocationType;
    }

    const undeliverable = String(safe.defaultUndeliverableAction || '').trim().toLowerCase();
    if (undeliverable === 'return to shop') safe.defaultUndeliverableAction = 'Return to Store';
    if (!['return to store', 'leave at location'].includes(String(safe.defaultUndeliverableAction || '').trim().toLowerCase())) {
      safe.defaultUndeliverableAction = DEFAULT_REQUEST_CONFIG.defaultUndeliverableAction;
    }

    const allowedFutureTimes = getConfigSelectOptions('defaultFuturePickupTime');
    if (!allowedFutureTimes.includes(String(safe.defaultFuturePickupTime || '').trim())) {
      safe.defaultFuturePickupTime = DEFAULT_REQUEST_CONFIG.defaultFuturePickupTime;
    }

    safe.defaultApiHost = sanitizeApiHostInput(safe.defaultApiHost);

    return safe;
  }

  function loadRequestDefaults() {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEYS.requestDefaults);
      if (!raw) return { ...DEFAULT_REQUEST_CONFIG };
      const parsed = JSON.parse(raw);
      return sanitizeRequestDefaults(parsed);
    } catch (error) {
      log('Failed to load request defaults from localStorage', error);
      return { ...DEFAULT_REQUEST_CONFIG };
    }
  }

  function saveRequestDefaults(nextDefaults) {
    const safe = sanitizeRequestDefaults(nextDefaults);
    state.requestDefaults = safe;
    try {
      window.localStorage?.setItem(STORAGE_KEYS.requestDefaults, JSON.stringify(safe));
    } catch (error) {
      log('Failed to save request defaults to localStorage', error);
    }
    return safe;
  }

  function getRequestDefault(key) {
    const defaults = state.requestDefaults || DEFAULT_REQUEST_CONFIG;
    if (!(key in defaults)) return '';
    return String(defaults[key] ?? '');
  }

  GM_addStyle(`
    .mhq-barcode-tab { cursor: pointer; margin: 5px 0 5px 50px; padding-top: 8px; padding-bottom: 8px; border-bottom: 2px solid transparent; user-select: none; }
    .mhq-barcode-tab--active { border-bottom-color: rgb(22, 65, 88) !important; }
    .mhq-barcode-tab__text { color: rgb(65, 65, 65); font-family: Arial; font-size: 16px; }
    .mhq-barcode-tab--active .mhq-barcode-tab__text { color: rgb(22, 65, 88) !important; font-weight: 600; }
    .mhq-tab-icon { display: inline-block; width: 14px; height: 14px; margin-right: 7px; vertical-align: -2px; position: relative; color: currentColor; }
    .mhq-tab-icon--single { border: 1.5px solid currentColor; border-radius: 2px; box-sizing: border-box; }
    .mhq-tab-icon--single::after { content: ''; position: absolute; left: 2px; right: 2px; top: 3px; height: 1.5px; background: currentColor; box-shadow: 0 3px 0 currentColor, 0 6px 0 currentColor; }
    .mhq-tab-icon--bulk::before, .mhq-tab-icon--bulk::after { content: ''; position: absolute; border: 1.5px solid currentColor; border-radius: 2px; box-sizing: border-box; width: 10px; height: 10px; }
    .mhq-tab-icon--bulk::before { left: 0; top: 3px; }
    .mhq-tab-icon--bulk::after { left: 3px; top: 0; background: white; }
    .mhq-tab-icon--barcode { border: 1px solid currentColor; border-radius: 2px; box-sizing: border-box; background: repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 2px, currentColor 2px 3px, transparent 3px 5px, currentColor 5px 7px, transparent 7px 8px); }
    .mhq-tab-icon--config { border: 1.5px solid currentColor; border-radius: 50%; box-sizing: border-box; }
    .mhq-tab-icon--config::before { content: ''; position: absolute; inset: 3px; border: 1.5px solid currentColor; border-radius: 50%; box-sizing: border-box; background: white; }
    .mhq-tab-icon--config::after { content: ''; position: absolute; width: 2px; height: 2px; left: 6px; top: -1px; background: currentColor; box-shadow: 0 13px 0 currentColor, -6px 6px 0 currentColor, 6px 6px 0 currentColor, -6px 0 0 currentColor, 6px 0 0 currentColor, -4px 2px 0 currentColor, 4px 2px 0 currentColor; }
    .mhq-filled { outline: 2px solid #2e8b57 !important; box-shadow: 0 0 0 3px rgba(46,139,87,.14) !important; background-color: rgba(46,139,87,.04) !important; }
    .mhq-review { outline: 2px solid #ffb000 !important; box-shadow: 0 0 0 3px rgba(255,176,0,.18) !important; background-color: rgba(255,176,0,.06) !important; }
    .mhq-field-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 6px; margin-left: 6px; border-radius: 999px; font-family: Arial; font-size: 10px; font-weight: 700; line-height: 18px; vertical-align: middle; }
    .mhq-field-badge--filled { color: white; background: #2e8b57; }
    .mhq-field-badge--review { color: #6c5000; background: #ffe29a; border: 1px solid #f0c24f; }
    .mhq-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483000; display: flex; align-items: center; justify-content: center; }
    .mhq-modal { width: min(560px, calc(100vw - 24px)); background: white; border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.22); overflow: hidden; font-family: Arial; }
    .mhq-modal__header, .mhq-modal__footer { padding: 14px 16px; border-bottom: 1px solid #e7e7e7; }
    .mhq-modal__footer { border-bottom: 0; border-top: 1px solid #e7e7e7; display: flex; justify-content: flex-end; gap: 8px; }
    .mhq-modal__body { padding: 16px; }
    .mhq-modal__input-wrap { position: relative; }
    .mhq-modal__input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px 38px 10px 12px; border: 1px solid #cfcfcf; border-radius: 6px; }
    .mhq-modal__input:disabled { background: #f4f6f8; color: #6b7785; cursor: not-allowed; }
    .mhq-modal__input-status { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); min-width: 20px; height: 20px; border-radius: 999px; font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; user-select: none; pointer-events: none; display: none; }
    .mhq-modal__input-status--checking { display: inline-block; color: #4f5b66; background: #e8edf2; }
    .mhq-modal__input-status--loading { display: inline-block; width: 20px; min-width: 20px; height: 20px; border: 2px solid #c7d4df; border-top-color: #1f4f7a; background: transparent; color: transparent; font-size: 0; line-height: 0; animation: mhq-modal-spin .8s linear infinite; }
    .mhq-modal__input-status--valid { display: inline-block; color: #fff; background: #2e8b57; }
    .mhq-modal__input-status--invalid { display: inline-block; color: #fff; background: #c62828; }
    .mhq-modal .mhq-btn[disabled] { opacity: .55; cursor: not-allowed; }
    @keyframes mhq-modal-spin { from { transform: translateY(-50%) rotate(0deg); } to { transform: translateY(-50%) rotate(360deg); } }
    .mhq-btn { appearance: none; border: 1px solid #c9d2d8; background: #fff; color: #1f2a33; border-radius: 6px; min-height: 34px; padding: 8px 12px; cursor: pointer; font-family: Arial; font-size: 12px; font-weight: 600; line-height: 1; }
    .mhq-btn:hover { background: #f6f9fb; }
    .mhq-btn--primary { border-color: rgb(22, 65, 88); background: rgb(22, 65, 88); color: #fff; }
    .mhq-btn.mhq-btn--primary:hover { background: rgb(22, 65, 88); color: #fff; filter: brightness(1.03); }
    .mhq-delivery-combo { margin-top: 6px; width: 100%; max-width: 520px; position: relative; isolation: isolate !important; z-index: 2147483190; }
    .mhq-delivery-template-input { width: 100%; box-sizing: border-box; height: 32px; border: 1px solid #cfcfcf; border-radius: 6px; padding: 4px 30px 4px 8px; font-family: Arial; font-size: 12px; color: #222; background: #fff; }
    .mhq-delivery-template-trigger { position: absolute; top: 1px; right: 1px; width: 28px; height: 30px; border: 0; border-left: 1px solid #e0e0e0; border-radius: 0 6px 6px 0; background: #f8f8f8; color: #555; cursor: pointer; font-size: 11px; line-height: 30px; padding: 0; }
    .mhq-delivery-template-menu { position: fixed; top: 0; left: 0; width: 320px; max-height: 160px; overflow: auto; border: 1px solid #cfcfcf; border-radius: 6px; background: #fff !important; background-image: none !important; box-shadow: 0 6px 18px rgba(0,0,0,.12); z-index: 2147483200; display: none; opacity: 1 !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; mix-blend-mode: normal !important; }
    .mhq-delivery-template-menu::before { content: ''; position: absolute; inset: 0; background: #fff !important; z-index: 0; }
    .mhq-delivery-template-menu--open { display: block; }
    .mhq-delivery-template-item { display: block; width: 100%; text-align: left; border: 0; background: #fff !important; background-image: none !important; color: #222; font-family: Arial; font-size: 12px; padding: 8px; cursor: pointer; opacity: 1 !important; position: relative; z-index: 1; mix-blend-mode: normal !important; }
    .mhq-delivery-template-item:hover, .mhq-delivery-template-item:focus { background: #f3f7fa !important; }
    .mhq-config-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .mhq-config-row { display: grid; gap: 4px; }
    .mhq-config-row label { font-size: var(--mhq-config-label-font-size, 12px); color: var(--mhq-config-label-color, #333); font-weight: var(--mhq-config-label-font-weight, 600); font-family: var(--mhq-config-font-family, Arial); }
    .mhq-config-row input, .mhq-config-row select { box-sizing: border-box; width: 100%; height: var(--mhq-config-input-height, 32px); border: 1px solid var(--mhq-config-input-border-color, #cfcfcf); border-radius: var(--mhq-config-input-radius, 6px); padding: var(--mhq-config-input-padding, 4px 8px); font-size: var(--mhq-config-input-font-size, 12px); font-weight: var(--mhq-config-input-font-weight, 400); color: var(--mhq-config-input-color, #222); background: var(--mhq-config-input-bg, #fff); font-family: var(--mhq-config-font-family, Arial); }
    .mhq-config-hint { margin: 0 0 12px; color: var(--mhq-config-hint-color, #555); font-size: var(--mhq-config-hint-font-size, 12px); font-family: var(--mhq-config-font-family, Arial); }
    .mhq-config-screen { margin-top: 12px; border: 1px solid #e1e1e1; border-radius: 8px; padding: 16px; background: #fff; max-width: 760px; box-shadow: 0 3px 10px rgba(0,0,0,.05); font-family: var(--mhq-config-font-family, Arial); color: var(--mhq-config-text-color, #1f1f1f); }
    .mhq-config-screen h3 { margin: 0 0 10px; font-size: 16px; color: var(--mhq-config-heading-color, #1f1f1f); font-family: var(--mhq-config-font-family, Arial); }
    .mhq-config-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
    .mhq-config-status { margin-top: 10px; min-height: 0; font-size: 13px; font-weight: 700; border-radius: 6px; padding: 0; display: none; }
    .mhq-config-status--success { display: block; padding: 8px 10px; color: #145c2e; background: #e8f6ed; border: 1px solid #b8e3c5; }
    .mhq-config-status--info { display: block; padding: 8px 10px; color: #0f3d59; background: #e8f2f8; border: 1px solid #b8d6ea; }
  `);

  function createElement(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function getInput(fieldKey) {
    const sel = CONFIG.selectors.formInputs[fieldKey];
    return sel ? qs(sel) : null;
  }

  function setNativeValue(el, value, options = {}) {
    const {
      dispatchBlur = false,
      dispatchInput = true,
      dispatchChange = true,
    } = options;
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
    if (dispatchInput) el.dispatchEvent(new Event('input', { bubbles: true }));
    if (dispatchChange) el.dispatchEvent(new Event('change', { bubbles: true }));
    if (dispatchBlur) el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setSelectByValueOrLabel(el, desired, setOptions = {}) {
    if (!el || desired == null || desired === '') return false;
    const normalized = String(desired).trim().toLowerCase();
    const match = Array.from(el.options || []).find(opt => opt.value.trim().toLowerCase() === normalized || opt.text.trim().toLowerCase() === normalized || (opt.label || '').trim().toLowerCase() === normalized);
    if (!match) return false;
    setNativeValue(el, match.value, setOptions);
    return true;
  }

  function clearFieldDecorations() {
    qsa('.mhq-filled, .mhq-review').forEach(el => { el.classList.remove('mhq-filled', 'mhq-review'); el.removeAttribute('title'); });
    qsa('.mhq-field-badge').forEach(el => el.remove());
  }

  function findFieldLabelNode(el) {
    const wrapper = el?.closest('[style], .css-1dbjc4n');
    if (!wrapper) return null;
    const candidates = qsa('div.css-901oao', wrapper.parentElement || wrapper);
    return candidates.find(node => /\*$|\(|Assignment|Delivery Date|Pickup Time|Your Order Number|Items|Item Description|Recipient|Street Address|City|State|Postal Code|Country|Location Type|Location \/ Business Name|Delivery Instructions|Undeliverable Action/i.test(node.textContent || '')) || null;
  }

  function addBadge(el, kind, text, title) {
    const labelNode = findFieldLabelNode(el);
    if (!labelNode) return;
    const badge = document.createElement('span');
    badge.className = `mhq-field-badge mhq-field-badge--${kind}`;
    badge.textContent = text;
    badge.title = title || '';
    labelNode.appendChild(badge);
  }

  function markFilled(el, reason = 'Auto-filled from service') {
    if (!el) return;
    el.classList.remove('mhq-review');
    el.classList.add('mhq-filled');
    el.title = reason;
    addBadge(el, 'filled', 'AUTO', reason);
  }

  function markReview(el, reason = 'Review needed') {
    if (!el) return;
    el.classList.remove('mhq-filled');
    el.classList.add('mhq-review');
    el.title = reason;
    addBadge(el, 'review', 'CHK', reason);
  }

  function clearHighlights() { clearFieldDecorations(); }

  function removeBannerIfPresent() {
    qsa('#mhq-barcode-banner').forEach(el => el.remove());
  }

  function ensureTabIcon(tabElement, kind) {
    if (!tabElement) return;
    const textNode = tabElement.querySelector('.css-901oao, .mhq-barcode-tab__text');
    if (!textNode) return;
    if (textNode.querySelector(`.mhq-tab-icon--${kind}`)) return;
    const icon = document.createElement('span');
    icon.className = `mhq-tab-icon mhq-tab-icon--${kind}`;
    icon.setAttribute('aria-hidden', 'true');
    textNode.prepend(icon);
  }

  function setTabLabel(tabElement, label) {
    if (!tabElement || !label) return;
    const textNode = tabElement.querySelector('.css-901oao, .mhq-barcode-tab__text');
    if (!textNode) return;
    const icon = textNode.querySelector('.mhq-tab-icon');
    if (!icon) {
      if (String(textNode.textContent || '').trim() === label) return;
      textNode.textContent = label;
      return;
    }
    const currentLabel = Array.from(textNode.childNodes)
      .filter(node => node !== icon)
      .map(node => String(node.textContent || ''))
      .join('')
      .trim();
    if (currentLabel === label) return;
    Array.from(textNode.childNodes).forEach(node => {
      if (node !== icon) node.remove();
    });
    textNode.append(document.createTextNode(` ${label}`));
  }

  function applyCustomTabLabels() {
    setTabLabel(qs(CONFIG.selectors.singleRequestTab), CONFIG.labels.manualTab);
    setTabLabel(qs('#mhq-single-request-barcode-tab'), CONFIG.labels.newTab);
  }

  function decorateTabsWithIcons() {
    ensureTabIcon(qs(CONFIG.selectors.singleRequestTab), 'single');
    ensureTabIcon(qs(CONFIG.selectors.bulkRequestTab), 'bulk');
    ensureTabIcon(qs('#mhq-single-request-barcode-tab'), 'barcode');
    ensureTabIcon(qs('#mhq-default-request-config-tab'), 'config');
    applyCustomTabLabels();
  }

  function setTabFontWeights({ single = '400', bulk = '400', barcode = '400', config = '400' } = {}) {
    const singleText = qs(CONFIG.selectors.singleRequestTab)?.querySelector('.css-901oao');
    const bulkText = qs(CONFIG.selectors.bulkRequestTab)?.querySelector('.css-901oao');
    const barcodeText = qs('#mhq-single-request-barcode-tab')?.querySelector('.mhq-barcode-tab__text');
    const configText = qs('#mhq-default-request-config-tab')?.querySelector('.mhq-barcode-tab__text');
    if (singleText) singleText.style.fontWeight = single;
    if (bulkText) bulkText.style.fontWeight = bulk;
    if (barcodeText) barcodeText.style.fontWeight = barcode;
    if (configText) configText.style.fontWeight = config;
  }

  function removeDeliveryInstructionPicker() {
    if (typeof state.deliveryMenuCleanup === 'function') {
      state.deliveryMenuCleanup();
      state.deliveryMenuCleanup = null;
    }
    qsa('#mhq-delivery-template-combo, #mhq-delivery-template-menu').forEach(el => el.remove());
  }

  function ensureDeliveryInstructionPicker(mappedText = state.deliveryInstructionPreset, forceOptionRefresh = false) {
    const field = getInput('specialDeliveryInstructions');
    if (!field) return;
    const mapped = String(mappedText ?? '');
    state.deliveryInstructionPreset = mapped;
    const staticDefault = getRequestDefault('defaultDeliveryInstruction');

    let combo = qs('#mhq-delivery-template-combo');
    let picker;
    let menu;
    let trigger;

    if ((combo && !qs('#mhq-delivery-template-menu')) || (!combo && qs('#mhq-delivery-template-menu'))) {
      removeDeliveryInstructionPicker();
      combo = null;
    }

    if (!combo) {
      combo = createElement('<div id="mhq-delivery-template-combo" class="mhq-delivery-combo"><input id="mhq-delivery-template-input" class="mhq-delivery-template-input" type="text" autocomplete="off" placeholder="Instruction template (editable)" title="Choose a template or type your own instruction." /><button id="mhq-delivery-template-trigger" class="mhq-delivery-template-trigger" type="button" aria-label="Show instruction templates" aria-expanded="false">&#9662;</button></div>');
      picker = combo.querySelector('#mhq-delivery-template-input');
      trigger = combo.querySelector('#mhq-delivery-template-trigger');
      menu = createElement('<div id="mhq-delivery-template-menu" class="mhq-delivery-template-menu" role="listbox"></div>');
      document.body.appendChild(menu);
      menu.style.backgroundColor = '#fff';
      menu.style.backgroundImage = 'none';
      menu.style.opacity = '1';
      menu.style.mixBlendMode = 'normal';
      menu.style.backdropFilter = 'none';
      menu.style.webkitBackdropFilter = 'none';

      const closeMenu = () => {
        menu.classList.remove('mhq-delivery-template-menu--open');
        trigger.setAttribute('aria-expanded', 'false');
      };
      const positionMenu = () => {
        const rect = combo.getBoundingClientRect();
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.top = `${Math.round(rect.bottom + 2)}px`;
        menu.style.width = `${Math.round(rect.width)}px`;
      };
      const openMenu = () => {
        if (!menu.children.length) return;
        positionMenu();
        menu.classList.add('mhq-delivery-template-menu--open');
        trigger.setAttribute('aria-expanded', 'true');
      };
      const toggleMenu = () => {
        if (menu.classList.contains('mhq-delivery-template-menu--open')) closeMenu();
        else openMenu();
      };

      picker.addEventListener('input', () => {
        const activeField = getInput('specialDeliveryInstructions');
        if (!activeField) return;
        setNativeValue(activeField, picker.value);
      });

      picker.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); openMenu(); }
        if (event.key === 'Escape') closeMenu();
      });

      trigger.addEventListener('click', event => {
        event.preventDefault();
        toggleMenu();
      });

      menu.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const item = target.closest('.mhq-delivery-template-item');
        if (!(item instanceof HTMLButtonElement)) return;
        const value = String(item.dataset.templateValue ?? '');
        picker.value = value;
        const activeField = getInput('specialDeliveryInstructions');
        if (activeField) setNativeValue(activeField, value);
        closeMenu();
      });

      const onDocMouseDown = event => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (!combo.contains(target) && !menu.contains(target)) closeMenu();
      };
      const onWindowReposition = () => {
        if (menu.classList.contains('mhq-delivery-template-menu--open')) positionMenu();
      };

      document.addEventListener('mousedown', onDocMouseDown, true);
      window.addEventListener('scroll', onWindowReposition, true);
      window.addEventListener('resize', onWindowReposition);
      state.deliveryMenuCleanup = () => {
        document.removeEventListener('mousedown', onDocMouseDown, true);
        window.removeEventListener('scroll', onWindowReposition, true);
        window.removeEventListener('resize', onWindowReposition);
      };
    } else {
      picker = combo.querySelector('#mhq-delivery-template-input');
      trigger = combo.querySelector('#mhq-delivery-template-trigger');
      menu = combo.querySelector('#mhq-delivery-template-menu');
      if (!menu) menu = qs('#mhq-delivery-template-menu');
    }

    if (combo.previousElementSibling !== field) field.insertAdjacentElement('afterend', combo);

    if (forceOptionRefresh || picker.dataset.mappedValue !== mapped || !picker.dataset.initialized) {
      const previousValue = picker.value || String(field.value || '');
      const optionDefs = [
        { key: 'mapped', value: mapped },
        { key: 'default', value: staticDefault },
        { key: 'blank', value: '' },
      ];

      menu.innerHTML = '';
      for (const def of optionDefs) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mhq-delivery-template-item';
        item.dataset.templateValue = def.value;
        item.textContent = def.value || ' ';
        item.style.backgroundColor = '#fff';
        item.style.opacity = '1';
        item.style.mixBlendMode = 'normal';
        menu.appendChild(item);
      }

      picker.dataset.mappedValue = mapped;
      picker.dataset.initialized = '1';
      if (forceOptionRefresh) picker.value = String(field.value || mapped || '');
      else if (!picker.value) picker.value = previousValue || String(field.value || mapped || '');
    }
  }

  const SUBMIT_SIGNAL_SELECTOR = '[role="alert"], [aria-live], [class*="toast"], [class*="alert"], [class*="snack"], [class*="notification"], [class*="message"]';

  function getMainRequestForm() {
    return getInput('referenceNumber')?.closest('form') || null;
  }

  function isMainRequestFormElement(target) {
    if (!(target instanceof Element)) return false;
    const mainForm = getMainRequestForm();
    if (!mainForm) return true;
    const candidateForm = target.closest('form');
    // Some Mercury cancel controls render outside the actual form element.
    // Allow those through and rely on cancel-specific text/testid checks.
    if (!candidateForm) return true;
    return candidateForm === mainForm;
  }

  function getSubmitButton() {
    const form = getMainRequestForm();
    if (form) {
      return qs('[data-testid="Submit"]', form) || qsa('button', form).find(btn => /submit/i.test((btn.textContent || '').trim()));
    }
    return qs('[data-testid="Submit"]') || qsa('button').find(btn => /submit/i.test((btn.textContent || '').trim()));
  }

  function isMainCancelControl(target) {
    if (!(target instanceof Element)) return false;
    const candidate = target.closest('button, [role="button"], [data-testid]');
    if (!(candidate instanceof HTMLElement)) return false;
    if (candidate.closest('.mhq-modal-backdrop') || candidate.closest('#mhq-default-config-screen')) return false;
    if (!isMainRequestFormElement(candidate)) return false;
    const text = String(candidate.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const testId = String(candidate.getAttribute('data-testid') || '').trim().toLowerCase();
    const ariaLabel = String(candidate.getAttribute('aria-label') || '').trim().toLowerCase();
    return text === 'cancel' || /\bcancel\b/.test(testId) || /\bcancel\b/.test(ariaLabel);
  }

  function isSubmitSuccessText(rawText = '') {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (/(error|failed|failure|invalid|unable|denied|required|missing|duplicate)/i.test(text)) return false;
    return /(success|submitted|created|completed)/i.test(text) && /(request|delivery|order)/i.test(text);
  }

  function getSubmitSuccessSignals() {
    const out = [];
    for (const node of qsa(SUBMIT_SIGNAL_SELECTOR)) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!isSubmitSuccessText(text)) continue;
      out.push(text);
    }
    return out;
  }

  function hasSuccessfulSubmitSignal(baselineSignals = null) {
    const currentSignals = getSubmitSuccessSignals();
    if (!currentSignals.length) return false;
    if (!(baselineSignals instanceof Set) || !baselineSignals.size) return true;
    return currentSignals.some(text => !baselineSignals.has(String(text || '').toLowerCase()));
  }

  function nodeContainsSubmitSuccessSignal(node) {
    if (!(node instanceof Node)) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      return isSubmitSuccessText(node.textContent || '');
    }
    if (!(node instanceof Element)) return false;
    if (isSubmitSuccessText(node.textContent || '')) return true;
    return qsa(SUBMIT_SIGNAL_SELECTOR, node).some(candidate => isSubmitSuccessText(candidate.textContent || ''));
  }

  async function handleSuccessfulSubmit() {
    const now = Date.now();
    if (now - state.lastSubmitHandledAt < 1200) return;
    state.lastSubmitHandledAt = now;
    resetFormToBaseline();
    await bridgeFlushScanner('submit-success');
    await bridgeReleaseScanner('submit-success', true);
    if (state.activeMode === 'barcode' && typeof state.scanModalClose !== 'function' && !qs('.mhq-modal-backdrop')) {
      setTimeout(() => {
        if (state.activeMode === 'barcode' && typeof state.scanModalClose !== 'function' && !qs('.mhq-modal-backdrop')) showScanModal();
      }, 120);
    }
  }

  function startSubmitSuccessWatch(expectedReference = '') {
    if (state.submitWatchStop) state.submitWatchStop();
    const startedAt = Date.now();
    const maxMs = 30000;
    const expected = String(expectedReference || '').trim();
    const baselineSignals = new Set(getSubmitSuccessSignals().map(text => String(text || '').toLowerCase()));
    let stopped = false;
    let observer = null;
    let timer = null;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (observer) observer.disconnect();
      observer = null;
      if (state.submitWatchStop === stop) state.submitWatchStop = null;
    };

    const complete = () => {
      if (stopped) return;
      stop();
      void handleSuccessfulSubmit();
    };

    timer = setInterval(() => {
      if (Date.now() - startedAt > maxMs) {
        stop();
        return;
      }
      if (expected && state.activeMode !== 'barcode') {
        stop();
        return;
      }
      if (hasSuccessfulSubmitSignal(baselineSignals)) {
        complete();
      }
    }, 350);

    if (document.body || document.documentElement) {
      observer = new MutationObserver(mutations => {
        if (stopped) return;
        for (const mutation of mutations) {
          if (mutation.type === 'characterData' && nodeContainsSubmitSuccessSignal(mutation.target)) {
            complete();
            return;
          }
          for (const added of Array.from(mutation.addedNodes || [])) {
            if (!nodeContainsSubmitSuccessSignal(added)) continue;
            complete();
            return;
          }
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    }

    state.submitWatchStop = stop;
  }

  function bindSubmitSuccessHooks() {
    const submitButton = getSubmitButton();
    const startWatchIfNeeded = () => {
      enforceCountryDefault();
      if (state.activeMode !== 'barcode') return;
      const expectedReference = String(getInput('referenceNumber')?.value || '').trim();
      if (expectedReference) startSubmitSuccessWatch(expectedReference);
    };

    if (submitButton && submitButton.dataset.mhqSubmitWatchBound !== '1') {
      submitButton.dataset.mhqSubmitWatchBound = '1';
      submitButton.addEventListener('click', () => {
        startWatchIfNeeded();
      });
    }

    if (!state.cancelResetHooksBound) {
      state.cancelResetHooksBound = true;
      const maybeResetFromCancel = event => {
        if (state.activeMode !== 'barcode') return;
        if (!isMainCancelControl(event.target)) return;
        clearBarcodeAutofillState();
      };
      // Capture early so rerender/navigation from cancel cannot skip cleanup.
      document.addEventListener('pointerdown', maybeResetFromCancel, true);
      document.addEventListener('click', maybeResetFromCancel, true);
      document.addEventListener('reset', event => {
        if (state.activeMode !== 'barcode') return;
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        const mainForm = getMainRequestForm();
        if (mainForm && form && form !== mainForm) return;
        clearBarcodeAutofillState();
      }, true);
    }

    const form = submitButton?.closest('form') || getMainRequestForm();
    if (form && form.dataset.mhqSubmitWatchBound !== '1') {
      form.dataset.mhqSubmitWatchBound = '1';
      form.addEventListener('submit', () => {
        startWatchIfNeeded();
      });
    }
  }

  function getText(node, selector) { return node.querySelector(selector)?.textContent?.trim() || ''; }

  function parseXmlDocument(xmlText, errorMessage = 'Unable to parse XML response') {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    const err = xml.querySelector('parsererror');
    if (err) throw new Error(errorMessage);
    return xml;
  }

  function getXmlChildText(node, candidateNames = []) {
    if (!node) return '';
    for (const name of candidateNames) {
      const direct = node.getElementsByTagNameNS('*', name)?.[0] || node.getElementsByTagName(name)?.[0];
      const text = String(direct?.textContent || '').trim();
      if (text) return text;
    }
    return '';
  }

  function findDataRowNode(xml, rowNames = [], keyFieldNames = []) {
    if (!xml) return null;
    const allowedRowNames = new Set(rowNames.map(name => String(name || '').trim().toLowerCase()));
    const nodes = Array.from(xml.getElementsByTagName('*'));
    for (const node of nodes) {
      const ns = String(node.namespaceURI || '').toLowerCase();
      if (ns.includes('www.w3.org/2001/xmlschema')) continue;
      const local = String(node.localName || node.nodeName || '').trim().toLowerCase();
      if (!allowedRowNames.has(local)) continue;
      const hasAnyKeyField = keyFieldNames.some(field => !!getXmlChildText(node, [field]));
      if (hasAnyKeyField) return node;
    }
    return null;
  }

  function parseEmbeddedResultXml(xml, resultNodeNames = []) {
    const decodeEntities = value => {
      let output = String(value || '').trim();
      for (let i = 0; i < 3; i += 1) {
        if (!output) break;
        if (output[0] === '<') break;
        if (!/&lt;|&#60;|&#x3c;/i.test(output)) break;
        const textarea = document.createElement('textarea');
        textarea.innerHTML = output;
        output = String(textarea.value || '').trim();
      }
      return output;
    };

    for (const name of resultNodeNames) {
      const resultNode = xml.getElementsByTagNameNS('*', name)?.[0] || xml.getElementsByTagName(name)?.[0];
      const raw = decodeEntities(resultNode?.textContent || '');
      if (!raw || raw[0] !== '<') continue;
      try {
        return parseXmlDocument(raw, `Unable to parse embedded XML from ${name}`);
      } catch (error) {
        log('Embedded XML parse failed', { name, error });
      }
    }
    return null;
  }

  function collectXmlLeafFieldValues(xml) {
    const values = new Map();
    if (!xml) return values;
    const nodes = Array.from(xml.getElementsByTagName('*'));
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      const ns = String(node.namespaceURI || '').toLowerCase();
      if (ns.includes('www.w3.org/2001/xmlschema')) continue;
      const children = Array.from(node.children || []);
      if (children.length) continue;
      const text = String(node.textContent || '').trim();
      if (!text) continue;
      const key = String(node.localName || node.nodeName || '').trim().toLowerCase();
      if (!key || values.has(key)) continue;
      values.set(key, text);
    }
    return values;
  }

  function getLeafValue(fieldMap, candidateNames = []) {
    for (const name of candidateNames) {
      const value = fieldMap.get(String(name || '').trim().toLowerCase());
      if (value) return value;
    }
    return '';
  }

  function parseLifecycleXml(xmlText) {
    const xml = parseXmlDocument(xmlText, 'Unable to parse Mercury XML response');
    const statusNodes = Array.from(xml.getElementsByTagNameNS('*', 'OLCStatusMsg'));
    const rows = statusNodes.map(node => ({
      id: getText(node, 'ID'),
      msgDateTime: getText(node, 'MSG_DATETIME'),
      statusText: getText(node, 'STATUS_TEXT'),
      ticketId: getText(node, 'TICKET_ID'),
      empName: getText(node, 'EMP_NAME'),
      statusCdDesc: getText(node, 'STATUS_CD_DESC'),
      indvOrgTypCd: getText(node, 'INDV_ORG_TYP_CD'),
    }));
    return { ticketId: rows.find(r => r.ticketId)?.ticketId || '', latest: rows[0] || null, rows };
  }

  function parseTicketsXml(xmlText, requiredTicketToken = '') {
    const xml = parseXmlDocument(xmlText, 'Unable to parse ticket XML response');

    const normalizeTicketRef = value => String(value || '').trim().replace(/\s+/g, '').toUpperCase();
    const normalizeDigits = value => String(value || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const parseRequiredToken = token => {
      const normalized = normalizeTicketRef(token);
      if (!normalized) return null;
      const m = normalized.match(/^(\d+)\/(\d+)$/);
      if (!m) return null;
      return {
        normalized,
        saleId: normalizeDigits(m[1]),
        ticketNumber: normalizeDigits(m[2]),
      };
    };
    const required = parseRequiredToken(requiredTicketToken);

    const parseTicketFromNode = node => ({
      id: getXmlChildText(node, ['ID']),
      ticketId: getXmlChildText(node, ['TICKET_ID', 'ticketID', 'TicketID', 'TICKETID', 'ticketId']),
      userReference: getXmlChildText(node, ['USER_REFERENCE', 'UserReference', 'userReference']),
      ticketPosition: getXmlChildText(node, ['TICKET_POSITION', 'TicketPosition', 'ticketPosition']),
      saleId: getXmlChildText(node, ['SALE_ID', 'saleID', 'SaleID', 'SALEID']),
      recipientId: getXmlChildText(node, ['RECIPIENT_ID', 'recipientID', 'RecipientID', 'RECIPIENTID']),
      amount: getXmlChildText(node, ['AMT', 'amount']),
      amountPaid: getXmlChildText(node, ['AMT_PAID']),
      deliveryDate: getXmlChildText(node, ['DELIV_DATE', 'DELIVERY_DATE']),
      specialInstructions: getXmlChildText(node, ['SPECIAL_INSTR', 'SPECIAL_INSTRUCTIONS']),
      deliveryDateInstructions: getXmlChildText(node, ['DELIVERY_DATE_INSTR']),
    });

    const collectTicketRows = doc => {
      const nodes = Array.from(doc.getElementsByTagName('*'));
      const rows = [];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        const ns = String(node.namespaceURI || '').toLowerCase();
        if (ns.includes('www.w3.org/2001/xmlschema')) continue;
        const local = String(node.localName || node.nodeName || '').trim().toLowerCase();
        if (!['ticket', 'table', 'row'].includes(local)) continue;
        const parsed = parseTicketFromNode(node);
        if (!(parsed.saleId || parsed.recipientId || parsed.deliveryDate || parsed.amount || parsed.ticketId || parsed.id)) continue;
        rows.push(parsed);
      }
      return rows;
    };

    const selectExactTicket = rows => {
      if (!Array.isArray(rows) || !rows.length) return null;
      if (!required) return rows[0];

      const direct = rows.find(row => normalizeTicketRef(row.ticketId) === required.normalized);
      if (direct) return direct;
      const byUserReference = rows.find(row => normalizeTicketRef(row.userReference) === required.normalized);
      if (byUserReference) return byUserReference;

      const saleRows = rows.filter(row => normalizeDigits(row.saleId) === required.saleId);
      if (saleRows.length) {
        const byPosition = saleRows.find(row => normalizeDigits(row.ticketPosition) === required.ticketNumber);
        if (byPosition) return byPosition;

        const byId = saleRows.find((row) => {
          const idNorm = normalizeTicketRef(row.id);
          if (!idNorm) return false;
          if (idNorm === required.normalized) return true;
          const slashTicket = String(row.id || '').match(/\/\s*(\d+)\s*$/);
          if (slashTicket && normalizeDigits(slashTicket[1]) === required.ticketNumber) return true;
          return normalizeDigits(row.id) === required.ticketNumber;
        });
        if (byId) return byId;

        const hasPerTicketIdentity = saleRows.some(row =>
          normalizeTicketRef(row.ticketId) ||
          normalizeTicketRef(row.userReference) ||
          normalizeDigits(row.ticketPosition),
        );
        if (!hasPerTicketIdentity) {
          const idx = Math.max(Number(required.ticketNumber) - 1, -1);
          if (idx >= 0 && idx < saleRows.length) return saleRows[idx];
        }
      }

      // Some responses omit SALE_ID per row; if so, fall back to deterministic row index.
      const allRowsMissingSaleId = rows.every(row => !normalizeDigits(row.saleId));
      if (allRowsMissingSaleId) {
        const idx = Math.max(Number(required.ticketNumber) - 1, -1);
        if (idx >= 0 && idx < rows.length) return rows[idx];
      }

      return null;
    };

    const parseTicketFromLeafFields = doc => {
      const fields = collectXmlLeafFieldValues(doc);
      const parsed = {
        id: getLeafValue(fields, ['ID']),
        ticketId: getLeafValue(fields, ['TICKET_ID', 'ticketID', 'TicketID', 'TICKETID', 'ticketId']),
        userReference: getLeafValue(fields, ['USER_REFERENCE', 'UserReference', 'userReference']),
        ticketPosition: getLeafValue(fields, ['TICKET_POSITION', 'TicketPosition', 'ticketPosition']),
        saleId: getLeafValue(fields, ['SALE_ID', 'saleID', 'SaleID', 'SALEID']),
        recipientId: getLeafValue(fields, ['RECIPIENT_ID', 'recipientID', 'RecipientID', 'RECIPIENTID']),
        amount: getLeafValue(fields, ['AMT', 'amount']),
        amountPaid: getLeafValue(fields, ['AMT_PAID']),
        deliveryDate: getLeafValue(fields, ['DELIV_DATE', 'DELIVERY_DATE']),
        specialInstructions: getLeafValue(fields, ['SPECIAL_INSTR', 'SPECIAL_INSTRUCTIONS']),
        deliveryDateInstructions: getLeafValue(fields, ['DELIVERY_DATE_INSTR']),
      };
      const hasTicketSignal = !!(
        parsed.saleId || parsed.recipientId || parsed.deliveryDate || parsed.amount || parsed.ticketId || parsed.userReference || parsed.ticketPosition
      );
      return hasTicketSignal ? parsed : null;
    };

    const selectFromLeaf = parsedLeaf => {
      if (!parsedLeaf) return null;
      if (!required) return parsedLeaf;

      if (normalizeTicketRef(parsedLeaf.ticketId) === required.normalized) return parsedLeaf;
      if (normalizeTicketRef(parsedLeaf.userReference) === required.normalized) return parsedLeaf;
      const saleId = normalizeDigits(parsedLeaf.saleId);
      const ticketNumber = normalizeDigits(parsedLeaf.id);
      const ticketPosition = normalizeDigits(parsedLeaf.ticketPosition);
      if (saleId && saleId === required.saleId && ticketPosition && ticketPosition === required.ticketNumber) return parsedLeaf;
      if (saleId && saleId === required.saleId && ticketNumber && ticketNumber === required.ticketNumber) return parsedLeaf;
      if (saleId && saleId === required.saleId && !ticketNumber && required.ticketNumber === '1') return parsedLeaf;
      return null;
    };

    const selectFromDoc = doc => {
      const fromRows = selectExactTicket(collectTicketRows(doc));
      if (fromRows) return fromRows;
      return selectFromLeaf(parseTicketFromLeafFields(doc));
    };

    let parsed = selectFromDoc(xml);
    if (!parsed) {
      const embeddedXml = parseEmbeddedResultXml(xml, ['GetTicketsResult', 'string']);
      if (embeddedXml) parsed = selectFromDoc(embeddedXml);
    }

    if (!parsed && requiredTicketToken) throw new Error(`Ticket ${requiredTicketToken} not found in GetTickets response`);

    if (!parsed) {
      const tagPreview = Array.from(xml.getElementsByTagName('*'))
        .slice(0, 20)
        .map(node => String(node.localName || node.nodeName || '').trim())
        .filter(Boolean)
        .join(', ');
      throw new Error(`No Ticket record found (XML tags: ${tagPreview || 'none'})`);
    }
    return parsed;
  }

  function parseRecipientXml(xmlText) {
    const xml = parseXmlDocument(xmlText, 'Unable to parse recipient XML response');

    const parseRecipientFromDoc = doc => {
      const recipient = findDataRowNode(
        doc,
        ['Recipient', 'RECIPIENT', 'Table', 'ROW'],
        ['ID', 'NAME', 'ADDRESS', 'RECIPIENT_ID', 'RECIPIENTID'],
      );
      if (!recipient) return null;
      return {
        id: getXmlChildText(recipient, ['ID', 'RECIPIENT_ID', 'RECIPIENTID']),
        name: getXmlChildText(recipient, ['NAME']),
        address: getXmlChildText(recipient, ['ADDRESS', 'ADDRESS1', 'ADDR1', 'STREET', 'STREET1', 'STREET_ADDRESS', 'DELIV_ADDR', 'DELIVERY_ADDRESS']),
        address2: getXmlChildText(recipient, ['ADDRESS2', 'ADDR2', 'STREET2']),
        city: getXmlChildText(recipient, ['CITY', 'CITY_NAME', 'TOWN']),
        state: getXmlChildText(recipient, ['STATE_PROV', 'STATE', 'STATE_CD']),
        country: getXmlChildText(recipient, ['COUNTRY']),
        postalCode: getXmlChildText(recipient, ['POSTAL_CODE', 'ZIP', 'ZIP_CODE', 'POSTCODE']),
        phone: getXmlChildText(recipient, ['PHONE']),
        firmName: getXmlChildText(recipient, ['FIRM_NAME', 'BUSINESS_NAME', 'COMPANY']).trim(),
      };
    };

    const parseRecipientFromLeafFields = doc => {
      const fields = collectXmlLeafFieldValues(doc);
      const parsed = {
        id: getLeafValue(fields, ['ID', 'RECIPIENT_ID', 'RECIPIENTID']),
        name: getLeafValue(fields, ['NAME']),
        address: getLeafValue(fields, ['ADDRESS', 'ADDRESS1', 'ADDR1', 'STREET', 'STREET1', 'STREET_ADDRESS', 'DELIV_ADDR', 'DELIVERY_ADDRESS']),
        address2: getLeafValue(fields, ['ADDRESS2', 'ADDR2', 'STREET2']),
        city: getLeafValue(fields, ['CITY', 'CITY_NAME', 'TOWN']),
        state: getLeafValue(fields, ['STATE_PROV', 'STATE', 'STATE_CD']),
        country: getLeafValue(fields, ['COUNTRY']),
        postalCode: getLeafValue(fields, ['POSTAL_CODE', 'ZIP', 'ZIP_CODE', 'POSTCODE']),
        phone: getLeafValue(fields, ['PHONE']),
        firmName: getLeafValue(fields, ['FIRM_NAME', 'BUSINESS_NAME', 'COMPANY']).trim(),
      };
      const hasRecipientSignal = !!(parsed.name || parsed.address || parsed.id);
      return hasRecipientSignal ? parsed : null;
    };

    let parsed = parseRecipientFromDoc(xml);
    if (!parsed) parsed = parseRecipientFromLeafFields(xml);
    if (!parsed) {
      const embeddedXml = parseEmbeddedResultXml(xml, ['GetRecipientResult', 'string']);
      if (embeddedXml) parsed = parseRecipientFromDoc(embeddedXml) || parseRecipientFromLeafFields(embeddedXml);
    }

    if (!parsed) throw new Error('No Recipient record found');
    return parsed;
  }

  function mercuryRequest({ method = 'GET', url, headers = {}, data = null }) {
    return new Promise((resolve, reject) => {
      const gmRequest =
        (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest)
        || (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' && GM.xmlHttpRequest.bind(GM))
        || null;
      if (!gmRequest) {
        reject(new Error('Userscript HTTP bridge is unavailable (GM_xmlhttpRequest missing).'));
        return;
      }
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestUrl = String(url || '').includes('?')
        ? `${url}&_mhqReq=${encodeURIComponent(requestId)}`
        : `${url}?_mhqReq=${encodeURIComponent(requestId)}`;
      const mergedHeaders = Object.assign({
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      }, headers || {});
      log('Mercury request', { method, url: requestUrl, data, requestId });
      gmRequest({
        method,
        url: requestUrl,
        headers: mergedHeaders,
        data,
        onload: response => {
          log('Mercury response', { method, url: requestUrl, status: response.status, preview: String(response.responseText || '').slice(0, 400), requestId });
          if (response.status >= 200 && response.status < 300) resolve(response.responseText);
          else {
            const preview = String(response.responseText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            reject(new Error(`Mercury service returned HTTP ${response.status} for ${method} ${requestUrl}${preview ? ` | Response: ${preview}` : ''}`));
          }
        },
        onerror: () => reject(new Error(`Network error calling Mercury service: ${method} ${requestUrl}`)),
        ontimeout: () => reject(new Error(`Mercury service timed out: ${method} ${requestUrl}`)),
      });
    });
  }

  function bridgeRequest({ method = 'GET', url, headers = {}, data = null }) {
    return new Promise((resolve, reject) => {
      const gmRequest =
        (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest)
        || (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' && GM.xmlHttpRequest.bind(GM))
        || null;
      if (gmRequest) {
        gmRequest({
          method,
          url,
          headers,
          data,
          onload: response => {
            if (response.status >= 200 && response.status < 300) resolve(response.responseText);
            else reject(new Error(`Bridge service returned HTTP ${response.status} for ${method} ${url}`));
          },
          onerror: () => reject(new Error(`Network error calling bridge service: ${method} ${url}`)),
          ontimeout: () => reject(new Error(`Bridge service timed out: ${method} ${url}`)),
        });
        return;
      }

      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutMs = 3000;
      const timeoutId = controller
        ? setTimeout(() => {
          try { controller.abort(); } catch {}
        }, timeoutMs)
        : null;

      const fetchHeaders = Object.assign({}, headers || {});
      fetch(url, {
        method,
        headers: fetchHeaders,
        body: data,
        signal: controller?.signal,
        cache: 'no-store',
      })
        .then(async response => {
          const text = await response.text();
          if (response.status >= 200 && response.status < 300) {
            resolve(text);
            return;
          }
          reject(new Error(`Bridge service returned HTTP ${response.status} for ${method} ${url}`));
        })
        .catch(error => {
          const msg = error && error.name === 'AbortError'
            ? `Bridge service timed out: ${method} ${url}`
            : `Network error calling bridge service: ${method} ${url}`;
          reject(new Error(msg));
        })
        .finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
    });
  }

  function getBridgeBaseUrl() {
    const raw = String(CONFIG.oposBridge?.url || '').trim();
    return raw.replace(/\/+$/, '');
  }

  function queueBridgeLeaseOperation(operation, reason = '') {
    const run = async () => {
      try {
        return await operation();
      } catch (error) {
        log(`Bridge lease op failed (${reason || 'unspecified'})`, error);
        return null;
      }
    };
    state.bridgeLeaseChain = Promise.resolve(state.bridgeLeaseChain)
      .catch(() => null)
      .then(run);
    return state.bridgeLeaseChain;
  }

  function sanitizeBridgeOwner(rawOwner = '') {
    const cleaned = String(rawOwner || '').replace(/[^\w\-.:]/g, '').trim();
    if (!cleaned) return `mhq-${Date.now()}`;
    return cleaned.slice(0, 80);
  }

  async function bridgeLeaseScanner(owner = '', leaseMs = 0) {
    const baseUrl = getBridgeBaseUrl();
    if (!baseUrl) return null;
    const safeOwner = sanitizeBridgeOwner(owner);
    const requestedMs = Math.max(500, Number(leaseMs || CONFIG.oposBridge?.leaseMs || 3500));
    const url = `${baseUrl}/scanner/lease?owner=${encodeURIComponent(safeOwner)}&ms=${encodeURIComponent(requestedMs)}`;
    return queueBridgeLeaseOperation(async () => {
      const body = await bridgeRequest({ method: 'GET', url });
      try {
        return JSON.parse(String(body || '{}'));
      } catch {
        return null;
      }
    }, `lease:${safeOwner}`);
  }

  async function bridgeReleaseScanner(owner = '', force = false) {
    const baseUrl = getBridgeBaseUrl();
    if (!baseUrl) return null;
    const safeOwner = sanitizeBridgeOwner(owner);
    const url = `${baseUrl}/scanner/release?owner=${encodeURIComponent(safeOwner)}${force ? '&force=1' : ''}`;
    return queueBridgeLeaseOperation(async () => {
      const body = await bridgeRequest({ method: 'GET', url });
      try {
        return JSON.parse(String(body || '{}'));
      } catch {
        return null;
      }
    }, `release:${safeOwner}`);
  }

  async function fetchBridgeLatestScan() {
    const baseUrl = getBridgeBaseUrl();
    if (!baseUrl) return null;
    const body = await bridgeRequest({ method: 'GET', url: `${baseUrl}/scan/latest` });
    const parsed = JSON.parse(String(body || '{}'));
    const scan = parsed?.scan || null;
    if (!scan) return null;
    const seq = Number(scan.seq || 0);
    const value = String(scan.value || '').trim();
    return { seq, value, at: String(scan.at || '') };
  }

  async function fetchBridgeNextScan(owner = '') {
    const baseUrl = getBridgeBaseUrl();
    if (!baseUrl) return null;
    const ownerToken = String(owner || '').trim();
    const ownerQuery = ownerToken ? `?owner=${encodeURIComponent(sanitizeBridgeOwner(ownerToken))}` : '';
    const body = await bridgeRequest({ method: 'GET', url: `${baseUrl}/scan/next${ownerQuery}` });
    const parsed = JSON.parse(String(body || '{}'));
    const scan = parsed?.scan || null;
    if (!scan) return null;
    const seq = Number(scan.seq || 0);
    const value = String(scan.value || '').trim();
    return { seq, value, at: String(scan.at || '') };
  }

  function parseOrderTicketToken(raw) {
    const token = String(raw || '').trim().toUpperCase();
    const m = token.match(/^(\d+)[/-](\d+)$/);
    if (!m) return null;
    return { orderId: String(Number(m[1])), ticketNumber: String(Number(m[2])), token: `${String(Number(m[1]))}/${String(Number(m[2]))}` };
  }

  function validateTicketLookup(expectedToken, ticket) {
    const expected = parseOrderTicketToken(expectedToken);
    if (!expected) return;
    const actualSaleId = String(ticket?.saleId || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (actualSaleId && actualSaleId !== expected.orderId) {
      throw new Error(`Ticket lookup mismatch: expected sale ${expected.orderId}, got ${actualSaleId}`);
    }
    const actualTicketPosition = String(ticket?.ticketPosition || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const actualId = String(ticket?.id || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const directRefs = [
      String(ticket?.ticketId || '').trim().toUpperCase(),
      String(ticket?.userReference || '').trim().toUpperCase(),
    ].filter(Boolean);
    if (directRefs.includes(expected.token)) return;
    if (actualTicketPosition && actualTicketPosition === expected.ticketNumber) return;
    if (actualId && actualId === expected.ticketNumber && actualSaleId === expected.orderId) return;
    if (!directRefs.length && !actualTicketPosition && !actualId && actualSaleId === expected.orderId && expected.ticketNumber === '1') return;
    throw new Error(`Ticket lookup mismatch: expected ${expected.token}, received non-matching ticket payload`);
  }

  async function bridgeRearmScanner() {
    const baseUrl = getBridgeBaseUrl();
    if (!baseUrl) return null;
    const body = await bridgeRequest({ method: 'GET', url: `${baseUrl}/scanner/rearm` });
    try {
      return JSON.parse(String(body || '{}'));
    } catch {
      return null;
    }
  }

  async function bridgeClearScan() {
    const baseUrl = getBridgeBaseUrl();
    if (!baseUrl) return null;
    const body = await bridgeRequest({ method: 'GET', url: `${baseUrl}/scan/clear` });
    try {
      return JSON.parse(String(body || '{}'));
    } catch {
      return null;
    }
  }

  function bridgeFlushScanner(reason = '') {
    if (!CONFIG.oposBridge?.enabled) return Promise.resolve(null);
    const runFlush = async () => {
      try {
        await bridgeClearScan();
        await bridgeRearmScanner();
        return true;
      } catch (error) {
        log(`Bridge flush failed (${reason || 'unspecified'})`, error);
        return false;
      }
    };
    state.bridgeFlushChain = Promise.resolve(state.bridgeFlushChain)
      .catch(() => null)
      .then(runFlush);
    return state.bridgeFlushChain;
  }

  async function fetchLifecycleByTicket(ticketId) {
    const url = buildApiUrl(CONFIG.olcByTicketPath);
    const serviceUrl = buildApiUrl('/OrderLifeCycle.asmx');
    const attempts = [];
    for (const soapNamespace of getSoapNamespaceVariants()) {
      for (const key of ['TicketID', 'ticketID']) {
        attempts.push({
          label: `SOAP OLCGetByTicket (${soapNamespace}, ${key})`,
          method: 'POST',
          url: serviceUrl,
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: buildSoapAction('OLCGetByTicket', soapNamespace),
          },
          data: buildSoapEnvelope('OLCGetByTicket', { [key]: ticketId }, soapNamespace),
        });
      }
    }
    attempts.push(
      {
        label: 'POST TicketID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `TicketID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST ticketID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketID=${encodeURIComponent(ticketId)}`,
      },
    );

    const errors = [];
    for (const attempt of attempts) {
      try {
        log('Trying lifecycle lookup', attempt.label, attempt);
        const xmlText = await mercuryRequest(attempt);
        return parseLifecycleXml(xmlText);
      } catch (error) {
        errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`OLCGetByTicket failed for ticket ${ticketId}. Attempts: ${errors.join(' | ')}`);
  }

  async function fetchTicket(orderId, requiredTicketToken = '') {
    const methodUrl = buildApiUrl('/OrderEntry.asmx/GetTickets');
    const serviceUrl = buildApiUrl('/OrderEntry.asmx');
    const attempts = [];
    for (const soapNamespace of getSoapNamespaceVariants()) {
      for (const key of ['saleID', 'SaleID']) {
        attempts.push({
          label: `SOAP GetTickets (${soapNamespace}, ${key})`,
          method: 'POST',
          url: serviceUrl,
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: buildSoapAction('GetTickets', soapNamespace),
          },
          data: buildSoapEnvelope('GetTickets', { [key]: orderId }, soapNamespace),
        });
      }
    }
    attempts.push(
      {
        label: 'POST saleID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'POST SaleID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `SaleID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'POST saleId',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleId=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'POST ticketID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'POST TicketID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `TicketID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'POST ticketId',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketId=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'POST saleID to service root',
        method: 'POST',
        url: serviceUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'GET saleID',
        method: 'GET',
        url: `${methodUrl}?saleID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'GET SaleID',
        method: 'GET',
        url: `${methodUrl}?SaleID=${encodeURIComponent(orderId)}`,
      },
      {
        label: 'GET ticketID',
        method: 'GET',
        url: `${methodUrl}?ticketID=${encodeURIComponent(orderId)}`,
      },
    );

    const errors = [];
    for (const attempt of attempts) {
      try {
        log('Trying ticket lookup', attempt.label, attempt);
        const xmlText = await mercuryRequest(attempt);
        return parseTicketsXml(xmlText, requiredTicketToken);
      } catch (error) {
        errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`GetTickets failed for order ${orderId} ticket ${requiredTicketToken || '(unspecified)'}. Attempts: ${errors.join(' | ')}`);
  }

  async function fetchRecipient(recipientId) {
    const methodUrl = buildApiUrl('/OrderEntry.asmx/GetRecipient');
    const serviceUrl = buildApiUrl('/OrderEntry.asmx');
    const attempts = [];
    for (const soapNamespace of getSoapNamespaceVariants()) {
      for (const key of ['recipientID', 'RecipientID']) {
        attempts.push({
          label: `SOAP GetRecipient (${soapNamespace}, ${key})`,
          method: 'POST',
          url: serviceUrl,
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: buildSoapAction('GetRecipient', soapNamespace),
          },
          data: buildSoapEnvelope('GetRecipient', { [key]: recipientId }, soapNamespace),
        });
      }
    }
    attempts.push(
      {
        label: 'POST recipientID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `recipientID=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'POST RecipientID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `RecipientID=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'POST recipientId',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `recipientId=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'POST recipientID to service root',
        method: 'POST',
        url: serviceUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `recipientID=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'GET recipientID',
        method: 'GET',
        url: `${methodUrl}?recipientID=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'GET RecipientID',
        method: 'GET',
        url: `${methodUrl}?RecipientID=${encodeURIComponent(recipientId)}`,
      },
    );

    const errors = [];
    for (const attempt of attempts) {
      try {
        log('Trying recipient lookup', attempt.label, attempt);
        const xmlText = await mercuryRequest(attempt);
        return parseRecipientXml(xmlText);
      } catch (error) {
        errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`GetRecipient failed for recipient ${recipientId}. Attempts: ${errors.join(' | ')}`);
  }

  function splitRecipientName(fullName) {
    const cleaned = String(fullName || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) return { firstName: '', lastName: '' };
    const parts = cleaned.split(' ');
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  function normalizePhone(phone) {
    const raw = String(phone || '').trim();
    const marker = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!raw || marker === 'NA') {
      const fallbackDigits = getRequestDefault('defaultPhone').replace(/\D/g, '');
      if (fallbackDigits.length === 10) return `${fallbackDigits.slice(0, 3)}-${fallbackDigits.slice(3, 6)}-${fallbackDigits.slice(6)}`;
      return getRequestDefault('defaultPhone');
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return raw;
  }

  function mapCountry(country) {
    const defaultCountry = getRequestDefault('defaultCountry') || CONFIG.fixedCountry || 'United States';
    const c = String(country || '').trim().toUpperCase();
    if (c === 'US' || c === 'USA' || c === 'UNITED STATES') return defaultCountry;
    return country || defaultCountry;
  }

  function normalizeUsZip5(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const explicit = text.match(/\b(\d{5})(?:-\d{4})?\b/);
    if (explicit?.[1]) return explicit[1];
    const digits = text.replace(/\D/g, '');
    return digits.length >= 5 ? digits.slice(0, 5) : '';
  }

  function deriveRecipientZip(recipient = {}) {
    const candidates = [
      recipient?.postalCode,
      recipient?.address,
      `${recipient?.city || ''} ${recipient?.state || ''} ${recipient?.postalCode || ''}`,
    ];
    for (const candidate of candidates) {
      const zip = normalizeUsZip5(candidate);
      if (zip) return zip;
    }
    return '';
  }

  function readElementValue(el) {
    if (!el) return '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return String(el.value || '').trim();
    }
    return String(el.textContent || '').trim();
  }

  function isCountryUnset(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    return normalized === 'select a country' || normalized === 'select country' || normalized === 'choose country';
  }

  function enforceCountryDefault(preferredCountry = '') {
    const defaultCountry = mapCountry(preferredCountry || 'US');
    const selectedCountry = getInput('country');
    if (selectedCountry && !isCountryUnset(readElementValue(selectedCountry))) return true;

    const usOption = qs('[data-testid="web_picker_country_US"]');
    if (usOption instanceof HTMLElement) {
      usOption.click();
      markFilled(usOption, `Defaulted to ${defaultCountry}`);
      return true;
    }

    const candidates = qsa('input, select, textarea, [role="combobox"]').filter(el => {
      const haystack = [
        el.getAttribute('data-testid'),
        el.getAttribute('name'),
        el.getAttribute('id'),
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
      ].join(' ').toLowerCase();
      return haystack.includes('country');
    });

    for (const candidate of candidates) {
      if (candidate instanceof HTMLSelectElement) {
        if (!setSelectByValueOrLabel(candidate, defaultCountry)) continue;
      } else if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
        setNativeValue(candidate, defaultCountry);
      } else {
        continue;
      }

      const current = readElementValue(candidate);
      if (!isCountryUnset(current)) {
        markFilled(candidate, `Defaulted to ${defaultCountry}`);
        return true;
      }
    }

    log('Country field is unset and could not be auto-corrected');
    return false;
  }

  function formatMoney(value) {
    const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
    if (Number.isNaN(n)) return '';
    return n.toFixed(2);
  }

  function formatDateMMDDYYYY(input) {
    if (!input) return '';
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  }

  function isSameLocalDay(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  function parseMeridianTimeToMinutes(raw) {
    const text = String(raw || '').trim().toUpperCase();
    const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2] || '0');
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    const hour24 = (hour % 12) + (match[3] === 'PM' ? 12 : 0);
    return (hour24 * 60) + minute;
  }

  function getNextHalfHourMinuteOfDay(now = new Date()) {
    const totalMinutes = (now.getHours() * 60) + now.getMinutes();
    return Math.ceil(totalMinutes / 30) * 30;
  }

  function clearPickupTimeFieldForToday() {
    const pickup = getInput('pickUpDateTime');
    if (!pickup) return;
    // Clear any prefilled "current time" style value first. We only want to
    // keep values selected from enabled, valid dropdown options.
    if (pickup instanceof HTMLSelectElement) {
      const blank = Array.from(pickup.options || []).find(opt => String(opt.value || '').trim() === '');
      if (blank) setNativeValue(pickup, blank.value);
      else setNativeValue(pickup, '');
      return;
    }
    if (pickup instanceof HTMLInputElement || pickup instanceof HTMLTextAreaElement) {
      setNativeValue(pickup, '');
    }
  }

  function selectNextAvailablePickupTimeForToday() {
    const pickup = getInput('pickUpDateTime');
    if (!(pickup instanceof HTMLSelectElement)) return false;
    const thresholdMinutes = getNextHalfHourMinuteOfDay(new Date());

    const candidates = Array.from(pickup.options || [])
      .map(opt => {
        const text = String(opt.textContent || opt.label || opt.value || '').trim();
        const value = String(opt.value || '').trim();
        const disabled = !!opt.disabled || String(opt.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const looksPlaceholder = !text || /^select\b/i.test(text) || /^choose\b/i.test(text);
        const minutes = parseMeridianTimeToMinutes(text);
        return { opt, text, value, disabled, looksPlaceholder, minutes };
      })
      .filter(entry => !entry.disabled && !entry.looksPlaceholder && !!entry.value && Number.isFinite(entry.minutes));

    if (!candidates.length) return false;

    const selected = candidates.find(entry => entry.minutes >= thresholdMinutes) || candidates[0];
    if (!selected) return false;
    setNativeValue(pickup, selected.value);
    const selectedOption = pickup.options[pickup.selectedIndex] || null;
    if (!selectedOption) return false;
    const selectedDisabled = !!selectedOption.disabled || String(selectedOption.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    if (selectedDisabled) return false;
    const selectedText = String(selectedOption.textContent || selectedOption.label || selectedOption.value || '').trim();
    if (!selectedText || /^select\b/i.test(selectedText) || /^choose\b/i.test(selectedText)) return false;
    markFilled(pickup, `Today delivery: auto-selected next available pickup time (${selectedText})`);
    return true;
  }

  function extractUnit(addressLine1, specialInstructions) {
    const combined = `${addressLine1 || ''} || ${specialInstructions || ''}`;
    const patterns = [/\b(?:APT|APARTMENT)\s*#?\s*([A-Z0-9-]+)/i, /\b(?:UNIT)\s*#?\s*([A-Z0-9-]+)/i, /\b(?:SUITE|STE)\s*#?\s*([A-Z0-9-]+)/i, /\b(?:ROOM|RM|ROIOM)\s*#?\s*([A-Z0-9-]+)/i, /\b#\s*([A-Z0-9-]+)/i];
    for (const pattern of patterns) {
      const match = combined.match(pattern);
      if (match?.[0]) return match[0].replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function splitBusinessAndStreetAddress(addressLine1, firmName = '') {
    const normalizedAddress = String(addressLine1 || '').trim().replace(/\s+/g, ' ');
    const normalizedFirm = String(firmName || '').trim().replace(/\s+/g, ' ');
    if (!normalizedAddress) return { street: '', businessName: normalizedFirm };
    if (normalizedFirm) return { street: normalizedAddress, businessName: normalizedFirm };

    // Handle concatenated values such as:
    // "CHILDREN'S HOSPITAL OF PITTSBURGH4401 PENN AVE"
    const match = normalizedAddress.match(/^(.+?)(\d{1,6}\s*[A-Za-z0-9].*)$/);
    if (match) {
      const candidateBusiness = String(match[1] || '').trim().replace(/[,\-;:]+$/, '').trim();
      const candidateStreet = String(match[2] || '').trim();
      const hasBusinessSignal = /[A-Za-z]{3,}/.test(candidateBusiness) && !/\d/.test(candidateBusiness);
      const hasStreetSignal = /^\d{1,6}\b/.test(candidateStreet) && /[A-Za-z]{2,}/.test(candidateStreet);
      if (hasBusinessSignal && hasStreetSignal) {
        return { street: candidateStreet, businessName: candidateBusiness };
      }
    }

    return { street: normalizedAddress, businessName: normalizedFirm };
  }

  function stripUnitFromAddress(addressLine1, extractedUnit) {
    let address = normalizeInlineWhitespace(addressLine1 || '');
    if (!address || !extractedUnit) return address;
    const escaped = extractedUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return normalizeInlineWhitespace(address.replace(new RegExp(`\\s*,?\\s*${escaped}`, 'i'), ''));
  }

  function inferLocationType(recipientName, firmName) {
    const combined = `${recipientName || ''} ${firmName || ''}`.toLowerCase();
    if (combined.includes('funeral home') || combined.includes('funeral')) return 'Funeral Home';
    return getRequestDefault('defaultLocationType') || 'Residence';
  }

  function deriveOrderData(scannedTicketId, lifecycle, ticket, recipient) {
    const latest = lifecycle?.latest || {};
    const nameParts = splitRecipientName(recipient?.name || '');
    const specialInstructions = [ticket?.specialInstructions, ticket?.deliveryDateInstructions].map(v => String(v || '').trim()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(' | ');
    const splitAddress = splitBusinessAndStreetAddress(recipient?.address || '', recipient?.firmName || '');
    const unit = extractUnit(splitAddress.street || '', specialInstructions);
    const street = stripUnitFromAddress(splitAddress.street || '', unit);
    const businessName = splitAddress.businessName || '';
    const isToday = isSameLocalDay(ticket?.deliveryDate);
    const scannedToken = parseOrderTicketToken(scannedTicketId);
    const fallbackOrderId = String(ticket?.saleId || lifecycle?.ticketId || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const fallbackTicketNumber = String(ticket?.ticketPosition || ticket?.id || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const referenceOrderId = scannedToken?.orderId || fallbackOrderId;
    const referenceTicketNumber = scannedToken?.ticketNumber || fallbackTicketNumber || '1';
    const referenceNumber = referenceOrderId
      ? `${referenceOrderId}-${referenceTicketNumber}`
      : (ticket?.saleId || lifecycle?.ticketId || scannedTicketId);

    return {
      referenceNumber,
      totalItemValue: formatMoney(ticket?.amount),
      itemDescription: getRequestDefault('defaultItemDescription'),
      recipient_name: nameParts.firstName,
      lastName: nameParts.lastName,
      phone: normalizePhone(recipient?.phone || ''),
      addressLine1: street,
      addressLine2: unit,
      city: recipient?.city || '',
      state: recipient?.state || '',
      zip: deriveRecipientZip(recipient),
      country: mapCountry(recipient?.country || 'US'),
      locationType: inferLocationType(recipient?.name || '', businessName),
      locationName: businessName,
      specialDeliveryInstructions: specialInstructions || getRequestDefault('defaultDeliveryInstruction'),
      undeliverableAction: getRequestDefault('defaultUndeliverableAction'),
      deliveryDate: formatDateMMDDYYYY(ticket?.deliveryDate),
      pickUpDateTime: isToday ? '' : getRequestDefault('defaultFuturePickupTime'),
      meta: {
        latestStatus: latest.statusCdDesc || '',
        latestStatusAt: latest.msgDateTime || '',
        scannedTicketId,
        resolvedTicketId: ticket?.id || lifecycle?.ticketId || '',
        saleId: ticket?.saleId || '',
        recipientId: ticket?.recipientId || '',
        isToday,
      },
    };
  }

  function fillField(name, value, reviewReason = '', options = {}) {
    const {
      source = 'manual',
      maxLength = null,
      dispatchInput = true,
      dispatchChange = true,
    } = options;
    const el = getInput(name);
    if (!el) { log('Missing field selector for', name); return null; }
    const rawValue = value == null ? '' : String(value);
    const hasValue = rawValue.trim() !== '';
    let finalValue = hasValue ? rawValue : '';
    let truncated = false;
    if (hasValue && maxLength && finalValue.length > maxLength) { finalValue = finalValue.slice(0, maxLength); truncated = true; }

    if (el.tagName === 'SELECT') {
      if (hasValue) {
        const ok = setSelectByValueOrLabel(el, finalValue, { dispatchInput, dispatchChange });
        if (ok) { if (source === 'service') markFilled(el, `Mapped from service${truncated ? ' (truncated/review suggested)' : ''}`); }
        else {
          const options = Array.from(el.options || []);
          const blank = options.find(opt => String(opt.value || '').trim() === '');
          if (blank) setNativeValue(el, blank.value);
          else if (options.length) setNativeValue(el, options[0].value);
          else setNativeValue(el, '');
          markReview(el, reviewReason || `Could not select ${finalValue}`);
        }
      } else {
        const options = Array.from(el.options || []);
        const blank = options.find(opt => String(opt.value || '').trim() === '');
        if (blank) setNativeValue(el, blank.value);
        else if (options.length) setNativeValue(el, options[0].value);
        else setNativeValue(el, '');
        if (reviewReason) markReview(el, reviewReason);
      }
    } else {
      if (hasValue) {
        setNativeValue(el, finalValue, { dispatchInput, dispatchChange });
        if (source === 'service') markFilled(el, `Mapped from service${truncated ? ' (truncated)' : ''}`);
      } else {
        setNativeValue(el, '');
        if (reviewReason) markReview(el, reviewReason);
      }
      if (truncated) markReview(el, 'Value was too long and was truncated');
    }
    return el;
  }

  function applyOrderData(orderData) {
    clearHighlights();
    fillField('referenceNumber', orderData.referenceNumber, 'Mapped from scanned order/ticket', { source: 'service', maxLength: 50 });
    fillField('totalItemValue', orderData.totalItemValue, 'Mapped from AMT on ticket', { source: orderData.totalItemValue ? 'service' : 'manual', maxLength: 20 });
    fillField('itemDescription', orderData.itemDescription, 'Fixed business rule', { source: 'service', maxLength: 500 });
    fillField('recipient_name', orderData.recipient_name, 'Mapped from recipient name split', { source: orderData.recipient_name ? 'service' : 'manual', maxLength: 100 });
    fillField('lastName', orderData.lastName, 'Mapped from recipient name split', { source: orderData.lastName ? 'service' : 'manual', maxLength: 100 });
    fillField('phone', orderData.phone, 'Mapped from recipient phone', { source: orderData.phone ? 'service' : 'manual', maxLength: 18 });
    fillField('addressLine1', orderData.addressLine1, 'Mapped from recipient address', { source: orderData.addressLine1 ? 'service' : 'manual', maxLength: 120, dispatchInput: true, dispatchChange: false });
    fillField('addressLine2', orderData.addressLine2, 'Extracted from address or instructions; verify', { source: orderData.addressLine2 ? 'service' : 'manual', maxLength: 120, dispatchInput: true, dispatchChange: false });
    fillField('city', orderData.city, 'Mapped from recipient city', { source: orderData.city ? 'service' : 'manual', maxLength: 100, dispatchInput: true, dispatchChange: false });
    fillField('state', orderData.state, 'Mapped from recipient state', { source: orderData.state ? 'service' : 'manual', dispatchInput: true, dispatchChange: false });
    fillField('zip', orderData.zip, 'Mapped from recipient postal code', { source: orderData.zip ? 'service' : 'manual', maxLength: 5, dispatchInput: true, dispatchChange: false });
    fillField('country', orderData.country, 'Mapped from recipient country', { source: orderData.country ? 'service' : 'manual', dispatchInput: true, dispatchChange: false });
    enforceCountryDefault(orderData.country);
    setTimeout(() => enforceCountryDefault(orderData.country), 180);
    setTimeout(() => enforceCountryDefault(orderData.country), 650);
    fillField('locationType', orderData.locationType, 'Defaulted by business rule; verify if needed', { source: 'service' });
    fillField('locationName', orderData.locationName, 'Mapped from firm name if present', { source: orderData.locationName ? 'service' : 'manual', maxLength: 120 });
    fillField('specialDeliveryInstructions', orderData.specialDeliveryInstructions, 'Mapped from special instructions or defaulted', { source: orderData.specialDeliveryInstructions ? 'service' : 'manual', maxLength: 500 });
    ensureDeliveryInstructionPicker(orderData.specialDeliveryInstructions, true);
    fillField('undeliverableAction', orderData.undeliverableAction, 'Fixed business rule', { source: 'service' });
    fillField('deliveryDate', orderData.deliveryDate, 'Mapped from ticket delivery date', { source: orderData.deliveryDate ? 'service' : 'manual', maxLength: 10 });
    if (orderData.meta?.isToday) {
      clearPickupTimeFieldForToday();
      const selectedNow = selectNextAvailablePickupTimeForToday();
      if (!selectedNow) {
        setTimeout(() => {
          const selectedLate = selectNextAvailablePickupTimeForToday();
          if (selectedLate) return;
          const pickup = getInput('pickUpDateTime');
          if (pickup) markReview(pickup, 'Today delivery: choose the next available pickup time manually');
        }, 220);
        setTimeout(() => { selectNextAvailablePickupTimeForToday(); }, 700);
      }
    } else {
      fillField('pickUpDateTime', orderData.pickUpDateTime, 'Future delivery: defaulted by configuration', { source: orderData.pickUpDateTime ? 'service' : 'manual', maxLength: 20 });
    }
    scheduleAddressVerificationCommit(addressCommitToken);
  }

  const AUTO_FILLED_FIELD_KEYS = [
    'referenceNumber',
    'totalItemValue',
    'itemDescription',
    'recipient_name',
    'lastName',
    'phone',
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'zip',
    'country',
    'locationType',
    'locationName',
    'specialDeliveryInstructions',
    'undeliverableAction',
    'deliveryDate',
    'pickUpDateTime',
  ];

  const ADDRESS_VERIFICATION_FIELD_KEYS = [
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'zip',
    'country',
  ];

  function dispatchInputAndChange(el) {
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dispatchChangeOnly(el) {
    if (!el) return;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function commitAddressVerificationState(token) {
    if (token !== state.addressVerificationCommitToken) return;
    for (const key of ADDRESS_VERIFICATION_FIELD_KEYS) {
      const el = getInput(key);
      dispatchChangeOnly(el);
    }
  }

  function removeBadgesForField(el) {
    const labelNode = findFieldLabelNode(el);
    if (!labelNode) return;
    qsa('.mhq-field-badge', labelNode).forEach(node => node.remove());
  }

  function reconcileAddressLine1VisualState(token) {
    if (token !== state.addressVerificationCommitToken) return;
    const addressLine1 = getInput('addressLine1');
    if (!addressLine1) return;
    if (readElementValue(addressLine1)) return;
    // Mercury may clear/replace address asynchronously after autofill.
    // If value is now empty, clear stale visual "filled" state.
    addressLine1.classList.remove('mhq-filled', 'mhq-review');
    addressLine1.removeAttribute('title');
    removeBadgesForField(addressLine1);
  }

  function scheduleAddressVerificationCommit(token) {
    // Commit once after all address fields are filled, then once later to beat stale async responses.
    setTimeout(() => commitAddressVerificationState(token), 90);
    setTimeout(() => commitAddressVerificationState(token), 420);
    setTimeout(() => reconcileAddressLine1VisualState(token), 950);
  }

  function clearFieldValue(fieldKey) {
    const el = getInput(fieldKey);
    if (!el) return;
    if (el.tagName === 'SELECT') {
      const selectEl = el;
      const options = Array.from(selectEl.options || []);
      const blank = options.find(opt => String(opt.value || '').trim() === '');
      if (blank) setNativeValue(selectEl, blank.value);
      else if (options.length) setNativeValue(selectEl, options[0].value);
      else setNativeValue(selectEl, '');
      return;
    }
    setNativeValue(el, '');
  }

  function clearBarcodeAutofillState() {
    resetFormToBaseline();
  }

  function captureFormBaseline(force = false) {
    if (state.formBaseline && !force) return state.formBaseline;
    const baseline = {};
    for (const fieldKey of Object.keys(CONFIG.selectors.formInputs || {})) {
      const el = getInput(fieldKey);
      if (!el) continue;
      baseline[fieldKey] = { value: String(el.value ?? '') };
    }
    state.formBaseline = baseline;
    return baseline;
  }

  function getResetValueForField(fieldKey, baselineValue = '') {
    const clearAlways = new Set([
      'referenceNumber',
      'totalItemValue',
      'recipient_name',
      'lastName',
      'phone',
      'addressLine1',
      'addressLine2',
      'city',
      'state',
      'zip',
      'locationName',
    ]);
    if (clearAlways.has(fieldKey)) return '';

    if (fieldKey === 'itemDescription') return getRequestDefault('defaultItemDescription') || '';
    if (fieldKey === 'specialDeliveryInstructions') return getRequestDefault('defaultDeliveryInstruction') || '';
    if (fieldKey === 'undeliverableAction') return getRequestDefault('defaultUndeliverableAction') || '';
    if (fieldKey === 'locationType') return getRequestDefault('defaultLocationType') || 'Residence';
    if (fieldKey === 'country') return mapCountry(getRequestDefault('defaultCountry') || 'US');

    return baselineValue;
  }

  function resetFormToBaseline() {
    const baseline = captureFormBaseline();
    for (const fieldKey of Object.keys(CONFIG.selectors.formInputs || {})) {
      const el = getInput(fieldKey);
      if (!el) continue;
      const baselineValue = baseline?.[fieldKey]?.value ?? '';
      const nextValue = getResetValueForField(fieldKey, baselineValue);
      if (el.tagName === 'SELECT') {
        const ok = setSelectByValueOrLabel(el, nextValue);
        if (!ok) setNativeValue(el, nextValue);
      } else {
        setNativeValue(el, nextValue);
      }
    }
    const pickerInput = qs('#mhq-delivery-template-input');
    if (pickerInput instanceof HTMLInputElement) pickerInput.value = '';
    clearHighlights();
    state.deliveryInstructionPreset = '';
  }

  function uniqueNonEmpty(values = []) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  function formatMeridianTime(totalMinutes) {
    const hours24 = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const suffix = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    return `${hours12}:${String(minutes).padStart(2, '0')} ${suffix}`;
  }

  function getFuturePickupTimeOptions() {
    const out = [];
    const start = (7 * 60) + 30;
    const end = (11 * 60) + 30;
    for (let m = start; m <= end; m += 30) out.push(formatMeridianTime(m));
    return out;
  }

  function getConfigSelectOptions(kind) {
    if (kind === 'defaultUndeliverableAction') return ['Return to Store', 'Leave at Location'];
    if (kind === 'defaultLocationType') return ['Residence', 'Office', 'Funeral Home', 'Other'];
    if (kind === 'defaultFuturePickupTime') return getFuturePickupTimeOptions();
    return [];
  }

  function setConfigSelectOptions(selectEl, optionValues, selectedValue) {
    if (!(selectEl instanceof HTMLSelectElement)) return;
    const options = uniqueNonEmpty(optionValues);
    selectEl.innerHTML = '';
    for (const value of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      selectEl.appendChild(opt);
    }
    const preferred = String(selectedValue || '').trim();
    selectEl.value = options.includes(preferred) ? preferred : (options[0] || '');
  }

  function applyNativeButtonVisual(sourceButton, targetButton, fallbackClass = 'mhq-btn') {
    if (!(targetButton instanceof HTMLElement)) return;
    targetButton.className = fallbackClass;
    targetButton.removeAttribute('style');
    targetButton.style.display = '';
    targetButton.setAttribute('type', 'button');
  }

  function syncConfigTypographyWithPageStyles(screen) {
    if (!(screen instanceof HTMLElement)) return;
    const sampleTextNode = qs(CONFIG.selectors.singleRequestTab)?.querySelector('.css-901oao') || qs('div.css-901oao');
    const sampleLabelNode = qsa('div.css-901oao').find(node => /Your Order Number|Recipient|Delivery Date|Item Description|Delivery Instructions/i.test(node.textContent || '')) || sampleTextNode;
    const sampleInputNode = getInput('referenceNumber') || getInput('recipient_name') || qs('input, select, textarea');

    if (sampleTextNode instanceof Element) {
      const textStyle = window.getComputedStyle(sampleTextNode);
      if (textStyle.fontFamily) screen.style.setProperty('--mhq-config-font-family', textStyle.fontFamily);
      if (textStyle.color) screen.style.setProperty('--mhq-config-text-color', textStyle.color);
      if (textStyle.color) screen.style.setProperty('--mhq-config-heading-color', textStyle.color);
    }
    if (sampleLabelNode instanceof Element) {
      const labelStyle = window.getComputedStyle(sampleLabelNode);
      if (labelStyle.fontSize) screen.style.setProperty('--mhq-config-label-font-size', labelStyle.fontSize);
      if (labelStyle.fontWeight) screen.style.setProperty('--mhq-config-label-font-weight', labelStyle.fontWeight);
      if (labelStyle.color) {
        screen.style.setProperty('--mhq-config-label-color', labelStyle.color);
        screen.style.setProperty('--mhq-config-hint-color', labelStyle.color);
      }
      if (labelStyle.fontSize) screen.style.setProperty('--mhq-config-hint-font-size', labelStyle.fontSize);
    }
    if (sampleInputNode instanceof Element) {
      const inputStyle = window.getComputedStyle(sampleInputNode);
      if (inputStyle.fontSize) screen.style.setProperty('--mhq-config-input-font-size', inputStyle.fontSize);
      if (inputStyle.fontWeight) screen.style.setProperty('--mhq-config-input-font-weight', inputStyle.fontWeight);
      if (inputStyle.color) screen.style.setProperty('--mhq-config-input-color', inputStyle.color);
      if (inputStyle.height) screen.style.setProperty('--mhq-config-input-height', inputStyle.height);
      if (inputStyle.padding) screen.style.setProperty('--mhq-config-input-padding', inputStyle.padding);
      if (inputStyle.borderRadius) screen.style.setProperty('--mhq-config-input-radius', inputStyle.borderRadius);
      if (inputStyle.borderTopColor) screen.style.setProperty('--mhq-config-input-border-color', inputStyle.borderTopColor);
      if (inputStyle.backgroundColor) screen.style.setProperty('--mhq-config-input-bg', inputStyle.backgroundColor);
    }
  }

  function syncConfigButtonsWithPageStyles(screen) {
    if (!screen) return;
    const saveButton = qs('[data-action="save"]', screen);
    const resetButton = qs('[data-action="reset"]', screen);
    if (saveButton) applyNativeButtonVisual(null, saveButton, 'mhq-btn mhq-btn--primary');
    if (resetButton) applyNativeButtonVisual(null, resetButton, 'mhq-btn');
  }

  function setConfigStatus(message = '', kind = 'success') {
    const statusEl = qs('#mhq-config-status');
    if (!statusEl) return;
    statusEl.classList.remove('mhq-config-status--success', 'mhq-config-status--info');
    const text = String(message || '').trim();
    if (!text) {
      statusEl.textContent = '';
      statusEl.style.display = 'none';
      return;
    }
    statusEl.style.display = 'block';
    statusEl.classList.add(kind === 'info' ? 'mhq-config-status--info' : 'mhq-config-status--success');
    statusEl.textContent = text;
  }

  function restoreSubmitCancelButtonsForConfig() {
    for (const entry of state.configHiddenButtons) {
      if (entry?.el instanceof HTMLElement) entry.el.style.display = entry.display || '';
    }
    state.configHiddenButtons = [];
  }

  function hideSubmitCancelButtonsForConfig(forceRescan = false) {
    if (forceRescan) restoreSubmitCancelButtonsForConfig();
    if (!forceRescan && state.configHiddenButtons.length) return;
    const candidates = qsa('button, [role="button"]');
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      if (candidate.closest('#mhq-default-config-screen')) continue;
      const testId = String(candidate.getAttribute('data-testid') || '').trim().toLowerCase();
      const text = String(candidate.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const shouldHide = /\bsubmit\b|\bcancel\b/.test(testId) || text === 'submit' || text === 'cancel';
      if (!shouldHide) continue;
      state.configHiddenButtons.push({ el: candidate, display: candidate.style.display || '' });
      candidate.style.display = 'none';
    }
  }

  function findSingleRequestContentRoot() {
    const referenceInput = getInput('referenceNumber');
    if (!referenceInput) return null;
    const formRoot = referenceInput.closest('form');
    if (formRoot) return formRoot;
    let node = referenceInput;
    for (let i = 0; i < 10 && node; i += 1) {
      if (node.querySelector?.('[data-testid="referenceNumber"]') && node.querySelector?.('[data-testid="specialDeliveryInstructions"]')) return node;
      node = node.parentElement;
    }
    return referenceInput.closest('form') || referenceInput.parentElement;
  }

  function ensureDefaultConfigScreen() {
    let screen = qs('#mhq-default-config-screen');
    if (screen) return screen;
    screen = createElement(`<div id="mhq-default-config-screen" class="mhq-config-screen" style="display:none;"><h3>${escapeHtml(CONFIG.labels.configScreenTitle)}</h3><p class="mhq-config-hint">Saved in browser local storage for MercuryHQ and shared across tabs/windows on this browser profile.</p><div class="mhq-config-grid"><div class="mhq-config-row"><label for="mhq-config-defaultDeliveryInstruction">Default Delivery Instruction</label><input id="mhq-config-defaultDeliveryInstruction" type="text" /></div><div class="mhq-config-row"><label for="mhq-config-defaultPhone">Default Phone (used when recipient phone is missing)</label><input id="mhq-config-defaultPhone" type="text" /></div><div class="mhq-config-row"><label for="mhq-config-defaultApiHost">Server IP/Host</label><input id="mhq-config-defaultApiHost" type="text" placeholder="192.168.1.50 or mercury-api.local" /></div><div class="mhq-config-row"><label for="mhq-config-defaultItemDescription">Default Item Description</label><input id="mhq-config-defaultItemDescription" type="text" /></div><div class="mhq-config-row"><label for="mhq-config-defaultUndeliverableAction">Default Undeliverable Action</label><select id="mhq-config-defaultUndeliverableAction"></select></div><div class="mhq-config-row"><label for="mhq-config-defaultFuturePickupTime">Default Future Pickup Time</label><select id="mhq-config-defaultFuturePickupTime"></select></div><div class="mhq-config-row"><label for="mhq-config-defaultLocationType">Default Location Type (non-funeral)</label><select id="mhq-config-defaultLocationType"></select></div></div><div class="mhq-config-actions"><button type="button" class="mhq-btn" data-action="reset">Reset Built-In Defaults</button><button type="button" class="mhq-btn mhq-btn--primary" data-action="save">Save</button></div><div id="mhq-config-status" class="mhq-config-status"></div></div>`);
    screen.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.getAttribute('data-action');
      if (action === 'reset') {
        saveRequestDefaults(DEFAULT_REQUEST_CONFIG);
        renderDefaultConfigScreenValues();
        setConfigStatus('Defaults reset to built-in values.', 'info');
      }
      if (action === 'save') {
        const nextValues = collectDefaultConfigScreenValues();
        saveRequestDefaults(nextValues);
        renderDefaultConfigScreenValues();
        setConfigStatus('Defaults saved successfully.', 'success');
      }
    });
    return screen;
  }

  function renderDefaultConfigScreenValues() {
    const screen = ensureDefaultConfigScreen();
    const defaults = loadRequestDefaults();
    state.requestDefaults = defaults;
    const undeliverableSelect = qs('#mhq-config-defaultUndeliverableAction', screen);
    const futurePickupSelect = qs('#mhq-config-defaultFuturePickupTime', screen);
    const locationTypeSelect = qs('#mhq-config-defaultLocationType', screen);
    setConfigSelectOptions(undeliverableSelect, getConfigSelectOptions('defaultUndeliverableAction'), defaults.defaultUndeliverableAction);
    setConfigSelectOptions(futurePickupSelect, getConfigSelectOptions('defaultFuturePickupTime'), defaults.defaultFuturePickupTime);
    setConfigSelectOptions(locationTypeSelect, getConfigSelectOptions('defaultLocationType'), defaults.defaultLocationType);
    const fields = {
      defaultDeliveryInstruction: qs('#mhq-config-defaultDeliveryInstruction', screen),
      defaultPhone: qs('#mhq-config-defaultPhone', screen),
      defaultApiHost: qs('#mhq-config-defaultApiHost', screen),
      defaultItemDescription: qs('#mhq-config-defaultItemDescription', screen),
      defaultUndeliverableAction: undeliverableSelect,
      defaultFuturePickupTime: futurePickupSelect,
      defaultLocationType: locationTypeSelect,
    };
    for (const [key, input] of Object.entries(fields)) {
      if (input) input.value = defaults[key] || '';
    }
    syncConfigTypographyWithPageStyles(screen);
    syncConfigButtonsWithPageStyles(screen);
  }

  function collectDefaultConfigScreenValues() {
    const screen = ensureDefaultConfigScreen();
    return sanitizeRequestDefaults({
      defaultDeliveryInstruction: qs('#mhq-config-defaultDeliveryInstruction', screen)?.value,
      defaultPhone: qs('#mhq-config-defaultPhone', screen)?.value,
      defaultApiHost: qs('#mhq-config-defaultApiHost', screen)?.value,
      defaultItemDescription: qs('#mhq-config-defaultItemDescription', screen)?.value,
      defaultUndeliverableAction: qs('#mhq-config-defaultUndeliverableAction', screen)?.value,
      defaultFuturePickupTime: qs('#mhq-config-defaultFuturePickupTime', screen)?.value,
      defaultLocationType: qs('#mhq-config-defaultLocationType', screen)?.value,
    });
  }

  function hideDefaultConfigScreen() {
    const screen = qs('#mhq-default-config-screen');
    if (screen) screen.style.display = 'none';
    restoreSubmitCancelButtonsForConfig();
    if (state.configHiddenRoot) {
      state.configHiddenRoot.style.display = state.configHiddenRootDisplay || '';
      state.configHiddenRoot = null;
      state.configHiddenRootDisplay = '';
    }
  }

  function showDefaultConfigScreen() {
    const screen = ensureDefaultConfigScreen();
    const contentRoot = findSingleRequestContentRoot();
    const alreadyVisible = screen.style.display === 'block';
    const sameRootVisible = !!state.configHiddenRoot && state.configHiddenRoot === contentRoot && state.configHiddenRoot.isConnected;
    if (alreadyVisible && sameRootVisible) {
      renderDefaultConfigScreenValues();
      hideSubmitCancelButtonsForConfig();
      return;
    }

    renderDefaultConfigScreenValues();
    hideSubmitCancelButtonsForConfig(true);
    if (contentRoot) {
      if (contentRoot.parentElement && screen.parentElement !== contentRoot.parentElement) contentRoot.insertAdjacentElement('beforebegin', screen);
      if (state.configHiddenRoot && state.configHiddenRoot !== contentRoot) {
        state.configHiddenRoot.style.display = state.configHiddenRootDisplay || '';
      }
      if (state.configHiddenRoot !== contentRoot) {
        state.configHiddenRoot = contentRoot;
        state.configHiddenRootDisplay = contentRoot.style.display || '';
      }
      contentRoot.style.display = 'none';
    } else if (!screen.parentElement) {
      document.body.appendChild(screen);
    }
    screen.style.display = 'block';
    setTimeout(() => {
      if (state.activeMode !== 'config') return;
      if (!screen.isConnected || screen.style.display !== 'block') return;
      renderDefaultConfigScreenValues();
    }, 0);
  }

  function closeActiveScanModal(options = {}) {
    if (typeof state.scanModalClose === 'function') {
      state.scanModalClose(options);
      return true;
    }
    const existing = qs('.mhq-modal-backdrop');
    if (existing) {
      if (options?.flushBridge) void bridgeFlushScanner('modal-close-fallback');
      void bridgeReleaseScanner('mhq-modal-fallback', true);
      existing.remove();
      return true;
    }
    return false;
  }

  function activateConfigTab() {
    state.activeMode = 'config';
    closeActiveScanModal({ resetDecorations: true, flushBridge: true });
    state.requestDefaults = loadRequestDefaults();
    renderDefaultConfigScreenValues();
    const singleTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
    const configTab = qs('#mhq-default-request-config-tab');

    if (singleTab) {
      singleTab.style.borderBottomWidth = '0px';
      singleTab.style.borderBottomColor = 'transparent';
      const text = singleTab.querySelector('.css-901oao');
      if (text) text.style.color = 'rgb(65, 65, 65)';
    }

    if (barcodeTab) {
      barcodeTab.classList.remove('mhq-barcode-tab--active');
      barcodeTab.style.borderBottomColor = 'transparent';
      barcodeTab.style.borderBottomWidth = '2px';
      const text = barcodeTab.querySelector('.mhq-barcode-tab__text');
      if (text) text.style.color = 'rgb(65, 65, 65)';
    }

    if (configTab) {
      configTab.classList.add('mhq-barcode-tab--active');
      configTab.style.borderBottomColor = 'rgb(22, 65, 88)';
      configTab.style.borderBottomWidth = '2px';
      const text = configTab.querySelector('.mhq-barcode-tab__text');
      if (text) text.style.color = 'rgb(22, 65, 88)';
    }

    setTabFontWeights({ single: '400', bulk: '400', barcode: '400', config: '600' });
    removeDeliveryInstructionPicker();
    showDefaultConfigScreen();
  }

  function activateBarcodeTab() {
    hideDefaultConfigScreen();
    state.activeMode = 'barcode';
    const normalTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
    const configTab = qs('#mhq-default-request-config-tab');
    if (normalTab) {
      normalTab.style.borderBottomWidth = '0px';
      normalTab.style.borderBottomColor = 'transparent';
      const text = normalTab.querySelector('.css-901oao');
      if (text) text.style.color = 'rgb(65, 65, 65)';
    }
    if (barcodeTab) {
      barcodeTab.classList.add('mhq-barcode-tab--active');
      barcodeTab.style.borderBottomColor = 'rgb(22, 65, 88)';
      barcodeTab.style.borderBottomWidth = '2px';
    }
    if (configTab) {
      configTab.classList.remove('mhq-barcode-tab--active');
      configTab.style.borderBottomColor = 'transparent';
      configTab.style.borderBottomWidth = '2px';
      const text = configTab.querySelector('.mhq-barcode-tab__text');
      if (text) text.style.color = 'rgb(65, 65, 65)';
    }
    setTabFontWeights({ single: '400', bulk: '400', barcode: '600', config: '400' });
    ensureDeliveryInstructionPicker();
    resetFormToBaseline();
    closeActiveScanModal({ flushBridge: true });
    setTimeout(() => {
      if (state.activeMode !== 'barcode') return;
      showScanModal();
    }, 0);
  }

  function activateNormalTab() {
    hideDefaultConfigScreen();
    state.activeMode = 'normal';
    closeActiveScanModal({ resetDecorations: true, flushBridge: false });
    const normalTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
    const configTab = qs('#mhq-default-request-config-tab');
    if (normalTab) {
      normalTab.style.borderBottomWidth = '2px';
      normalTab.style.borderBottomColor = 'rgb(22, 65, 88)';
      const text = normalTab.querySelector('.css-901oao');
      if (text) text.style.color = 'rgb(22, 65, 88)';
    }
    if (barcodeTab) {
      barcodeTab.classList.remove('mhq-barcode-tab--active');
      barcodeTab.style.borderBottomColor = 'transparent';
      barcodeTab.style.borderBottomWidth = '2px';
      const text = barcodeTab.querySelector('.mhq-barcode-tab__text');
      if (text) text.style.color = 'rgb(65, 65, 65)';
    }
    if (configTab) {
      configTab.classList.remove('mhq-barcode-tab--active');
      configTab.style.borderBottomColor = 'transparent';
      configTab.style.borderBottomWidth = '2px';
      const text = configTab.querySelector('.mhq-barcode-tab__text');
      if (text) text.style.color = 'rgb(65, 65, 65)';
    }
    setTabFontWeights({ single: '600', bulk: '400', barcode: '400', config: '400' });
    removeDeliveryInstructionPicker();
    resetFormToBaseline();
    void bridgeReleaseScanner('switch-to-normal', true);
    bridgeFlushScanner('switch-to-normal');
  }

  function activateBulkTab() {
    hideDefaultConfigScreen();
    state.activeMode = 'bulk';
    closeActiveScanModal({ resetDecorations: true, flushBridge: false });
    const singleTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
    const configTab = qs('#mhq-default-request-config-tab');
    if (singleTab) {
      singleTab.style.borderBottomWidth = '0px';
      singleTab.style.borderBottomColor = 'transparent';
      const singleText = singleTab.querySelector('.css-901oao');
      if (singleText) singleText.style.color = 'rgb(65, 65, 65)';
    }
    if (barcodeTab) {
      barcodeTab.classList.remove('mhq-barcode-tab--active');
      barcodeTab.style.borderBottomColor = 'transparent';
      barcodeTab.style.borderBottomWidth = '2px';
      const barcodeText = barcodeTab.querySelector('.mhq-barcode-tab__text');
      if (barcodeText) barcodeText.style.color = 'rgb(65, 65, 65)';
    }
    if (configTab) {
      configTab.classList.remove('mhq-barcode-tab--active');
      configTab.style.borderBottomColor = 'transparent';
      configTab.style.borderBottomWidth = '2px';
      const configText = configTab.querySelector('.mhq-barcode-tab__text');
      if (configText) configText.style.color = 'rgb(65, 65, 65)';
    }
    setTabFontWeights({ single: '400', bulk: '600', barcode: '400', config: '400' });
    removeDeliveryInstructionPicker();
    resetFormToBaseline();
    void bridgeReleaseScanner('switch-to-bulk', true);
    bridgeFlushScanner('switch-to-bulk');
  }

  function showScanModal() {
    closeActiveScanModal();
    const modalNonce = ++state.scanModalNonce;
    const backdrop = createElement(`<div class="mhq-modal-backdrop" role="dialog" aria-modal="true"><div class="mhq-modal"><div class="mhq-modal__header"><strong>${escapeHtml(CONFIG.labels.modalTitle)}</strong></div><div class="mhq-modal__body"><p style="margin-top:0">Enter the Order ID manually or scan the ticket into the input below.</p><div class="mhq-modal__input-wrap"><input class="mhq-modal__input" type="text" placeholder="${escapeHtml(CONFIG.labels.modalPlaceholder)}" autofocus /><span class="mhq-modal__input-status" aria-hidden="true"></span></div><div id="mhq-modal-error" style="display:none;color:#b00020;margin-top:10px"></div></div><div class="mhq-modal__footer"><button type="button" class="mhq-btn" data-action="cancel">Cancel</button><button type="button" class="mhq-btn mhq-btn--primary" data-action="lookup">Lookup</button></div></div></div>`);
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('.mhq-modal__input');
    const statusEl = backdrop.querySelector('.mhq-modal__input-status');
    const errorEl = backdrop.querySelector('#mhq-modal-error');
    const lookupButton = backdrop.querySelector('[data-action="lookup"]');
    let bridgeTimer = null;
    let bridgeBusy = false;
    let bridgeLastSeq = -1;
    let isSubmitting = false;
    let submitGeneration = 0;
    const modalOpenedAtMs = Date.now();
    let closed = false;
    let autoLookupTimer = null;
    let pendingAutoLookupToken = '';
    let pendingInputSource = 'manual';
    let lastInputSource = 'manual';
    let rapidInputStreak = 0;
    let rapidInputStartedAtMs = 0;
    let lastInputAtMs = 0;
    const bridgeLeaseOwner = sanitizeBridgeOwner(`mhq-modal-${modalNonce}-${Date.now()}`);
    let bridgeLeaseTimer = null;
    let bridgeLeaseHeld = false;
    let bridgeLeaseRenewing = false;
    let bridgeLeaseRetryAfterMs = 0;
    let handleModalVisibility = null;
    let handleWindowFocus = null;
    let handleWindowBlur = null;
    let scanAcceptAfterMs = modalOpenedAtMs;
    let backgroundReleaseTimer = null;
    let modalWasBackgrounded = false;

    function stopBridgePolling() {
      if (bridgeTimer) clearInterval(bridgeTimer);
      bridgeTimer = null;
      bridgeBusy = false;
    }

    function stopBridgeLeaseHeartbeat() {
      if (bridgeLeaseTimer) clearInterval(bridgeLeaseTimer);
      bridgeLeaseTimer = null;
    }

    function stopBackgroundReleaseTimer() {
      if (backgroundReleaseTimer) clearTimeout(backgroundReleaseTimer);
      backgroundReleaseTimer = null;
    }

    function isModalForegroundActive() {
      if (closed || !backdrop.isConnected || state.scanModalClose !== close) return false;
      if (document.visibilityState !== 'visible') return false;
      return !!document.hasFocus();
    }

    function markScanAcceptanceBoundary() {
      scanAcceptAfterMs = Date.now();
    }

    function suspendBridgeLease(reason = 'background') {
      stopBackgroundReleaseTimer();
      markScanAcceptanceBoundary();
      if (!CONFIG.oposBridge?.enabled) return;
      if (!bridgeLeaseHeld && !bridgeLeaseRenewing) return;
      bridgeLeaseHeld = false;
      bridgeLeaseRetryAfterMs = Date.now() + 500;
      void bridgeReleaseScanner(bridgeLeaseOwner).catch(error => {
        log(`Bridge release during ${reason} failed`, error);
      });
    }

    function scheduleBackgroundRelease(reason = 'background') {
      modalWasBackgrounded = true;
      stopBackgroundReleaseTimer();
      backgroundReleaseTimer = setTimeout(() => {
        if (closed || !backdrop.isConnected || state.scanModalClose !== close) return;
        if (isModalForegroundActive()) return;
        suspendBridgeLease(reason);
      }, 500);
    }

    async function renewBridgeLease(reason = 'heartbeat') {
      if (!CONFIG.oposBridge?.enabled) return false;
      if (closed || !backdrop.isConnected) return false;
      if (bridgeLeaseRenewing) return bridgeLeaseHeld;
      bridgeLeaseRenewing = true;
      const leaseMs = Math.max(1000, Number(CONFIG.oposBridge?.leaseMs || 3500));
      try {
        const leaseResult = await bridgeLeaseScanner(bridgeLeaseOwner, leaseMs);
        bridgeLeaseHeld = !!(leaseResult?.claimed || leaseResult?.scannerClaimed);
        if (!bridgeLeaseHeld) {
          bridgeLeaseRetryAfterMs = Date.now() + 250;
          if (reason === 'open') log('Bridge lease not acquired on modal open', leaseResult);
          if (reason !== 'heartbeat') {
            setError('Scanner is currently in use in Mercury. Close Mercury ticket entry, then scan again.');
          }
          return false;
        }
        bridgeLeaseRetryAfterMs = 0;
        try {
          await bridgeRearmScanner();
        } catch (error) {
          log('OPOS bridge rearm failed after lease', error);
        }
        if (/Scanner is currently in use in Mercury/i.test(String(errorEl.textContent || ''))) {
          setError('');
        }
        return true;
      } finally {
        bridgeLeaseRenewing = false;
      }
    }

    const close = ({ resetDecorations = false, flushBridge = false } = {}) => {
      if (closed) return;
      closed = true;
      if (handleModalVisibility) {
        document.removeEventListener('visibilitychange', handleModalVisibility);
        handleModalVisibility = null;
      }
      if (handleWindowFocus) {
        window.removeEventListener('focus', handleWindowFocus);
        handleWindowFocus = null;
      }
      if (handleWindowBlur) {
        window.removeEventListener('blur', handleWindowBlur);
        handleWindowBlur = null;
      }
      stopBackgroundReleaseTimer();
      submitGeneration += 1;
      stopBridgePolling();
      stopBridgeLeaseHeartbeat();
      clearVerificationState();
      if (resetDecorations) {
        clearBarcodeAutofillState();
      }
      if (autoLookupTimer) clearTimeout(autoLookupTimer);
      autoLookupTimer = null;
      pendingAutoLookupToken = '';
      rapidInputStreak = 0;
      rapidInputStartedAtMs = 0;
      lastInputAtMs = 0;
      bridgeLeaseHeld = false;
      if (flushBridge) {
        void bridgeFlushScanner('modal-close').finally(() => bridgeReleaseScanner(bridgeLeaseOwner));
      } else {
        void bridgeReleaseScanner(bridgeLeaseOwner);
      }
      if (state.scanModalClose === close || state.scanModalNonce === modalNonce) {
        state.scanModalClose = null;
      }
      if (backdrop.isConnected) backdrop.remove();
    };
    state.scanModalClose = close;
    const setError = msg => { errorEl.textContent = msg; errorEl.style.display = msg ? 'block' : 'none'; };
    const statusClasses = ['mhq-modal__input-status--checking', 'mhq-modal__input-status--loading', 'mhq-modal__input-status--valid', 'mhq-modal__input-status--invalid'];
    let verifyTimer = null;
    let verifySeq = 0;
    let verifyState = { normalizedTicketId: '', status: 'idle', lifecycle: null };

    function setInputStatus(kind, text = '', title = '') {
      if (!statusEl) return;
      if (submitBusy && kind !== 'loading' && kind !== 'invalid') return;
      statusEl.classList.remove(...statusClasses);
      if (!kind) {
        statusEl.textContent = '';
        statusEl.title = '';
        statusEl.style.display = 'none';
        return;
      }
      statusEl.classList.add(`mhq-modal__input-status--${kind}`);
      statusEl.textContent = text;
      statusEl.title = title;
      statusEl.style.display = 'inline-block';
    }

    function syncStatusFromVerifyState() {
      if (isSubmitting) {
        setInputStatus('loading', '', 'Loading order details');
        updateLookupButtonState();
        return;
      }
      if (verifyState.status === 'verifying') {
        setInputStatus('checking', '...', 'Checking order number');
        updateLookupButtonState();
        return;
      }
      if (verifyState.status === 'valid') {
        setInputStatus('valid', '\u2713', 'Order number verified');
        updateLookupButtonState();
        return;
      }
      if (verifyState.status === 'invalid') {
        setInputStatus('invalid', '\u00d7', 'Order number not found');
        updateLookupButtonState();
        return;
      }
      setInputStatus('');
      updateLookupButtonState();
    }

    function updateLookupButtonState() {
      if (!(lookupButton instanceof HTMLButtonElement)) return;
      if (isSubmitting) {
        lookupButton.disabled = true;
        return;
      }

      const raw = String(input?.value || '').trim();
      if (!raw) {
        lookupButton.disabled = false;
        return;
      }

      const parsed = parseOrderTicketInput(raw);
      if (lastInputSource === 'scan') {
        lookupButton.disabled = !parsed;
        return;
      }

      if (!parsed) {
        lookupButton.disabled = true;
        return;
      }

      const normalized = normalizeSixDigit(raw);
      if (!normalized) {
        lookupButton.disabled = false;
        return;
      }

      const hasCurrentVerify = verifyState.normalizedTicketId === normalized;
      const verifyStatus = hasCurrentVerify ? verifyState.status : 'idle';
      lookupButton.disabled = verifyStatus === 'idle' || verifyStatus === 'verifying';
    }

    function setLoadingState(loading) {
      isSubmitting = !!loading;
      if (input instanceof HTMLInputElement) input.disabled = isSubmitting;
      syncStatusFromVerifyState();
    }

    function normalizeTicketToken(raw) {
      let value = String(raw || '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim();
      value = value.replace(/\s+/g, '');
      // Accept scanner prefixes like OR, OR-, OR:, ORDER, etc.
      value = value.replace(/^(?:ORDER|ORD|OR)(?:[-:#_]+)?(?=\d)/i, '');
      value = value.replace(/[^0-9A-Za-z\/-]/g, '');
      return value;
    }

    function parseOrderTicketInput(raw) {
      const token = normalizeTicketToken(raw);
      if (!token) return null;
      const match = token.match(/^(\d+)(?:[/-](\d+))?$/);
      if (!match) return null;
      const orderId = String(match[1] || '').trim();
      const ticketNumber = String(Number(match[2] || '1'));
      if (!orderId || !/^\d+$/.test(orderId)) return null;
      if (!ticketNumber || !/^\d+$/.test(ticketNumber)) return null;
      if (Number(ticketNumber) < 1) return null;
      return { orderId, ticketNumber, ticketToken: `${orderId}/${ticketNumber}` };
    }

    function normalizeSixDigit(raw) {
      const parsed = parseOrderTicketInput(raw);
      const digits = String(parsed?.orderId || '').replace(/\D/g, '');
      return /^\d{6}$/.test(digits) ? digits : '';
    }

    function recordInputCadence() {
      const now = Date.now();
      if (!lastInputAtMs || (now - lastInputAtMs) > 70) {
        rapidInputStreak = 1;
        rapidInputStartedAtMs = now;
      } else {
        rapidInputStreak += 1;
      }
      lastInputAtMs = now;
    }

    function looksLikeScannerCadence() {
      if (!rapidInputStartedAtMs) return false;
      const burstAge = Date.now() - rapidInputStartedAtMs;
      return rapidInputStreak >= 4 && burstAge <= 550;
    }

    function shouldUseKeyboardWedgeFallback() {
      if (!CONFIG.oposBridge?.enabled) return true;
      return !!CONFIG.oposBridge?.allowKeyboardWedgeFallback;
    }

    function canAutoSubmitScannedValue(rawValue = '', expectedToken = '') {
      const currentToken = normalizeTicketToken(rawValue);
      if (!currentToken) return false;
      if (expectedToken && currentToken !== expectedToken) return false;
      const parsed = parseOrderTicketInput(currentToken);
      if (!parsed) return false;
      // Scanner auto-submit should wait for a realistic full order id to avoid
      // acting on partial fragments (for example "36-1" during key bursts).
      const orderDigits = String(parsed.orderId || '').replace(/\D/g, '');
      return orderDigits.length >= 6;
    }

    function scheduleAutoLookupFromScan(scannedValue = '') {
      if (!CONFIG.oposBridge?.autoLookupOnScan) return;
      pendingAutoLookupToken = normalizeTicketToken(scannedValue || input.value);
      if (autoLookupTimer) clearTimeout(autoLookupTimer);
      autoLookupTimer = setTimeout(() => {
        if (closed || !backdrop.isConnected || isSubmitting || !isModalForegroundActive()) return;
        const currentRaw = String(input.value || '').trim();
        if (!canAutoSubmitScannedValue(currentRaw, pendingAutoLookupToken)) return;
        submit({ source: 'scan' });
      }, 180);
    }

    function clearVerificationState() {
      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = null;
      verifySeq += 1;
      verifyState = { normalizedTicketId: '', status: 'idle', lifecycle: null };
      syncStatusFromVerifyState();
    }

    function scheduleVerification() {
      if (submitBusy) return;
      const normalized = normalizeSixDigit(input.value);
      if (!normalized) {
        clearVerificationState();
        return;
      }

      if (verifyState.status === 'valid' && verifyState.normalizedTicketId === normalized) {
        syncStatusFromVerifyState();
        return;
      }

      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = setTimeout(() => {
        const seq = ++verifySeq;
        verifyState = { normalizedTicketId: normalized, status: 'verifying', lifecycle: null };
        syncStatusFromVerifyState();
        (async () => {
          try {
            const lifecycle = await fetchLifecycleByTicket(normalized);
            if (seq !== verifySeq) return;
            verifyState = { normalizedTicketId: normalized, status: 'valid', lifecycle };
            syncStatusFromVerifyState();
            setError('');
          } catch (error) {
            if (seq !== verifySeq) return;
            verifyState = { normalizedTicketId: normalized, status: 'invalid', lifecycle: null };
            syncStatusFromVerifyState();
          }
        })();
      }, 220);
    }

    async function submit(options = {}) {
      if (isSubmitting) return;
      const submitSource = options?.source === 'scan' ? 'scan' : 'manual';
      const runGeneration = ++submitGeneration;
      const raw = String(input.value || '').trim();
      const parsedInput = parseOrderTicketInput(raw);
      if (!parsedInput) { setError('Invalid ticket format. Use <orderId> or <orderId>/<ticket>.'); return; }
      const scannedTicketId = parsedInput.ticketToken;
      const scannedOrderId = parsedInput.orderId;
      const normalizedSixDigit = normalizeSixDigit(scannedTicketId);

      errorEl.style.display = 'none';
      setLoadingState(true);

      try {
        let lifecycle = null;

        if (submitSource !== 'scan' && normalizedSixDigit) {
          const hasVerifiedLifecycle = verifyState.normalizedTicketId === normalizedSixDigit && verifyState.status === 'valid' && !!verifyState.lifecycle;
          if (hasVerifiedLifecycle) {
            lifecycle = verifyState.lifecycle;
          } else {
            if (verifyTimer) {
              clearTimeout(verifyTimer);
              verifyTimer = null;
            }
            const seq = ++verifySeq;
            verifyState = { normalizedTicketId: normalizedSixDigit, status: 'verifying', lifecycle: null };
            syncStatusFromVerifyState();
            try {
              lifecycle = await fetchLifecycleByTicket(normalizedSixDigit);
              if (runGeneration !== submitGeneration || !backdrop.isConnected) return;
              if (seq !== verifySeq) return;
              verifyState = { normalizedTicketId: normalizedSixDigit, status: 'valid', lifecycle };
              syncStatusFromVerifyState();
            } catch (error) {
              if (seq !== verifySeq) return;
              verifyState = { normalizedTicketId: normalizedSixDigit, status: 'invalid', lifecycle: null };
              syncStatusFromVerifyState();
              // Do not hard-stop here. Some environments fail OLC endpoint but
              // still return valid data through GetTickets/GetRecipient.
              setError('Could not verify this 6-digit order number via OLC. Continuing with direct ticket lookup...');
            }
          }
        }

        if (!lifecycle) {
          try {
            lifecycle = await fetchLifecycleByTicket(scannedTicketId);
            if (runGeneration !== submitGeneration || !backdrop.isConnected) return;
          } catch (lifecycleError) {
            log('Lifecycle lookup failed, continuing with direct ticket lookup', lifecycleError);
          }
        }
        const ticket = await fetchTicket(scannedOrderId, scannedTicketId);
        if (runGeneration !== submitGeneration || !backdrop.isConnected) return;
        validateTicketLookup(scannedTicketId, ticket);
        const recipient = ticket.recipientId ? await fetchRecipient(ticket.recipientId) : null;
        if (runGeneration !== submitGeneration || !backdrop.isConnected) return;

        state.lastTicketId = scannedTicketId;
        state.lastLifecycle = lifecycle;
        state.lastTicket = ticket;
        state.lastRecipient = recipient;

        log('Lookup chain', {
          scannedTicketId,
          scannedOrderId,
          lifecycleTicketId: lifecycle?.ticketId,
          ticketResponse: ticket,
          recipientResponse: recipient,
        });

        resetFormToBaseline();
        const orderData = deriveOrderData(scannedTicketId, lifecycle, ticket, recipient);
        if (runGeneration !== submitGeneration || !backdrop.isConnected) return;
        applyOrderData(orderData);
        close({ flushBridge: true });
      } catch (error) {
        if (runGeneration !== submitGeneration || !backdrop.isConnected) return;
        log(error);
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
      } finally {
        if (runGeneration === submitGeneration && backdrop.isConnected) setLoadingState(false);
      }
    }

    async function pollBridgeScan() {
      if (!CONFIG.oposBridge?.enabled || bridgeBusy || isSubmitting) return;
      if (!isModalForegroundActive()) {
        return;
      }
      if (!bridgeLeaseHeld) {
        if (!bridgeLeaseRenewing && Date.now() >= bridgeLeaseRetryAfterMs) {
          bridgeLeaseRetryAfterMs = Date.now() + 250;
          void renewBridgeLease('poll');
        }
        return;
      }
      if (closed || !backdrop.isConnected) return;
      bridgeBusy = true;
      try {
        const latest = await fetchBridgeNextScan(bridgeLeaseOwner);
        if (!latest || !Number.isFinite(latest.seq) || latest.seq <= bridgeLastSeq) return;
        bridgeLastSeq = latest.seq;
        if (!latest.value) return;
        const scanAtMs = Date.parse(String(latest.at || ''));
        // Ignore scans captured before this modal was active in the foreground.
        if (!Number.isFinite(scanAtMs) || scanAtMs < scanAcceptAfterMs) {
          return;
        }
        const normalizedScanValue = normalizeTicketToken(latest.value);
        if (!normalizedScanValue) return;
        pendingInputSource = 'scan';
        input.value = normalizedScanValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (error) {
        // Bridge is optional. Keep modal usable with manual entry.
        log('OPOS bridge poll failed', error);
      } finally {
        bridgeInputWrite = false;
        bridgeBusy = false;
      }
    }

    backdrop.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target === backdrop || target.getAttribute('data-action') === 'cancel') close({ resetDecorations: true, flushBridge: true });
      if (target.getAttribute('data-action') === 'lookup') submit({ source: 'manual' });
    });

    input.addEventListener('input', event => {
      let source = pendingInputSource === 'scan' ? 'scan' : 'manual';
      pendingInputSource = 'manual';
      setError('');
      recordInputCadence();
      const normalizedValue = normalizeTicketToken(input.value);
      if (normalizedValue !== String(input.value || '')) {
        input.value = normalizedValue;
      }
      const parsed = parseOrderTicketInput(normalizedValue);
      if (source !== 'scan' && parsed) {
        const inputEvent = event instanceof InputEvent ? event : null;
        const fromPaste = inputEvent?.inputType === 'insertFromPaste';
        if (!fromPaste && shouldUseKeyboardWedgeFallback() && looksLikeScannerCadence()) {
          source = 'scan';
        }
      }
      lastInputSource = source;
      if (source === 'scan') {
        clearVerificationState();
        updateLookupButtonState();
        scheduleAutoLookupFromScan(normalizedValue);
        return;
      }
      scheduleVerification();
      updateLookupButtonState();
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submit({ source: 'manual' }); }
      if (event.key === 'Escape') close({ resetDecorations: true, flushBridge: true });
    });

    handleModalVisibility = () => {
      if (closed || !backdrop.isConnected || state.scanModalClose !== close) return;
      if (document.visibilityState !== 'visible') {
        scheduleBackgroundRelease('visibility-hidden');
        return;
      }
      stopBackgroundReleaseTimer();
      if (modalWasBackgrounded) {
        markScanAcceptanceBoundary();
        modalWasBackgrounded = false;
      }
      if (document.visibilityState === 'visible') {
        void renewBridgeLease('focus');
      }
    };
    handleWindowFocus = () => {
      if (closed || !backdrop.isConnected || state.scanModalClose !== close) return;
      stopBackgroundReleaseTimer();
      if (modalWasBackgrounded) {
        markScanAcceptanceBoundary();
        modalWasBackgrounded = false;
      }
      void renewBridgeLease('focus');
    };
    handleWindowBlur = () => {
      if (closed || !backdrop.isConnected || state.scanModalClose !== close) return;
      modalWasBackgrounded = true;
      scheduleBackgroundRelease('window-blur');
    };
    document.addEventListener('visibilitychange', handleModalVisibility);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);

    setTimeout(() => {
      if (closed) return;
      if (input instanceof HTMLInputElement) input.focus();
    }, 0);
    if (input instanceof HTMLInputElement) input.value = '';
    updateLookupButtonState();
    if (CONFIG.oposBridge?.enabled) {
      (async () => {
        let leaseAcquired = false;
        try {
          if (isModalForegroundActive()) {
            leaseAcquired = await renewBridgeLease('open');
            if (bridgeLeaseHeld) {
              await bridgeRearmScanner();
            }
          }
        } catch (error) {
          log('OPOS bridge startup failed', error);
        } finally {
          if (closed || !backdrop.isConnected || state.scanModalClose !== close) return;
          if (isModalForegroundActive() && !leaseAcquired) {
            setError('Scanner bridge did not connect. If scans beep but do not populate, reload the userscript and retry.');
          }
          const keepAliveEvery = Math.max(500, Number(CONFIG.oposBridge?.leaseKeepAliveMs || 1200));
          bridgeLeaseTimer = setInterval(() => {
            if (closed || !backdrop.isConnected || state.scanModalClose !== close) return;
            if (!isModalForegroundActive()) {
              return;
            }
            void renewBridgeLease('heartbeat').then(acquired => {
              if (acquired && /Scanner bridge did not connect/i.test(String(errorEl.textContent || ''))) {
                setError('');
              }
            });
          }, keepAliveEvery);
          bridgeTimer = setInterval(pollBridgeScan, Math.max(100, Number(CONFIG.oposBridge?.pollIntervalMs || 250)));
          pollBridgeScan();
        }
      })();
    }

  }

  function injectBarcodeTab() {
    const existingBarcodeTab = qs('#mhq-single-request-barcode-tab');
    const existingConfigTab = qs('#mhq-default-request-config-tab');
    if (existingBarcodeTab && existingConfigTab) return true;
    existingBarcodeTab?.remove();
    existingConfigTab?.remove();
    const singleRequestTab = qs(CONFIG.selectors.singleRequestTab);
    if (!singleRequestTab) return false;
    const tabRow = singleRequestTab.parentElement;
    if (!tabRow) return false;
    const bulkRequestTab = qs(CONFIG.selectors.bulkRequestTab);
    const barcodeTab = createElement(`<div id="mhq-single-request-barcode-tab" aria-label="Single Request Barcode-tab" data-focusable="true" tabindex="0" class="css-1dbjc4n r-1loqt21 r-1otgn73 r-1i6wzkk r-lrvibr mhq-barcode-tab" data-testid="Single Request Barcode-tab" style="border-bottom-color: transparent; border-bottom-width: 2px; margin: 5px 0px 5px 50px; padding-top: 8px; padding-bottom: 8px; transition-duration: 0s;"><div dir="auto" class="css-901oao mhq-barcode-tab__text" style="color: rgb(65, 65, 65); font-family: Arial; font-size: 16px;">${escapeHtml(CONFIG.labels.newTab)}</div></div>`);
    const configTab = createElement(`<div id="mhq-default-request-config-tab" aria-label="Default Request Configuration-tab" data-focusable="true" tabindex="0" class="css-1dbjc4n r-1loqt21 r-1otgn73 r-1i6wzkk r-lrvibr mhq-barcode-tab" data-testid="Default Request Configuration-tab" style="border-bottom-color: transparent; border-bottom-width: 2px; margin: 5px 0px 5px 50px; padding-top: 8px; padding-bottom: 8px; transition-duration: 0s;"><div dir="auto" class="css-901oao mhq-barcode-tab__text" style="color: rgb(65, 65, 65); font-family: Arial; font-size: 16px;">${escapeHtml(CONFIG.labels.defaultsTab)}</div></div>`);
    barcodeTab.addEventListener('click', activateBarcodeTab);
    barcodeTab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateBarcodeTab(); } });
    configTab.addEventListener('click', activateConfigTab);
    configTab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateConfigTab(); } });
    singleRequestTab.addEventListener('click', () => setTimeout(activateNormalTab, 0));
    bulkRequestTab?.addEventListener('click', () => setTimeout(activateBulkTab, 0));
    if (bulkRequestTab && bulkRequestTab.parentElement === tabRow) {
      tabRow.insertBefore(barcodeTab, bulkRequestTab.nextSibling);
      tabRow.insertBefore(configTab, barcodeTab.nextSibling);
    } else {
      tabRow.appendChild(barcodeTab);
      tabRow.appendChild(configTab);
    }
    decorateTabsWithIcons();
    removeBannerIfPresent();
    setTabFontWeights({ single: '600', bulk: '400', barcode: '400', config: '400' });
    removeDeliveryInstructionPicker();
    captureFormBaseline();
    bindSubmitSuccessHooks();
    return true;
  }

  function isDeliverySingleRequestPage() {
    return !!qs(CONFIG.selectors.singleRequestTab) && !!getInput('referenceNumber');
  }

  async function mount() {
    if (state.mounted) return;
    removeBannerIfPresent();
    for (let i = 0; i < 60; i++) {
      if (isDeliverySingleRequestPage()) {
        const injected = injectBarcodeTab();
        if (injected) {
          bindSubmitSuccessHooks();
          renderDefaultConfigScreenValues();
          state.mounted = true;
          return;
        }
      }
      await wait(500);
    }
  }

  const observer = new MutationObserver(() => {
    if (isDeliverySingleRequestPage() && (!qs('#mhq-single-request-barcode-tab') || !qs('#mhq-default-request-config-tab'))) injectBarcodeTab();
    if (isDeliverySingleRequestPage()) {
      decorateTabsWithIcons();
      removeBannerIfPresent();
      bindSubmitSuccessHooks();
      if (state.activeMode === 'barcode') ensureDeliveryInstructionPicker();
      else removeDeliveryInstructionPicker();
      if (state.activeMode === 'config') {
        const screen = qs('#mhq-default-config-screen');
        const contentRoot = findSingleRequestContentRoot();
        const isStableVisible = !!screen
          && screen.style.display === 'block'
          && !!state.configHiddenRoot
          && state.configHiddenRoot === contentRoot
          && state.configHiddenRoot.isConnected;
        if (!isStableVisible) showDefaultConfigScreen();
        else hideSubmitCancelButtonsForConfig();
      }
      else hideDefaultConfigScreen();
    }
    if (!isDeliverySingleRequestPage()) hideDefaultConfigScreen();
  });

  log('Userscript loaded', window.location.href);
  state.requestDefaults = loadRequestDefaults();
  mount();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
