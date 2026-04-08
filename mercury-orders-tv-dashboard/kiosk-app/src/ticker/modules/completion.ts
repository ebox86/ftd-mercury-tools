import type { TickerModuleItem } from '../types';

export function buildCompletionTickerItem(input: {
  dayLabel: string;
  completed: number;
  total: number;
  percent: number;
}): TickerModuleItem {
  const safePercent = Math.max(0, Math.min(100, Math.round(input.percent)));
  return {
    id: 'completion',
    text: `Completion ${input.dayLabel}: ${input.completed}/${input.total} complete (${safePercent}%)`,
  };
}
