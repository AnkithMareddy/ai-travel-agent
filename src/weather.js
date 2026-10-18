// Free forecast from Open-Meteo (no API key needed).
const CODES = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorms',
};

export class Weather {
  constructor({ offline = false, fetchImpl = globalThis.fetch, log = console } = {}) {
    this.offline = offline;
    this.fetch = fetchImpl;
    this.log = log;
    this.cache = new Map();
  }

  async forDay(dateStr, point = { lat: 51.51, lng: -0.13 }) {
    const key = `${dateStr}|${point.lat.toFixed(1)}|${point.lng.toFixed(1)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 3 * 3600_000) return hit.value;
    let value = null;
    if (!this.offline) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${point.lat.toFixed(3)}&longitude=${point.lng.toFixed(3)}`
          + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max'
          + `&timezone=Europe%2FLondon&start_date=${dateStr}&end_date=${dateStr}`;
        const res = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()).daily;
        value = {
          source: 'forecast',
          highC: Math.round(d.temperature_2m_max[0]),
          lowC: Math.round(d.temperature_2m_min[0]),
          rainChancePct: d.precipitation_probability_max[0],
          sky: CODES[d.weather_code[0]] || 'mixed',
          windKmh: Math.round(d.wind_speed_10m_max[0]),
        };
      } catch (err) {
        this.log.warn?.(`Weather lookup failed for ${dateStr}: ${err.message}`);
      }
    }
    value ||= { source: 'typical October (no live forecast)', highC: 15, lowC: 9, rainChancePct: 50, sky: 'changeable, showers likely', windKmh: 20 };
    value.highF = Math.round(value.highC * 1.8 + 32);
    value.lowF = Math.round(value.lowC * 1.8 + 32);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  // Hourly forecast for several points in ONE Open-Meteo request (it accepts comma-separated coordinates).
  // Returns one { hours: [{ at: 'YYYY-MM-DDTHH:00', tempC, feelsC, rainPct, rainMm, code, sky, gustKmh }] } per point (null if unavailable).
  async hourly(points, { days = 2 } = {}) {
    if (this.offline || !points.length) return points.map(() => null);
    const key = `h|${days}|${points.map((p) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`).join(';')}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 45 * 60_000) return hit.value;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${points.map((p) => p.lat.toFixed(3)).join(',')}`
        + `&longitude=${points.map((p) => p.lng.toFixed(3)).join(',')}`
        + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_gusts_10m,cloud_cover'
        + `&timezone=Europe%2FLondon&forecast_days=${days}`;
      const res = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const value = (Array.isArray(json) ? json : [json]).map(({ hourly: h }) => ({
        hours: h.time.map((at, i) => ({
          at,
          tempC: Math.round(h.temperature_2m[i]),
          feelsC: Math.round(h.apparent_temperature[i]),
          rainPct: h.precipitation_probability[i] ?? 0,
          rainMm: h.precipitation[i] ?? 0,
          code: h.weather_code[i],
          sky: skyFor(h.weather_code[i]),
          gustKmh: Math.round(h.wind_gusts_10m[i] ?? 0),
          cloudPct: h.cloud_cover?.[i] ?? null,
        })),
      }));
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      this.log.warn?.(`Hourly weather lookup failed: ${err.message}`);
      return points.map(() => null);
    }
  }
}

export const skyFor = (code) => CODES[code] || 'mixed';

// The forecast hour covering a local "YYYY-MM-DD HH:MM".
export function hourAt(series, date, time) {
  if (!series) return null;
  return series.hours.find((h) => h.at === `${date}T${time.slice(0, 2)}:00`) || null;
}
