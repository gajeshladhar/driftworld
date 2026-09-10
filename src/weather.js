// ── Live weather for wherever you are ───────────────────────────────────────
// Open-Meteo, no key, CORS-clean. Two endpoints: the land forecast always
// answers, the marine one only has an opinion near coasts — inland it returns
// nothing, which is not an error and must not blank the panel.
import { WEATHER } from './config.js?v=cc9cefc5';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

const CURRENT = [
  'temperature_2m', 'apparent_temperature', 'precipitation', 'weather_code',
  'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'is_day',
].join(',');

/** WMO weather codes, collapsed to what actually changes the look of the sky. */
function describe(code, cloud) {
  if (code >= 95) return 'Thunderstorm';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80) return 'Showers';
  if (code >= 61) return 'Rain';
  if (code >= 51) return 'Drizzle';
  if (code >= 45 && code <= 48) return 'Fog';
  if (cloud > 85) return 'Overcast';
  if (cloud > 55) return 'Cloudy';
  if (cloud > 20) return 'Partly cloudy';
  return 'Clear';
}

export class Weather {
  constructor() {
    this.data = null;
    this.busy = false;
    this.lastAt = null;      // [lat, lon] of the last successful fetch
    this.onUpdate = null;
  }

  /** Great-circle-ish distance in km; good enough to decide "have we moved". */
  static _km(a, b) {
    const dLat = (a[0] - b[0]) * 111;
    const dLon = (a[1] - b[1]) * 111 * Math.cos((a[0] * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  }

  maybeFetch(lat, lon) {
    if (this.busy) return;
    if (this.lastAt && Weather._km([lat, lon], this.lastAt) < WEATHER.refreshKm) return;
    this.busy = true;
    this.lastAt = [lat, lon];
    this._fetch(lat, lon).finally(() => { this.busy = false; });
  }

  async _fetch(lat, lon) {
    const q = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
    try {
      const [land, sea] = await Promise.all([
        fetch(`${FORECAST}?${q}&current=${CURRENT}&timezone=auto`).then((r) => r.json()),
        // inland this legitimately fails; swallow it rather than lose the land data
        fetch(`${MARINE}?${q}&current=wave_height,wave_period,wave_direction`)
          .then((r) => r.json()).catch(() => null),
      ]);
      if (!land?.current) return;
      const c = land.current;
      const m = sea?.current ?? {};

      this.data = {
        temp: c.temperature_2m,
        feels: c.apparent_temperature,
        precip: c.precipitation ?? 0,
        code: c.weather_code ?? 0,
        cloud: c.cloud_cover ?? 0,
        wind: c.wind_speed_10m ?? 0,
        gust: c.wind_gusts_10m ?? 0,
        windDir: c.wind_direction_10m ?? 0,
        isDay: c.is_day === 1,
        tz: land.timezone ?? '',
        localTime: (c.time ?? '').replace('T', ' ').slice(11, 16),
        wave: m.wave_height ?? null,
        wavePeriod: m.wave_period ?? null,
        waveDir: m.wave_direction ?? null,
        label: describe(c.weather_code ?? 0, c.cloud_cover ?? 0),
      };
      this.onUpdate?.(this.data);
    } catch {
      /* offline or throttled — keep whatever we had */
    }
  }

  /**
   * Sea state as shader parameters. Falls back to a light chop inland so lakes
   * and rivers still move, rather than turning into glass.
   */
  seaState() {
    const w = this.data;
    const h = w?.wave ?? null;
    if (h === null) {
      // no marine data: infer a little surface texture from the wind alone
      const windChop = Math.min(1, (w?.wind ?? 4) / 22);
      return { amp: 0.45 + windChop * 0.5, speed: 0.8 + windChop * 0.5 };
    }
    return {
      amp: Math.max(0.35, Math.min(2.6, 0.35 + h * 0.85)),
      speed: Math.max(0.5, Math.min(1.8, 8 / Math.max(3, w.wavePeriod ?? 6))),
    };
  }
}
