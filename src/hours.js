import { DAYS, toMinutes } from './time.js';

// Opening hours format (places.json):
//   { "mon-sat": "11:00-19:00", "sun": "12:00-18:00" }
//   { "daily": "24h" }   { "fri": "23:00-06:00" }  (past-midnight ranges are fine)
//   { "sun-mon": "10:00-17:30" }  (day ranges can wrap around the week)
//   "12:00-15:00,17:30-23:00" for split shifts. "closed" for closed days.
// Missing day = closed.

function expandDays(key) {
  if (key === 'daily') return [...DAYS];
  if (key === 'weekdays') return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (key === 'weekend') return ['sat', 'sun'];
  const [a, b] = key.split('-');
  const i = DAYS.indexOf(a);
  if (i < 0) throw new Error(`Bad day key "${key}"`);
  if (!b) return [a];
  const j = DAYS.indexOf(b);
  if (j < 0) throw new Error(`Bad day key "${key}"`);
  const out = [];
  for (let k = i; ; k = (k + 1) % 7) {
    out.push(DAYS[k]);
    if (k === j) break;
  }
  return out;
}

function parseRanges(value) {
  if (!value || value === 'closed') return [];
  if (value === '24h') return [[0, 1440]];
  return value.split(',').map((r) => {
    const [s, e] = r.trim().split('-');
    const start = toMinutes(s);
    let end = e === '24:00' ? 1440 : toMinutes(e);
    if (end <= start) end += 1440; // past midnight
    return [start, end];
  });
}

// -> { mon: [[start,end],...], ... } with more specific keys winning over "daily".
export function parseHours(hours) {
  const table = Object.fromEntries(DAYS.map((d) => [d, null]));
  const keys = Object.keys(hours || {}).sort((a, b) => expandDays(b).length - expandDays(a).length);
  for (const key of keys) {
    for (const day of expandDays(key)) table[day] = parseRanges(hours[key]);
  }
  for (const d of DAYS) table[d] ||= [];
  return table;
}

// Is the place open at London weekday+minutes? Returns minutes until close (or null if closed).
export function minutesUntilClose(hours, weekday, minutes) {
  const table = parseHours(hours);
  let best = null;
  for (const [s, e] of table[weekday]) {
    if (minutes >= s && minutes < e) best = Math.max(best ?? 0, e - minutes);
  }
  const prev = DAYS[(DAYS.indexOf(weekday) + 6) % 7];
  for (const [, e] of table[prev]) {
    if (e > 1440 && minutes < e - 1440) best = Math.max(best ?? 0, e - 1440 - minutes);
  }
  // 24h places: treat as always open for a long time.
  if (best !== null && table[weekday].some(([s, e]) => s === 0 && e === 1440)) best = Math.max(best, 600);
  return best;
}

export function describeHours(hours, weekday) {
  const table = parseHours(hours);
  const r = table[weekday];
  if (!r.length) return 'closed today';
  const f = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return r.map(([s, e]) => (s === 0 && e === 1440 ? 'open 24h' : `${f(s)}–${f(e)}`)).join(', ');
}
