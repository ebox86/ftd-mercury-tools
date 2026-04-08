import type { TickerModuleItem } from '../types';

export function buildExceptionWatchTickerItem(input: {
  dayLabel: string;
  exceptionCount: number;
}): TickerModuleItem {
  if (input.exceptionCount <= 0) {
    return {
      id: 'exception_watch',
      text: `Exception watch ${input.dayLabel}: none`,
    };
  }

  return {
    id: 'exception_watch',
    text: `Exception watch ${input.dayLabel}: ${input.exceptionCount}`,
  };
}
