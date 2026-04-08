import type { TickerModuleItem } from '../types';

export function buildIntakeTickerItem(input: {
  pendingCount: number;
  newOrderCount: number;
  staleAskCount: number;
  marketplaceCount: number;
}): TickerModuleItem {
  if (input.pendingCount <= 0) {
    return {
      id: 'intake',
      text: 'Intake clear: no pending tickets waiting for action',
    };
  }

  return {
    id: 'intake',
    text: `Intake ${input.pendingCount} pending, ${input.newOrderCount} new orders, ${input.staleAskCount} stale asks, ${input.marketplaceCount} delivery-service`,
  };
}
