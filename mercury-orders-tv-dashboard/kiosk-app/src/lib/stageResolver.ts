import type { LifecycleRow, OrderItem, StatusStage, TicketStatusRow } from './types';

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeObjectKey(raw: string): string {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function firstTextByNormalizedKey(source: Record<string, unknown>, normalizedKeys: string[]): string {
  const wanted = new Set(normalizedKeys.map(normalizeObjectKey).filter(Boolean));
  if (!wanted.size) return '';

  for (const [key, value] of Object.entries(source)) {
    if (!wanted.has(normalizeObjectKey(key))) continue;
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function isTruthyFlag(raw: string): boolean {
  const text = String(raw || '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'y';
}

function isPickupOrCodOrderType(orderTypeRaw = ''): boolean {
  const orderType = String(orderTypeRaw || '').toLowerCase();
  return (
    orderType.includes('pickup')
    || orderType.includes('pick up')
    || orderType.includes('cod')
  );
}

function isQueuedDesignStatus(designStatusRaw = ''): boolean {
  const designStatus = String(designStatusRaw || '').toLowerCase();
  return (
    designStatus.includes('not assigned')
    || designStatus.includes('not designed')
    || designStatus.includes('queued')
    || designStatus.includes('awaiting')
    || designStatus.includes('pending')
  );
}

function isDesignedDesignStatus(designStatusRaw = ''): boolean {
  const designStatus = String(designStatusRaw || '').toLowerCase();
  if (!designStatus) return false;
  if (isQueuedDesignStatus(designStatus)) return false;
  return designStatus.includes('designed') || designStatus.includes('complete');
}

function isDeliveredStatus(statusCode = '', statusDesc = ''): boolean {
  const code = statusCode.toUpperCase();
  const desc = statusDesc.toLowerCase();
  return code.includes('DELIVER') || desc.includes('deliver');
}

function ticketDeliveryOutcome(deliveryStatusRaw = '', designerStatus = ''): 'delivered' | 'exception' | '' {
  const statusText = String(deliveryStatusRaw || '').trim().toLowerCase();
  const designerText = String(designerStatus || '').trim().toLowerCase();
  const normalizedStatus = statusText.replace(/\s+/g, ' ');

  if (
    normalizedStatus.includes('delivered')
    || normalizedStatus.includes('completed')
    || normalizedStatus.includes('picked up')
    || normalizedStatus.includes('left with neighbor')
    || normalizedStatus.includes('left at front door')
    || designerText.includes('delivered')
    || designerText.includes('picked up')
  ) {
    return 'delivered';
  }

  if (
    normalizedStatus.includes('not at home')
    || normalizedStatus.includes('not at work')
    || normalizedStatus.includes('discharged from hospital')
    || normalizedStatus.includes('bad address')
    || normalizedStatus.includes('undeliver')
    || normalizedStatus.includes('return')
    || normalizedStatus.includes('fail')
    || normalizedStatus.includes('exception')
  ) {
    return 'exception';
  }

  const numeric = Number(statusText);
  if (Number.isFinite(numeric)) {
    if (numeric >= 1 && numeric <= 3) return 'delivered';
    if (numeric >= 4) return 'exception';
  }
  return '';
}

function isExceptionStatus(statusCode = '', statusDesc = ''): boolean {
  const code = statusCode.toUpperCase();
  const desc = statusDesc.toLowerCase();
  return (
    code.includes('EXCEPT')
    || code.includes('FAIL')
    || code.includes('UNDELIV')
    || code.includes('RETURN')
    || desc.includes('exception')
    || desc.includes('failed')
    || desc.includes('undeliver')
    || desc.includes('unable to deliver')
    || desc.includes('return')
  );
}

function isOnTruckStatus(statusCode = '', statusDesc = ''): boolean {
  const code = statusCode.toUpperCase();
  const desc = statusDesc.toLowerCase();
  return code.includes('ONTRUCK') || desc.includes('on truck') || desc.includes('route');
}

function isSavedOrStagedStatus(statusCode = '', statusDesc = ''): boolean {
  const code = statusCode.toUpperCase();
  const desc = statusDesc.toLowerCase();
  return code.includes('SAVE') || code.includes('STAGE') || desc.includes('saved') || desc.includes('staged');
}

function isIncomingStatus(statusCode = '', statusDesc = ''): boolean {
  const code = statusCode.toUpperCase();
  const desc = statusDesc.toLowerCase();
  return code.includes('NEW') || code.includes('PRINT') || desc.includes('incoming') || desc.includes('printed');
}

function isCanceledStatus(statusCode = '', statusDesc = ''): boolean {
  const code = statusCode.toUpperCase();
  const desc = statusDesc.toLowerCase();
  return code.includes('CANCEL') || code.includes('VOID') || desc.includes('cancel') || desc.includes('void');
}

export function deriveStage(
  order: OrderItem,
  ticketStatus: TicketStatusRow | null,
  latestLifecycle: LifecycleRow | null,
  undeliveredIds: Set<string>,
): { stage: StatusStage; reason: string } {
  const ticketStatusRecord = (ticketStatus || {}) as unknown as Record<string, unknown>;
  const orderRecord = (order as unknown as Record<string, unknown>);
  const statusCode = String(latestLifecycle?.STATUS_CD || '');
  const statusDesc = String(latestLifecycle?.STATUS_CD_DESC || latestLifecycle?.STATUS_TEXT || '');
  const listedAsUndelivered = undeliveredIds.has(order.ID);
  const designerStatusRaw = firstText(ticketStatusRecord, [
    'DesignerStatus',
    'DESIGNER_STATUS',
    'DesignStatus',
    'designStatus',
    'DESIGN_STATUS',
    'DESIGNERSTATUS',
    'DESIGNSTATUS',
    'Design Status',
    'DESIGN STATUS',
    'Designer Status',
    'DESIGNER STATUS',
  ]) || firstTextByNormalizedKey(ticketStatusRecord, ['designerstatus', 'designstatus']) || firstText(orderRecord, [
    'DesignerStatus',
    'DESIGNER_STATUS',
    'DesignStatus',
    'designStatus',
    'DESIGN_STATUS',
    'DESIGNERSTATUS',
    'DESIGNSTATUS',
    'Design Status',
    'DESIGN STATUS',
    'Designer Status',
    'DESIGNER STATUS',
  ]) || firstTextByNormalizedKey(orderRecord, ['designerstatus', 'designstatus']);
  const designerStatus = designerStatusRaw.toLowerCase();
  const deliveryStatus = firstText(ticketStatusRecord, [
    'DeliveryStatus',
    'DELIVERY_STATUS',
    'Delivery_Status',
    'deliveryStatus',
    'DELIVERYSTATUS',
    'Delivery Status',
    'DELIVERY STATUS',
  ]) || firstTextByNormalizedKey(ticketStatusRecord, ['deliverystatus']);
  const designedIndicator = firstText(orderRecord, [
    'DESIGNED_IND',
    'DESIGNED',
    'DESIGNEDIND',
    'DesignedInd',
    'designedInd',
    'DESIGNED_INDICATOR',
  ]) || firstTextByNormalizedKey(orderRecord, ['designedind', 'designedindicator', 'designed']);
  const isDesignedByIndicator = isTruthyFlag(designedIndicator);
  const isPickupOrCod = isPickupOrCodOrderType(order.ORDER_TYPE);
  const deliveryOutcome = ticketDeliveryOutcome(deliveryStatus, designerStatus);

  if (isDeliveredStatus(statusCode, statusDesc) || deliveryOutcome === 'delivered') {
    const deliveredReason = statusCode || statusDesc
      ? `Lifecycle ${statusCode || statusDesc}`
      : `TicketStatus ${deliveryStatus || designerStatusRaw || 'Delivered'}`;
    return { stage: 'delivered_or_exception', reason: deliveredReason };
  }

  if (isExceptionStatus(statusCode, statusDesc) || deliveryOutcome === 'exception') {
    const exceptionReason = statusCode || statusDesc
      ? `Exception ${statusCode || statusDesc}`
      : `Exception TicketStatus ${deliveryStatus || designerStatusRaw || 'Exception'}`;
    return { stage: 'delivered_or_exception', reason: exceptionReason };
  }

  if (isCanceledStatus(statusCode, statusDesc)) {
    return { stage: 'incoming', reason: `Canceled ${statusCode || statusDesc}` };
  }

  if (isPickupOrCod) {
    if (!listedAsUndelivered) {
      return { stage: 'delivered_or_exception', reason: `${order.ORDER_TYPE || 'Pickup/COD'} delivered (not in active feed)` };
    }
    if (isDesignedByIndicator || isDesignedDesignStatus(designerStatus)) {
      return { stage: 'designed', reason: `${order.ORDER_TYPE || 'Pickup/COD'} designed` };
    }
    if (designedIndicator === '0' || isQueuedDesignStatus(designerStatus)) {
      return { stage: 'queued_not_designed', reason: `${order.ORDER_TYPE || 'Pickup/COD'} awaiting design` };
    }
    return { stage: 'queued_not_designed', reason: `${order.ORDER_TYPE || 'Pickup/COD'} awaiting design` };
  }

  const route = String(ticketStatus?.DeliveryRoute || '').trim();
  if (route || isOnTruckStatus(statusCode, statusDesc)) {
    return { stage: 'on_truck', reason: route ? `Route ${route}` : `Lifecycle ${statusCode || statusDesc}` };
  }

  if (isSavedOrStagedStatus(statusCode, statusDesc)) {
    return { stage: 'saved_or_staged', reason: `Lifecycle ${statusCode || statusDesc}` };
  }

  if (isQueuedDesignStatus(designerStatus)) {
    return { stage: 'queued_not_designed', reason: `DesignerStatus ${designerStatusRaw}` };
  }
  if (isDesignedByIndicator || isDesignedDesignStatus(designerStatus)) {
    return { stage: 'designed', reason: `DesignerStatus ${designerStatusRaw || 'Designed'}` };
  }

  if (isIncomingStatus(statusCode, statusDesc)) {
    return { stage: 'incoming', reason: `Lifecycle ${statusCode || statusDesc}` };
  }

  const category = String(order.CATEGORY || '').trim();
  if (category === '2' || category === '15') {
    return { stage: 'incoming', reason: `Category ${category}` };
  }
  if (category === '12') {
    return { stage: 'queued_not_designed', reason: `Category ${category}` };
  }
  if (category === '6') {
    return { stage: 'on_truck', reason: `Category ${category}` };
  }

  if (listedAsUndelivered) {
    return { stage: 'incoming', reason: 'Undelivered feed (active)' };
  }

  return { stage: 'incoming', reason: 'Default mapping' };
}
