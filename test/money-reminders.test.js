// Expenses (local + Splitwise), reminders, polls, road-trip essentials, reply context and owner alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRIP = 'ireland';
const { loadData } = await import('../src/data.js');
const { Store } = await import('../src/store.js');
const { ManualClock, localToDate } = await import('../src/time.js');
const { Transit } = await import('../src/transit.js');
const { Weather } = await import('../src/weather.js');
const { Writer } = await import('../src/writer.js');
const { Engine, parseIntent } = await import('../src/engine.js');
const { Splitwise } = await import('../src/splitwise.js');
const { settle, parsePaid } = await import('../src/expenses.js');

const OWNER = 1;
const GROUP = -100;
const silent = { info() {}, warn() {}, error() {} };
const people = { 1: 'Kith', 2: 'Alex', 3: 'Sam' };

// A tiny fake of the Splitwise API that records what was sent.
function fakeSplitwise() {
  const calls = [];
  const members = [
    { id: 11, first_name: 'Ankith', last_name: 'M', balance: [{ currency_code: 'EUR', amount: '56.33' }] },
    { id: 22, first_name: 'Alexander', last_name: 'K', balance: [{ currency_code: 'EUR', amount: '-28.17' }] },
    { id: 33, first_name: 'Sam', last_name: 'R', balance: [{ currency_code: 'EUR', amount: '-28.16' }] },
  ];
  const fetchImpl = async (url, opts = {}) => {
    const path = url.split('/api/v3.0/')[1];
    const form = opts.body instanceof FormData ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.type}>`])) : null;
    calls.push({ path, form });
    const json = path === 'get_current_user' ? { user: { id: 11 } }
      : path.startsWith('get_group/') ? { group: { id: 777, name: 'Ireland 2026', members } }
        : path === 'get_groups' ? { groups: [{ id: 777, name: 'Ireland 2026' }, { id: 5, name: 'Flat' }] }
          : path === 'create_expense' ? { expenses: [{ id: 9001 }], errors: {} }
            : path.startsWith('delete_expense/') ? { success: true } : {};
    return { ok: true, status: 200, json: async () => json };
  };
  return { sw: new Splitwise({ apiKey: 'test', fetchImpl, log: silent }), calls };
}

function setup(start, { claude, splitwise, essentials } = {}) {
  const sent = [];
  const polls = [];
  const clock = new ManualClock(start);
  const data = loadData();
  const writer = new Writer({ offline: true, log: silent, trip: data.trip });
  const calls = [];
  if (claude) {
    Object.defineProperty(writer, 'usingClaude', { value: true });
    writer.answerWithTools = async (facts, history, tools, run, opts = {}) => { calls.push({ facts, opts }); return claude(run, facts, opts); };
  }
  const engine = new Engine({
    data, store: new Store(null), clock, writer, log: silent, splitwise, essentials,
    weather: new Weather({ offline: true, log: silent }),
    transit: new Transit({ offline: true, log: silent, transport: data.trip.transport, region: data.trip.region }),
    transport: {
      async send(chatId, html) { sent.push({ chatId, html, at: clock.now() }); },
      async download() { return { base64: '/9j/receipt', size: 10 }; },
      async poll(chatId, question, options) { polls.push({ chatId, question, options }); return { poll: { id: 'p1' } }; },
    },
  });
  engine.offlineWishes = true;
  engine.s.ownerChatId = OWNER; engine.s.ownerUserId = OWNER;
  engine.s.groups[GROUP] = { title: 'Ireland', approved: true };
  Object.assign(engine.s.members, people);
  const say = (text, { from = 2, chat = GROUP, reply } = {}) => engine.handleUpdate({ update_id: 1, message: { chat: { id: chat, type: chat < 0 ? 'group' : 'private' }, from: { id: from, first_name: people[from] }, date: 0, text, ...(reply ? { reply_to_message: reply } : {}) } });
  return { engine, sent, clock, calls, polls, say };
}

test('settle: fewest transfers, per currency; parsePaid reads amounts and currencies', () => {
  const r = settle([
    { payer: 'Ankith', amount: 90, currency: 'EUR' },
    { payer: 'Alex', amount: 30, currency: 'EUR', split: ['Alex', 'Sam'] },
    { payer: 'Sam', amount: 12, currency: 'GBP' },
  ], ['Ankith', 'Alex', 'Sam']);
  assert.deepEqual(r.EUR.transfers, [{ from: 'Sam', to: 'Ankith', amount: 45 }, { from: 'Alex', to: 'Ankith', amount: 15 }]);
  assert.deepEqual(r.GBP.transfers.map((t) => t.amount), [4, 4]);
  assert.deepEqual(parsePaid('I paid €45.50 for petrol', 'GBP'), { amount: 45.5, currency: 'EUR', what: 'petrol' });
  assert.deepEqual(parsePaid('30 quid parking', 'EUR'), { amount: 30, currency: 'GBP', what: 'parking' });
  assert.equal(parsePaid('nothing here', 'EUR'), null);
});

test('without Splitwise: the tab settles in $ with Venmo links, and exports to CSV', async () => {
  const t = setup(localToDate('2026-10-03', '21:00'));
  t.engine.rates = async () => ({ USD: 1, EUR: 1.1, GBP: 1.3 });
  const files = [];
  t.engine.transport.sendFile = async (chatId, name, content) => { files.push({ name, content }); };
  await t.say('Ed I paid 45 for dinner', { from: 2 });
  assert.match(t.sent.at(-1).html, /Logged #1: <b>dinner<\/b> €45 · paid by Alex · split 3 ways/);
  await t.say('Ed I paid £30 for parking', { from: 3 });
  await t.say('/venmo alex-k', { from: 2 });
  await t.say('/expenses');
  const tab = t.sent.at(-1).html;
  assert.match(tab, /€45 \+ £30 spent \(≈ \$88.50\)/);
  // Each owes $29.50: Alex paid $49.50 (+20), Sam $39 (+9.50), Kith 0 (−29.50).
  assert.match(tab, /Kith → Alex <b>\$20<\/b> · <a href="https:\/\/venmo.com\/alex-k\?txn=pay&amp;amount=20.00/);
  assert.match(tab, /Kith → Sam <b>\$9.50<\/b>/);
  assert.match(tab, /Sam: send <code>\/venmo your-handle<\/code>/);
  await t.say('/export');
  assert.equal(files[0].name, 'ireland-expenses.csv');
  assert.match(files[0].content, /"2","2026-10-03","parking","Sam","30.00","GBP","39.00","everyone","Sam"/);
  await t.say('/unpaid 1');
  assert.equal(t.engine.s.expenses.length, 1);
});

test('Northern Ireland days default to £', async () => {
  const t = setup(localToDate('2026-10-08', '13:00'));
  await t.say('Ed I paid 12 for parking');
  assert.match(t.sent.at(-1).html, /£12/);
});

test('receipt photo with a caption goes into Splitwise with the photo and the right shares', async () => {
  const { sw, calls } = fakeSplitwise();
  const t = setup(localToDate('2026-10-05', '21:30'), {
    splitwise: sw,
    claude: async (run, facts, opts) => {
      assert.equal(opts.attachments[0].type, 'image');
      await run('log_expense', { amount: 84.5, currency: 'EUR', what: 'Dinner at Kai, Galway' });
      return 'Got the Kai receipt.';
    },
  });
  // A normal 4:3 photo (not screenshot-shaped) is read because the caption is about money.
  await t.engine.handleUpdate({ update_id: 1, message: { chat: { id: GROUP, type: 'group' }, from: { id: 2, first_name: 'Alex' }, date: 0, caption: 'dinner at kai, all of us', photo: [{ file_id: 'r', width: 4032, height: 3024 }] } });
  assert.ok(t.sent.some((m) => /Added to Splitwise: <b>Dinner at Kai, Galway<\/b> €84.50 · paid by Alexander · split 3 ways \(€28.17 each\) · receipt attached/.test(m.html)), t.sent.map((m) => m.html).join('\n---\n'));
  const create = calls.find((c) => c.path === 'create_expense').form;
  assert.equal(create.cost, '84.50');
  assert.equal(create.group_id, '777', 'auto-picked the group whose name says Ireland');
  assert.equal(create.receipt, '<file image/jpeg>');
  const shares = [0, 1, 2].map((i) => [create[`users__${i}__user_id`], create[`users__${i}__paid_share`], create[`users__${i}__owed_share`]]);
  assert.deepEqual(shares, [['22', '84.50', '28.17'], ['11', '0.00', '28.17'], ['33', '0.00', '28.16']]);
  // Undo deletes it in Splitwise too.
  await t.say('/unpaid 1');
  assert.ok(calls.some((c) => c.path === 'delete_expense/9001'));
  // Balances come from Splitwise.
  await t.say('/expenses');
  assert.match(t.sent.at(-1).html, /Ankith is owed <b>€56.33<\/b>[\s\S]*Alexander owes <b>€28.17<\/b>/);
});

test('an uneven split names only the people who share it; unknown names are refused', async () => {
  const { sw, calls } = fakeSplitwise();
  let input;
  const t = setup(localToDate('2026-10-05', '21:30'), { splitwise: sw, claude: async (run) => { await run('log_expense', input); return 'ok'; } });
  t.engine.s.swGroupId = 777;
  input = { amount: 20, currency: 'EUR', what: 'Pints', payer: 'Sam', split_with: ['Sam', 'Alex'] };
  await t.say('Ed Sam got 20 of pints for him and Alex');
  const f = calls.find((c) => c.path === 'create_expense').form;
  assert.equal(f.users__0__user_id, '33');
  assert.equal(f.users__0__paid_share, '20.00');
  assert.equal(f.users__1__owed_share, '10.00');
  input = { amount: 20, currency: 'EUR', what: 'Pints', split_with: ['Dave'] };
  await t.say('Ed split with Dave');
  assert.match(t.sent.at(-1).html, /can't find <b>Dave<\/b>/);
});

test('reminders: "remind us in 30 min to move the car" fires once, on time', async () => {
  const t = setup(localToDate('2026-10-06', '14:00'));
  await t.say('Ed remind us in 30 min to move the car');
  assert.match(t.sent.at(-1).html, /remind everyone at <b>14:30<\/b>: move the car/);
  t.clock.advance(29); await t.engine.tick();
  assert.ok(!t.sent.some((m) => /Reminder/.test(m.html)));
  t.clock.advance(1); await t.engine.tick(); await t.engine.tick();
  assert.equal(t.sent.filter((m) => /⏰ <b>Reminder<\/b> \(from Alex\): move the car/.test(m.html)).length, 1);
  assert.equal(parseIntent('remind me at 6pm to book dinner').hh, 18);
});

test('polls: Claude can post one, votes are tracked and fed back as facts', async () => {
  const t = setup(localToDate('2026-10-05', '19:00'), { claude: async (run) => { await run('create_poll', { question: 'Dinner?', options: ['Kai', 'Dough Bros'] }); return 'Vote!'; } });
  await t.say('Ed poll: Kai or Dough Bros');
  assert.deepEqual(t.polls[0], { chatId: GROUP, question: 'Dinner?', options: ['Kai', 'Dough Bros'] });
  await t.engine.handleUpdate({ update_id: 2, poll: { id: 'p1', options: [{ text: 'Kai', voter_count: 2 }, { text: 'Dough Bros', voter_count: 1 }], total_voter_count: 3, is_closed: false } });
  assert.match(t.engine.pollFacts()[0].results, /Kai: 2 · Dough Bros: 1/);
});

test('essentials: "petrol near me" is a free map lookup; "parking at Kylemore" is a question', async () => {
  const essentials = { async near(kind) { return [{ name: 'Applegreen', lat: 53.27, lng: -9.05, distM: 1800, hours: '24/7' }].map((p) => ({ ...p, kind: kind.id })); } };
  const t = setup(localToDate('2026-10-06', '11:00'), { essentials, claude: async () => 'Kylemore has a free car park.' });
  t.engine.track(GROUP).location = { lat: 53.272, lng: -9.05, at: t.clock.now().toISOString() };
  await t.say('Ed where can we get petrol?');
  assert.match(t.sent.at(-1).html, /Petrol stations nearest you:[\s\S]*Applegreen<\/b>, 1.8 km \(hours: 24\/7\)[\s\S]*travelmode=driving/);
  assert.equal(t.calls.length, 0, 'no Claude call');
  await t.say('Ed is there parking at Kylemore?');
  assert.equal(t.calls.length, 1, 'a question about another place goes to Claude');
});

test('replying to a message passes the quoted text to Claude', async () => {
  const t = setup(localToDate('2026-10-05', '19:00'), { claude: async () => 'Sure.' });
  await t.say('Ed what do you reckon, worth the detour?', { reply: { from: { first_name: 'Sam', is_bot: false }, text: 'Kylemore Abbey walled garden looks unreal' } });
  assert.match(t.calls[0].facts.question, /replying to Sam's message: "Kylemore Abbey walled garden/);
});

test('out of credit: the owner gets one DM, not one per message', async () => {
  const t = setup(localToDate('2026-10-05', '19:00'));
  t.engine.writer.onTrouble('credit');
  t.engine.writer.onTrouble('credit');
  await new Promise((r) => setTimeout(r, 10));
  const dms = t.sent.filter((m) => m.chatId === OWNER && /out of API credit/.test(m.html));
  assert.equal(dms.length, 1);
  t.engine.writer.onUsage({ cost: 0.031, searches: 2 });
  await t.say('/usage');
  assert.match(t.sent.at(-1).html, /Today: <b>\$0.03<\/b> \(1 calls, 2 web searches\)/);
});

test('end-of-trip Splitwise report: one entry per currency, paid and split columns add up to the cent', async () => {
  const t = setup(localToDate('2026-10-08', '20:00'));
  t.engine.rates = async () => ({ USD: 1, EUR: 1.1, GBP: 1.3 });
  await t.say('Ed I paid 100 for dinner', { from: 2 }); // Thu 8 Oct is a £ day
  await t.say('Ed I paid €50 for petrol', { from: 3 });
  await t.say('Ed I paid €10.01 for snacks', { from: 1 });
  await t.say('/report');
  const r = t.sent.at(-1).html;
  assert.match(r, /1\) "Ireland road trip \(GBP\)"<\/b>: <b>£100<\/b>, 1 expense\n  Paid by: Alex £100\n  Split: Alex £33.33 · Kith £33.34 · Sam £33.33/);
  assert.match(r, /2\) "Ireland road trip \(EUR\)"<\/b>: <b>€60.01<\/b>, 2 expenses\n  Paid by: Kith €10.01 · Sam €50\n  Split: Alex €20 · Kith €20.01 · Sam €20/);
  // The last trip day sends it by itself, once.
  const t2 = setup(localToDate('2026-10-09', '07:50'));
  t2.engine.s.expenses = t.engine.s.expenses;
  for (let i = 0; i < 20; i++) { await t2.engine.tick(); t2.clock.advance(1); }
  assert.equal(t2.sent.filter((m) => /Splitwise report/.test(m.html)).length, 1);
});

test('Splitwise key from someone else (Sam): Telegram "Kith" still maps to Splitwise "Ankith"; report skips synced ones', async () => {
  const { sw, calls } = fakeSplitwise();
  const t = setup(localToDate('2026-10-05', '21:30'), { splitwise: sw });
  t.engine.s.swGroupId = 777;
  await t.say('Ed I paid 30 for parking', { from: 1 });
  const f = calls.find((c) => c.path === 'create_expense').form;
  assert.equal(f.users__0__user_id, '11', 'Kith → Ankith (the only unmatched pair)');
  assert.equal(f.users__0__paid_share, '30.00');
  assert.ok(!calls.some((c) => c.path === 'get_current_user'), 'never assumes the key owner is the payer');
  await t.say('/report');
  assert.match(t.sent.at(-1).html, /Everything \(1 expenses\) is already in Splitwise/);
});
