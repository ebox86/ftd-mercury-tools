import type { TickerModuleId } from './types';

export interface TickerModuleDefinition {
  id: TickerModuleId;
  label: string;
  description: string;
}

export const TICKER_MODULE_DEFINITIONS: TickerModuleDefinition[] = [
  {
    id: 'weather',
    label: 'Weather',
    description: 'Current weather by ZIP code with a condition icon.',
  },
  {
    id: 'completion',
    label: 'Daily completion',
    description: 'Completion percentage for the selected delivery day.',
  },
  {
    id: 'intake',
    label: 'Intake attention',
    description: 'Pending intake summary for new, stale, and marketplace work.',
  },
  {
    id: 'exception_watch',
    label: 'Exception watch',
    description: 'Delivery exceptions for the currently selected day.',
  },
  {
    id: 'new_orders',
    label: 'New orders pulse',
    description: 'New uncreated orders in a rolling recent time window.',
  },
  {
    id: 'store_hours',
    label: 'Store hours status',
    description: 'Open/closed status based on Eastern Time business hours.',
  },
];

export const DEFAULT_TICKER_MODULES: TickerModuleId[] = TICKER_MODULE_DEFINITIONS.map(definition => definition.id);

export function isTickerModuleId(value: unknown): value is TickerModuleId {
  return value === 'weather'
    || value === 'completion'
    || value === 'intake'
    || value === 'exception_watch'
    || value === 'new_orders'
    || value === 'store_hours';
}

export function normalizeTickerModuleIds(raw: unknown): TickerModuleId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TICKER_MODULES];
  const uniqueIds = new Set(raw.filter(isTickerModuleId));
  return TICKER_MODULE_DEFINITIONS
    .map(definition => definition.id)
    .filter(id => uniqueIds.has(id));
}
