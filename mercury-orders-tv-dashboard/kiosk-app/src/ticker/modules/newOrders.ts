import type { TickerModuleItem } from '../types';

export function buildNewOrdersTickerItem(input: {
  windowMinutes: number;
  count: number;
  previousCount: number;
}): TickerModuleItem {
  const minutes = Math.max(1, Math.round(input.windowMinutes));
  const currentCount = Math.max(0, Math.round(input.count));
  const previousCount = Math.max(0, Math.round(input.previousCount));
  const trendEmoji = currentCount > previousCount
    ? '📈'
    : (currentCount < previousCount ? '📉' : '➖');
  return {
    id: 'new_orders',
    text: `New orders last ${minutes} min: ${currentCount} ${trendEmoji}`,
  };
}
