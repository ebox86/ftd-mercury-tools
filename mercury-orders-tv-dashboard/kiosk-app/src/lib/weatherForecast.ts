interface OpenMeteoGeocodeResult {
  latitude?: number;
  longitude?: number;
  name?: string;
  admin1?: string;
  country_code?: string;
}

interface OpenMeteoForecastResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    precipitation?: number;
    is_day?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    precipitation_probability?: number[];
    weather_code?: number[];
  };
}

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
  location: { label: string; lat: number; lon: number };
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

function encodeQuery(params: Record<string, string | number | boolean>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return q.toString();
}

function buildLocationLabel(result: OpenMeteoGeocodeResult): string {
  const city = String(result.name || '').trim();
  const region = String(result.admin1 || '').trim();
  if (city && region) return `${city}, ${region}`;
  return city || region || 'Unknown location';
}

function parseSunTime(isoDateTime: string | undefined): string {
  if (!isoDateTime) return '--';
  const timePart = isoDateTime.split('T')[1] || '';
  const [h, m] = timePart.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '--';
  const period = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`;
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

async function fetchNWSRadarStation(lat: number, lon: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'FTD-Mercury-Dashboard/1.0 (florist-dashboard)' }, signal },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { properties?: { radarStation?: string } };
    return String(data?.properties?.radarStation || '').trim() || null;
  } catch {
    return null;
  }
}

export async function fetchWeatherForecast(
  zip: string,
  signal?: AbortSignal,
): Promise<WeatherForecastData | null> {
  const geoResp = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?${encodeQuery({ name: zip, count: 10, language: 'en', format: 'json' })}`,
    { headers: { Accept: 'application/json' }, signal },
  );
  if (!geoResp.ok) return null;

  const geoData = await geoResp.json() as { results?: OpenMeteoGeocodeResult[] };
  const location = geoData.results?.find(r => String(r.country_code || '').toUpperCase() === 'US')
    ?? geoData.results?.[0];
  if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') return null;

  const lat = location.latitude;
  const lon = location.longitude;

  const [forecastResp, radarStation] = await Promise.all([
    fetch(
      `https://api.open-meteo.com/v1/forecast?${encodeQuery({
        latitude: lat,
        longitude: lon,
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day',
        hourly: 'temperature_2m,precipitation_probability,weather_code',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        timezone: 'auto',
        forecast_days: 2,
      })}`,
      { headers: { Accept: 'application/json' }, signal },
    ),
    fetchNWSRadarStation(lat, lon, signal),
  ]);

  if (!forecastResp.ok) return null;
  const forecast = await forecastResp.json() as OpenMeteoForecastResponse;
  const cur = forecast.current;
  if (!cur) return null;

  const buildDay = (idx: number): DayForecast => ({
    high: Math.round(Number(forecast.daily?.temperature_2m_max?.[idx] ?? 0)),
    low: Math.round(Number(forecast.daily?.temperature_2m_min?.[idx] ?? 0)),
    weatherCode: Number(forecast.daily?.weather_code?.[idx] ?? 0),
    precipSum: Math.round(Number(forecast.daily?.precipitation_sum?.[idx] ?? 0) * 10) / 10,
    precipProbability: Number(forecast.daily?.precipitation_probability_max?.[idx] ?? 0),
    sunrise: parseSunTime(forecast.daily?.sunrise?.[idx]),
    sunset: parseSunTime(forecast.daily?.sunset?.[idx]),
  });

  // Collect next 12 hours starting from the current hour
  const nowDateStr = new Date().toISOString().split('T')[0];
  const nowHour = new Date().getHours();
  const hourlyTimes = forecast.hourly?.time ?? [];
  const hourlyTemps = forecast.hourly?.temperature_2m ?? [];
  const hourlyPrecip = forecast.hourly?.precipitation_probability ?? [];
  const hourlyCodes = forecast.hourly?.weather_code ?? [];
  const hourly: HourlySlice[] = [];

  for (let i = 0; i < hourlyTimes.length && hourly.length < 12; i++) {
    const iso = hourlyTimes[i];
    const [datePart, timePart] = iso.split('T');
    const h = parseInt(timePart?.split(':')[0] ?? '0', 10);
    // Skip past hours from today
    if (datePart === nowDateStr && h < nowHour) continue;
    hourly.push({
      isoTime: iso,
      hour: h,
      temp: Math.round(Number(hourlyTemps[i] ?? 0)),
      precipProbability: Number(hourlyPrecip[i] ?? 0),
      weatherCode: Number(hourlyCodes[i] ?? 0),
    });
  }

  return {
    location: { label: buildLocationLabel(location), lat, lon },
    current: {
      temp: Math.round(Number(cur.temperature_2m ?? 0)),
      feelsLike: Math.round(Number(cur.apparent_temperature ?? 0)),
      humidity: Math.round(Number(cur.relative_humidity_2m ?? 0)),
      windSpeed: Math.round(Number(cur.wind_speed_10m ?? 0)),
      windDirection: Number(cur.wind_direction_10m ?? 0),
      weatherCode: Number(cur.weather_code ?? 0),
      isDay: Number(cur.is_day ?? 1) !== 0,
      precipitation: Math.round(Number(cur.precipitation ?? 0) * 100) / 100,
    },
    today: buildDay(0),
    tomorrow: buildDay(1),
    hourly,
    radarStation,
  };
}
