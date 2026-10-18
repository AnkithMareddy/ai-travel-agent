import { distanceM, walkMinutes, inRegion, LONDON } from './geo.js';
import { londonParts, MIN } from './time.js';

// Travel times via the free TfL Journey Planner, with a distance-based fallback.
export class Transit {
  // transport: 'tfl' (London public transport) or 'drive' (road trip; OSRM driving times).
  // traffic: { provider: 'google' | 'tomtom', key } for live-traffic drive times (optional).
  constructor({ appKey = '', offline = false, fetchImpl = globalThis.fetch, log = console, transport = 'tfl', region = LONDON, traffic = null } = {}) {
    this.transport = transport;
    this.traffic = traffic?.key ? traffic : null;
    this.trafficSeen = new Map(); // destination -> { at, ratio, delayMin } (one live lookup per destination every 5 min)
    this.region = region;
    this.appKey = appKey;
    this.offline = offline;
    this.fetch = fetchImpl;
    this.log = log;
    this.cache = new Map();
  }

  // mode: optional per-day override, e.g. 'city' on car-free city days of a road trip.
  async route(from, to, at = new Date(), mode = null) {
    if (this.transport === 'drive') return this.driveRoute(from, to, at, mode);
    const dist = distanceM(from, to);
    if (dist < 1000) {
      return { minutes: walkMinutes(from, to), summary: `walk (${Math.round(dist)} m)`, mode: 'walk', source: 'estimate' };
    }
    const key = [from.lat.toFixed(3), from.lng.toFixed(3), to.lat.toFixed(3), to.lng.toFixed(3), Math.floor(at / (10 * MIN))].join('|');
    if (this.cache.has(key)) return this.cache.get(key);

    let result = null;
    if (!this.offline && inRegion(this.region, from) && inRegion(this.region, to)) {
      result = await this.tfl(from, to, at).catch((err) => {
        this.log.warn?.(`TfL lookup failed, using estimate: ${err.message}`);
        return null;
      });
    }
    result ||= this.estimate(from, to, at);
    this.cache.set(key, result);
    return result;
  }

