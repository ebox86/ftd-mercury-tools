import type { TickerModuleItem } from '../types';

export function buildExceptionWatchTickerItem(input: {
  dayLabel: string;
  exceptionCount: number;
}): TickerModuleItem {
  const isToday = input.dayLabel.trim().toLowerCase() === 'today';
  if (input.exceptionCount <= 0) {
    return {
      id: 'exception_watch',
      text: isToday
        ? 'Exceptions Today: none'
        : `Exceptions ${input.dayLabel}: none`,
    };
  }
  return {
    id: 'exception_watch',
    text: isToday
      ? `Exceptions Today: ${input.exceptionCount}`
      : `Exceptions ${input.dayLabel}: ${input.exceptionCount}`,
  };
}
