export type TickerModuleId = 'weather' | 'completion' | 'intake' | 'exception_watch' | 'new_orders' | 'store_hours';

export interface TickerModuleItem {
  id: TickerModuleId;
  text: string;
}

export interface WeatherTickerSnapshot {
  zip: string;
  locationLabel: string;
  conditionLabel: string;
  conditionEmoji: string;
  temperatureLabel: string;
}
