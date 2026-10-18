import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseHours } from './hours.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Each trip lives in trips/<name>/ (itinerary.json, places.json, neighborhoods.json, sim-route.json).
// Pick one with TRIP=ireland (default: london).
export const TRIP = process.env.TRIP || 'london';
export const DATA_DIR = path.join(here, '..', 'trips', TRIP);

function readJson(file) {
  const full = path.join(DATA_DIR, file);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read trips/${TRIP}/${file}: ${err.message}`);
  }
}

export function loadData() {
  const itinerary = readJson('itinerary.json');
  const places = readJson('places.json');
  const neighborhoods = readJson('neighborhoods.json');
  const plans = itinerary.plans
    .map((p) => ({
      ...p,
      start: new Date(p.start),
      end: new Date(p.end),
      arriveBy: p.arriveBy ? new Date(p.arriveBy) : null,
      immovable: p.immovable ?? ['flight', 'ferry'].includes(p.type),
    }))
    .sort((a, b) => a.start - b.start);
  const trip = {
    transport: 'tfl',
    wakeWord: 'Cench',
    ...itinerary.trip,
  };
  return { itinerary, trip, days: itinerary.days, plans, places, neighborhoods };
}

// Returns a list of problems (empty = all good). Used by `npm run check-data` and tests.
export function validateData(data) {
  const problems = [];
  const ids = new Set();
  const areaIds = new Set(data.neighborhoods.map((n) => n.id));
  for (const p of data.places) {
    if (ids.has(p.id)) problems.push(`Duplicate place id: ${p.id}`);
    ids.add(p.id);
    for (const f of ['name', 'category', 'lat', 'lng', 'why']) if (p[f] === undefined) problems.push(`${p.id}: missing ${f}`);
    if (p.neighborhood && !areaIds.has(p.neighborhood)) problems.push(`${p.id}: unknown neighborhood "${p.neighborhood}"`);
    try { parseHours(p.hours); } catch (err) { problems.push(`${p.id}: bad hours (${err.message})`); }
  }
  for (const plan of data.plans) {
    if (Number.isNaN(plan.start.getTime())) problems.push(`${plan.id}: bad start time`);
    if (Number.isNaN(plan.end.getTime())) problems.push(`${plan.id}: bad end time`);
    if (!plan.location?.lat) problems.push(`${plan.id}: missing location lat/lng`);
  }
  const fixed = data.plans.filter((p) => p.fixed);
  for (let i = 1; i < fixed.length; i++) {
    if (fixed[i].start < fixed[i - 1].end) problems.push(`Fixed plans overlap: ${fixed[i - 1].id} and ${fixed[i].id}`);
  }
  return problems;
}
