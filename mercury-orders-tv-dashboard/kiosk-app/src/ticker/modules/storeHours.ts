import type { TickerModuleItem } from '../types';

type DayCode = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

function parseEasternClock(now: Date): { day: DayCode; minutes: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const weekday = String(parts.find(part => part.type === 'weekday')?.value || '').toLowerCase().slice(0, 3) as DayCode;
  const hour = Number(parts.find(part => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value || '0');
  return {
    day: weekday,
    minutes: (hour * 60) + minute,
  };
}

function isStoreOpenEastern(now: Date): boolean {
  const { day, minutes } = parseEasternClock(now);
  if (day === 'mon' || day === 'tue' || day === 'wed' || day === 'thu' || day === 'fri') {
    return minutes >= (9 * 60) && minutes < (17 * 60);
  }
  if (day === 'sat') {
    return minutes >= (9 * 60) && minutes < (14 * 60);
  }
  return false;
}

export function buildStoreHoursTickerItem(now = new Date()): TickerModuleItem {
  const isOpen = isStoreOpenEastern(now);
  return {
    id: 'store_hours',
    text: isOpen ? '🟢 Store Open' : '🔴 Store Closed',
  };
}
