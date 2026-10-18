// Test mode: replay a walk through London on a fake clock and print every message the bot would send.
//
//   npm run simulate                      # all 4 days, offline (templates + estimated travel times)
//   npm run simulate -- --day 2026-10-10  # one day
//   npm run simulate -- --live            # real Claude + TfL + weather (needs ANTHROPIC_API_KEY; costs ~cents)
//   npm run simulate -- --route my-route.json
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadData, DATA_DIR } from '../src/data.js';
import { Store } from '../src/store.js';
import { ManualClock, londonParts, hhmm, localToDate, dayLabel } from '../src/time.js';
import { Transit } from '../src/transit.js';
import { Weather } from '../src/weather.js';
import { Writer } from '../src/writer.js';
import { Engine } from '../src/engine.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

const live = flag('live');
const onlyDay = opt('day');
const routeFile = opt('route') || path.join(DATA_DIR, 'sim-route.json');
const quietLog = { info() {}, warn() {}, error: (...a) => console.error('ERROR', ...a) };

const data = loadData();
const steps = JSON.parse(readFileSync(routeFile, 'utf8'))
  .map((s) => ({ ...s, time: localToDate(s.at.slice(0, 10), s.at.slice(11, 16)) }))
  .filter((s) => !onlyDay || s.at.startsWith(onlyDay))
  .sort((a, b) => a.time - b.time);
if (!steps.length) throw new Error('No route steps for that day.');

const OWNER = 1001;
const out = [];
const transport = {
  async send(chatId, html) {
    const text = html
      .replace(/<a href="[^"]*">([^<]*)<\/a>/g, '[$1]')
      .replace(/<\/?(b|i|code)>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    out.push({ at: clock.now(), text });
    console.log(`\n\x1b[36m── ${dayLabel(clock.now())} ${hhmm(clock.now())} · bot → ${chatId === OWNER ? 'you' : chatId}\x1b[0m\n${text}`);
  },
};

const firstDay = steps[0].at.slice(0, 10);
const lastDay = steps.at(-1).at.slice(0, 10);
const clock = new ManualClock(localToDate(firstDay, '07:00'));
const store = new Store(null);
const writer = new Writer({ apiKey: live ? process.env.ANTHROPIC_API_KEY : null, model: process.env.CLAUDE_MODEL || 'claude-sonnet-5', log: quietLog, trip: data.trip });
const engine = new Engine({
  data, store, clock, transport, writer, log: quietLog,
  transit: new Transit({ offline: !live, appKey: process.env.TFL_APP_KEY || '', log: quietLog, transport: data.trip.transport, region: data.trip.region }),
  weather: new Weather({ offline: !live, log: quietLog }),
});

const update = (message, edited = false) => engine.handleUpdate({
  update_id: 0,
  [edited ? 'edited_message' : 'message']: { date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'You' }, ...message },
});
let liveSharedOn = null; // Telegram sends the first live location as a message, then edits it as you move.

console.log(`Simulating ${firstDay} → ${lastDay} (${live ? 'LIVE: Claude + TfL + weather' : 'offline: templates + estimates'})`);
if (live && !process.env.ANTHROPIC_API_KEY) console.log('(No ANTHROPIC_API_KEY set, so messages will use templates.)');
await update({ text: '/start' });

const end = localToDate(lastDay, '23:59');
let i = 0;
while (clock.now() <= end) {
  while (i < steps.length && steps[i].time <= clock.now()) {
    const s = steps[i++];
    if (s.say) {
      console.log(`\n\x1b[33m── ${hhmm(clock.now())} · you → bot: "${s.say}"\x1b[0m`);
      await update({ text: s.say });
    } else {
      console.log(`\x1b[90m   ${hhmm(clock.now())} 📍 ${s.label}\x1b[0m`);
      const day = s.at.slice(0, 10);
      await update({ location: { latitude: s.lat, longitude: s.lng, live_period: 28800 } }, liveSharedOn === day);
      liveSharedOn = day;
    }
  }
  // Live location keeps "refreshing" while you stand still, like Telegram does.
  const tr = engine.track(OWNER);
  if (tr.location && londonParts(clock.now()).mm % 5 === 0) tr.location.at = clock.now().toISOString();
  await engine.tick();
  clock.advance(1);
}

const unprompted = out.filter((m) => !/^📍 (Live location|Got your pin)/.test(m.text));
console.log(`\n\nDone: ${out.length} messages (${unprompted.length} excluding location acks).`);
if (writer.usingClaude) {
  const u = writer.usage;
  const cost = (u.input * 2 + u.output * 10) / 1e6;
  console.log(`Claude: ${u.calls} calls, ${u.input} input + ${u.output} output tokens ≈ $${cost.toFixed(3)} (Sonnet 5 at $2/$10 per M tokens)`);
}
const md = out.map((m) => `### ${dayLabel(m.at)} ${hhmm(m.at)}\n\n${m.text}\n`).join('\n');
const file = `sim-output${onlyDay ? `-${onlyDay}` : ''}.md`;
writeFileSync(file, `# Simulated trip messages\n\n${md}`);
console.log(`Saved to ${file}`);
