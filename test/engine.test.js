import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData, validateData } from '../src/data.js';
import { Store } from '../src/store.js';
import { ManualClock, localToDate, londonParts, hhmm } from '../src/time.js';
import { Transit } from '../src/transit.js';
import { Weather } from '../src/weather.js';
import { Writer } from '../src/writer.js';
import { Engine, parseIntent, cleanHistory } from '../src/engine.js';
import { minutesUntilClose } from '../src/hours.js';

const OWNER = 1;
const silent = { info() {}, warn() {}, error() {} };
const SOHO = { lat: 51.5137, lng: -0.1350 };
const HOME = { lat: 51.514, lng: -0.159 };

function setup(start) {
  const sent = [];
  const clock = new ManualClock(start);
  const engine = new Engine({
    data: loadData(),
    store: new Store(null),
    clock,
    transport: { async send(chatId, html) { sent.push({ chatId, html, at: clock.now() }); } },
    writer: new Writer({ offline: true, log: silent }),
    transit: new Transit({ offline: true, log: silent }),
    weather: new Weather({ offline: true, log: silent }),
    log: silent,
    botUsername: 'tripbot',
  });
  const msg = (extra, chat = { id: OWNER, type: 'private' }, from = { id: OWNER, first_name: 'Me' }) =>
    engine.handleUpdate({ update_id: 1, message: { chat, from, date: 0, ...extra } });
  const at = (loc, chatId = OWNER) => { engine.track(chatId).location = { ...loc, at: clock.now().toISOString(), userId: chatId }; };
  const run = async (minutes, loc) => {
    for (let i = 0; i < minutes; i++) {
      if (loc) at(loc);
      await engine.tick();
      clock.advance(1);
    }
  };
  return { engine, clock, sent, msg, at, run };
}

test('data files are valid and fixed plans never overlap', () => {
  assert.deepEqual(validateData(loadData()), []);
});

test('Oct 9 2026 is a Friday (the pasted plan said Thursday)', () => {
  assert.equal(londonParts(localToDate('2026-10-09', '12:00')).weekday, 'fri');
});

test('opening hours: overnight ranges and closed days', () => {
  assert.equal(minutesUntilClose({ fri: '23:00-06:00' }, 'sat', 60), 300);
  assert.equal(minutesUntilClose({ 'tue-fri': '10:00-17:00' }, 'mon', 720), null);
  assert.equal(minutesUntilClose({ 'mon-sat': '11:00-19:00', sun: '12:00-18:00' }, 'sun', 11 * 60), null);
  assert.equal(minutesUntilClose({ 'sun-mon': '10:00-17:30' }, 'mon', 17 * 60), 30);
});

test('locks to the first /start and ignores strangers', async () => {
  const { engine, sent, msg } = setup(localToDate('2026-10-01', '12:00'));
  await msg({ text: 'hello' });
  assert.equal(engine.s.ownerChatId, null, 'plain text does not claim the bot');
  await msg({ text: '/start' });
  assert.equal(engine.s.ownerChatId, OWNER);
  const before = sent.length;
  await msg({ text: '/start' }, { id: 99, type: 'private' }, { id: 99, first_name: 'Stranger' });
  await msg({ text: 'what now?' }, { id: 99, type: 'private' }, { id: 99, first_name: 'Stranger' });
  assert.equal(sent.length, before, 'stranger gets no reply');
});

test('group needs approval unless the owner adds the bot', async () => {
  const { engine, sent, msg } = setup(localToDate('2026-10-01', '12:00'));
  await msg({ text: '/start' });
  const group = { id: -500, type: 'group', title: 'London boys' };
  await msg({ text: '/start' }, group, { id: 7, first_name: 'Friend' });
  assert.equal(engine.s.groups[-500].approved, false);
  assert.match(sent.at(-1).html, /\/approve -500/);
  await msg({ text: '/approve -500' });
  assert.equal(engine.s.groups[-500].approved, true);
  await msg({ text: 'cench what now?' }, group, { id: 7, first_name: 'Friend' });
  assert.equal(sent.at(-1).chatId, -500);
  assert.deepEqual(engine.broadcastTargets(), [-500]);

  await engine.handleUpdate({ my_chat_member: { chat: { id: -600, type: 'supergroup', title: 'Other' }, from: { id: OWNER }, new_chat_member: { status: 'member' } } });
  assert.equal(engine.s.groups[-600].approved, true, 'owner-added group auto-approved');
});

