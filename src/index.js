import { loadData, validateData, TRIP } from './data.js';
import { Store } from './store.js';
import { Clock, localToDate, shiftDate } from './time.js';
import { Transit } from './transit.js';
import { Weather } from './weather.js';
import { Writer } from './writer.js';
import { Telegram } from './telegram.js';
import { Engine } from './engine.js';
import { startWeb } from './web.js';
import { Splitwise } from './splitwise.js';
import { Essentials } from './essentials.js';

const env = process.env;
const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

const data = loadData();
const problems = validateData(data);
if (problems.length) {
  log.error(`Fix these in the data/ files first:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

const store = new Store(env.DATA_DIR || './state');
const clock = new Clock();

// Restore a /fake test clock, but never let it leak into the real trip.
const fake = store.state.fakeNow;
// Safety: the test clock switches itself off the day before the trip starts.
const firstDay = Object.keys(data.days).sort()[0];
const cutoff = localToDate(shiftDate(firstDay, -1), '00:00');
if (fake && new Date() < cutoff) {
  clock.offsetMs = new Date(fake.fake) - new Date(fake.real);
} else if (fake) {
  store.resetTripProgress();
  log.warn('Test clock was still on; turned it off and reset trip progress for the real trip.');
}

// Pre-approve the owner and group from env, so moving servers doesn't need /start again.
// (In a private chat, the chat id is the same as the user id.)
if (env.OWNER_USER_ID && !store.state.ownerChatId) {
  store.state.ownerChatId = Number(env.OWNER_USER_ID);
  store.state.ownerUserId = Number(env.OWNER_USER_ID);
}
for (const id of (env.APPROVED_GROUP_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
  store.state.groups[id] ||= { title: 'group', approved: true };
}
store.save();

if (!env.TELEGRAM_BOT_TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN is not set. Add it to .env (local) or Railway Variables (cloud). See README Part 1.');
  process.exit(1);
}
const telegram = new Telegram(env.TELEGRAM_BOT_TOKEN, { log });
const me = await telegram.me().catch((err) => {
  log.error(`Telegram rejected the bot token (${err.message}). Copy it again from @BotFather.`);
  process.exit(1);
});
const writer = new Writer({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || 'claude-sonnet-5', log, trip: data.trip });

const engine = new Engine({
  data, store, clock, log,
  transport: telegram,
  writer,
  transit: new Transit({
    appKey: env.TFL_APP_KEY || '', log, transport: data.trip.transport, region: data.trip.region,
    // Live traffic for drive times: Google Routes API, or TomTom (free, no card).
    traffic: env.GOOGLE_MAPS_API_KEY ? { provider: 'google', key: env.GOOGLE_MAPS_API_KEY } : env.TOMTOM_API_KEY ? { provider: 'tomtom', key: env.TOMTOM_API_KEY } : null,
  }),
  weather: new Weather({ log }),
  publicUrl: env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  botUsername: me.username,
  ownerUserId: env.OWNER_USER_ID || '',
  splitwise: new Splitwise({ apiKey: env.SPLITWISE_API_KEY || '', groupId: env.SPLITWISE_GROUP_ID || null, log }),
  essentials: new Essentials({ log }),
});

startWeb({ engine, port: Number(env.PORT || 3000), log });

log.info(`Trip: ${TRIP} (${data.trip.name}). @${me.username} running. Owner: ${store.state.ownerChatId ? 'set' : 'not yet (send /start in a DM)'}. Writer: ${writer.usingClaude ? writer.model : 'templates'}.`);
log.info(`Live traffic: ${env.GOOGLE_MAPS_API_KEY ? 'Google' : env.TOMTOM_API_KEY ? 'TomTom' : 'off (OSRM estimates)'}.`);
log.info(`Splitwise: ${env.SPLITWISE_API_KEY ? 'connected' : 'not set (expenses tracked in the bot)'}.`);
if (!env.ANTHROPIC_API_KEY) log.warn('ANTHROPIC_API_KEY not set: messages will use simple templates.');

const timer = setInterval(() => engine.tick(), 60_000);
engine.tick();

const shutdown = () => {
  log.info('shutting down');
  clearInterval(timer);
  telegram.stop();
  store.save();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await telegram.start((u) => engine.handleUpdate(u));
