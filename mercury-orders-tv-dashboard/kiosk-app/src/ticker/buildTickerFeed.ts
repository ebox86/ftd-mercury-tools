import { buildCompletionTickerItem } from './modules/completion';
import { buildExceptionWatchTickerItem } from './modules/exceptionWatch';
import { buildIntakeTickerItem } from './modules/intake';
import { buildNewOrdersTickerItem } from './modules/newOrders';
import { buildStoreHoursTickerItem } from './modules/storeHours';
import { buildWeatherTickerItem } from './modules/weather';
import type { TickerModuleId, TickerModuleItem, WeatherTickerSnapshot } from './types';

const MODULE_SEPARATOR = ' 🌸 ';

export function buildTickerItems(input: {
  enabledModuleIds: TickerModuleId[];
  weatherZip: string;
  weatherSnapshot: WeatherTickerSnapshot | null;
  completion: {
    dayLabel: string;
    completed: number;
    total: number;
    percent: number;
  };
  intake: {
    pendingCount: number;
    newOrderCount: number;
    staleAskCount: number;
    marketplaceCount: number;
  };
  exceptionWatch: {
    dayLabel: string;
    exceptionCount: number;
  };
  newOrders: {
    windowMinutes: number;
    count: number;
    previousCount: number;
  };
}): TickerModuleItem[] {
  const items: TickerModuleItem[] = [];

  for (const moduleId of input.enabledModuleIds) {
    if (moduleId === 'weather') {
      const item = buildWeatherTickerItem(input.weatherSnapshot, input.weatherZip);
      if (item) items.push(item);
      continue;
    }
    if (moduleId === 'completion') {
      items.push(buildCompletionTickerItem(input.completion));
      continue;
    }
    if (moduleId === 'intake') {
      items.push(buildIntakeTickerItem(input.intake));
      continue;
    }
    if (moduleId === 'exception_watch') {
      items.push(buildExceptionWatchTickerItem(input.exceptionWatch));
      continue;
    }
    if (moduleId === 'new_orders') {
      items.push(buildNewOrdersTickerItem(input.newOrders));
      continue;
    }
    if (moduleId === 'store_hours') {
      items.push(buildStoreHoursTickerItem());
    }
  }

  return items;
}

export function buildTickerScrollText(items: TickerModuleItem[]): string {
  if (!items.length) return 'Order flow monitor online 🌸';
  return `${items.map(item => item.text).join(MODULE_SEPARATOR)}${MODULE_SEPARATOR}`;
}