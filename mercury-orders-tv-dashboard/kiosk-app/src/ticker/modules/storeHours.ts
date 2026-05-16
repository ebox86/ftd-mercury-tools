import type { TickerModuleItem } from '../types';

type DayCode = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface StoreHoursConfig {
  monFriEnabled: boolean;
  monFriOpen: string;
  monFriClose: string;
  saturdayEnabled: boolean;
  saturdayOpen: string;
  saturdayClose: string;
  sundayEnabled: boolean;
  sundayOpen: string;
  sundayClose: string;
}

export const DEFAULT_STORE_HOURS_CONFIG: StoreHoursConfig = {
  monFriEnabled: true,
  monFriOpen: '09:00',
  monFriClose: '17:00',
  saturdayEnabled: true,
  saturdayOpen: '09:00',
  saturdayClose: '14:00',
  sundayEnabled: false,
  sundayOpen: '09:00',
  sundayClose: '14:00',
};

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

function minutesFromTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return (hours * 60) + minutes;
}

function isOpenForWindow(minutes: number, enabled: boolean, openTime: string, closeTime: string): boolean {
  if (!enabled) return false;
  const openMinutes = minutesFromTime(openTime);
  const closeMinutes = minutesFromTime(closeTime);
  if (openMinutes === closeMinutes) return false;
  if (openMinutes < closeMinutes) {
    return minutes >= openMinutes && minutes < closeMinutes;
  }
  return minutes >= openMinutes || minutes < closeMinutes;
}

function isStoreOpenEastern(now: Date, config: StoreHoursConfig): boolean {
  const { day, minutes } = parseEasternClock(now);
  if (day === 'mon' || day === 'tue' || day === 'wed' || day === 'thu' || day === 'fri') {
    return isOpenForWindow(minutes, config.monFriEnabled, config.monFriOpen, config.monFriClose);
  }
  if (day === 'sat') {
    return isOpenForWindow(minutes, config.saturdayEnabled, config.saturdayOpen, config.saturdayClose);
  }
  return isOpenForWindow(minutes, config.sundayEnabled, config.sundayOpen, config.sundayClose);
}

export function buildStoreHoursTickerItem(config = DEFAULT_STORE_HOURS_CONFIG, now = new Date()): TickerModuleItem {
  const isOpen = isStoreOpenEastern(now, config);
  return {
    id: 'store_hours',
    text: isOpen ? 'Store Open' : 'Store Closed',
  };
}
