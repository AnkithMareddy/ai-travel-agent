// Road-trip behaviour, using the Ireland trip data (TRIP=ireland).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRIP = 'ireland';
const { loadData, validateData } = await import('../src/data.js');
const { Store } = await import('../src/store.js');
const { ManualClock, localToDate, londonParts } = await import('../src/time.js');
const { Transit } = await import('../src/transit.js');
const { Weather } = await import('../src/weather.js');
const { Writer } = await import('../src/writer.js');
const { Engine } = await import('../src/engine.js');

const OWNER = 1;
const silent = { info() {}, warn() {}, error() {} };

function setup(start) {
  const sent = [];
  const clock = new ManualClock(start);
  const data = loadData();
  const engine = new Engine({
    data, store: new Store(null), clock,
    transport: { async send(chatId, html) { sent.push({ chatId, html, at: clock.now() }); } },
    writer: new Writer({ offline: true, log: silent, trip: data.trip }),
    transit: new Transit({ offline: true, log: silent, transport: data.trip.transport, region: data.trip.region }),
    weather: new Weather({ offline: true, log: silent }),
    log: silent,
  });
  engine.s.ownerChatId = OWNER; engine.s.ownerUserId = OWNER;
  const at = (loc) => { engine.track(OWNER).location = { ...loc, at: clock.now().toISOString() }; };
  const msg = (text) => engine.handleUpdate({ update_id: 1, message: { chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Me' }, date: 0, text } });
  const run = async (minutes, loc) => { for (let i = 0; i < minutes; i++) { if (loc) at(loc); await engine.tick(); clock.advance(1); } };
  return { engine, sent, clock, at, msg, run };
}

test('Ireland data is valid and Oct 2 is a Friday', () => {
  assert.deepEqual(validateData(loadData()), []);
  assert.equal(londonParts(localToDate('2026-10-02', '12:00')).weekday, 'fri');
});

test('base follows the itinerary night by night (switches at noon)', () => {
  const { engine } = setup(localToDate('2026-10-05', '09:00'));
  assert.match(engine.homeFor(localToDate('2026-10-05', '09:00')).name, /Kerry/);
  assert.match(engine.homeFor(localToDate('2026-10-05', '15:00')).name, /Geata/);
  assert.match(engine.homeFor(localToDate('2026-10-07', '20:00')).name, /Kilcar/);
});

test('stop nudge: when time is up it says what is next, the drive, and if behind', async () => {
  const { sent, run } = setup(localToDate('2026-10-05', '11:30'));
  // Arrive late at Dingle town and linger past the planned end.
  await run(90, { lat: 52.1409, lng: -10.2671 });
  const nudge = sent.find((m) => /Time to move on from Dingle town/.test(m.html));
  assert.ok(nudge, 'nudged to leave Dingle');
  assert.match(nudge.html, /Slea Head/);
  assert.match(nudge.html, /driving/, 'driving directions link');
  assert.doesNotMatch(nudge.html, /citymapper/i);
});

test('running 45 min late on the big day: the ferry will not wait, and Plan B is offered', async () => {
  const { sent, at, msg } = setup(localToDate('2026-10-05', '10:05'));
  at({ lat: 51.8685, lng: -10.3855 });
  await msg("we're running late 45 min");
  assert.match(sent.at(-1).html, /won't wait/);
  assert.match(sent.at(-1).html, /17:30/, 'next sailing mentioned');
  assert.match(sent.at(-1).html, /Plan B/);
});

test('no free-time detours on a drive day while stops remain', async () => {
  const { sent, run } = setup(localToDate('2026-10-07', '10:45'));
  await run(150, { lat: 54.0, lng: -9.2 }); // somewhere on the road to Strandhill
  assert.ok(!sent.some((m) => /min free/.test(m.html)));
});

test('Ireland bot answers to "Ed" in the group, not "Cench"', async () => {
  const { engine, sent } = setup(localToDate('2026-09-28', '12:00'));
  engine.s.groups['-700'] = { title: 'Ireland', approved: true };
  const g = (text) => engine.handleUpdate({ update_id: 1, message: { chat: { id: -700, type: 'group' }, from: { id: 5, first_name: 'Alex' }, date: 0, text } });
  await g("Cench what's on the wishlist?");
  assert.equal(sent.length, 0);
  await g("Ed what's on the wishlist?");
  assert.match(sent.at(-1).html, /Wishlist is empty/);
  await g('edward is late lol');
  assert.equal(sent.length, 1, '"edward" is not the wake word');
});

test('en route: after "leave now", a slow drive that misses the ferry gets one warning with the next sailing', async () => {
  const { engine, sent, clock, run } = setup(localToDate('2026-10-05', '15:00'));
  engine.track(OWNER).keys['leavenow:ferry'] = clock.now().toISOString(); // already told to leave
  const dingle = { lat: 52.1409, lng: -10.2671 };
  await run(15, dingle); // still in Dingle: no way to make the 16:30
  let warns = sent.filter((m) => /At this pace you'll reach/.test(m.html));
  assert.equal(warns.length, 1);
  await run(60, dingle); // an hour later it's much worse: one more warning, then quiet
  warns = sent.filter((m) => /At this pace you'll reach/.test(m.html));
  assert.equal(warns.length, 2);
  assert.match(warns[0].html, /Tarbert → Killimer ferry/);
  assert.match(warns[0].html, /Next sailing is 17:30/);
});

test('stays: arrival card with the booking details, then a check-out nudge on the last morning', async () => {
  const { engine, sent, clock, run } = setup(localToDate('2026-10-07', '18:00'));
  const kilcar = { lat: 54.6305, lng: -8.5901 };
  engine.s.bookings.push({ n: 1, kind: 'stay', title: 'Kilcar Airbnb', date: '2026-10-07', start: '16:00', endDate: '2026-10-08', end: '10:30', confirmation: 'HMX42', details: 'Key box by the door, code 1234', location: { name: 'Teach Kilcar', ...kilcar } });
  await run(3, kilcar);
  const card = sent.find((m) => /Kilcar Airbnb<\/b>: you're here/.test(m.html));
  assert.ok(card);
  assert.match(card.html, /HMX42[\s\S]*code 1234[\s\S]*Check-out Thu 8 Oct by <b>10:30<\/b>/);
  clock.setNow?.(localToDate('2026-10-08', '09:10'));
  if (!clock.setNow) clock.advance((localToDate('2026-10-08', '09:10') - clock.now()) / 60000);
  await run(10, kilcar);
  assert.equal(sent.filter((m) => /Check-out from <b>Kilcar Airbnb<\/b> by <b>10:30<\/b>/.test(m.html)).length, 1);
  assert.equal(sent.filter((m) => /you're here/.test(m.html)).length, 1, 'arrival card only once');
});

test('sunset ping: once, ~80 min before, with the chosen viewpoint linked', async () => {
  const { engine, sent, run } = setup(localToDate('2026-10-05', '17:30'));
  engine.essentials = { viewpoints: async () => [{ id: 'vp1', name: "Hag's Head", kind: 'cape', lat: 52.95, lng: -9.47, distM: 4200 }] };
  let facts;
  engine.writer.write = async (kind, f) => { if (kind === 'sun_ping') { facts = f; return 'Sunset 19:08: go to {{vp1}} for it.'; } return 'ok'; };
  await run(60, { lat: 52.9715, lng: -9.4309 }); // at the Cliffs of Moher
  const pings = sent.filter((m) => /Sunset 19:0\d: go to/.test(m.html));
  assert.equal(pings.length, 1);
  assert.match(pings[0].html, /<b>Hag's Head<\/b>[\s\S]*📍 Hag's Head: <a href/);
  assert.equal(facts.sunDirection.split(' ')[0], 'W');
  assert.ok(facts.time >= '19:00' && facts.time <= '19:12', facts.time);
});

test('nightly recap: km from the live location, stops visited and spend go into the wrap-up and the journal', async () => {
  const { engine, sent, msg, clock } = setup(localToDate('2026-10-06', '12:00'));
  let facts;
  engine.writer.write = async (kind, f) => { if (kind === 'night_wrap') { facts = f; return '📓 Today: Galway → Westport.\n\nTomorrow: Achill.'; } return 'ok'; };
  for (const pt of [{ lat: 53.2728, lng: -9.0526 }, { lat: 53.5037, lng: -10.0682 }, { lat: 53.8003, lng: -9.5186 }]) {
    await engine.handleUpdate({ update_id: 1, edited_message: { chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Me' }, date: 0, location: { latitude: pt.lat, longitude: pt.lng, live_period: 28800 } } });
  }
  await msg('Ed I paid 40 for petrol');
  engine.track(OWNER).keys['at:d6-kylemore'] = localToDate('2026-10-06', '13:30').toISOString();
  clock.advance(10 * 60);
  for (let i = 0; i < 30; i++) { await engine.tick(); clock.advance(1); }
  assert.ok(facts, 'night wrap sent');
  assert.ok(facts.todayRecap.kmCovered >= 100, `km ${facts.todayRecap.kmCovered}`);
  assert.match(facts.todayRecap.stopsVisited.join(), /Kylemore/);
  assert.equal(facts.todayRecap.spent, '€40');
  assert.match(engine.s.journal['2026-10-06'], /Galway → Westport/);
  await msg('/journal');
  assert.match(sent.at(-1).html, /Trip journal[\s\S]*Tue 6 Oct[\s\S]*Galway → Westport/);
});

test('on the road: answers get where they are and the ETAs to the next stop and base', async () => {
  const { engine, msg, at } = setup(localToDate('2026-10-05', '14:40'));
  Object.defineProperty(engine.writer, 'usingClaude', { value: true });
  let facts;
  engine.writer.answerWithTools = async (f) => { facts = f; return 'Try Listowel.'; };
  at({ lat: 52.25, lng: -9.7 }); // between Dingle and Tarbert
  await msg('where can we eat on the way?');
  assert.ok(facts.onTheRoad.nextStop.eta, JSON.stringify(facts.onTheRoad));
  assert.match(facts.onTheRoad.nextStop.title, /ferry/i);
  assert.match(facts.onTheRoad.tonightsBase.name, /Geata/);
});
