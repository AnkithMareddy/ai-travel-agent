import { distanceM } from './geo.js';
import { minutesUntilClose } from './hours.js';
import { londonParts, addMin } from './time.js';

// How much this group cares about each category (0–1).
const INTEREST = {
  streetwear: 1, sneakers: 0.95, fashion: 0.85, vintage: 0.8, music: 0.8, sports: 0.8,
  food: 0.6, market: 0.7, filming: 0.6, movies: 0.5, sights: 0.65, sportsbar: 0.5, venue: 0.3,
  nature: 0.85, pub: 0.7, history: 0.65, drive: 0.7, shopping: 0.85,
};

// Words people might text -> categories/tags.
export const REQUEST_CATEGORIES = [
  [/sports? ?bar|watch (the )?(game|match)|nfl|nba/, ['sportsbar']],
  [/food|eat|hungry|lunch|dinner|breakfast|brunch|snack|restaurant|bite/, ['food', 'market']],
  [/sneaker|kicks|trainers|shoes/, ['sneakers']],
  [/streetwear|clothes|clothing|fashion|shop|shopping|drip|fit|sweater|jersey/, ['streetwear', 'fashion', 'sneakers', 'shopping']],
  [/vintage|thrift|second ?hand/, ['vintage']],
  [/record|vinyl|music|jazz|gig|concert/, ['music', 'venue']],
  [/bar|drink|pub|beer|pint|guinness|trad/, ['bar', 'sportsbar', 'pub']],
  [/hike|walk|view|waterfall|cliff|beach|nature|scenic/, ['nature', 'drive']],
  [/castle|history|abbey|museum|ruin/, ['history', 'sights']],
  [/movie|cinema|film|imax/, ['movies', 'filming']],
  [/stadium|football|soccer|sport/, ['sports', 'sportsbar']],
  [/sight|see|landmark|tourist|photo|view|museum/, ['sights', 'filming']],
  [/late|night|open now/, ['latenight']],
];

export function categoriesFor(text) {
  const t = text.toLowerCase();
  for (const [re, cats] of REQUEST_CATEGORIES) if (re.test(t)) return cats;
  return null;
}

const matches = (place, cats) => !cats || cats.includes(place.category) || (place.tags || []).some((t) => cats.includes(t));

// Rough minutes between two points (fast, no API): walking under ~1.5 km, else Tube-ish (or driving on a road trip).
export function quickMinutes(a, b, drive = false) {
  const km = (distanceM(a, b) * 1.3) / 1000;
  if (drive && km >= 1.2) return Math.round((5 + (km / 62) * 60) * 1.15 + 3);
  if (km < 1.5) return Math.round((km * 1000) / 80);
  return Math.round(12 + Math.min(km, 8) * 2.3 + Math.max(0, km - 8) * 1.2); // long hops are mostly fast rail
}

/**
 * Rank places for right now.
 * opts: { places, here, now, gapMin, nextStop, categories, exclude:Set, dayAreas:[], mealTime }
 */
export function rankPlaces(opts) {
  const { places, here, now, gapMin = 180, nextStop = null, categories = null, exclude = new Set(), dayAreas = [], drive = false } = opts;
  const qm = (a, b) => quickMinutes(a, b, drive);
  const p = londonParts(now);
  const meal = (p.minutes >= 690 && p.minutes <= 870) || (p.minutes >= 1080 && p.minutes <= 1290);
  const out = [];
  for (const place of places) {
    if (place.passive || exclude.has(place.id) || !matches(place, categories)) continue;
    const travelTo = qm(here, place);
    const arrive = londonParts(addMin(now, travelTo));
    const left = minutesUntilClose(place.hours, arrive.weekday, arrive.minutes);
    const visit = place.visitMin || 45;
    if (left === null || left < Math.min(visit, 30)) continue;
    const onward = nextStop ? qm(place, nextStop) : 0;
    if (travelTo + Math.min(visit, 30) + onward > gapMin) continue;
    const direct = nextStop ? qm(here, nextStop) : 0;
    // With lots of time, don't drag them toward the evening plan yet; with little time, stay on the way.
    const detour = nextStop && gapMin < 180 ? Math.max(0, travelTo + onward - direct) : travelTo;
    let score = (INTEREST[place.category] ?? 0.5) * 10;
    if (place.category === 'food' || (place.tags || []).includes('food')) score += meal ? 3 : -1;
    if (dayAreas.includes(place.neighborhood)) score += 2;
    if (place.wishlist) score += 5; // someone in the group asked for it
    score -= travelTo * 0.2 + detour * 0.12;
    out.push({ place, travelTo, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Pick up to n, avoiding 3 of the same category (spread the ideas).
export function pickVaried(ranked, n = 3) {
  const out = [];
  const perCat = {};
  for (const r of ranked) {
    const c = r.place.category;
    if ((perCat[c] || 0) >= 2) continue;
    perCat[c] = (perCat[c] || 0) + 1;
    out.push(r);
    if (out.length === n) break;
  }
  return out;
}
