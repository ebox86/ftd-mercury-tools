import type { TickerModuleItem, WeatherTickerSnapshot } from '../types';

interface OpenMeteoGeocodeResult {
  latitude?: number;
  longitude?: number;
  name?: string;
  admin1?: string;
  country_code?: string;
}

interface OpenMeteoGeocodeResponse {
  results?: OpenMeteoGeocodeResult[];
}

interface OpenMeteoForecastResponse {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
    is_day?: number;
  };
}

const DEFAULT_WEATHER_ZIP = '15212';

function encodeQuery(params: Record<string, string | number | boolean>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  return query.toString();
}

function weatherCodeToDisplay(code: number, isDay: boolean): { label: string; emoji: string } {
  if (code === 0) return { label: 'Clear', emoji: isDay ? '☀️' : '🌙' };
  if (code === 1) return { label: 'Mostly clear', emoji: isDay ? '🌤️' : '🌙' };
  if (code === 2) return { label: 'Partly cloudy', emoji: '⛅' };
  if (code === 3) return { label: 'Cloudy', emoji: '☁️' };
  if ([45, 48].includes(code)) return { label: 'Fog', emoji: '🌫️' };
  if ([51, 53, 55, 56, 57].includes(code)) return { label: 'Drizzle', emoji: '🌦️' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: 'Rain', emoji: '🌧️' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: 'Snow', emoji: '❄️' };
  if ([95, 96, 99].includes(code)) return { label: 'Thunderstorm', emoji: '⛈️' };
  return { label: 'Weather', emoji: '🌤️' };
}

function buildLocationLabel(result: OpenMeteoGeocodeResult): string {
  const city = String(result.name || '').trim();
  const region = String(result.admin1 || '').trim();
  if (city && region) return `${city}, ${region}`;
  if (city) return city;
  return region || 'Local forecast';
}

export function normalizeWeatherZip(raw: unknown): string {
  const match = String(raw || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || DEFAULT_WEATHER_ZIP;
}

export async function prefetchWeatherTicker(zipRaw: string, signal?: AbortSignal): Promise<WeatherTickerSnapshot | null> {
  const zip = normalizeWeatherZip(zipRaw);
  const geocodeResponse = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?${encodeQuery({
      name: zip,
      count: 10,
      language: 'en',
      format: 'json',
    })}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    },
  );
  if (!geocodeResponse.ok) {
    throw new Error(`Weather geocode request failed (${geocodeResponse.status})`);
  }
  const geocodeData = await geocodeResponse.json() as OpenMeteoGeocodeResponse;
  const location = geocodeData.results?.find(result => String(result.country_code || '').toUpperCase() === 'US')
    || geocodeData.results?.[0];
  if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
    return null;
  }

  const forecastResponse = await fetch(
    `https://api.open-meteo.com/v1/forecast?${encodeQuery({
      latitude: location.latitude,
      longitude: location.longitude,
      current: 'temperature_2m,weather_code,is_day',
      temperature_unit: 'fahrenheit',
      timezone: 'auto',
    })}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    },
  );
  if (!forecastResponse.ok) {
    throw new Error(`Weather forecast request failed (${forecastResponse.status})`);
  }
  const forecastData = await forecastResponse.json() as OpenMeteoForecastResponse;
  const temperature = Number(forecastData.current?.temperature_2m);
  const weatherCode = Number(forecastData.current?.weather_code);
  const isDay = Number(forecastData.current?.is_day) !== 0;
  if (!Number.isFinite(temperature) || !Number.isFinite(weatherCode)) {
    return null;
  }

  const display = weatherCodeToDisplay(weatherCode, isDay);
  return {
    zip,
    locationLabel: buildLocationLabel(location),
    conditionLabel: display.label,
    conditionEmoji: display.emoji,
    temperatureLabel: `${Math.round(temperature)}°F`,
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