  async tfl(from, to, at) {
    const p = londonParts(at);
    const date = p.date.replaceAll('-', '');
    const time = `${String(p.hh).padStart(2, '0')}${String(p.mm).padStart(2, '0')}`;
    // TfL-network modes only: skips the Heathrow Express (~£25) in favour of the Elizabeth line (~£13).
    const mode = 'tube,elizabeth-line,overground,dlr,bus,walking,tram,replacement-bus';
    const params = new URLSearchParams({ date, time, timeIs: 'Departing', mode });
    if (this.appKey) params.set('app_key', this.appKey);
    const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${from.lat},${from.lng}/to/${to.lat},${to.lng}?${params}`;
    const res = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`TfL HTTP ${res.status}`);
    const body = await res.json();
    const journeys = body.journeys || [];
    if (!journeys.length) throw new Error('TfL returned no journeys');
    const best = journeys.reduce((a, b) => (b.duration < a.duration ? b : a));
    const legs = (best.legs || []).filter((l) => l.duration > 0).map((l) => {
      const mode = l.mode?.id || l.mode?.name || 'travel';
      if (mode === 'walking') return `walk ${l.duration}m`;
      const line = l.routeOptions?.[0]?.name || l.instruction?.summary || mode;
      const label = mode === 'tube' ? `${line} line` : mode === 'bus' ? `bus ${line}` : line;
      return `${label} ${l.duration}m`;
    });
    return { minutes: best.duration, summary: legs.join(' → '), mode: 'transit', source: 'tfl' };
  }

  // ---- road trip: OSRM (free, no key) with a distance-based fallback
  async driveRoute(from, to, at, mode) {
    const dist = distanceM(from, to);
    if (dist < 1200) return { minutes: walkMinutes(from, to), summary: `walk (${Math.round(dist)} m)`, mode: 'walk', source: 'estimate' };
    const key = ['d', from.lat.toFixed(3), from.lng.toFixed(3), to.lat.toFixed(3), to.lng.toFixed(3)].join('|');
    let base = this.cache.get(key);
    if (!base && !this.offline) {
      base = await this.osrm(from, to).catch((err) => {
        this.log.warn?.(`OSRM lookup failed, using estimate: ${err.message}`);
        return null;
      });
    }
    if (!base) {
      // Irish back roads twist a lot: ~1.4x straight-line distance at ~55 km/h average.
      const km = (dist * 1.3) / 1000;
      base = { rawMin: 5 + (km / 62) * 60, km, source: 'estimate' };
    }
    this.cache.set(key, base);
    const km = Math.round(base.km);
    if (mode === 'city') {
      if (dist < 2500) return { minutes: walkMinutes(from, to), summary: 'walk', mode: 'walk', source: 'estimate' };
      const minutes = Math.round(base.rawMin * 1.6 + 5);
      return { minutes, summary: `taxi/bus ~${minutes} min (${km} km)`, mode: 'taxi', source: base.source };
    }
    // Live traffic for trips leaving within the next 2 hours (later than that, traffic now says little).
    const live = this.traffic && !this.offline && at - Date.now() < 2 * 3600_000 ? await this.liveTraffic(from, to, base) : null;
    if (live) {
      // Live times already include traffic; a small pad for parking and photo stops.
      const minutes = Math.round(base.rawMin * live.ratio * 1.05 + 3);
      const delay = live.delayMin >= 5 ? `, incl. ~${live.delayMin} min of traffic` : ', traffic is light';
      return { minutes, summary: `drive ~${minutes} min (${km} km${delay})`, mode: 'drive', source: `live traffic (${this.traffic.provider})`, trafficDelayMin: live.delayMin };
    }
    // Real Irish roads (narrow, scenic, tractors, photo stops) run slower than free-flow estimates.
    const minutes = Math.round(base.rawMin * 1.15 + 3);
    return { minutes, summary: `drive ~${minutes} min (${km} km)`, mode: 'drive', source: base.source };
  }

  // How much slower than the free-flow estimate the drive is right now: { ratio, delayMin } or null.
  // The car moves, so we look up each destination at most every 5 minutes and reuse the ratio in between.
  async liveTraffic(from, to, base) {
    const dest = `${to.lat.toFixed(3)},${to.lng.toFixed(3)}`;
    const seen = this.trafficSeen.get(dest);
    if (seen && Date.now() - seen.at < 5 * 60_000) return seen;
    try {
      const r = this.traffic.provider === 'tomtom' ? await this.tomtom(from, to) : await this.google(from, to);
      const value = { at: Date.now(), ratio: Math.max(0.8, Math.min(3, r.minutes / Math.max(1, base.rawMin))), delayMin: Math.max(0, Math.round(r.delayMin)) };
      this.trafficSeen.set(dest, value);
      return value;
    } catch (err) {
      this.log.warn?.(`Live traffic lookup failed (${this.traffic.provider}), using the usual estimate: ${err.message}`);
      this.trafficSeen.set(dest, { at: Date.now(), ratio: 1.1, delayMin: 0, failed: true });
      return null;
    }
  }

  // Google Routes API (needs the Routes API enabled on the key). Returns { minutes, delayMin }.
  async google(from, to) {
    const res = await this.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.traffic.key, 'x-goog-fieldmask': 'routes.duration,routes.staticDuration' },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
    const r = (await res.json()).routes?.[0];
    if (!r?.duration) throw new Error('no route');
    const secs = (d) => Number(String(d).replace('s', ''));
    return { minutes: secs(r.duration) / 60, delayMin: (secs(r.duration) - secs(r.staticDuration || r.duration)) / 60 };
  }

  // TomTom Routing API (free tier, no card). Returns { minutes, delayMin }.
  async tomtom(from, to) {
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${from.lat},${from.lng}:${to.lat},${to.lng}/json?key=${encodeURIComponent(this.traffic.key)}&traffic=true&travelMode=car&routeType=fastest`;
    const res = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`TomTom HTTP ${res.status}`);
    const sum = (await res.json()).routes?.[0]?.summary;
    if (!sum) throw new Error('no route');
    return { minutes: sum.travelTimeInSeconds / 60, delayMin: (sum.trafficDelayInSeconds || 0) / 60 };
  }

  async osrm(from, to) {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const res = await this.fetch(url, { headers: { 'user-agent': 'london-trip-bot/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const r = (await res.json()).routes?.[0];
    if (!r) throw new Error('no route');
    return { rawMin: r.duration / 60, km: r.distance / 1000, source: 'osrm' };
  }

  estimate(from, to, at) {
    const km = (distanceM(from, to) * 1.3) / 1000;
    const p = londonParts(at);
    const lateNight = p.minutes < 330 || p.minutes >= 1410; // ~23:30–05:30
    if (!inRegion(this.region, from) || !inRegion(this.region, to)) {
      const minutes = Math.round(10 + km * 1.6); // outside London: assume taxi-ish
      return { minutes, summary: `~${minutes} min by taxi (rough estimate)`, mode: 'taxi', source: 'estimate' };
    }
    if (km < 1.6) {
      const minutes = Math.round((km * 1000) / 80);
      return { minutes, summary: 'walk', mode: 'walk', source: 'estimate' };
    }
    if (lateNight) {
      const minutes = Math.round(6 + km * 2.6);
      const fare = Math.round(10 + km * 2.4);
      return { minutes, summary: `Uber/black cab (~£${fare}), Tube may be closed`, mode: 'taxi', source: 'estimate' };
    }
    const minutes = Math.round(12 + Math.min(km, 8) * 2.3 + Math.max(0, km - 8) * 1.2);
    return { minutes, summary: `Tube/bus (estimate, ${km.toFixed(1)} km)`, mode: 'transit', source: 'estimate' };
  }

  // Live London line status (TfL, free). Returns only lines that aren't running a good service:
  // [{ line, status, reason }]; [] if all good; null if the lookup failed.
  async lineStatus() {
    if (this.offline || this.transport !== 'tfl') return null;
    const hit = this.cache.get('status');
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    try {
      const url = `https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,dlr,overground/Status${this.appKey ? `?app_key=${this.appKey}` : ''}`;
      const res = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const value = (await res.json()).flatMap((l) => (l.lineStatuses || [])
        .filter((s) => s.statusSeverity !== 10)
        .map((s) => ({ line: l.name, status: s.statusSeverityDescription, reason: (s.reason || '').replace(/^[^:]+:\s*/, '').slice(0, 220) })));
      this.cache.set('status', { at: Date.now(), value });
      return value;
    } catch (err) {
      this.log.warn?.(`TfL status lookup failed: ${err.message}`);
      return null;
    }
  }
}