test('in a group, the bot ignores normal chatter but answers clear requests', async () => {
  const { sent, msg } = setup(localToDate('2026-10-10', '12:00'));
  await msg({ text: '/start' });
  const group = { id: -500, type: 'group', title: 'G' };
  await msg({ text: '/start' }, group, { id: 7 });
  await msg({ text: '/approve -500' });
  const n = sent.length;
  await msg({ text: 'lol did you see that guy' }, group, { id: 7 });
  assert.equal(sent.length, n);
  await msg({ text: 'food near me' }, group, { id: 7 });
  assert.equal(sent.length, n, 'no wake word, no reply');
  await msg({ text: 'Cench food near me' }, group, { id: 7 });
  assert.equal(sent.length, n + 1);
});

test('leave-by: 15-minute warning, then leave now, each exactly once', async () => {
  const { engine, sent, msg, run } = setup(localToDate('2026-10-10', '17:30'));
  await msg({ text: '/start' });
  await run(120, SOHO);
  const warn = sent.filter((m) => /Leave in ~15 min/.test(m.html) && /Kutir/.test(m.html));
  const now = sent.filter((m) => /Time to go/.test(m.html) && /Kutir/.test(m.html));
  assert.equal(warn.length, 1);
  assert.equal(now.length, 1);
  assert.ok(now[0].at - warn[0].at >= 14 * 60_000, 'warning comes ~15 min before');
  assert.ok(now[0].at < engine.data.plans.find((p) => p.id === 'kutir').start);
  assert.match(now[0].html, /google\.com\/maps\/dir/);
  assert.match(now[0].html, /citymapper\.com/);
});

test('"running late 20 min" shifts the next alert and flags the booking', async () => {
  const { sent, msg, run } = setup(localToDate('2026-10-10', '17:45'));
  await msg({ text: '/start' });
  await msg({ text: "we're running late 20 min" });
  assert.match(sent.at(-1).html, /shifted <b>Dinner at Kutir<\/b> alerts by 20 min/);
  assert.match(sent.at(-1).html, /020 7581 1144/);
  await run(100, SOHO);
  const leaveNow = sent.find((m) => /Time to go/.test(m.html));
  assert.ok(leaveNow);
  assert.ok(londonParts(leaveNow.at).minutes > 18 * 60 + 40, `shifted leave time, got ${hhmm(leaveNow.at)}`);
});

