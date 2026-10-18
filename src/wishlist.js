import { areaAt, inRegion, LONDON } from './geo.js';

export const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set(['the', 'a', 'an', 'in', 'at', 'london', 'place', 'spot', 'shop', 'store', 'thing', 'that', 'to', 'see', 'go', 'visit']);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

// Is this wish one of the places we already know? (e.g. "supreme", "arsenal stadium tour")
export function matchKnownPlace(rawText, places) {
  const text = String(rawText).split(',')[0]; // "Name, street, town" -> match on the name
  const q = norm(text);
  const qWords = words(text);
  let best = null;
  let bestScore = 0;
  for (const p of places) {
    const n = norm(p.name);
    let score = 0;
    if (n === q) score = 100;
    else if (q.length >= 4 && (n.includes(q) || q.includes(n))) score = 80;
    else {
      const pWords = words(p.name);
      const hits = qWords.filter((w) => pWords.includes(w)).length;
      if (hits && hits >= Math.min(2, qWords.length)) score = 50 + hits;
    }
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

// OpenStreetMap category -> our category + rough opening hours.
function categorize(osm, text) {
  const t = `${osm.category}:${osm.type}`;
  const hint = norm(text);
  if (/shoes|sneaker|trainer/.test(hint) || t === 'shop:shoes') return ['sneakers', { 'mon-sat': '10:00-19:00', sun: '12:00-18:00' }];
  if (/vintage|thrift/.test(hint) || t === 'shop:second_hand') return ['vintage', { 'mon-sat': '10:00-19:00', sun: '12:00-18:00' }];
  if (t.startsWith('shop:clothes') || t.startsWith('shop:boutique') || t.startsWith('shop:fashion')) return ['fashion', { 'mon-sat': '10:00-19:00', sun: '12:00-18:00' }];
  if (t === 'shop:music') return ['music', { 'mon-sat': '10:00-19:00', sun: '12:00-18:00' }];
  if (/^amenity:(pub|bar|nightclub)/.test(t)) return ['food', { daily: '12:00-23:00' }];
  if (/^amenity:(restaurant|cafe|fast_food|food_court)/.test(t)) return ['food', { daily: '11:30-22:00' }];
  if (t === 'amenity:cinema') return ['movies', { daily: '11:00-23:00' }];
  if (/stadium|sports|pitch/.test(t) || /stadium|football|arena/.test(hint)) return ['sports', { daily: '09:30-17:00' }];
  if (t.startsWith('shop:')) return ['fashion', { 'mon-sat': '10:00-19:00', sun: '12:00-18:00' }];
  if (/^(tourism|historic|leisure|place|highway|bridge|building)/.test(t)) return ['sights', { daily: '09:00-20:00' }];
  return ['sights', { daily: '10:00-18:00' }];
}

// Free geocoding via OpenStreetMap Nominatim, limited to Greater London.
// Nominatim asks for at most ~1 request/second.
let lastGeocode = 0;
async function politePause() {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();
}

export async function geocode(query, fetchImpl = globalThis.fetch, region = LONDON) {
  await politePause();
  const [w, s, e, n] = region.bbox;
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '1', countrycodes: 'gb,ie', viewbox: `${w},${n},${e},${s}`, bounded: '1',
  });
  const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'user-agent': 'london-trip-bot/1.0 (personal trip assistant)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  return hit || null;
}

/**
 * Turn "I want to see the arsenal museum" into a place we can route to.
 * Returns { place, known } where known=true means it matched places.json, or { place: null } for a plain note.
 */
export async function resolveWish(text, { places, neighborhoods, canonicalize, fetchImpl, offline = false, log = console, region = LONDON }) {
  const known = matchKnownPlace(text, places);
  if (known) return { place: known, known: true };
  if (offline) return { place: null };

  // "Name, street, town": try it whole, then "Name, town", then "Name town".
  const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
  const tries = parts.length > 1 ? [...new Set([text, `${parts[0]}, ${parts.at(-1)}`, `${parts[0]} ${parts.at(-1)}`])] : [text];
  try {
    // "Name, street, town" is already specific; only ask Claude to clean up vague wishes.
    const better = canonicalize && !text.includes(',') ? await canonicalize(text) : null;
    if (better && norm(better) !== norm(text)) {
      const k = matchKnownPlace(better, places);
      if (k) return { place: k, known: true };
      tries.unshift(better);
    }
  } catch (err) {
    log.warn?.(`canonicalize failed: ${err.message}`);
  }

  for (const q of tries) {
    try {
      const hit = await geocode(q, fetchImpl, region);
      if (!hit) continue;
      const pt = { lat: Number(hit.lat), lng: Number(hit.lon) };
      if (!inRegion(region, pt)) continue;
      const [category, hours] = categorize(hit, text);
      const name = hit.name || q;
      return {
        known: false,
        place: {
          name,
          category,
          neighborhood: areaAt(neighborhoods, pt)?.id || null,
          address: hit.display_name.split(', ').slice(0, 4).join(', '),
          ...pt,
          hours,
          visitMin: 45,
          verified: 'wishlist (hours are a rough guess)',
        },
      };
    } catch (err) {
      log.warn?.(`geocode failed for "${q}": ${err.message}`);
    }
  }
  return { place: null };
}

// ---------- Google Maps links -> a place (name + coordinates), no API key needed

export const MAPS_LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\S*/i;

export function parseMapsUrl(url) {
  let dec = url;
  try { dec = decodeURIComponent(url); } catch { /* keep raw */ }
  let name = (dec.match(/\/maps\/place\/([^/@?]+)/) || [])[1]?.replace(/\+/g, ' ') || null;
  const m = dec.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || dec.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || dec.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (!name) {
    const q = dec.match(/[?&](?:q|query)=([^&]+)/);
    if (q && !/^-?\d/.test(q[1])) name = q[1].replace(/\+/g, ' ');
  }
  return {
    name: name ? name.split(',')[0].trim() : null,
    fullName: name,
    lat: m ? Number(m[1]) : null,
    lng: m ? Number(m[2]) : null,
    isList: /placelists|\/lists\/|!11m/.test(dec),
    url,
  };
}

export async function resolveMapsLink(url, fetchImpl = globalThis.fetch) {
  let u = url;
  for (let i = 0; i < 6; i++) {
    const parsed = parseMapsUrl(u);
    if (parsed.lat !== null && parsed.name) return parsed;
    const res = await fetchImpl(u, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u).toString(); continue; }
    break;
  }
  return parseMapsUrl(u);
}

// Rough category from a place name (used for pasted Google Maps links).
export function guessCategory(name = '') {
  const n = norm(name);
  if (/\b(pub|bar|tavern|inn|brewery|brewing|taphouse)\b/.test(n)) return ['pub', { 'mon-thu': '10:30-23:30', 'fri-sat': '10:30-00:30', sun: '12:30-23:00' }];
  if (/\b(restaurant|cafe|coffee|kitchen|pizza|burger|chipper|chips|grill|bakery|takeaway|diner|bbq|ramen|curry|chinese)\b/.test(n)) return ['food', { daily: '12:00-22:00' }];
  if (/\b(store|shop|boutique|vintage|market|outlet|clothing)\b/.test(n)) return ['shopping', { 'mon-sat': '10:00-18:00', sun: '12:00-18:00' }];
  if (/\b(stadium|park|fc|football|arena)\b/.test(n)) return ['sports', { daily: '10:00-17:00' }];
  return ['sights', { daily: '10:00-18:00' }];
}
