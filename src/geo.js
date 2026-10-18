const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A trip's region: { name, bbox: [west, south, east, north] }. Location tips only fire inside it.
export const LONDON = { name: 'London', bbox: [-0.51, 51.28, 0.33, 51.69] };
export function inRegion(region, p) {
  const [w, s, e, n] = (region || LONDON).bbox;
  return p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n;
}
export const inLondon = (p) => inRegion(LONDON, p);

// Neighborhood whose centre is closest relative to its radius.
export function areaAt(neighborhoods, p) {
  let best = null;
  let bestScore = Infinity;
  for (const n of neighborhoods) {
    const score = distanceM(n, p) / n.radius;
    if (score <= 1 && score < bestScore) { best = n; bestScore = score; }
  }
  return best;
}

export function walkMinutes(a, b) {
  return Math.max(1, Math.round((distanceM(a, b) * 1.3) / 80)); // 80 m/min, 1.3 street factor
}