test('flights are never shifted', async () => {
  const { sent, msg } = setup(localToDate('2026-10-12', '09:30'));
  await msg({ text: '/start' });
  await msg({ text: "we're gonna be 30 min late" });
  assert.match(sent.at(-1).html, /won't wait/);
});

test('quiet hours: nothing unprompted between 01:00 and 08:00', async () => {
  const { sent, msg, run } = setup(localToDate('2026-10-11', '01:00'));
  await msg({ text: '/start' });
  const n = sent.length;
  await run(7 * 60, SOHO);
  assert.equal(sent.length, n);
});

test('anti-spam: unprompted messages are 45+ min apart and suggestions never repeat', async () => {
  const { engine, sent, msg, run } = setup(localToDate('2026-10-10', '10:00'));
  await msg({ text: '/start' });
  const start = sent.length;
  await run(8 * 60, SOHO); // wander Soho all day
  const auto = sent.slice(start).filter((m) => !/Leave in|Time to go|At this pace|🌅|Morning|Wrap-up/.test(m.html));
  for (let i = 1; i < auto.length; i++) {
    assert.ok(auto[i].at - auto[i - 1].at >= 45 * 60_000, `gap between msgs ${i - 1} and ${i}`);
  }
  assert.ok(auto.length >= 2, 'did send some ideas');
  const ids = engine.track(OWNER).suggested;
  assert.equal(new Set(ids).size, ids.length);
  const names = auto.flatMap((m) => [...m.html.matchAll(/📍 ([^:]+): <a/g)].map((x) => x[1]));
  assert.equal(new Set(names).size, names.length, 'no place suggested twice');
});

test('morning brief at 08:30 and night wrap after dinner, once each', async () => {
  const { sent, msg, run } = setup(localToDate('2026-10-11', '08:00'));
  await msg({ text: '/start' });
  await run(60, HOME);
  assert.equal(sent.filter((m) => /Morning!/.test(m.html)).length, 1);
  const { sent: s2, msg: m2, run: r2 } = setup(localToDate('2026-10-11', '22:00'));
  await m2({ text: '/start' });
  await r2(150, HOME);
  const wraps = s2.filter((m) => /Wrap-up/.test(m.html));
  assert.equal(wraps.length, 1);
  assert.ok(londonParts(wraps[0].at).minutes >= 23 * 60 + 45, 'waits until OMA is over');
});

test('skip removes the last suggestion and snoozes ideas', async () => {
  const { engine, sent, msg } = setup(localToDate('2026-10-10', '12:00'));
  await msg({ text: '/start' });
  engine.track(OWNER).location = { ...SOHO, at: engine.now().toISOString() };
  await msg({ text: 'best streetwear near me' });
  const suggested = [...engine.track(OWNER).lastSuggestion];
  assert.ok(suggested.length > 0);
  await msg({ text: 'skip' });
  assert.match(sent.at(-1).html, /Skipped/);
  for (const id of suggested) assert.ok(engine.track(OWNER).skipped.includes(id));
});

test('directions find fixed plans, places and home', async () => {
  const { engine } = setup(localToDate('2026-10-11', '14:00'));
  const now = engine.now();
  assert.equal(engine.findDestination('Kutir', now).name, 'Kutir');
  assert.equal(engine.findDestination('oma', now).name, 'OMA');
  assert.equal(engine.findDestination('the airport', now).name, 'Heathrow Terminal 3');
  assert.equal(engine.findDestination('home', now).lat, HOME.lat);
  assert.equal(engine.findDestination('supreme', now).id, 'supreme');
});

test('intent parsing', () => {
  assert.equal(parseIntent('what now?').type, 'what_now');
  assert.deepEqual(parseIntent("we're running late 20 min"), { type: 'late', minutes: 20 });
  assert.deepEqual(parseIntent('running like an hour late'), { type: 'late', minutes: 60 });
  assert.deepEqual(parseIntent("we're late"), { type: 'late', minutes: 15 });
  assert.deepEqual(parseIntent('gonna be 1 hour late'), { type: 'late', minutes: 60 });
  assert.equal(parseIntent('late night food near me').type, 'nearby');
  assert.equal(parseIntent('how do i get to kutir').query, 'kutir');
  assert.deepEqual(parseIntent('best streetwear near me').categories, ['streetwear', 'fashion', 'sneakers', 'shopping']);
  assert.equal(parseIntent('skip').type, 'skip');
  assert.equal(parseIntent('is it worth going to camden?').type, 'answer');
});

// ---------------------------------------------------------------- wishlist

import { resolveWish, matchKnownPlace } from '../src/wishlist.js';
import { rankPlaces } from '../src/recommend.js';

function wishSetup() {
  const t = setup(localToDate('2026-09-28', '12:00'));
  t.engine.offlineWishes = true;
  return t;
}

test('wishlist intents: explicit forms vs casual ones', () => {
  assert.deepEqual(parseIntent('add Palace to the list'), { type: 'wish', text: 'Palace', explicit: true });
  assert.deepEqual(parseIntent('wishlist: Arsenal museum'), { type: 'wish', text: 'Arsenal museum', explicit: true });
  assert.deepEqual(parseIntent('I want to see Abbey Road'), { type: 'wish', text: 'Abbey Road', explicit: false });
  assert.deepEqual(parseIntent('we should go to Sketch'), { type: 'wish', text: 'Sketch', explicit: false });
  assert.equal(parseIntent('can we go to Supreme now?').type, 'answer', '"now" means a live question, not a wish');
  assert.equal(parseIntent('what now?').type, 'what_now');
});

test('friends can add to the wishlist from the group before the trip; list and remove work', async () => {
  const { engine, sent, msg } = wishSetup();
  await msg({ text: '/start' });
  const group = { id: -500, type: 'group', title: 'G' };
  await msg({ text: '/start' }, group, { id: 7, first_name: 'Alex' });
  await msg({ text: '/approve -500' });

  await msg({ text: '/want Supreme' }, group, { id: 7, first_name: 'Alex' });
  assert.match(sent.at(-1).html, /Added <b>Supreme London<\/b> for Alex/);
  await msg({ text: 'Cench add abbey road crossing to the list' }, group, { id: 8, first_name: 'Sam' });
  assert.match(sent.at(-1).html, /Abbey Road crossing/);
  await msg({ text: 'hey Cench, I want to eat a full English breakfast' }, group, { id: 7, first_name: 'Alex' });
  assert.match(sent.at(-1).html, /Saved "a full English breakfast"/);

  const n = sent.length;
  await msg({ text: 'I want to see a show tonight lol' }, group, { id: 8, first_name: 'Sam' });
  assert.equal(sent.length, n, 'casual chatter in the group is not captured unless addressed');

  await msg({ text: '/want supreme' }, group, { id: 8 });
  assert.match(sent.at(-1).html, /Already on the list/);

  await msg({ text: '/wishlist' }, group, { id: 7 });
  assert.match(sent.at(-1).html, /1\. <b>Supreme London<\/b>.*Alex/);
  assert.match(sent.at(-1).html, /3\. <b>a full English breakfast<\/b> · <i>idea<\/i>/);

  await msg({ text: '/unwish 2' }, group, { id: 7 });
  assert.equal(engine.s.wishlist.length, 2);

  engine.store.resetTripProgress();
  assert.equal(engine.s.wishlist.length, 2, '/fake off and /reset keep the wishlist');
});

test('wishlist places rank higher in suggestions', () => {
  const { engine } = wishSetup();
  engine.s.wishlist.push({ n: 1, text: 'sister ray', by: 'Alex', placeId: 'sister-ray' });
  const now = localToDate('2026-10-10', '12:00');
  const ranked = rankPlaces({ places: engine.allPlaces(), here: SOHO, now, gapMin: 240 });
  assert.equal(ranked[0].place.id, 'sister-ray');
  assert.match(ranked[0].place.why, /on Alex's wishlist/);
});

test('unknown wishes are geocoded (stubbed OpenStreetMap) and become suggestible places', async () => {
  const { engine } = wishSetup();
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [{ name: 'Sketch', lat: '51.5127', lon: '-0.1412', category: 'amenity', type: 'restaurant', display_name: 'Sketch, 9, Conduit Street, Mayfair, London' }],
  });
  const r = await resolveWish('sketch', { places: engine.data.places, neighborhoods: engine.data.neighborhoods, fetchImpl: fakeFetch, log: silent });
  assert.equal(r.known, false);
  assert.equal(r.place.category, 'food');
  assert.equal(r.place.neighborhood, 'mayfair');
  assert.equal(matchKnownPlace('the arsenal stadium tour', engine.data.places).id, 'emirates-tour');
});

