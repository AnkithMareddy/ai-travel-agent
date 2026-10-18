// Live-traffic drive times (Google Routes / TomTom), rate-limited per destination, falling back to OSRM estimates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transit } from '../src/transit.js';

const silent = { info() {}, warn() {}, error() {} };
const region = { name: 'Ireland', bbox: [-10.8, 51.3, -5.3, 55.5] };
const dingle = { lat: 52.1409, lng: -10.2671 };
const tarbert = { lat: 52.5847, lng: -9.37 };

function fakeFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push(url);
      const h = handlers.find(([re]) => re.test(url));
      if (!h) throw new Error(`unexpected ${url}`);
      const body = await h[1](url, opts);
      return { ok: body !== null, status: body === null ? 500 : 200, json: async () => body };
    },
  };
}
const osrm = [/router\.project-osrm/, () => ({ routes: [{ duration: 100 * 60, distance: 110_000 }] })];

test('TomTom: live time and traffic delay go into the drive summary', async () => {
  const f = fakeFetch([osrm, [/api\.tomtom\.com/, () => ({ routes: [{ summary: { travelTimeInSeconds: 120 * 60, trafficDelayInSeconds: 14 * 60 } }] })]]);
  const t = new Transit({ transport: 'drive', region, fetchImpl: f.fetch, log: silent, traffic: { provider: 'tomtom', key: 'k' } });
  const r = await t.route(dingle, tarbert, new Date());
  assert.equal(r.minutes, Math.round(100 * 1.2 * 1.05 + 3));
  assert.match(r.summary, /incl\. ~14 min of traffic/);
  assert.equal(r.source, 'live traffic (tomtom)');
  // The car moved a bit: same destination within 5 min reuses the ratio (no new lookup).
  await t.route({ lat: 52.15, lng: -10.2 }, tarbert, new Date());
  assert.equal(f.calls.filter((u) => /tomtom/.test(u)).length, 1);
});

test('Google Routes API: duration vs staticDuration gives the delay', async () => {
  let sent;
  const f = fakeFetch([osrm, [/routes\.googleapis\.com/, (url, opts) => { sent = opts; return { routes: [{ duration: '6300s', staticDuration: '6000s' }] }; }]]);
  const t = new Transit({ transport: 'drive', region, fetchImpl: f.fetch, log: silent, traffic: { provider: 'google', key: 'g' } });
  const r = await t.route(dingle, tarbert, new Date());
  assert.equal(sent.headers['x-goog-api-key'], 'g');
  assert.equal(JSON.parse(sent.body).routingPreference, 'TRAFFIC_AWARE');
  assert.match(r.summary, /incl\. ~5 min of traffic/);
});

test('provider down or trip far ahead: the usual OSRM estimate', async () => {
  const f = fakeFetch([osrm, [/api\.tomtom\.com/, () => null]]);
  const t = new Transit({ transport: 'drive', region, fetchImpl: f.fetch, log: silent, traffic: { provider: 'tomtom', key: 'k' } });
  const r = await t.route(dingle, tarbert, new Date());
  assert.equal(r.minutes, Math.round(100 * 1.15 + 3));
  const later = await t.route(dingle, { lat: 53.27, lng: -9.05 }, new Date(Date.now() + 5 * 3600_000));
  assert.equal(later.source, 'osrm');
  assert.equal(f.calls.filter((u) => /tomtom/.test(u)).length, 1, 'no live lookup for a drive 5h from now');
});
