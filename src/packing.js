// "What to pack today", built from the day's stops, the forecast at each stop, bookings and base changes.
// Deterministic (no Claude), so /pack is free and the morning brief gets solid facts to work from.

const has = (text, re) => re.test(text.toLowerCase());

const RULES = [
  { re: /\b(cliffs?|slieve|slea head|downpatrick|causeway|carrick-a-rede|dunquin|slea|sky road|atlantic drive|diamond hill|hike|trail|national park|gleniff|benbulben|waterfall|strand|beach)\b/,
    item: 'Shoes with grip you don\'t mind getting muddy (cliff paths and beaches are wet in October)' },
  { re: /\b(carrick-a-rede)\b/, item: 'Rope bridge ticket on your phone (timed slot)' },
  { re: /\b(chelsea|stamford bridge|stadium|match|vs)\b/, item: 'Match tickets on your phone (charged!). Stadiums only allow small bags, roughly A4 size or smaller' },
  { re: /\b(guinness|jameson|distillery|storehouse|pub crawl)\b/, item: 'Physical ID for tastings and bars (a passport or US licence)' },
  { re: /\b(ferry)\b/, item: 'A card for the ferry ticket (bought on board)' },
  { re: /\b(derry|causeway|dunluce|belfast|dark hedges|mussenden|bushmills)\b/, item: '£ for Northern Ireland: cards work, but have a little cash for car parks and small shops' },
  { re: /\b(flight|airport|bhd|heathrow|lhr|dub)\b/, item: 'Passport, boarding pass and a charged phone' },
  { re: /\b(shopping|grafton|shop st|oxford st|carnaby|arcade|victoria square|market)\b/, item: 'A foldable tote bag for shopping, plus room left in your bag' },
  { re: /\b(dinner|restaurant|kutir)\b/, item: 'Something a bit smarter than hiking gear for dinner' },
];

/**
 * @param day     itinerary day ({ label, flow, transport, driveHours, base, ... })
 * @param stops   [{ title, place, time, weather: {tempC, feelsC, rainPct, rainMm, gustKmh, sky} | null }]
 * @param extra   { prevBase, bookings: [{ title, confirmation }], dayWeather }
 * Returns [{ item, why }] (short, most important first).
 */
export function packingList(day = {}, stops = [], { prevBase = null, bookings = [], dayWeather = null } = {}) {
  const out = [];
  const add = (item, why = '') => { if (!out.some((o) => o.item === item)) out.push({ item, why }); };
  const text = [day.label, day.flow, ...stops.map((s) => `${s.title} ${s.place || ''}`)].filter(Boolean).join(' ');

  // Checking out of last night's base?
  if (prevBase && day.base && prevBase.name !== day.base.name) {
    add(`Pack everything: you're checking out of ${prevBase.name}`, `tonight is ${day.base.name}`);
  }

  // Weather across the day's stops (fall back to the day's summary forecast).
  const ws = stops.map((s) => s.weather && { ...s.weather, where: s.place || s.title, time: s.time }).filter(Boolean);
  const wettest = ws.reduce((m, w) => (!m || w.rainPct > m.rainPct ? w : m), null);
  const windiest = ws.reduce((m, w) => (!m || w.gustKmh > m.gustKmh ? w : m), null);
  const coldest = ws.reduce((m, w) => (!m || w.feelsC < m.feelsC ? w : m), null);
  const rainPct = wettest?.rainPct ?? dayWeather?.rainChancePct ?? 0;
  const gust = windiest?.gustKmh ?? dayWeather?.windKmh ?? 0;
  const feels = coldest?.feelsC ?? dayWeather?.lowC ?? 12;

  if (rainPct >= 40) {
    const where = wettest ? ` (${wettest.rainPct}% at ${wettest.where} around ${wettest.time})` : ` (${rainPct}% chance)`;
    add(gust >= 35 ? 'Rain jacket with a hood. Too windy for an umbrella' : 'Rain jacket or a compact umbrella', `rain likely${where}`);
  }
  if (gust >= 40) add('Windproof layer, and a beanie or cap that won\'t blow off', `gusts up to ${gust} km/h${windiest ? ` at ${windiest.where}` : ''}`);
  if (feels <= 8) add('Warm layer: a hoodie or fleece under your jacket, and a beanie', `feels like ${feels}°C${coldest ? ` at ${coldest.where} (${coldest.time})` : ''}`);
  else if (feels <= 12) add('An extra layer for the evening', `feels like ${feels}°C at the coldest`);
  if (ws.filter((w) => /clear/.test(w.sky) && w.rainPct < 30).length >= Math.max(1, ws.length / 3) || (!ws.length && /clear/.test(dayWeather?.sky || ''))) add('Sunglasses', 'sunny spells forecast');

  for (const r of RULES) if (has(text, r.re)) add(r.item);

  if (day.transport === 'car' || day.driveHours) {
    add('Car phone charger/cable and a power bank', day.driveHours ? `~${day.driveHours}h of driving` : 'driving day');
    if (day.driveHours >= 4) add('Snacks and water for the car');
  } else if (stops.length >= 5) {
    add('Power bank', 'long day of maps and photos');
  }
  if (/\b(pick up|pickup|collect) (the )?(rental )?car\b|car pickup|rental car/i.test(text)) add("Driver's licence, the credit card used to book, and the rental confirmation");

  for (const b of bookings) add(`${b.title}: booking${b.confirmation ? ` ref ${b.confirmation}` : ''} ready on your phone`);
  return out.slice(0, 10);
}
