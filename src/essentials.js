// Road-trip essentials near a point, from OpenStreetMap (Overpass API, free, no key):
// petrol, EV chargers, parking, toilets, cash machines, pharmacies, supermarkets, hospitals.
import { distanceM } from './geo.js';

export const ESSENTIALS = [
  { id: 'fuel', re: /\b(petrol|fuel|gas station|gas|diesel|fill (?:up|the tank)|filling station)\b/, label: 'Petrol stations', tags: ['["amenity"="fuel"]'], radius: 8000 },
  { id: 'ev', re: /\b(ev charg\w*|charging station|charger for the car|supercharger)\b/, label: 'EV chargers', tags: ['["amenity"="charging_station"]'], radius: 8000 },
  { id: 'parking', re: /\b(park(ing)?|car park|where (?:can|do|should) we park)\b/, label: 'Parking', tags: ['["amenity"="parking"]'], radius: 1500 },
  { id: 'toilets', re: /\b(toilets?|bathroom|restroom|loo|wc|jacks)\b/, label: 'Toilets', tags: ['["amenity"="toilets"]'], radius: 1500 },
  { id: 'atm', re: /\b(atm|cash ?machine|cashpoint|cash point|withdraw|get cash|need cash)\b/, label: 'Cash machines', tags: ['["amenity"="atm"]', '["amenity"="bank"]["atm"="yes"]'], radius: 2500 },
  { id: 'pharmacy', re: /\b(pharmacy|chemist|drugstore|paracetamol|ibuprofen|painkillers|plasters|hangover cure)\b/, label: 'Pharmacies', tags: ['["amenity"="pharmacy"]', '["shop"="chemist"]'], radius: 4000 },
  { id: 'supermarket', re: /\b(supermarket|grocer\w*|tesco|lidl|aldi|spar|centra|sainsbury'?s|snacks for the car|corner shop|off.?licen[cs]e)\b/, label: 'Supermarkets & shops', tags: ['["shop"="supermarket"]', '["shop"="convenience"]'], radius: 3000 },
  { id: 'hospital', re: /\b(hospital|a ?& ?e|emergency room|er\b|urgent care|doctor)\b/, label: 'Hospitals / A&E', tags: ['["amenity"="hospital"]["emergency"!="no"]'], radius: 25000 },
];

// The essential someone is asking for, if any. Must read like a request, not a passing mention.
export function essentialFor(text) {
  const t = text.toLowerCase();
  const asking = /\b(where|near|nearest|closest|need|find|any|is there|we're low|running low|gotta|how far)\b|\?$/.test(t);
  if (!asking) return null;
  return ESSENTIALS.find((e) => e.re.test(t)) || null;
}

// The main Overpass server is often busy; these public mirrors serve the same data.
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export class Essentials {
  constructor({ offline = false, fetchImpl = globalThis.fetch, log = console } = {}) {
    Object.assign(this, { offline, fetch: fetchImpl, log });
    this.cache = new Map();
  }

  // Named spots to watch a sunrise/sunset from: viewpoints, beaches, headlands, lighthouses, piers, hilltops, castles.
  // Returns [{ id, name, kind, lat, lng, distM }] (closest 12), [] if none, null if the lookup failed.
  async viewpoints(here, radius = 20000) {
    if (this.offline) return null;
    const key = `vp|${here.lat.toFixed(2)}|${here.lng.toFixed(2)}|${radius}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
    // Mostly points (fast); beaches and castles are often drawn as areas, so those use nwr.
    const tags = ['node["tourism"="viewpoint"]', 'node["natural"="cape"]', 'node["man_made"="lighthouse"]', 'node["natural"="peak"]["name"]', 'nwr["natural"="beach"]["name"]', 'nwr["historic"="castle"]["name"]'];
    const q = `[out:json][timeout:25];(${tags.map((t) => `${t}(around:${radius},${here.lat},${here.lng});`).join('')});out center 80;`;
    for (const url of SERVERS) {
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'trip-bot/1.0 (personal Telegram trip assistant)' },
          body: `data=${encodeURIComponent(q)}`,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const kindOf = (t) => (t.tourism === 'viewpoint' ? 'viewpoint' : t.natural || t.man_made || t.historic);
        const value = ((await res.json()).elements || [])
          .map((e) => ({ name: e.tags?.name, kind: kindOf(e.tags || {}), lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, ele: e.tags?.ele ? Number(e.tags.ele) : null }))
          .filter((e) => e.name && e.lat)
          .map((e) => ({ ...e, distM: Math.round(distanceM(here, e)) }))
          .sort((a, b) => a.distM - b.distM)
          .filter((e, i, all) => all.findIndex((x) => x.name === e.name) === i)
          .slice(0, 12)
          .map((e, i) => ({ id: `vp${i + 1}`, ...e }));
        this.cache.set(key, { at: Date.now(), value });
        return value;
      } catch (err) {
        this.log.warn?.(`Overpass viewpoints failed (${new URL(url).host}): ${err.message}`);
      }
    }
    return null;
  }

  // Returns up to `limit` places sorted by distance: [{ name, lat, lng, distM, hours, brand }], or null if the lookup failed.
  async near(kind, here, { limit = 3 } = {}) {
    if (this.offline) return null;
    const key = `${kind.id}|${here.lat.toFixed(3)}|${here.lng.toFixed(3)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 20 * 60_000) return hit.value;
    for (const radius of [kind.radius, kind.radius * 3]) {
      const q = `[out:json][timeout:12];(${kind.tags.map((t) => `nwr${t}(around:${radius},${here.lat},${here.lng});`).join('')});out center 40;`;
      let els = null;
      for (const url of SERVERS) {
        try {
          const res = await this.fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'trip-bot/1.0 (personal Telegram trip assistant)' },
            body: `data=${encodeURIComponent(q)}`,
            signal: AbortSignal.timeout(12_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          els = (await res.json()).elements || [];
          break;
        } catch (err) {
          this.log.warn?.(`Overpass lookup failed (${kind.id}, ${new URL(url).host}): ${err.message}`);
        }
      }
      if (!els) return null;
      const value = els
        .map((e) => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, tags: e.tags || {} }))
        .filter((e) => e.lat && !(kind.id === 'parking' && /private|customers/.test(e.tags.access || '')))
        .map((e) => ({
          name: e.tags.name || e.tags.brand || e.tags.operator || kind.label.replace(/s( &.*)?$/, ''),
          brand: e.tags.brand || null,
          lat: e.lat, lng: e.lng,
          distM: distanceM(here, e),
          hours: e.tags.opening_hours || null,
          fee: e.tags.fee || null,
        }))
        .sort((a, b) => a.distM - b.distM)
        .slice(0, limit);
      if (value.length || radius !== kind.radius) {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      }
    }
    return [];
  }
}