// ---------------------------------------------------------------- individuals moving on their own

const SAM = 42;
const GROUP = { id: -500, type: 'group', title: 'London Boys' };
const SOUTH_BANK = { lat: 51.5064, lng: -0.1170 };

async function groupSetup(start) {
  const t = setup(start);
  t.engine.offlineWishes = true;
  await t.msg({ text: '/start' });
  await t.msg({ text: '/start' }, GROUP, { id: SAM, first_name: 'Sam' });
  await t.msg({ text: '/approve -500' });
  await t.msg({ text: 'yo', new_chat_members: [{ id: SAM, first_name: 'Sam' }] }, GROUP, { id: OWNER, first_name: 'Me' });
  t.samDm = (extra) => t.msg(extra, { id: SAM, type: 'private' }, { id: SAM, first_name: 'Sam' });
  return t;
}

test('personal plans: saved, and group plans stay locked in', async () => {
  const { engine, sent, samDm } = await groupSetup(localToDate('2026-09-28', '12:00'));
  await samDm({ text: '/start' });
  await samDm({ text: '/plan 2026-10-10 14:15-17:00 Movie premiere @ BFI IMAX' });
  assert.match(sent.at(-1).html, /Couldn't save.*Chelsea vs Bournemouth.*\/skipplan/s, 'clashes with the group match');
  await samDm({ text: '/skipplan chelsea' });
  assert.ok(sent.some((m) => m.chatId === GROUP.id && /Sam is sitting out <b>Chelsea vs Bournemouth<\/b>.*Dinner at Kutir/.test(m.html)), 'group is told');
  await samDm({ text: '/skipplan the flight home' });
  assert.match(sent.at(-1).html, /Can't skip a flight/);
  await samDm({ text: '/plan 2026-10-10 14:15-17:00 Movie premiere @ BFI IMAX' });
  assert.match(sent.at(-1).html, /Saved for Sam: <b>Movie premiere<\/b> · Sat 10 Oct 14:15–17:00 @ BFI IMAX/);
  assert.doesNotMatch(sent.at(-1).html, /leave by/, 'ends well before Kutir');

  await samDm({ text: '/plan 2026-10-10 19:30 Drinks @ Bar Italia' });
  assert.match(sent.at(-1).html, /Couldn't save.*Dinner at Kutir/s, 'cannot start during a group plan');

  await samDm({ text: "/plan 2026-10-10 17:30-20:00 Jazz @ Ronnie Scott's" });
  assert.match(sent.at(-1).html, /leave by <b>1[78]:\d\d<\/b> to make <b>Dinner at Kutir/, 'overlap is saved with a leave-by warning');

  await samDm({ text: '/myplans' });
  assert.match(sent.at(-1).html, /1\. <b>Movie premiere/);
  await samDm({ text: '/unplan 2' });
  assert.equal(engine.s.personalPlans[SAM].length, 1);

  engine.store.resetTripProgress();
  assert.equal(engine.s.personalPlans[SAM].length, 1, 'personal plans survive /fake off');
});

test('someone on their own gets private alerts from their own location; the group gets group alerts', async () => {
  const { engine, sent, samDm, clock } = await groupSetup(localToDate('2026-10-10', '13:00'));
  await samDm({ text: '/start' });
  await samDm({ text: '/skipplan chelsea' });
  await samDm({ text: '/plan 2026-10-10 14:15-17:00 Movie premiere @ BFI IMAX' });
  const before = sent.length;
  for (let i = 0; i < 6 * 60; i++) { // 13:00 -> 19:00
    engine.track(GROUP.id).location = { ...SOHO, at: clock.now().toISOString() };
    if (clock.now() < localToDate('2026-10-10', '17:00')) engine.track(SAM).location = { ...SOHO, at: clock.now().toISOString() };
    else engine.track(SAM).location = { ...SOUTH_BANK, at: clock.now().toISOString() };
    await engine.tick();
    clock.advance(1);
  }
  const msgs = sent.slice(before);
  const toSam = msgs.filter((m) => m.chatId === SAM);
  const toGroup = msgs.filter((m) => m.chatId === GROUP.id);
  assert.ok(toSam.some((m) => /Time to go/.test(m.html) && /Movie premiere/.test(m.html)), 'Sam gets his premiere leave-now privately');
  assert.ok(toSam.some((m) => /Time to go/.test(m.html) && /Kutir/.test(m.html)), 'Sam also gets the group dinner alert from his own location');
  assert.ok(toGroup.some((m) => /Time to go/.test(m.html) && /Kutir/.test(m.html)), 'group gets the dinner alert');
  assert.ok(!toGroup.some((m) => /Movie premiere/.test(m.html) && /Time to go/.test(m.html)), "the group isn't pinged about Sam's premiere");
  assert.ok(!toSam.some((m) => /Chelsea vs Bournemouth/.test(m.html) && /Time to go|Leave in/.test(m.html)), 'no match alerts for the person sitting it out');
  assert.ok(toGroup.some((m) => /Chelsea vs Bournemouth/.test(m.html) && /Time to go|Leave in/.test(m.html)), 'the group still gets match alerts');
});

test("personal alerts fall back to the group (tagged) if that person never opened a DM", async () => {
  const { engine, sent, msg, clock } = await groupSetup(localToDate('2026-10-10', '13:00'));
  await msg({ text: '/skipplan chelsea' }, GROUP, { id: SAM, first_name: 'Sam' });
  await msg({ text: '/plan 2026-10-10 14:15-17:00 Movie premiere @ BFI IMAX' }, GROUP, { id: SAM, first_name: 'Sam' });
  assert.match(sent.at(-1).html, /DM me \/start so they come privately/);
  for (let i = 0; i < 90; i++) { await engine.tick(); clock.advance(1); }
  const tagged = sent.find((m) => m.chatId === GROUP.id && /^👤 Sam: /.test(m.html) && /Movie premiere/.test(m.html));
  assert.ok(tagged, 'premiere alert shows up in the group, tagged with his name');
});

test('dated personal statements go to Claude (to save as a plan), not the wishlist', () => {
  assert.equal(parseIntent('I want to see a movie premiere on Oct 10 at 2:15 at the Southbank Centre').type, 'answer');
  assert.equal(parseIntent('I want to see Abbey Road').type, 'wish');
});

test('group chat: Cench is the wake word', async () => {
  const { sent, msg } = setup(localToDate('2026-09-28', '12:00'));
  const G = { id: -500, type: 'group', title: 'G' };
  await msg({ text: '/start' });
  await msg({ text: '/start' }, G, { id: 7 });
  await msg({ text: '/approve -500' });
  const n = sent.length;
  await msg({ text: "What's the plan for Oct 10th?" }, G, { id: 7 });
  await msg({ text: 'bot what now?' }, G, { id: 7 });
  assert.equal(sent.length, n, 'no reply without "Cench"');
  await msg({ text: "Cench what's on the wishlist?" }, G, { id: 7 });
  assert.match(sent.at(-1).html, /Wishlist is empty|Group wishlist/);
  await msg({ text: 'yo cench, what now?' }, G, { id: 7 });
  assert.equal(sent.length, n + 2);
  await msg({ text: '/today' }, G, { id: 7 });
  assert.equal(sent.length, n + 3, 'slash commands work without the wake word');
  assert.equal(parseIntent("what is ankith's wishlist").type, 'show_wishlist');
});

test('chat history sent to Claude never has empty or out-of-order turns', async () => {
  const bad = [{ role: 'user', content: '' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'dangling' }];
  assert.deepEqual(cleanHistory(bad), [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  const { sent, msg } = setup(localToDate('2026-10-10', '12:00'));
  await msg({ text: '/start' });
  await msg({ text: '/start' }, { id: -500, type: 'group', title: 'G' }, { id: 7 });
  await msg({ text: '/approve -500' });
  await msg({ text: 'Cench' }, { id: -500, type: 'group', title: 'G' }, { id: 7 });
  assert.match(sent.at(-1).html, /I'm here/);
});

test('group memory: remembers group chatter and forwarded old messages as context', async () => {
  const { engine, sent, msg } = setup(localToDate('2026-09-28', '12:00'));
  const G = { id: -500, type: 'group', title: 'G' };
  await msg({ text: '/start' });
  await msg({ text: '/start' }, G, { id: 7, first_name: 'Alex' });
  await msg({ text: '/approve -500' });
  await msg({ text: 'we should def do the guinness thing', date: 1790300000 }, G, { id: 7, first_name: 'Alex' });
  await msg({ text: 'zach wants the chelsea shirt' }, G, { id: 8, first_name: 'Sam' });
  const n = sent.length;
  await msg({ text: 'old: remember I booked padella for sunday', forward_origin: { type: 'user', sender_user: { first_name: 'Alex' }, date: 1790200000 }, date: 1790300100 });
  assert.match(sent.at(-1).html, /added to the group memory/);
  await msg({ text: 'another old one', forward_origin: { type: 'user', sender_user: { first_name: 'Sam' }, date: 1790200050 } });
  assert.equal(sent.length, n + 1, 'forwards acknowledged once, not per message');
  const mem = engine.groupMemory(-500);
  assert.ok(mem.some((l) => /Alex: we should def do the guinness thing/.test(l)));
  assert.ok(mem.some((l) => /Sam: zach wants the chelsea shirt/.test(l)));
  assert.match(mem[0], /Alex: old: remember I booked padella/, 'forwarded messages sorted by their original time');
});

import { parseMapsUrl, guessCategory } from '../src/wishlist.js';

test('Google Maps links: parsed into a place and added without the wake word; other links need it', async () => {
  const long = 'https://www.google.com/maps/place/The+Blue+Posts/@51.5131,-0.1343,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d51.51312!4d-0.13436';
  const p = parseMapsUrl(long);
  assert.equal(p.name, 'The Blue Posts');
  assert.equal(p.lat, 51.51312);
  assert.equal(guessCategory('The Blue Posts pub')[0], 'pub');
  assert.ok(parseMapsUrl('https://www.google.com/maps/placelists/list/abc').isList);

  const { engine, sent, msg } = setup(localToDate('2026-09-28', '12:00'));
  const G = { id: -500, type: 'group', title: 'G' };
  await msg({ text: '/start' });
  await msg({ text: '/start' }, G, { id: 7, first_name: 'Alex' });
  await msg({ text: '/approve -500' });
  await msg({ text: `we have to go here ${long}` }, G, { id: 7, first_name: 'Alex' });
  assert.match(sent.at(-1).html, /Added <b>The Blue Posts<\/b> to the wishlist for Alex \(Soho &amp; Carnaby\)/);
  assert.equal(engine.s.wishlist.at(-1).note, 'we have to go here');
  await msg({ text: long }, G, { id: 8, first_name: 'Sam' });
  assert.match(sent.at(-1).html, /already on the list/);
  const n = sent.length;
  await msg({ text: 'lol look https://example.com/funny' }, G, { id: 8 });
  assert.equal(sent.length, n, 'random links in the group are ignored without the wake word');
});

test('locking in a wishlist place moves it into the group plan (with alerts); clashes refused; unlock restores', async () => {
  const { engine, sent, msg, run } = wishSetup();
  await msg({ text: '/start' });
  await msg({ text: '/want Bar Italia' });
  const n = engine.s.wishlist.at(-1).n;
  await msg({ text: `/lockin ${n} 2026-10-10 20:00` });
  assert.match(sent.at(-1).html, /Couldn't lock that in: it overlaps Dinner at Kutir/);
  await msg({ text: `/lockin ${n} 2026-10-10 21:45-23:00` });
  assert.match(sent.at(-1).html, /Locked in: <b>Bar Italia<\/b> · Sat 10 Oct 21:45–23:00/);
  assert.equal(engine.s.wishlist.length, 0, 'moved off the wishlist');
  assert.ok(engine.data.plans.some((p) => p.locked && p.title === 'Bar Italia'), 'now part of the group plans');

  // Group gets leave-by alerts for it (from Chelsea after dinner).
  engine.clock.set(localToDate('2026-10-10', '21:00'));
  await run(45, { lat: 51.4916, lng: -0.1611 });
  assert.ok(sent.some((m) => /Time to go/.test(m.html) && /Bar Italia/.test(m.html)));

  await msg({ text: '/today' });
  assert.match(sent.at(-1).html, /🔒#1 Bar Italia/);
  await msg({ text: '/unlock 1' });
  assert.equal(engine.s.wishlist.length, 1, 'back on the wishlist');
  assert.ok(!engine.data.plans.some((p) => p.locked));
});
