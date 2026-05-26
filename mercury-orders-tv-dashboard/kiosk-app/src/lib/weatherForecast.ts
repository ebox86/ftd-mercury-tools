import { buildRequestUrl } from './api';

export interface DayForecast {
  high: number;
  low: number;
  weatherCode: number;
  precipSum: number;
  precipProbability: number;
  sunrise: string;
  sunset: string;
}

export interface HourlySlice {
  isoTime: string;
  hour: number;
  temp: number;
  precipProbability: number;
  weatherCode: number;
}

export interface WeatherForecastData {
  zip?: string;
  cachedAt?: string;
  cacheStatus?: string;
  stale?: boolean;
  warning?: string;
  provider?: string;
  providerFallbackReason?: string;
  location: { label: string; lat: number; lon: number; source?: string };
  current: {
    temp: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    windDirection: number;
    weatherCode: number;
    isDay: boolean;
    precipitation: number;
  };
  today: DayForecast;
  tomorrow: DayForecast;
  hourly: HourlySlice[];
  radarStation: string | null;
}

export function weatherIconNumber(code: number, isDay: boolean): number {
  switch (code) {
    case 0:   return isDay ? 32 : 31;
    case 1:   return isDay ? 34 : 33;
    case 2:   return isDay ? 30 : 29;
    case 3:   return 26;
    case 45:
    case 48:  return 20;
    case 51:
    case 53:
    case 55:  return 9;
    case 56:
    case 57:  return 8;
    case 61:
    case 63:
    case 65:  return 12;
    case 66:
    case 67:  return 10;
    case 71:
    case 73:
    case 75:
    case 77:  return 16;
    case 80:
    case 81:
    case 82:  return 39;
    case 85:
    case 86:  return 41;
    case 95:  return 4;
    case 96:
    case 99:  return 3;
    default:  return isDay ? 30 : 29;
  }
}

export function ccefIconName(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? 'Sunny.gif' : 'Clear.gif';
  if (code === 1) return isDay ? 'Mostly-Clear.gif' : 'Mostly-Clear.gif';
  if (code === 2) return 'Partly-Cloudy.gif';
  if (code === 3) return 'Cloudy.gif';
  if (code === 45 || code === 48) return 'Fog.gif';
  if (code === 51 || code === 53 || code === 55) return 'Scattered-Showers.gif';
  if (code === 56 || code === 57) return 'Freezing-Rain.gif';
  if (code === 61 || code === 63 || code === 65) return 'Rain.gif';
  if (code === 66 || code === 67) return 'Freezing-Rain.gif';
  if (code === 71 || code === 73 || code === 75) return 'Snow.gif';
  if (code === 77) return 'Light-Snow.gif';
  if (code === 80 || code === 81 || code === 82) return 'Shower.gif';
  if (code === 85 || code === 86) return 'Scat-Snow-Showers.gif';
  if (code === 95) return 'Thunderstorm.gif';
  if (code === 96 || code === 99) return 'Scattered-T-storms.gif';
  return isDay ? 'Partly-Cloudy.gif' : 'Mostly-Clear.gif';
}

export function weatherCodeDisplay(code: number, isDay: boolean): { label: string; emoji: string } {
  if (code === 0) return { label: 'Clear', emoji: isDay ? '☀️' : '🌙' };
  if (code === 1) return { label: 'Mostly Clear', emoji: isDay ? '🌤️' : '🌙' };
  if (code === 2) return { label: 'Partly Cloudy', emoji: '⛅' };
  if (code === 3) return { label: 'Cloudy', emoji: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', emoji: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', emoji: '🌦️' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: 'Rain', emoji: '🌧️' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: 'Snow', emoji: '❄️' };
  if (code === 95 || code === 96 || code === 99) return { label: 'Thunderstorm', emoji: '⛈️' };
  return { label: 'Weather', emoji: '🌤️' };
}

export function degreesToCompass(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

export interface RadarFrame {
  timestamp: number;
  tilePath: string;
  host: string;
}

export async function fetchRadarFrames(signal?: AbortSignal): Promise<RadarFrame[]> {
  try {
    const resp = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal });
    if (!resp.ok) return [];
    const data = await resp.json() as {
      host?: string;
      radar?: { past?: Array<{ time: number; path: string }> };
    };
    const host = String(data.host || 'https://tilecache.rainviewer.com');
    const past = data.radar?.past ?? [];
    return past.slice(-8).map(f => ({ timestamp: f.time, tilePath: f.path, host }));
  } catch {
    return [];
  }
}

export function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const z = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * z);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * z);
  return { x, y };
}

export async function fetchWeatherForecast(
  zip: string,
  signal?: AbortSignal,
): Promise<WeatherForecastData | null> {
  try {
    const query = new URLSearchParams({ zip }).toString();
    const resp = await fetch(buildRequestUrl(`/api/workflow/weather/forecast?${query}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!resp.ok) return null;
    return await resp.json() as WeatherForecastData;
  } catch {
    return null;
  }
}
