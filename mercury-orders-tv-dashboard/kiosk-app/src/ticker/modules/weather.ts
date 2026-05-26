import { fetchWeatherForecast, weatherCodeDisplay } from '../../lib/weatherForecast';
import type { TickerModuleItem, WeatherTickerSnapshot } from '../types';

const DEFAULT_WEATHER_ZIP = '15212';

export function normalizeWeatherZip(raw: unknown): string {
  const match = String(raw || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || DEFAULT_WEATHER_ZIP;
}

export async function prefetchWeatherTicker(zipRaw: string, signal?: AbortSignal): Promise<WeatherTickerSnapshot | null> {
  const zip = normalizeWeatherZip(zipRaw);
  const forecast = await fetchWeatherForecast(zip, signal);
  if (!forecast) return null;

  const display = weatherCodeDisplay(forecast.current.weatherCode, forecast.current.isDay);
  return {
    zip,
    locationLabel: forecast.location.label,
    conditionLabel: display.label,
    conditionEmoji: display.emoji,
    temperatureLabel: `${Math.round(forecast.current.temp)}°F`,
  };
}

export function buildWeatherTickerItem(snapshot: WeatherTickerSnapshot | null, zipRaw: string): TickerModuleItem | null {
  const expectedZip = normalizeWeatherZip(zipRaw);
  if (!snapshot || snapshot.zip !== expectedZip) return null;
  return {
    id: 'weather',
    text: `${snapshot.locationLabel} ${snapshot.conditionEmoji} ${snapshot.temperatureLabel} ${snapshot.conditionLabel}`,
  };
}
