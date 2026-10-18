// Screenshots → bookings/places, day changes from the chat, live weather alerts and the packing list (Ireland data).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRIP = 'ireland';
const { loadData } = await import('../src/data.js');
const { Store } = await import('../src/store.js');
const { ManualClock, localToDate } = await import('../src/time.js');
const { Transit } = await import('../src/transit.js');
const { Weather } = await import('../src/weather.js');
const { Writer } = await import('../src/writer.js');
const { Engine } = await import('../src/engine.js');
const { packingList } = await import('../src/packing.js');

const OWNER = 1;
const GROUP = -100;
const silent = { info() {}, warn() {}, error() {} };

// A forecast where every hour is the same, except the overrides for given "HH" hours.
function fakeHours(date, base, overrides = {}) {
  return {
    hours: Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, '0');
      return { at: `${date}T${hh}:00`, tempC: 13, feelsC: 11, rainPct: 10, rainMm: 0, code: 2, sky: 'partly cloudy', gustKmh: 25, ...base, ...(overrides[hh] || {}) };
    }),
  };
}

function setup(start, { claude } = {}) {
  const sent = [];
  const clock = new ManualClock(start);
  const data = loadData();
  const writer = new Writer({ offline: true, log: silent, trip: data.trip });
  const calls = [];
  if (claude) {
    Object.defineProperty(writer, 'usingClaude', { value: true });
    writer.answerWithTools = async (facts, history, tools, run, opts = {}) => {
      calls.push({ facts, opts });
      return claude(run, facts, opts);
    };
  }
  const weather = new Weather({ offline: true, log: silent });
  const engine = new Engine({
    data, store: new Store(null), clock, writer, weather, log: silent,
    transport: {
      async send(chatId, html) { sent.push({ chatId, html, at: clock.now() }); },
      async download() { return { base64: 'aGVsbG8=', size: 5 }; },
    },
    transit: new Transit({ offline: true, log: silent, transport: data.trip.transport, region: data.trip.region }),
  });
  engine.offlineWishes = true;
  engine.s.ownerChatId = OWNER; engine.s.ownerUserId = OWNER;
  engine.s.groups[GROUP] = { title: 'Ireland', approved: true };
  const photo = (chatId, { w = 1179, h = 2556, caption, album } = {}) => engine.handleUpdate({
    update_id: 1,
    message: { chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' }, from: { id: 2, first_name: 'Alex' }, date: 0, caption, photo: [{ file_id: 'small', width: w / 4, height: h / 4 }, { file_id: 'big', width: w, height: h, file_size: 200_000 }] },
    ...(album ? { album } : {}),
  });
  const say = (chatId, text) => engine.handleUpdate({ update_id: 2, message: { chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' }, from: { id: 2, first_name: 'Alex' }, date: 0, text } });
  return { engine, sent, clock, calls, photo, say, weather, data };
}

test('group: holiday photos are ignored for free; tall screenshots and captioned photos are read', async () => {
  const t = setup(localToDate('2026-10-03', '10:00'), { claude: async () => 'SKIP' });
  await t.photo(GROUP, { w: 4032, h: 3024 });
  assert.equal(t.calls.length, 0, 'a normal photo does not call Claude');
  assert.match(t.engine.s.chatLog[GROUP].at(-1).text, /shared a screenshot/, 'still noted in the group memory');

  await t.photo(GROUP); // phone screenshot shape
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].opts.attachments[0].type, 'image');
  assert.equal(t.sent.length, 0, 'nothing trip-related in a guessed screenshot: stays quiet');

  await t.photo(GROUP, { w: 4032, h: 3024, caption: 'Ed what is this place' });
  assert.equal(t.calls.length, 2, 'wake word in the caption: read it');
  assert.match(t.sent.at(-1).html, /Nothing trip-related/, 'asked directly, so it answers');
});

test('screenshot of a hotel booking becomes that night\'s base', async () => {
  const t = setup(localToDate('2026-10-01', '10:00'), {
    claude: async (run) => {
      await run('save_booking', { kind: 'stay', title: 'Kilcar Airbnb', place: 'Teach Kilcar, Main St, Kilcar', date: '2026-10-07', end_date: '2026-10-08', start: '16:00', confirmation: 'HMX42', details: '3 guests, key box 1234' });
      return 'Kilcar stay saved: check-in from 16:00.';
    },
  });
  t.data.places.push({ id: 'teach-kilcar', name: 'Teach Kilcar', category: 'stay', lat: 54.6305, lng: -8.5901, why: 'test', hours: { daily: '00:00-24:00' } });
  await t.photo(OWNER);
  const reply = t.sent.at(-1).html;
  assert.match(reply, /Saved booking #1/);
  assert.match(reply, /HMX42/);
  assert.match(reply, /base for Wed 7 Oct/);
  assert.equal(t.engine.data.days['2026-10-07'].base.name, 'Teach Kilcar');
  assert.equal(t.engine.homeFor(localToDate('2026-10-07', '20:00')).name, 'Teach Kilcar');
  assert.equal(t.engine.data.days['2026-10-08'].base.name, t.data.days['2026-10-08'].base.name, 'check-out night unchanged');
  await t.say(OWNER, '/bookings');
  assert.match(t.sent.at(-1).html, /Kilcar Airbnb[\s\S]*key box 1234/);
  // Removing it puts the itinerary base back.
  await t.say(OWNER, '/unbook 1');
  assert.notEqual(t.engine.data.days['2026-10-07'].base.name, 'Teach Kilcar');
});

test('a timed booking at a new time moves the planned stop; same time just attaches', async () => {
  let input;
  const t = setup(localToDate('2026-10-01', '10:00'), { claude: async (run) => { await run('save_booking', input); return 'Saved.'; } });
  input = { kind: 'tickets', title: 'Carrick-a-Rede rope bridge', place: 'Carrick-a-Rede', date: '2026-10-08', start: '14:30', end: '15:30', confirmation: 'NT-778', matches_plan: 'Carrick-a-Rede rope bridge' };
  await t.photo(OWNER);
  const plans = t.engine.plansOn('2026-10-08');
  assert.ok(!plans.some((p) => p.id === 'carrick-a-rede'), 'old 15:00 slot dropped');
  const locked = plans.find((p) => p.locked && /Carrick/.test(p.title));
  assert.equal(locked.start.toISOString(), localToDate('2026-10-08', '14:30').toISOString());
  assert.match(t.sent.at(-1).html, /Moved <b>Carrick-a-Rede rope bridge \(timed slot\)<\/b> from 15:00/);
  assert.match(JSON.stringify(t.engine.planFacts(locked)), /NT-778/, 'reference shows up in the plan facts');

  input = { kind: 'tickets', title: 'Guinness Storehouse', place: 'Guinness Storehouse', date: '2026-10-03', start: '13:00', confirmation: 'GS-1', matches_plan: 'Guinness Storehouse' };
  await t.photo(OWNER);
  const g = t.engine.plansOn('2026-10-03').find((p) => p.id === 'guinness');
  assert.ok(g, 'same time: itinerary plan kept');
  assert.equal(t.engine.planFacts(g).booking, 'ref GS-1');
});

test('an album of screenshots goes to Claude in one call', async () => {
  const t = setup(localToDate('2026-10-01', '10:00'), { claude: async () => 'Two bookings, nothing to change.' });
  const m = (id) => ({ chat: { id: OWNER, type: 'private' }, from: { id: 2, first_name: 'Alex' }, date: 0, media_group_id: 'g1', photo: [{ file_id: id, width: 1179, height: 2556 }] });
  const album = [m('a'), m('b'), m('c')];
  await t.engine.handleUpdate({ update_id: 1, message: album[0], album });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].opts.attachments.length, 3);
});

test('tomorrow\'s plan agreed in the chat replaces the rough flow; revert restores it', async () => {
  const t = setup(localToDate('2026-10-06', '22:30'), {
    claude: async (run) => { await run('update_day_plan', { date: '2026-10-07', flow: 'Sleep in → Keem Bay 10:30 → Sligo 14:00 → Kilcar', drop_stops: ['Slievemore'] }); return 'Done.'; },
  });
  await t.say(GROUP, 'Ed tomorrow we sleep in, Keem Bay then straight to Sligo, skip Slievemore');
  assert.match(t.sent.at(-1).html, /Updated the plan for <b>Wed 7 Oct/);
  assert.match(t.engine.data.days['2026-10-07'].flow, /Keem Bay 10:30/);
  assert.ok(!t.engine.plansOn('2026-10-07').some((p) => /Slievemore/.test(p.title)));
  t.engine.updateDayPlan({ first_name: 'Alex' }, { date: '2026-10-07', revert: true });
  assert.doesNotMatch(t.engine.data.days['2026-10-07'].flow, /Keem Bay 10:30/);
  assert.ok(t.engine.plansOn('2026-10-07').some((p) => /Slievemore/.test(p.title)));
});

test('live weather: warns before rain hits and about wind at an exposed stop, once', async () => {
  const t = setup(localToDate('2026-10-05', '16:40'));
  t.weather.hourly = async (points) => points.map((_, i) => (i === 0
    ? fakeHours('2026-10-05', {}, { 17: { rainPct: 85, rainMm: 1.2, sky: 'rain' }, 18: { rainPct: 80, rainMm: 0.8, sky: 'rain' }, 19: { rainPct: 20 } })
    : fakeHours('2026-10-05', { gustKmh: 70 })));
  t.engine.track(GROUP).location = { lat: 52.5847, lng: -9.37, at: t.clock.now().toISOString() };
  await t.engine.tick();
  const wx = t.sent.filter((m) => /🌧|💨/.test(m.html));
  assert.ok(wx.some((m) => /Rain heading for .* around <b>17:00<\/b>/.test(m.html) && /ease off around 19:00/.test(m.html)), 'rain warning with clear-up time');
  assert.ok(wx.some((m) => /Very windy at <b>.*Moher/i.test(m.html)), 'wind warning for the cliffs');
  t.clock.advance(35);
  t.engine.track(GROUP).location.at = t.clock.now().toISOString();
  await t.engine.tick();
  assert.equal(t.sent.filter((m) => /🌧|💨/.test(m.html)).length, wx.length, 'no repeats');
});

test('packing list uses the forecast at each stop, the places and the base change', () => {
  const day = { label: 'Mon 5 Oct: Kerry Cliffs → Dingle → ferry → Cliffs of Moher → Galway', transport: 'car', driveHours: 9.5, base: { name: 'Geata Na Cathrach' } };
  const stops = [
    { title: 'Kerry Cliffs', place: 'Kerry Cliffs', time: '09:30', weather: { tempC: 11, feelsC: 7, rainPct: 70, rainMm: 1, gustKmh: 50, sky: 'rain' } },
    { title: 'Tarbert ferry', place: 'Tarbert', time: '16:30', weather: { tempC: 13, feelsC: 11, rainPct: 20, rainMm: 0, gustKmh: 30, sky: 'partly cloudy' } },
  ];
  const list = packingList(day, stops, { prevBase: { name: 'Kerry base' } }).map((x) => `${x.item} ${x.why}`).join('\n');
  assert.match(list, /checking out of Kerry base/);
  assert.match(list, /hood\. Too windy for an umbrella.*70% at Kerry Cliffs around 09:30/);
  assert.match(list, /Warm layer.*feels like 7°C/);
  assert.match(list, /grip/);
  assert.match(list, /ferry/);
  assert.match(list, /charger/);
});

test('/pack and /weather work without AI (typical weather offline)', async () => {
  const t = setup(localToDate('2026-09-30', '09:00'));
  await t.say(OWNER, '/pack');
  assert.match(t.sent.at(-1).html, /Pack for Fri 2 Oct/);
  await t.say(OWNER, '/weather');
  assert.match(t.sent.at(-1).html, /Trip outlook[\s\S]*Fri 2 Oct[\s\S]*Fri 9 Oct/);
});
