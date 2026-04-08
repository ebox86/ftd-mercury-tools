import type { TickerModuleItem } from '../types';

export function buildNewOrdersTickerItem(input: {
  windowMinutes: number;
  count: number;
}): TickerModuleItem {
  const minutes = Math.max(1, Math.round(input.windowMinutes));
  return {
    id: 'new_orders',
    text: `New orders last ${minutes} min: ${Math.max(0, input.count)}`,
  };
}
