// ==UserScript==
// @name         MercuryHQ - Single Request Barcode
// @namespace    https://ebox86.com/
// @version      0.3.52
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
    lastTicketId: null,
    lastLifecycle: null,
    lastTicket: null,
    lastRecipient: null,
    submitWatchStop: null,
    lastSubmitHandledAt: 0,
    deliveryInstructionPreset: '',
    deliveryMenuCleanup: null,
    requestDefaults: { ...DEFAULT_REQUEST_CONFIG },
    configHiddenRoot: null,
    configHiddenRootDisplay: '',
    configHiddenButtons: [],
    cancelResetHooksBound: false,
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
    .mhq-modal__input-status { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); min-width: 20px; height: 20px; border-radius: 999px; font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; user-select: none; pointer-events: none; display: none; }
    .mhq-modal__input-status--checking { display: inline-block; color: #4f5b66; background: #e8edf2; }
    .mhq-modal__input-status--valid { display: inline-block; color: #fff; background: #2e8b57; }
    .mhq-modal__input-status--invalid { display: inline-block; color: #fff; background: #c62828; }
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

  function setNativeValue(el, value) {
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setSelectByValueOrLabel(el, desired) {
    if (!el || desired == null || desired === '') return false;
    const normalized = String(desired).trim().toLowerCase();
    const match = Array.from(el.options || []).find(opt => opt.value.trim().toLowerCase() === normalized || opt.text.trim().toLowerCase() === normalized || (opt.label || '').trim().toLowerCase() === normalized);
    if (!match) return false;
    setNativeValue(el, match.value);
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

  function getSubmitButton() {
    return qs('[data-testid="Submit"]') || qsa('button').find(btn => /submit/i.test((btn.textContent || '').trim()));
  }

  function isMainCancelControl(target) {
    if (!(target instanceof Element)) return false;
    const candidate = target.closest('button, [role="button"], [data-testid]');
    if (!(candidate instanceof HTMLElement)) return false;
    if (candidate.closest('.mhq-modal-backdrop') || candidate.closest('#mhq-default-config-screen')) return false;
    const text = String(candidate.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const testId = String(candidate.getAttribute('data-testid') || '').trim().toLowerCase();
    const ariaLabel = String(candidate.getAttribute('aria-label') || '').trim().toLowerCase();
    return text === 'cancel' || /\bcancel\b/.test(testId) || /\bcancel\b/.test(ariaLabel);
  }

  function hasSuccessfulSubmitSignal() {
    const candidates = qsa('[role="alert"], [aria-live], [class*="toast"], [class*="alert"], [class*="snack"], [class*="notification"], [class*="message"]');
    return candidates.some(node => {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      return !!text && /(success|submitted|created|completed)/i.test(text) && /(request|delivery|order)/i.test(text);
    });
  }

  function handleSuccessfulSubmit() {
    const now = Date.now();
    if (now - state.lastSubmitHandledAt < 1200) return;
    state.lastSubmitHandledAt = now;
    clearHighlights();
    state.lastTicketId = null;
    state.lastLifecycle = null;
    state.lastTicket = null;
    state.lastRecipient = null;
    state.deliveryInstructionPreset = '';
    if (state.activeMode === 'barcode' && !qs('.mhq-modal-backdrop')) {
      setTimeout(() => {
        if (state.activeMode === 'barcode' && !qs('.mhq-modal-backdrop')) showScanModal();
      }, 250);
    }
  }

  function startSubmitSuccessWatch(expectedReference = '') {
    if (state.submitWatchStop) state.submitWatchStop();
    const startedAt = Date.now();
    const maxMs = 30000;
    const expected = String(expectedReference || '').trim();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > maxMs) {
        clearInterval(timer);
        state.submitWatchStop = null;
        return;
      }

      const refInput = getInput('referenceNumber');
      const currentReference = String(refInput?.value || '').trim();
      const formReset = !!expected && currentReference === '';
      if (hasSuccessfulSubmitSignal() || formReset) {
        clearInterval(timer);
        state.submitWatchStop = null;
        handleSuccessfulSubmit();
      }
    }, 350);

    state.submitWatchStop = () => {
      clearInterval(timer);
      state.submitWatchStop = null;
    };
  }

  function bindSubmitSuccessHooks() {
    const submitButton = getSubmitButton();
    if (submitButton && submitButton.dataset.mhqSubmitWatchBound !== '1') {
      submitButton.dataset.mhqSubmitWatchBound = '1';
      submitButton.addEventListener('click', () => {
        enforceCountryDefault();
        const expectedReference = String(getInput('referenceNumber')?.value || '').trim();
        if (expectedReference) startSubmitSuccessWatch(expectedReference);
      });
    }

    if (!state.cancelResetHooksBound) {
      state.cancelResetHooksBound = true;
      const maybeResetFromCancel = event => {
        if (!isMainCancelControl(event.target)) return;
        clearBarcodeAutofillState();
      };
      // Capture early so Mercury button rerenders/navigation do not skip cleanup.
      document.addEventListener('pointerdown', maybeResetFromCancel, true);
      document.addEventListener('click', event => {
        if (!isMainCancelControl(event.target)) return;
        clearBarcodeAutofillState();
      }, true);
      document.addEventListener('reset', () => {
        clearBarcodeAutofillState();
      }, true);
    }

    const form = submitButton?.closest('form');
    if (form && form.dataset.mhqSubmitWatchBound !== '1') {
      form.dataset.mhqSubmitWatchBound = '1';
      form.addEventListener('submit', () => {
        enforceCountryDefault();
        const expectedReference = String(getInput('referenceNumber')?.value || '').trim();
        if (expectedReference) startSubmitSuccessWatch(expectedReference);
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

  function parseTicketsXml(xmlText) {
    const xml = parseXmlDocument(xmlText, 'Unable to parse ticket XML response');

    const parseTicketFromDoc = doc => {
      const ticket = findDataRowNode(
        doc,
        ['Ticket', 'TICKET', 'Table', 'ROW'],
        ['SALE_ID', 'saleID', 'SaleID', 'SALEID', 'RECIPIENT_ID', 'recipientID', 'RecipientID', 'ID'],
      );
      if (!ticket) return null;
      return {
        id: getXmlChildText(ticket, ['ID']),
        saleId: getXmlChildText(ticket, ['SALE_ID', 'saleID', 'SaleID', 'SALEID']),
        recipientId: getXmlChildText(ticket, ['RECIPIENT_ID', 'recipientID', 'RecipientID', 'RECIPIENTID']),
        amount: getXmlChildText(ticket, ['AMT', 'amount']),
        amountPaid: getXmlChildText(ticket, ['AMT_PAID']),
        deliveryDate: getXmlChildText(ticket, ['DELIV_DATE', 'DELIVERY_DATE']),
        specialInstructions: getXmlChildText(ticket, ['SPECIAL_INSTR', 'SPECIAL_INSTRUCTIONS']),
        deliveryDateInstructions: getXmlChildText(ticket, ['DELIVERY_DATE_INSTR']),
      };
    };

    const parseTicketFromLeafFields = doc => {
      const fields = collectXmlLeafFieldValues(doc);
      const parsed = {
        id: getLeafValue(fields, ['ID']),
        saleId: getLeafValue(fields, ['SALE_ID', 'saleID', 'SaleID', 'SALEID']),
        recipientId: getLeafValue(fields, ['RECIPIENT_ID', 'recipientID', 'RecipientID', 'RECIPIENTID']),
        amount: getLeafValue(fields, ['AMT', 'amount']),
        amountPaid: getLeafValue(fields, ['AMT_PAID']),
        deliveryDate: getLeafValue(fields, ['DELIV_DATE', 'DELIVERY_DATE']),
        specialInstructions: getLeafValue(fields, ['SPECIAL_INSTR', 'SPECIAL_INSTRUCTIONS']),
        deliveryDateInstructions: getLeafValue(fields, ['DELIVERY_DATE_INSTR']),
      };
      const hasTicketSignal = !!(parsed.saleId || parsed.recipientId || parsed.deliveryDate || parsed.amount);
      return hasTicketSignal ? parsed : null;
    };

    let parsed = parseTicketFromDoc(xml);
    if (!parsed) parsed = parseTicketFromLeafFields(xml);
    if (!parsed) {
      const embeddedXml = parseEmbeddedResultXml(xml, ['GetTicketsResult', 'string']);
      if (embeddedXml) parsed = parseTicketFromDoc(embeddedXml) || parseTicketFromLeafFields(embeddedXml);
    }

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
        address: getXmlChildText(recipient, ['ADDRESS']),
        city: getXmlChildText(recipient, ['CITY']),
        state: getXmlChildText(recipient, ['STATE_PROV', 'STATE']),
        country: getXmlChildText(recipient, ['COUNTRY']),
        postalCode: getXmlChildText(recipient, ['POSTAL_CODE', 'ZIP']),
        phone: getXmlChildText(recipient, ['PHONE']),
        firmName: getXmlChildText(recipient, ['FIRM_NAME']).trim(),
      };
    };

    const parseRecipientFromLeafFields = doc => {
      const fields = collectXmlLeafFieldValues(doc);
      const parsed = {
        id: getLeafValue(fields, ['ID', 'RECIPIENT_ID', 'RECIPIENTID']),
        name: getLeafValue(fields, ['NAME']),
        address: getLeafValue(fields, ['ADDRESS']),
        city: getLeafValue(fields, ['CITY']),
        state: getLeafValue(fields, ['STATE_PROV', 'STATE']),
        country: getLeafValue(fields, ['COUNTRY']),
        postalCode: getLeafValue(fields, ['POSTAL_CODE', 'ZIP']),
        phone: getLeafValue(fields, ['PHONE']),
        firmName: getLeafValue(fields, ['FIRM_NAME']).trim(),
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
      log('Mercury request', { method, url, data });
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        onload: response => {
          log('Mercury response', { method, url, status: response.status, preview: String(response.responseText || '').slice(0, 400) });
          if (response.status >= 200 && response.status < 300) resolve(response.responseText);
          else {
            const preview = String(response.responseText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            reject(new Error(`Mercury service returned HTTP ${response.status} for ${method} ${url}${preview ? ` | Response: ${preview}` : ''}`));
          }
        },
        onerror: () => reject(new Error(`Network error calling Mercury service: ${method} ${url}`)),
        ontimeout: () => reject(new Error(`Mercury service timed out: ${method} ${url}`)),
      });
    });
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

  async function fetchTicket(ticketId) {
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
          data: buildSoapEnvelope('GetTickets', { [key]: ticketId }, soapNamespace),
        });
      }
    }
    attempts.push(
      {
        label: 'POST saleID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST SaleID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `SaleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST saleId',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleId=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST ticketID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST TicketID',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `TicketID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST ticketId',
        method: 'POST',
        url: methodUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketId=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST saleID to service root',
        method: 'POST',
        url: serviceUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'GET saleID',
        method: 'GET',
        url: `${methodUrl}?saleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'GET SaleID',
        method: 'GET',
        url: `${methodUrl}?SaleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'GET ticketID',
        method: 'GET',
        url: `${methodUrl}?ticketID=${encodeURIComponent(ticketId)}`,
      },
    );

    const errors = [];
    for (const attempt of attempts) {
      try {
        log('Trying ticket lookup', attempt.label, attempt);
        const xmlText = await mercuryRequest(attempt);
        return parseTicketsXml(xmlText);
      } catch (error) {
        errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`GetTickets failed for ticket ${ticketId}. Attempts: ${errors.join(' | ')}`);
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
    if (!raw) {
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

  function extractUnit(addressLine1, specialInstructions) {
    const combined = `${addressLine1 || ''} || ${specialInstructions || ''}`;
    const patterns = [/\b(?:APT|APARTMENT)\s*#?\s*([A-Z0-9-]+)/i, /\b(?:UNIT)\s*#?\s*([A-Z0-9-]+)/i, /\b(?:SUITE|STE)\s*#?\s*([A-Z0-9-]+)/i, /\b(?:ROOM|RM|ROIOM)\s*#?\s*([A-Z0-9-]+)/i, /\b#\s*([A-Z0-9-]+)/i];
    for (const pattern of patterns) {
      const match = combined.match(pattern);
      if (match?.[0]) return match[0].replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function stripUnitFromAddress(addressLine1, extractedUnit) {
    let address = String(addressLine1 || '').trim();
    if (!address || !extractedUnit) return address;
    const escaped = extractedUnit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return address.replace(new RegExp(`\\s*,?\\s*${escaped}`, 'i'), '').replace(/\s{2,}/g, ' ').trim();
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
    const unit = extractUnit(recipient?.address || '', specialInstructions);
    const street = stripUnitFromAddress(recipient?.address || '', unit);
    const isToday = isSameLocalDay(ticket?.deliveryDate);

    return {
      referenceNumber: ticket?.saleId || lifecycle?.ticketId || scannedTicketId,
      totalItemValue: formatMoney(ticket?.amount),
      itemDescription: getRequestDefault('defaultItemDescription'),
      recipient_name: nameParts.firstName,
      lastName: nameParts.lastName,
      phone: normalizePhone(recipient?.phone || ''),
      addressLine1: street,
      addressLine2: unit,
      city: recipient?.city || '',
      state: recipient?.state || '',
      zip: recipient?.postalCode || '',
      country: mapCountry(recipient?.country || 'US'),
      locationType: inferLocationType(recipient?.name || '', recipient?.firmName || ''),
      locationName: recipient?.firmName || '',
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
    const { source = 'manual', maxLength = null } = options;
    const el = getInput(name);
    if (!el) { log('Missing field selector for', name); return null; }
    const hasValue = value != null && String(value) !== '';
    let finalValue = hasValue ? String(value) : '';
    let truncated = false;
    if (hasValue && maxLength && finalValue.length > maxLength) { finalValue = finalValue.slice(0, maxLength); truncated = true; }

    if (el.tagName === 'SELECT') {
      if (hasValue) {
        const ok = setSelectByValueOrLabel(el, finalValue);
        if (ok) { if (source === 'service') markFilled(el, `Mapped from service${truncated ? ' (truncated/review suggested)' : ''}`); }
        else markReview(el, reviewReason || `Could not select ${finalValue}`);
      } else if (reviewReason) markReview(el, reviewReason);
    } else {
      if (hasValue) {
        setNativeValue(el, finalValue);
        if (source === 'service') markFilled(el, `Mapped from service${truncated ? ' (truncated)' : ''}`);
      }
      if (!hasValue && reviewReason) markReview(el, reviewReason);
      if (truncated) markReview(el, 'Value was too long and was truncated');
    }
    return el;
  }

  function applyOrderData(orderData) {
    clearHighlights();
    fillField('referenceNumber', orderData.referenceNumber, 'Mapped from sale id', { source: 'service', maxLength: 50 });
    fillField('totalItemValue', orderData.totalItemValue, 'Mapped from AMT on ticket', { source: orderData.totalItemValue ? 'service' : 'manual', maxLength: 20 });
    fillField('itemDescription', orderData.itemDescription, 'Fixed business rule', { source: 'service', maxLength: 500 });
    fillField('recipient_name', orderData.recipient_name, 'Mapped from recipient name split', { source: orderData.recipient_name ? 'service' : 'manual', maxLength: 100 });
    fillField('lastName', orderData.lastName, 'Mapped from recipient name split', { source: orderData.lastName ? 'service' : 'manual', maxLength: 100 });
    fillField('phone', orderData.phone, 'Mapped from recipient phone', { source: orderData.phone ? 'service' : 'manual', maxLength: 18 });
    fillField('addressLine1', orderData.addressLine1, 'Mapped from recipient address', { source: orderData.addressLine1 ? 'service' : 'manual', maxLength: 120 });
    fillField('addressLine2', orderData.addressLine2, 'Extracted from address or instructions; verify', { source: orderData.addressLine2 ? 'service' : 'manual', maxLength: 120 });
    fillField('city', orderData.city, 'Mapped from recipient city', { source: orderData.city ? 'service' : 'manual', maxLength: 100 });
    fillField('state', orderData.state, 'Mapped from recipient state', { source: orderData.state ? 'service' : 'manual' });
    fillField('zip', orderData.zip, 'Mapped from recipient postal code', { source: orderData.zip ? 'service' : 'manual', maxLength: 5 });
    fillField('country', orderData.country, 'Mapped from recipient country', { source: orderData.country ? 'service' : 'manual' });
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
      const pickup = getInput('pickUpDateTime');
      if (pickup) markReview(pickup, 'Today delivery: choose the next available pickup time manually');
    } else {
      fillField('pickUpDateTime', orderData.pickUpDateTime, 'Future delivery: defaulted by configuration', { source: orderData.pickUpDateTime ? 'service' : 'manual', maxLength: 20 });
    }
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
    for (const key of AUTO_FILLED_FIELD_KEYS) clearFieldValue(key);
    const pickerInput = qs('#mhq-delivery-template-input');
    if (pickerInput instanceof HTMLInputElement) pickerInput.value = '';
    clearHighlights();
    state.lastTicketId = null;
    state.lastLifecycle = null;
    state.lastTicket = null;
    state.lastRecipient = null;
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

  function activateConfigTab() {
    state.activeMode = 'config';
    qsa('.mhq-modal-backdrop').forEach(el => el.remove());
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
    showScanModal();
  }

  function activateNormalTab() {
    hideDefaultConfigScreen();
    state.activeMode = 'normal';
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
  }

  function activateBulkTab() {
    hideDefaultConfigScreen();
    state.activeMode = 'bulk';
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
  }

  function showScanModal() {
    const backdrop = createElement(`<div class="mhq-modal-backdrop" role="dialog" aria-modal="true"><div class="mhq-modal"><div class="mhq-modal__header"><strong>${escapeHtml(CONFIG.labels.modalTitle)}</strong></div><div class="mhq-modal__body"><p style="margin-top:0">Enter the Order ID manually or scan the ticket into the input below. Most barcode scanners will type the value and send Enter.</p><div class="mhq-modal__input-wrap"><input class="mhq-modal__input" type="text" placeholder="${escapeHtml(CONFIG.labels.modalPlaceholder)}" autofocus /><span class="mhq-modal__input-status" aria-hidden="true"></span></div><div id="mhq-modal-error" style="display:none;color:#b00020;margin-top:10px"></div></div><div class="mhq-modal__footer"><button type="button" class="mhq-btn" data-action="cancel">Cancel</button><button type="button" class="mhq-btn mhq-btn--primary" data-action="lookup">Lookup</button></div></div></div>`);
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('.mhq-modal__input');
    const statusEl = backdrop.querySelector('.mhq-modal__input-status');
    const errorEl = backdrop.querySelector('#mhq-modal-error');
    const close = ({ resetDecorations = false } = {}) => {
      clearVerificationState();
      if (resetDecorations) {
        clearBarcodeAutofillState();
      }
      backdrop.remove();
    };
    const setError = msg => { errorEl.textContent = msg; errorEl.style.display = msg ? 'block' : 'none'; };
    const statusClasses = ['mhq-modal__input-status--checking', 'mhq-modal__input-status--valid', 'mhq-modal__input-status--invalid'];
    let verifyTimer = null;
    let verifySeq = 0;
    let verifyState = { normalizedTicketId: '', status: 'idle', lifecycle: null };

    function setInputStatus(kind, text = '', title = '') {
      if (!statusEl) return;
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

    function normalizeSixDigit(raw) {
      const digits = String(raw || '').replace(/\D/g, '');
      return /^\d{6}$/.test(digits) ? digits : '';
    }

    function clearVerificationState() {
      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = null;
      verifySeq += 1;
      verifyState = { normalizedTicketId: '', status: 'idle', lifecycle: null };
      setInputStatus('');
    }

    function scheduleVerification() {
      const normalized = normalizeSixDigit(input.value);
      if (!normalized) {
        clearVerificationState();
        return;
      }

      if (verifyState.status === 'valid' && verifyState.normalizedTicketId === normalized) {
        setInputStatus('valid', '\u2713', 'Order number verified');
        return;
      }

      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = setTimeout(() => {
        const seq = ++verifySeq;
        verifyState = { normalizedTicketId: normalized, status: 'verifying', lifecycle: null };
        setInputStatus('checking', '...', 'Checking order number');
        (async () => {
          try {
            const lifecycle = await fetchLifecycleByTicket(normalized);
            if (seq !== verifySeq) return;
            verifyState = { normalizedTicketId: normalized, status: 'valid', lifecycle };
            setInputStatus('valid', '\u2713', 'Order number verified');
            setError('');
          } catch (error) {
            if (seq !== verifySeq) return;
            verifyState = { normalizedTicketId: normalized, status: 'invalid', lifecycle: null };
            setInputStatus('invalid', '\u00d7', 'Order number not found');
          }
        })();
      }, 220);
    }

    async function submit() {
      const raw = String(input.value || '').trim();
      if (!raw) { setError('Scan a ticket first.'); return; }
      const scannedTicketId = raw.replace(/[^0-9A-Za-z\-]/g, '');
      const normalizedSixDigit = normalizeSixDigit(raw);

      errorEl.style.display = 'none';

      try {
        let lifecycle = null;

        if (normalizedSixDigit) {
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
            setInputStatus('checking', '...', 'Checking order number');
            try {
              lifecycle = await fetchLifecycleByTicket(normalizedSixDigit);
              if (seq !== verifySeq) return;
              verifyState = { normalizedTicketId: normalizedSixDigit, status: 'valid', lifecycle };
              setInputStatus('valid', '\u2713', 'Order number verified');
            } catch (error) {
              if (seq !== verifySeq) return;
              verifyState = { normalizedTicketId: normalizedSixDigit, status: 'invalid', lifecycle: null };
              setInputStatus('invalid', '\u00d7', 'Order number not found');
              // Do not hard-stop here. Some environments fail OLC endpoint but still return
              // valid data through GetTickets/GetRecipient.
              setError('Could not verify this 6-digit order number via OLC. Trying fallback lookup...');
            }
          }
        }

        if (!lifecycle) {
          try {
            lifecycle = await fetchLifecycleByTicket(scannedTicketId);
          } catch (lifecycleError) {
            log('Lifecycle lookup failed, continuing with ticket fallback', lifecycleError);
          }
        }
        const resolvedTicketId = lifecycle?.ticketId || scannedTicketId;
        let ticket = null;
        try {
          ticket = await fetchTicket(scannedTicketId);
        } catch (primaryError) {
          if (resolvedTicketId && resolvedTicketId !== scannedTicketId) {
            ticket = await fetchTicket(resolvedTicketId);
          } else {
            throw primaryError;
          }
        }
        const recipient = ticket.recipientId ? await fetchRecipient(ticket.recipientId) : null;

        state.lastTicketId = resolvedTicketId;
        state.lastLifecycle = lifecycle;
        state.lastTicket = ticket;
        state.lastRecipient = recipient;

        log('Lookup chain', {
          scannedTicketId,
          resolvedTicketId,
          lifecycleTicketId: lifecycle?.ticketId,
          ticketResponse: ticket,
          recipientResponse: recipient,
        });

        const orderData = deriveOrderData(scannedTicketId, lifecycle, ticket, recipient);
        applyOrderData(orderData);
        close();
      } catch (error) {
        log(error);
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
      }
    }

    backdrop.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target === backdrop || target.getAttribute('data-action') === 'cancel') close({ resetDecorations: true });
      if (target.getAttribute('data-action') === 'lookup') submit();
    });

    input.addEventListener('input', () => {
      setError('');
      scheduleVerification();
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape') close({ resetDecorations: true });
    });

    setTimeout(() => input.focus(), 0);
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
