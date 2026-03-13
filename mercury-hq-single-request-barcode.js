// ==UserScript==
// @name         MercuryHQ - Single Request Barcode
// @namespace    https://ebox86.com/
// @version      0.3.20
// @description  Adds a barcode-assisted delivery request tab to MercuryHQ and prepopulates the Single Request form from Mercury services.
// @author       Evan
// @match        https://mercuryhq.com/create-delivery-service-request*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    apiBaseUrl: 'http://localhost/WsMercuryWebAPI',
    olcByTicketPath: '/OrderLifeCycle.asmx/OLCGetByTicket',
    defaultDeliveryInstruction: 'LEAVE AT DOOR IF NOT AVAILABLE',
    defaultPhone: '4122810350',
    debug: true,
    labels: {
      newTab: 'Single Request Barcode',
      modalTitle: 'Scan barcode ticket',
      modalPlaceholder: 'Scan or type ticket number',
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

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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
    .mhq-btn { appearance: none; border: 1px solid #cfcfcf; background: #f7f7f7; color: #111; border-radius: 6px; padding: 8px 12px; cursor: pointer; font-family: Arial; }
    .mhq-btn--primary { border-color: rgb(22, 65, 88); background: rgb(22, 65, 88); color: white; }
    .mhq-delivery-combo { margin-top: 6px; width: 100%; max-width: 520px; position: relative; isolation: isolate !important; z-index: 2147483190; }
    .mhq-delivery-template-input { width: 100%; box-sizing: border-box; height: 32px; border: 1px solid #cfcfcf; border-radius: 6px; padding: 4px 30px 4px 8px; font-family: Arial; font-size: 12px; color: #222; background: #fff; }
    .mhq-delivery-template-trigger { position: absolute; top: 1px; right: 1px; width: 28px; height: 30px; border: 0; border-left: 1px solid #e0e0e0; border-radius: 0 6px 6px 0; background: #f8f8f8; color: #555; cursor: pointer; font-size: 11px; line-height: 30px; padding: 0; }
    .mhq-delivery-template-menu { position: fixed; top: 0; left: 0; width: 320px; max-height: 160px; overflow: auto; border: 1px solid #cfcfcf; border-radius: 6px; background: #fff !important; background-image: none !important; box-shadow: 0 6px 18px rgba(0,0,0,.12); z-index: 2147483200; display: none; opacity: 1 !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; mix-blend-mode: normal !important; }
    .mhq-delivery-template-menu::before { content: ''; position: absolute; inset: 0; background: #fff !important; z-index: 0; }
    .mhq-delivery-template-menu--open { display: block; }
    .mhq-delivery-template-item { display: block; width: 100%; text-align: left; border: 0; background: #fff !important; background-image: none !important; color: #222; font-family: Arial; font-size: 12px; padding: 8px; cursor: pointer; opacity: 1 !important; position: relative; z-index: 1; mix-blend-mode: normal !important; }
    .mhq-delivery-template-item:hover, .mhq-delivery-template-item:focus { background: #f3f7fa !important; }
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

  function decorateTabsWithIcons() {
    ensureTabIcon(qs(CONFIG.selectors.singleRequestTab), 'single');
    ensureTabIcon(qs(CONFIG.selectors.bulkRequestTab), 'bulk');
    ensureTabIcon(qs('#mhq-single-request-barcode-tab'), 'barcode');
  }

  function setTabFontWeights({ single = '400', bulk = '400', barcode = '400' } = {}) {
    const singleText = qs(CONFIG.selectors.singleRequestTab)?.querySelector('.css-901oao');
    const bulkText = qs(CONFIG.selectors.bulkRequestTab)?.querySelector('.css-901oao');
    const barcodeText = qs('#mhq-single-request-barcode-tab')?.querySelector('.mhq-barcode-tab__text');
    if (singleText) singleText.style.fontWeight = single;
    if (bulkText) bulkText.style.fontWeight = bulk;
    if (barcodeText) barcodeText.style.fontWeight = barcode;
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
    const staticDefault = String(CONFIG.defaultDeliveryInstruction || '');

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
        const expectedReference = String(getInput('referenceNumber')?.value || '').trim();
        if (expectedReference) startSubmitSuccessWatch(expectedReference);
      });
    }

    const form = submitButton?.closest('form');
    if (form && form.dataset.mhqSubmitWatchBound !== '1') {
      form.dataset.mhqSubmitWatchBound = '1';
      form.addEventListener('submit', () => {
        const expectedReference = String(getInput('referenceNumber')?.value || '').trim();
        if (expectedReference) startSubmitSuccessWatch(expectedReference);
      });
    }
  }

  function getText(node, selector) { return node.querySelector(selector)?.textContent?.trim() || ''; }

  function parseLifecycleXml(xmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    const err = xml.querySelector('parsererror');
    if (err) throw new Error('Unable to parse Mercury XML response');
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
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    const err = xml.querySelector('parsererror');
    if (err) throw new Error('Unable to parse ticket XML response');
    const ticket = xml.getElementsByTagNameNS('*', 'Ticket')[0];
    if (!ticket) throw new Error('No Ticket record found');
    return {
      id: getText(ticket, 'ID'),
      saleId: getText(ticket, 'SALE_ID'),
      recipientId: getText(ticket, 'RECIPIENT_ID'),
      amount: getText(ticket, 'AMT'),
      amountPaid: getText(ticket, 'AMT_PAID'),
      deliveryDate: getText(ticket, 'DELIV_DATE'),
      specialInstructions: getText(ticket, 'SPECIAL_INSTR'),
      deliveryDateInstructions: getText(ticket, 'DELIVERY_DATE_INSTR'),
    };
  }

  function parseRecipientXml(xmlText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    const err = xml.querySelector('parsererror');
    if (err) throw new Error('Unable to parse recipient XML response');
    const recipient = xml.getElementsByTagNameNS('*', 'Recipient')[0];
    if (!recipient) throw new Error('No Recipient record found');
    return {
      id: getText(recipient, 'ID'),
      name: getText(recipient, 'NAME'),
      address: getText(recipient, 'ADDRESS'),
      city: getText(recipient, 'CITY'),
      state: getText(recipient, 'STATE_PROV'),
      country: getText(recipient, 'COUNTRY'),
      postalCode: getText(recipient, 'POSTAL_CODE'),
      phone: getText(recipient, 'PHONE'),
      firmName: getText(recipient, 'FIRM_NAME').trim(),
    };
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
    const url = `${CONFIG.apiBaseUrl}${CONFIG.olcByTicketPath}`;
    const attempts = [
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
    ];

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
    const url = `${CONFIG.apiBaseUrl}/OrderEntry.asmx/GetTickets`;
    const attempts = [
      {
        label: 'POST saleID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST SaleID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `SaleID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST saleId',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `saleId=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST ticketID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST TicketID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `TicketID=${encodeURIComponent(ticketId)}`,
      },
      {
        label: 'POST ticketId',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `ticketId=${encodeURIComponent(ticketId)}`,
      },
    ];

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
    const url = `${CONFIG.apiBaseUrl}/OrderEntry.asmx/GetRecipient`;
    const attempts = [
      {
        label: 'POST recipientID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `recipientID=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'POST RecipientID',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `RecipientID=${encodeURIComponent(recipientId)}`,
      },
      {
        label: 'POST recipientId',
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `recipientId=${encodeURIComponent(recipientId)}`,
      },
    ];

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
      const fallbackDigits = String(CONFIG.defaultPhone || '').replace(/\D/g, '');
      if (fallbackDigits.length === 10) return `${fallbackDigits.slice(0, 3)}-${fallbackDigits.slice(3, 6)}-${fallbackDigits.slice(6)}`;
      return String(CONFIG.defaultPhone || '');
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return raw;
  }

  function mapCountry(country) {
    const c = String(country || '').trim().toUpperCase();
    if (c === 'US' || c === 'USA' || c === 'UNITED STATES') return 'United States';
    return country || 'United States';
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
    return 'Residence';
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
      itemDescription: 'FLORAL',
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
      specialDeliveryInstructions: specialInstructions || CONFIG.defaultDeliveryInstruction,
      undeliverableAction: 'Leave at Location',
      deliveryDate: formatDateMMDDYYYY(ticket?.deliveryDate),
      pickUpDateTime: isToday ? '' : '8:00 AM',
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
      fillField('pickUpDateTime', orderData.pickUpDateTime, 'Future delivery: defaulted to 8:00 AM', { source: orderData.pickUpDateTime ? 'service' : 'manual', maxLength: 20 });
    }
  }

  function activateBarcodeTab() {
    state.activeMode = 'barcode';
    const normalTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
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
    setTabFontWeights({ single: '400', bulk: '400', barcode: '600' });
    ensureDeliveryInstructionPicker();
    showScanModal();
  }

  function activateNormalTab() {
    state.activeMode = 'normal';
    const normalTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
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
    setTabFontWeights({ single: '600', bulk: '400', barcode: '400' });
    removeDeliveryInstructionPicker();
  }

  function activateBulkTab() {
    state.activeMode = 'bulk';
    const singleTab = qs(CONFIG.selectors.singleRequestTab);
    const barcodeTab = qs('#mhq-single-request-barcode-tab');
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
    setTabFontWeights({ single: '400', bulk: '600', barcode: '400' });
    removeDeliveryInstructionPicker();
  }

  function showScanModal() {
    const backdrop = createElement(`<div class="mhq-modal-backdrop" role="dialog" aria-modal="true"><div class="mhq-modal"><div class="mhq-modal__header"><strong>${escapeHtml(CONFIG.labels.modalTitle)}</strong></div><div class="mhq-modal__body"><p style="margin-top:0">Scan the ticket into the input below. Most barcode scanners will type the value and send Enter.</p><div class="mhq-modal__input-wrap"><input class="mhq-modal__input" type="text" placeholder="${escapeHtml(CONFIG.labels.modalPlaceholder)}" autofocus /><span class="mhq-modal__input-status" aria-hidden="true"></span></div><div id="mhq-modal-error" style="display:none;color:#b00020;margin-top:10px"></div></div><div class="mhq-modal__footer"><button type="button" class="mhq-btn" data-action="cancel">Cancel</button><button type="button" class="mhq-btn mhq-btn--primary" data-action="lookup">Lookup</button></div></div></div>`);
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('.mhq-modal__input');
    const statusEl = backdrop.querySelector('.mhq-modal__input-status');
    const errorEl = backdrop.querySelector('#mhq-modal-error');
    const close = () => { clearVerificationState(); backdrop.remove(); };
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
              setError('Could not verify this 6-digit order number. Check the number and try again.');
              return;
            }
          }
        }

        if (!lifecycle) lifecycle = await fetchLifecycleByTicket(scannedTicketId);
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
      if (target === backdrop || target.getAttribute('data-action') === 'cancel') close();
      if (target.getAttribute('data-action') === 'lookup') submit();
    });

    input.addEventListener('input', () => {
      setError('');
      scheduleVerification();
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape') close();
    });

    setTimeout(() => input.focus(), 0);
  }

  function injectBarcodeTab() {
    if (qs('#mhq-single-request-barcode-tab')) return true;
    const singleRequestTab = qs(CONFIG.selectors.singleRequestTab);
    if (!singleRequestTab) return false;
    const tabRow = singleRequestTab.parentElement;
    if (!tabRow) return false;
    const bulkRequestTab = qs(CONFIG.selectors.bulkRequestTab);
    const barcodeTab = createElement(`<div id="mhq-single-request-barcode-tab" aria-label="Single Request Barcode-tab" data-focusable="true" tabindex="0" class="css-1dbjc4n r-1loqt21 r-1otgn73 r-1i6wzkk r-lrvibr mhq-barcode-tab" data-testid="Single Request Barcode-tab" style="border-bottom-color: transparent; border-bottom-width: 2px; margin: 5px 0px 5px 50px; padding-top: 8px; padding-bottom: 8px; transition-duration: 0s;"><div dir="auto" class="css-901oao mhq-barcode-tab__text" style="color: rgb(65, 65, 65); font-family: Arial; font-size: 16px;">${escapeHtml(CONFIG.labels.newTab)}</div></div>`);
    barcodeTab.addEventListener('click', activateBarcodeTab);
    barcodeTab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateBarcodeTab(); } });
    singleRequestTab.addEventListener('click', () => setTimeout(activateNormalTab, 0));
    bulkRequestTab?.addEventListener('click', () => setTimeout(activateBulkTab, 0));
    if (bulkRequestTab && bulkRequestTab.parentElement === tabRow) tabRow.insertBefore(barcodeTab, bulkRequestTab.nextSibling); else tabRow.appendChild(barcodeTab);
    decorateTabsWithIcons();
    removeBannerIfPresent();
    setTabFontWeights({ single: '600', bulk: '400', barcode: '400' });
    removeDeliveryInstructionPicker();
    bindSubmitSuccessHooks();
    return true;
  }

  function isDeliverySingleRequestPage() {
    return !!qs(CONFIG.selectors.singleRequestTab) && !!getInput('referenceNumber') && document.body.innerText.includes('Delivery Service Request');
  }

  async function mount() {
    if (state.mounted) return;
    removeBannerIfPresent();
    for (let i = 0; i < 60; i++) {
      if (isDeliverySingleRequestPage()) {
        const injected = injectBarcodeTab();
        if (injected) {
          bindSubmitSuccessHooks();
          state.mounted = true;
          return;
        }
      }
      await wait(500);
    }
  }

  const observer = new MutationObserver(() => {
    if (isDeliverySingleRequestPage() && !qs('#mhq-single-request-barcode-tab')) injectBarcodeTab();
    if (isDeliverySingleRequestPage()) {
      decorateTabsWithIcons();
      removeBannerIfPresent();
      bindSubmitSuccessHooks();
      if (state.activeMode === 'barcode') ensureDeliveryInstructionPicker();
      else removeDeliveryInstructionPicker();
    }
  });

  log('Userscript loaded', window.location.href);
  mount();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
