import { londonParts, hhmm, addMin, minutesBetween, localToDate, shiftDate, dayLabel, toMinutes } from './time.js';
import { distanceM, areaAt, inRegion } from './geo.js';
import { googleMapsLink, citymapperLink, googleSearchLink } from './links.js';
import { rankPlaces, pickVaried, categoriesFor, quickMinutes } from './recommend.js';
import { describeHours } from './hours.js';
import { resolveWish, norm, MAPS_LINK, resolveMapsLink, guessCategory } from './wishlist.js';
import { newTrack } from './store.js';
import { answerTools } from './writer.js';
import { hourAt } from './weather.js';
import { sunTimes, compass } from './sun.js';
import { packingList } from './packing.js';
import { Splitwise, memberName } from './splitwise.js';
import { parsePaid, settle, money, venmoLink, usdRates, toCsv, splitwiseShares } from './expenses.js';
import { Essentials, essentialFor } from './essentials.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Help text; examples come from trip.helpExamples so each trip reads naturally.
function helpText(trip) {
  const ex = {
    directions: 'Kutir', plan: '2026-10-10 14:15-17:00 Movie premiere @ Southbank Centre', skip: 'Chelsea', want: 'Arsenal museum',
    nearby: ['food near me', 'best streetwear near me', 'sports bar near me'],
    ...(trip.helpExamples || {}),
  };
  const wake = trip.wakeWord || 'Cench';
  return `Here's what I do:
• Auto: leave-by alerts, free-time ideas, new-area tips, ${trip.schedule.morningBrief} morning brief, late-night wrap-up${trip.transport === 'drive' ? ', and "time to move on" nudges at each stop so the road trip stays on schedule' : ''}.
• With the group: share <b>Live Location</b> in the group chat (📎 → Location → Share Live Location → 8 hours).
• Off on your own: DM me and share your Live Location there. I'll guide <i>you</i> and make sure you're back for the group plans.

In the group chat, start with <b>${wake}</b> (e.g. <i>${wake} what now?</i>). In a private chat with me, no need.

Text me anytime:
• <i>what now?</i>
• ${ex.nearby.map((n) => `<i>${n}</i>`).join(' · ')}
• <i>how do I get to ${ex.directions}</i> (or ${trip.transport === 'drive' ? 'tonight\'s base' : 'home'} / the airport / any place)
• <i>skip</i> (drop the last suggestion)
• <i>we're running late 20 min</i> · <i>we're on time</i>

Your own plans (group plans always come first):
• <code>/plan ${ex.plan}</code>
• or just tell me in words, e.g. <i>${wake}, only I'm going to … at 2:15 on the 10th</i>
• Not going to one of the group plans? <code>/skipplan ${ex.skip}</code> (the group gets told; flights can't be skipped)
• /myplans to see yours · <code>/unplan 1</code> to remove

Wishlist (anyone, anytime, even before the trip):
• <code>/want ${ex.want}</code> or <i>add … to the list</i>
• /wishlist to see everything · <code>/unwish 3</code> to remove one
• Decided? <i>lock in #3 Friday 22:00</i> or <code>/lockin 3 2026-10-02 22:00</code> moves it into the group plan (<code>/unlock N</code> to undo)

Screenshots: drop a booking confirmation, a map pin or a place's post in the chat (or send it to me privately) and I'll save the booking or add the place. PDFs work too.
• /bookings shows everything saved, with reference numbers

Weather + packing: /weather (now, next hours, along today's route) · /pack (what to bring today; <code>/pack tomorrow</code>). I also warn you when rain or strong wind is about to hit.
Tell me what you decide each night (<i>${wake}, tomorrow we're doing …</i>) and I'll update the day.

Money: snap a receipt with a caption (<i>dinner at Kai, all of us</i>) or say <i>${wake}, I paid 45 for petrol</i>. Split evenly unless you say otherwise. /expenses shows the running tab · <code>/unpaid N</code> to undo · /report at the end gives you one Splitwise entry per currency (I send it automatically on the last day).
Reminders: <i>${wake}, remind us in 2h to move the car</i> · /reminders
Votes: <i>${wake}, poll: Kai or Dough Bros for dinner</i>
Ask for food or things to do and I'll say how to book each one. On the road, <i>${wake}, where can we eat on the way?</i> finds places ahead of you that are still serving when you get there.
${(trip.sunPings || []).length ? `🌅 I'll ping you before ${trip.sunPings.join(' and ')} with the best spot nearby (/sun for times) and send a 📓 recap of the day each night (/journal).\n` : ''}
On the road: <i>petrol near me</i> · <i>toilets?</i> · <i>nearest ATM</i> · <i>pharmacy</i> · <i>where can we park</i> (free, from OpenStreetMap)${trip.transport === 'tfl' ? '\nTube trouble? /tube shows live delays.' : ''}
↩️ Reply to any message with your question and I'll read the message you replied to.

Commands: /today /weather /pack /bookings /expenses /reminders /status /map /wishlist /myplans /mute 60 /unmute /help`;
}

// What a message carries that Claude can read: a photo (Telegram sends JPEGs), an image file, or a PDF.
// Phone screenshots are tall (about 2.1:1); normal photos are 4:3 or 16:9.
function mediaOf(msg) {
  if (msg?.photo?.length) {
    const p = msg.photo.at(-1);
    return { kind: 'photo', fileId: p.file_id, size: p.file_size || 0, mime: 'image/jpeg', screenshot: p.height / p.width >= 1.9 };
  }
  const d = msg?.document;
  if (!d) return null;
  if (d.mime_type === 'application/pdf') return { kind: 'pdf', fileId: d.file_id, size: d.file_size || 0 };
  if (/^image\/(jpeg|png|gif|webp)$/.test(d.mime_type || '')) return { kind: 'image', fileId: d.file_id, size: d.file_size || 0, mime: d.mime_type };
  return null;
}

// Trust the bytes over the label (a "photo" can be a PNG when sent from some apps).
const TRIP_SLUG = (trip) => (trip.region?.name || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-');

const sniffImage = (b64) => ({ '/9j/': 'image/jpeg', iVBO: 'image/png', R0lG: 'image/gif', UklG: 'image/webp' })[b64.slice(0, 4)] || null;

const EXPOSED = /\b(cliffs?|slea head|downpatrick|causeway|carrick-a-rede|slieve|sky road|atlantic drive|strand|beach|pier|dunquin|slea|diamond hill|gleniff|mussenden|dunluce|ladies' view)\b/i;
const skyEmoji = (sky = '') => (/thunder/.test(sky) ? '⛈' : /rain|drizzle|shower/.test(sky) ? '🌧' : /fog/.test(sky) ? '🌫' : /overcast/.test(sky) ? '☁️' : /partly|mostly/.test(sky) ? '⛅' : /clear/.test(sky) ? '☀️' : '🌥');

export class Engine {
  constructor({ data, store, clock, transport, writer, transit, log = console, weather, publicUrl = '', botUsername = '', ownerUserId = '', splitwise = null, essentials = null }) {
    Object.assign(this, { data, store, clock, transport, writer, transit, weather, log, publicUrl, botUsername, ownerUserId });
    this.splitwise = splitwise || new Splitwise({ log });
    this.essentials = essentials || new Essentials({ offline: true, log });
    // Updates and the minute timer both switch "the current track"; run them one at a time so they can't interleave.
    this.queue = Promise.resolve();
    writer.onUsage = (u) => this.recordUsage(u);
    writer.onTrouble = (kind) => this.trouble(kind).catch(() => {});
    this.sched = data.trip.schedule;
    // Group plans = the itinerary + anything the group locked in from the wishlist at runtime.
    const basePlans = data.plans;
    this.basePlans = basePlans;
    Object.defineProperty(this.data, 'plans', {
      configurable: true,
      get: () => [...basePlans.filter((p) => !(this.s.droppedStops || []).includes(p.id)), ...this.lockedPlans()].sort((a, b) => a.start - b.start),
    });
    // Days = the itinerary + what the group changed at runtime (tomorrow's plan from the chat, booked stays).
    const baseDays = data.days;
    Object.defineProperty(this.data, 'days', {
      configurable: true,
      get: () => {
        const o = this.s.dayOverrides || {};
        if (!Object.keys(o).length) return baseDays;
        return Object.fromEntries(Object.entries(baseDays).map(([d, v]) => [d, o[d] ? {
          ...v,
          ...(o[d].flow ? { flow: o[d].flow, originalFlow: v.flow } : {}),
          ...(o[d].base ? { base: o[d].base } : {}),
        } : v]));
      },
    });
    this.help = helpText(data.trip);
    this.wake = wakeRegex(data.trip.wakeWord);
    this.tools = answerTools({ ...data.trip, daysList: data.days });
    this.ticking = false;
    this._tr = null;
  }

  get s() { return this.store.state; }

  // Where they're sleeping: London has one Airbnb; a road trip has a base per night (days[date].base).
  // Before noon it's last night's base (you haven't checked out/moved yet); after noon, tonight's.
  homeFor(now = this.now()) {
    const p = londonParts(now);
    const tonight = this.data.days[p.date]?.base;
    const lastNight = this.data.days[shiftDate(p.date, -1)]?.base;
    return (p.minutes < 12 * 60 ? lastNight || tonight : tonight || lastNight) || this.data.trip.home;
  }

  get home() { return this.homeFor(); }

  dayMode(now) { return this.data.days[londonParts(now).date]?.transport || null; }
  route(from, to, now) { return this.transit.route(from, to, now, this.dayMode(now)); }
  driving(now = this.now()) { return this.data.trip.transport === 'drive' && this.dayMode(now) !== 'city'; }
  quick(a, b, now = this.now()) { return quickMinutes(a, b, this.driving(now)); }
  weatherFor(date) { return this.weather.forDay(date, this.data.days[date]?.base || this.data.trip.home); }
  inRegion(p) { return inRegion(this.data.trip.region, p); }
  now() { return this.clock.now(); }

  // ---------------------------------------------------------------- tracks (group chat vs individual DMs)

  track(chatId) {
    const k = String(chatId);
    this.s.tracks[k] ||= newTrack(chatId);
    return this.s.tracks[k];
  }

  // The track we're currently acting for. Defaults to the main (group) track.
  get tr() {
    if (this._tr) return this._tr;
    const main = this.broadcastTargets()[0];
    return main === undefined ? (this._scratch ||= newTrack(0)) : this.track(main);
  }

  async withTrack(chatId, fn) {
    const prev = this._tr;
    this._tr = this.track(chatId);
    try { return await fn(); } finally { this._tr = prev; }
  }

  isMainTrack(t = this.tr) { return this.broadcastTargets().includes(t.chatId); }
  personName(userId) { return this.s.members[userId] || (String(userId) === String(this.s.ownerUserId) ? 'you' : 'friend'); }

  // Where a track's messages go. A person who hasn't opened a DM with the bot gets tagged in the group instead.
  targetsFor(t = this.tr) {
    if (t.isGroup || this.isMainTrack(t) || this.s.dm[t.chatId]) return { chatIds: [t.chatId], prefix: '' };
    return { chatIds: this.broadcastTargets(), prefix: `👤 ${this.personName(t.chatId)}: ` };
  }

  markT(key) { this.tr.keys[key] = this.now().toISOString(); }
  mark(key) { this.s.keys[key] = this.now().toISOString(); }
  placeById(id) { return this.allPlaces().find((p) => p.id === id); }

  // Built-in places plus anything friends added to the wishlist (flagged so they rank higher).
  allPlaces() {
    const wl = this.s.wishlist || [];
    const byId = new Map(wl.filter((w) => w.placeId).map((w) => [w.placeId, w]));
    const base = this.data.places.map((p) => (byId.has(p.id)
      ? { ...p, wishlist: true, why: `${p.why} (on ${byId.get(p.id).by}'s wishlist)` }
      : p));
    return [...base, ...wl.filter((w) => w.place).map((w) => ({ ...w.place, wishlist: true }))];
  }

  // ---------------------------------------------------------------- sending

  // lookup: extra places that {{id}} may refer to (e.g. sunset viewpoints), linked only if mentioned.
  formatText(text, places = [], from = null, lookup = []) {
    // {{id}} already renders bold, so drop any **…** Claude put around it.
    let html = esc(text.replace(/\*\*\s*(\{\{[\w-]+\}\})\s*\*\*/g, '$1')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const linked = [...places];
    html = html.replace(/\{\{([\w-]+)\}\}/g, (_, id) => {
      const p = lookup.find((x) => x.id === id) || this.placeById(id);
      if (!p) return '';
      if (!linked.includes(p)) linked.push(p);
      return `<b>${esc(p.name)}</b>`;
    });
    // Road-trip car days get driving directions (Citymapper only covers cities); otherwise public transport.
    const driving = this.driving();
    const lines = linked.filter((p) => p?.lat).map((p) => (driving
      ? (from && distanceM(from, p) < 1500
        ? `📍 ${esc(p.name)}: <a href="${esc(googleMapsLink(from, p, 'walking'))}">Google Maps (walk)</a>`
        : `📍 ${esc(p.name)}: <a href="${esc(googleMapsLink(from, p, 'driving'))}">Google Maps (drive)</a>`)
      : `📍 ${esc(p.name)}: <a href="${esc(googleMapsLink(from, p))}">Google Maps</a> · <a href="${esc(citymapperLink(from, p))}">Citymapper</a>`));
    return lines.length ? `${html}\n\n${lines.join('\n')}` : html;
  }

  // Group memory: keep the last ~300 messages (14 days) per group chat.
  remember(chatId, who, text, unixOrDate) {
    if (chatId === undefined || !text?.trim()) return;
    const at = typeof unixOrDate === 'number' && unixOrDate > 0 ? new Date(unixOrDate * 1000) : this.now();
    const log = (this.s.chatLog[chatId] ||= []);
    log.push({ at: at.toISOString(), who, text: text.slice(0, 600) });
    log.sort((a, b) => new Date(a.at) - new Date(b.at));
    const cutoff = addMin(this.now(), -14 * 24 * 60);
    this.s.chatLog[chatId] = log.filter((m) => new Date(m.at) >= cutoff).slice(-300);
  }

  groupMemory(chatId, max = 60, since = null) {
    const id = chatId ?? this.broadcastTargets()[0];
    return (this.s.chatLog[id] || []).filter((m) => !since || new Date(m.at) >= since).slice(-max).map((m) => `${dayLabel(new Date(m.at))} ${hhmm(new Date(m.at))} ${m.who}: ${m.text}`);
  }

  async sendHtml(chatIds, kind, html, { unprompted = false } = {}) {
    const botName = this.data.trip.wakeWord || 'Cench';
    for (const chatId of chatIds) {
      if (chatId < 0 && !['system'].includes(kind)) this.remember(chatId, botName, html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      try {
        await this.transport.send(chatId, html);
      } catch (err) {
        this.log.error?.(`Send to ${chatId} failed: ${err.message}`);
      }
    }
    const now = this.now();
    this.store.logMessage({ at: now.toISOString(), london: `${londonParts(now).date} ${hhmm(now)}`, kind, chatIds, text: html });
    if (unprompted) this.tr.lastUnpromptedAt = now.toISOString();
    this.store.save();
  }

  async compose(chatIds, kind, facts, { places = [], from = null, unprompted = false, history, prefix = '', lookup = [] } = {}) {
    const text = await this.writer.write(kind, facts, history);
    await this.sendHtml(chatIds, kind, esc(prefix) + this.formatText(text, places, from, lookup), { unprompted });
    // If they just asked for ideas, hold off on unprompted ideas for a while.
    if (['what_now', 'nearby'].includes(kind)) this.tr.lastUnpromptedAt = this.now().toISOString();
    return text;
  }

  // Send something to the current track (its DM, or the group if that's the track).
  async composeForTrack(kind, facts, opts = {}) {
    const { chatIds, prefix } = this.targetsFor();
    return this.compose(chatIds, kind, facts, { ...opts, prefix });
  }

  broadcastTargets() {
    const groups = Object.entries(this.s.groups).filter(([, g]) => g.approved).map(([id]) => Number(id));
    if (groups.length) return groups;
    return this.s.ownerChatId ? [this.s.ownerChatId] : [];
  }

  // ---------------------------------------------------------------- context helpers

  isQuiet(now) {
    const m = londonParts(now).minutes;
    return m >= toMinutes(this.sched.quietStart) && m < toMinutes(this.sched.quietEnd);
  }

  muted(now) { return this.tr.muteUntil && now < new Date(this.tr.muteUntil); }

  canUnprompted(now) {
    if (this.isQuiet(now) || this.muted(now)) return false;
    if (!this.tr.lastUnpromptedAt) return true;
    return minutesBetween(new Date(this.tr.lastUnpromptedAt), now) >= this.sched.minGapBetweenUnpromptedMin;
  }

  freshLocation(maxAgeMin = 20, t = this.tr) {
    const l = t.location;
    if (!l) return null;
    const ageMin = minutesBetween(new Date(l.at), this.now());
    return ageMin <= maxAgeMin && ageMin >= -5 ? { ...l, ageMin } : null;
  }

  // Best known starting point: this track's location, else the group's, else the Airbnb.
  origin() {
    const l = this.freshLocation(120);
    if (l) return { lat: l.lat, lng: l.lng, live: true, label: l.ageMin > 20 ? `your last location (${l.ageMin} min ago)` : 'your current location' };
    if (!this.isMainTrack()) {
      for (const id of this.broadcastTargets()) {
        const g = this.freshLocation(120, this.track(id));
        if (g) return { lat: g.lat, lng: g.lng, live: true, label: "the group's last shared location" };
      }
    }
    const h = this.home;
    return { lat: h.lat, lng: h.lng, live: false, label: `${h.name} (no recent location shared)` };
  }

  areaName(p) { return p ? areaAt(this.data.neighborhoods, p)?.name || null : null; }

  hydratePersonal(p, userId) {
    return { ...p, start: new Date(p.start), end: new Date(p.end), arriveBy: null, fixed: true, personal: true, type: 'personal', userId, by: p.by };
  }

  personalPlansOf(userId) {
    return (this.s.personalPlans[userId] || []).map((p) => this.hydratePersonal(p, userId));
  }

  // Group plans, plus the current person's own plans when acting in their DM track.
  plans() {
    const t = this.tr;
    const own = t && !t.isGroup ? this.personalPlansOf(t.chatId) : [];
    const group = t && !t.isGroup ? this.data.plans.filter((p) => !this.optedOut(t.chatId, p.id)) : this.data.plans;
    return [...group, ...own].sort((a, b) => a.start - b.start);
  }

  optedOut(userId, planId) { return (this.s.optOuts[userId] || []).includes(planId); }
  fixedPlans() { return this.plans().filter((p) => p.fixed); }
  groupFixedPlans() { return this.data.plans.filter((p) => p.fixed); }
  plansOn(date) { return this.plans().filter((p) => londonParts(p.start).date === date); }
  currentBlock(now) { return this.plans().find((p) => p.start <= now && now < p.end) || null; }

  baseArrival(plan) { return plan.arriveBy || addMin(plan.start, -(plan.arriveEarlyMin ?? 0)); }

  arrivalTarget(plan) {
    let t = this.baseArrival(plan);
    const d = this.tr.delay;
    if (d && d.planId === plan.id && plan.type !== 'flight') t = addMin(t, d.minutes);
    return t;
  }

  // Between "leave now" (or the arrival target) and the end of a fixed plan, they're busy.
  committedPlan(now) {
    return this.fixedPlans().find((p) => now < p.end && (now >= this.arrivalTarget(p) || this.tr.keys[`leavenow:${p.id}`])) || null;
  }

  tripOver(now) {
    const last = this.groupFixedPlans().at(-1);
    return now >= this.baseArrival(last);
  }

  nextFixed(now) { return this.fixedPlans().find((p) => this.arrivalTarget(p) > now && p.leaveBy !== false) || null; }

  planFacts(plan) {
    return {
      title: plan.title,
      ...(plan.personal ? { personalPlanOf: this.personName(plan.userId) } : { groupPlan: plan.fixed ? 'locked in, everyone' : 'flexible' }),
      time: hhmm(plan.start),
      until: hhmm(plan.end),
      where: plan.location?.name,
      address: plan.location?.address,
      ...(plan.fixed && plan.leaveBy !== false ? { beThereBy: hhmm(this.arrivalTarget(plan)) } : {}),
      ...(plan.details || {}),
      ...(plan.tips ? { tips: plan.tips } : {}),
      ...this.bookingFor(plan),
    };
  }

  bookingFor(plan) {
    const bk = (this.s.bookings || []).find((b) => b.planId === plan.id);
    return bk ? { booking: [bk.confirmation && `ref ${bk.confirmation}`, bk.details].filter(Boolean).join(', ') || 'booked' } : {};
  }

  // Free time until we need to leave for the next fixed plan (quick estimate, no API call).
  gapInfo(now, from) {
    const next = this.nextFixed(now);
    const endOfDay = localToDate(londonParts(now).date, '23:30');
    if (next && next.location && minutesBetween(now, this.arrivalTarget(next)) <= 16 * 60) {
      const leaveAt = addMin(this.arrivalTarget(next), -(this.quick(from, next.location, now) + 5));
      return { next, leaveAt, gapMin: minutesBetween(now, leaveAt) };
    }
    return { next: null, leaveAt: endOfDay, gapMin: Math.max(0, minutesBetween(now, endOfDay)) };
  }

  // Same as gapInfo, but with a real travel time to the next fixed plan (used whenever we quote a leave time).
  async exactGap(now, from) {
    const g = this.gapInfo(now, from);
    if (g.next?.location) {
      const r = await this.route(from, g.next.location, now);
      g.leaveAt = addMin(this.arrivalTarget(g.next), -r.minutes);
      g.gapMin = minutesBetween(now, g.leaveAt);
    }
    return g;
  }

  excluded({ includeSuggested = true } = {}) {
    return new Set([...(includeSuggested ? this.tr.suggested : []), ...this.tr.skipped]);
  }

  placeFacts(place, route, weekday) {
    return {
      id: place.id,
      name: place.name,
      category: place.category,
      why: place.why,
      travel: route ? `${route.minutes} min (${route.summary})` : undefined,
      hoursToday: describeHours(place.hours, weekday),
    };
  }

  async withRoutes(picks, from, now) {
    const wd = londonParts(now).weekday;
    const out = [];
    for (const r of picks) {
      const route = await this.route(from, r.place, now);
      out.push(this.placeFacts(r.place, route, wd));
    }
    return out;
  }

  rememberSuggestion(places) {
    const ids = places.map((p) => p.id);
    this.tr.suggested = [...new Set([...this.tr.suggested, ...ids])];
    this.tr.lastSuggestion = ids;
  }

  personalPlansFacts(date) {
    const out = [];
    for (const uid of Object.keys(this.s.personalPlans)) {
      for (const p of this.personalPlansOf(uid)) {
        if (!date || londonParts(p.start).date === date) out.push({ who: this.personName(uid), time: `${hhmm(p.start)}–${hhmm(p.end)}`, title: p.title, where: p.location?.name || null });
      }
    }
    for (const [uid, ids] of Object.entries(this.s.optOuts)) {
      for (const id of ids) {
        const g = this.data.plans.find((p) => p.id === id);
        if (g && (!date || londonParts(g.start).date === date)) out.push({ who: this.personName(uid), time: `${hhmm(g.start)}–${hhmm(g.end)}`, title: `sitting out ${g.title}`, where: null });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the scheduler (runs every minute)

  // Main (group) track always; individual tracks when that person is sharing their own location
  // or has a personal plan coming up.
  activeTracks(now) {
    for (const uid of Object.keys(this.s.personalPlans)) this.track(uid);
    const main = this.broadcastTargets().map((id) => this.track(id));
    const solo = Object.values(this.s.tracks).filter((t) => {
      if (t.isGroup || main.includes(t)) return false;
      const ownLoc = this.freshLocation(120, t);
      const soonPlan = (this.s.personalPlans[t.chatId] || []).some((p) => new Date(p.end) > now && minutesBetween(now, new Date(p.start)) <= 300);
      return Boolean(ownLoc || soonPlan);
    });
    return [...main, ...solo];
  }

  tick() { return this.serial(() => this.runTick()); }

  async runTick() {
    if (this.ticking || !this.s.ownerChatId) return;
    this.ticking = true;
    try {
      const now = this.now();
      await this.checkUserReminders(now);
      // Group-wide messages go to the group chat.
      await this.withTrack(this.broadcastTargets()[0], async () => {
        await this.checkReminders(now);
        await this.checkMorningBrief(now);
        await this.checkNightWrap(now);
        await this.checkSunPings(now);
      });
      await this.checkPersonalBriefs(now);
      await this.withTrack(this.broadcastTargets()[0], () => this.checkFinalReport(now));
      // Location-driven alerts, per track.
      for (const t of this.activeTracks(now)) {
        await this.withTrack(t.chatId, async () => {
          if (this.tr.delay) {
            const plan = this.plans().find((p) => p.id === this.tr.delay.planId);
            if (!plan || now > plan.start) this.tr.delay = null;
          }
          await this.checkLeaveBy(now);
          await this.checkEnRoute(now);
          await this.checkStays(now);
          await this.checkStops(now);
          await this.checkNewArea(now);
          await this.checkFreeTime(now);
          await this.checkWeather(now);
        });
      }
    } catch (err) {
      this.log.error?.(`tick failed: ${err.stack || err.message}`);
    } finally {
      this.ticking = false;
      this.store.save();
    }
  }

  async checkLeaveBy(now) {
    const main = this.isMainTrack();
    const ownLoc = this.freshLocation(120);
    // A solo track without its own location only handles that person's own plans; the group track covers the rest.
    const plans = this.fixedPlans().filter((p) => main || ownLoc || p.personal);
    for (const plan of plans) {
      if (plan.leaveBy === false || !plan.location) continue;
      const target = this.arrivalTarget(plan);
      const toTarget = minutesBetween(now, target);
      if (toTarget > 240 || toTarget < -20) continue;
      const kNow = `leavenow:${plan.id}`;
      const kWarn = `leave15:${plan.id}`;
      if (this.tr.keys[kNow]) continue;
      const from = this.origin();
      if (!from.live && !this.inRegion(plan.location)) continue; // e.g. Belfast flight with no location shared
      if (from.live && distanceM(from, plan.location) < 500) { this.markT(kWarn); this.markT(kNow); continue; }
      const route = await this.route(from, plan.location, now);
      if (route.minutes > 180) continue; // location is somewhere unrelated; don't guess
      const leaveAt = addMin(target, -route.minutes);
      const untilLeave = minutesBetween(now, leaveAt);
      if (untilLeave > 15 || (untilLeave > 0 && this.tr.keys[kWarn])) continue;
      const arrive = addMin(now, route.minutes);
      const deadline = plan.type === 'flight' ? target : plan.start;
      const d = this.tr.delay?.planId === plan.id ? this.tr.delay : null;
      const facts = {
        plan: { ...this.planFacts(plan), phone: plan.details?.phone },
        from: from.label,
        leaveAt: hhmm(leaveAt),
        aimToArrive: hhmm(target),
        arriveAt: hhmm(arrive),
        route: { minutes: route.minutes, summary: route.summary, source: route.source },
        late: arrive > deadline,
        ...(d ? { delayNote: `Alerts shifted ${d.minutes} min because you said you're running late.` } : {}),
      };
      const kind = untilLeave <= 0 ? 'leave_now' : 'leave_warning';
      await this.composeForTrack(kind, facts, { places: [plan.location], from, unprompted: true });
      this.markT(kWarn);
      if (kind === 'leave_now') this.markT(kNow);
    }
  }

  // After "leave now": keep checking the live ETA (every 10 min) and warn if they'll now miss a fixed time,
  // e.g. traffic or a long stop means the 16:30 ferry goes without them.
  async checkEnRoute(now) {
    const loc = this.freshLocation(10);
    if (!loc) return;
    for (const plan of this.fixedPlans()) {
      if (plan.leaveBy === false || !plan.location || plan.type === 'arrival' || !this.tr.keys[`leavenow:${plan.id}`]) continue;
      const deadline = plan.type === 'flight' ? this.arrivalTarget(plan) : plan.start;
      if (now >= deadline || minutesBetween(now, deadline) > 300 || distanceM(loc, plan.location) < 800) continue;
      const kCheck = `enroute:${plan.id}`;
      if (this.tr.keys[kCheck] && minutesBetween(new Date(this.tr.keys[kCheck]), now) < 10) continue;
      this.markT(kCheck);
      const route = await this.route(loc, plan.location, now);
      const eta = addMin(now, route.minutes);
      const lateBy = minutesBetween(deadline, eta);
      // At most two warnings per plan: the first, and one more only if it's got 20+ min worse since.
      const kWarn = `enroutewarn:${plan.id}`;
      const [count, last] = String(this.tr.keys[kWarn] || '0:0').split(':').map(Number);
      if (lateBy < 3 || count >= 2 || (count === 1 && lateBy < last + 20)) continue;
      this.tr.keys[kWarn] = `${count + 1}:${lateBy}`;
      const day = this.data.days[londonParts(now).date] || {};
      await this.composeForTrack('late_enroute', {
        plan: { ...this.planFacts(plan), phone: plan.details?.phone },
        arriveAt: hhmm(eta),
        lateByMin: lateBy,
        route: { minutes: route.minutes, summary: route.summary, source: route.source },
        ...(plan.ifMissed ? { nextOption: plan.ifMissed } : {}),
        ...(day.fallback ? { fallback: day.fallback } : {}),
      }, { places: [plan.location], from: loc, unprompted: true });
    }
  }

  // Hotel/Airbnb bookings: the arrival card when you get there, and a check-out nudge on the last morning. Free (no Claude).
  async checkStays(now) {
    if (!this.isMainTrack() || this.isQuiet(now)) return;
    const loc = this.freshLocation(20);
    const today = londonParts(now).date;
    for (const b of (this.s.bookings || []).filter((x) => x.kind === 'stay')) {
      const kIn = `stayin:${b.n}`;
      if (loc && b.location && !this.s.keys[kIn] && today >= b.date && today < (b.endDate || shiftDate(b.date, 1)) && distanceM(loc, b.location) < 700) {
        this.mark(kIn);
        const early = b.start && localToDate(today, b.start) > now ? `\nCheck-in opens at <b>${b.start}</b>. Most places will hold your bags if you're early.` : '';
        await this.sendHtml(this.broadcastTargets(), 'stay', `🛏 <b>${esc(b.title)}</b>: you're here.${b.confirmation ? ` Ref <code>${esc(b.confirmation)}</code>.` : ''}${b.details ? `\n${esc(b.details)}` : ''}${early}${b.end && b.endDate ? `\nCheck-out ${dayLabel(b.endDate)} by <b>${b.end}</b>.` : ''}`);
      }
      const kOut = `stayout:${b.n}`;
      if (b.endDate === today && !this.s.keys[kOut]) {
        const out = localToDate(today, b.end || '11:00');
        const remindAt = new Date(Math.max(addMin(out, -75), localToDate(today, this.sched.morningBrief)));
        if (now >= remindAt && now < out) {
          this.mark(kOut);
          await this.sendHtml(this.broadcastTargets(), 'stay', `🧳 Check-out from <b>${esc(b.title)}</b> by <b>${hhmm(out)}</b>${b.end ? '' : ' (usual time, check your booking)'}. Sweep for chargers, adapters, passports and anything in the fridge or the shower.${b.details && /key|code|lockbox|box/i.test(b.details) ? `\nKey return: ${esc(b.details)}` : ''}`);
        }
      }
    }
  }

  // Road trip: when their planned time at a stop is up, nudge them on to the next one with a schedule check.
  async checkStops(now) {
    const loc = this.freshLocation(30);
    if (!loc || this.isQuiet(now)) return;
    const date = londonParts(now).date;
    const dayPlans = this.plans().filter((p) => londonParts(p.start).date === date && p.location);
    const stops = dayPlans.filter((p) => p.type === 'stop');
    const here = stops.find((st) => distanceM(loc, st.location) <= (st.radiusM || 1500));
    if (!here) return;
    const atKey = `at:${here.id}`;
    this.tr.keys[atKey] ||= now.toISOString();
    const key = `moveon:${here.id}`;
    if (this.tr.keys[key]) return;
    // They get the planned slot; if they arrived late, still give them at least 10 min there.
    const planned = minutesBetween(here.start, here.end);
    const leaveAt = new Date(Math.max(here.end, addMin(new Date(this.tr.keys[atKey]), Math.min(10, planned))));
    if (now < addMin(leaveAt, -2)) return;
    const next = dayPlans.find((p) => p.start >= here.end && p.id !== here.id && (p.type === 'stop' || p.fixed));
    if (!next || here.nudge === false || (next.fixed && (this.tr.keys[`leavenow:${next.id}`] || this.tr.keys[`leave15:${next.id}`]))) { this.markT(key); return; }
    const dest = next.location;
    const route = await this.route(loc, dest, now);
    // Only nudge when the schedule is actually tight: lots of slack (e.g. an evening pub) isn't "time to go".
    const slack = minutesBetween(here.end, next.start) - route.minutes;
    if (slack > 45) { this.markT(key); return; }
    const eta = addMin(now, route.minutes);
    const target = next ? (next.fixed ? this.arrivalTarget(next) : next.start) : null;
    const behind = target ? minutesBetween(target, eta) : 0;
    const day = this.data.days[date] || {};
    const facts = {
      leaving: here.title,
      next: next ? { title: next.title, plannedArrival: hhmm(target), lockedIn: Boolean(next.fixed), note: next.note } : { title: `${dest.name} (tonight's base)` },
      route: { minutes: route.minutes, summary: route.summary },
      eta: hhmm(eta),
      status: !target ? 'last stop of the day' : behind > 5 ? `${behind} min behind schedule` : behind < -10 ? `${-behind} min ahead of schedule` : 'on schedule',
      ...(behind >= 30 && day.fallback ? { fallback: day.fallback } : {}),
      ...(next.note ? { aboutNextStop: next.note } : {}),
    };
    await this.composeForTrack('move_on', facts, { places: [dest], from: loc, unprompted: true });
    this.markT(key);
  }

  async checkReminders(now) {
    if (this.isQuiet(now)) return;
    for (const plan of this.data.plans) {
      for (const r of plan.reminders || []) {
        const at = new Date(r.at);
        const key = `rem:${plan.id}:${r.at}`;
        if (this.s.keys[key] || now < at || minutesBetween(at, now) > (r.windowMin || 60)) continue;
        if (r.whenInArea) {
          // Wait until they're actually there (e.g. landed at Heathrow), or give up waiting after an hour.
          const loc = this.freshLocation(30);
          const there = loc && areaAt(this.data.neighborhoods, loc)?.id === r.whenInArea;
          if (!there && minutesBetween(at, now) < 60) continue;
        }
        const from = this.origin();
        const dest = r.kind === 'exit_plan' ? this.home : plan.location;
        await this.compose(this.broadcastTargets(), r.kind, r.facts, { places: [dest], from: r.kind === 'exit_plan' ? plan.location : from, unprompted: true });
        this.mark(key);
      }
    }
  }

  async checkMorningBrief(now) {
    const p = londonParts(now);
    const day = this.data.days[p.date];
    const t = toMinutes(this.sched.morningBrief);
    if (!day || p.minutes < t || p.minutes > t + 120 || this.s.keys[`brief:${p.date}`] || this.muted(now)) return;
    await this.sendMorningBrief(p.date, this.broadcastTargets());
    this.mark(`brief:${p.date}`);
  }

  async sendMorningBrief(date, chatIds, { prefix = '' } = {}) {
    const now = this.now();
    const day = this.data.days[date] || {};
    const plans = this.plansOn(date);
    const from = this.origin();
    const firstFixed = plans.find((pl) => pl.fixed && pl.leaveBy !== false && pl.location && this.arrivalTarget(pl) > now);
    let firstLeave;
    const route = firstFixed && (from.live || this.inRegion(firstFixed.location)) ? await this.route(from, firstFixed.location, now) : null;
    if (route && route.minutes <= 180) {
      firstLeave = { plan: firstFixed.title, leaveAround: hhmm(addMin(this.arrivalTarget(firstFixed), -route.minutes)), route: route.summary, from: from.label };
    }
    const facts = {
      day: day.label || dayLabel(date),
      ...(this.tr.isGroup || this.isMainTrack() ? { othersDoingTheirOwnThing: this.personalPlansFacts(date) } : { forPerson: this.personName(this.tr.chatId), note: 'Personal brief: their own plans plus the locked-in group plans they must be back for.' }),
      plans: plans.map((pl) => this.planFacts(pl)),
      flow: day.flow,
      weather: await this.weatherFor(date),
      ...(await this.packFacts(date)),
      firstLeave,
      wishlistToday: this.wishlistFacts(day.areas || []),
      ...(day.base ? { tonightsBase: `${day.base.name}${day.base.address ? `, ${day.base.address}` : ''}` } : {}),
      ...(day.driveHours ? { drivingToday: `~${day.driveHours}h total` } : {}),
      ...(day.prebook ? { bookingsToday: day.prebook } : {}),
      ...(day.fallback ? { ifRunningLate: day.fallback } : {}),
      ...(day.notes ? { heads_up: day.notes } : {}),
      ...(this.data.trip.transport === 'tfl' ? { tubeDisruptions: (await this.transit.lineStatus?.()) || 'unknown' } : {}),
      ...(day.originalFlow ? { agreedInChat: `The group changed today's plan in the chat (${this.s.dayOverrides[date]?.by || 'someone'} told me). flow is the new plan.` } : {}),
      ...(this.tr.isGroup || this.isMainTrack() ? { recentGroupChat: this.groupMemory(undefined, 40, localToDate(shiftDate(date, -1), '17:00')) } : {}),
    };
    await this.compose(chatIds, 'morning_brief', facts, { places: plans.filter((pl) => pl.fixed && pl.location).map((pl) => pl.location), from, unprompted: true, prefix });
  }

  // People with their own plans today get a personal brief in their DM too.
  async checkPersonalBriefs(now) {
    const p = londonParts(now);
    const t = toMinutes(this.sched.morningBrief);
    if (!this.data.days[p.date] || p.minutes < t + 5 || p.minutes > t + 120) return;
    for (const uid of Object.keys(this.s.personalPlans)) {
      if (!this.s.dm[uid] || this.broadcastTargets().includes(Number(uid))) continue;
      const key = `brief:${p.date}:${uid}`;
      if (this.s.keys[key] || !this.personalPlansOf(uid).some((pl) => londonParts(pl.start).date === p.date)) continue;
      await this.withTrack(uid, () => (this.muted(now) ? null : this.sendMorningBrief(p.date, [Number(uid)])));
      this.mark(key);
    }
  }

  async checkNightWrap(now) {
    const today = londonParts(now).date;
    for (const date of [today, shiftDate(today, -1)]) {
      if (!this.data.days[date] || !this.data.days[shiftDate(date, 1)] || this.s.keys[`wrap:${date}`]) continue;
      let wrapAt = localToDate(date, this.sched.nightWrap);
      for (const pl of this.data.plans.filter((x) => londonParts(x.start).date === date)) if (pl.start < wrapAt && pl.end > wrapAt) wrapAt = addMin(pl.end, 15);
      const cutoff = localToDate(shiftDate(date, 1), this.sched.quietStart);
      if (now < wrapAt || now >= cutoff || this.muted(now)) continue;
      await this.sendNightWrap(date, this.broadcastTargets());
      this.mark(`wrap:${date}`);
    }
  }

  async sendNightWrap(date, chatIds) {
    const tomorrow = shiftDate(date, 1);
    const day = this.data.days[tomorrow] || {};
    const plans = this.plansOn(tomorrow);
    const first = plans[0];
    const facts = {
      tomorrow: day.label || dayLabel(tomorrow),
      firstPlan: first ? this.planFacts(first) : null,
      allPlansTomorrow: plans.map((pl) => `${hhmm(pl.start)} ${pl.title}`),
      personalPlansTomorrow: this.personalPlansFacts(tomorrow),
      wakeBy: day.wakeBy,
      flow: day.flow,
      weather: await this.weatherFor(tomorrow),
      ...(await this.packFacts(tomorrow)),
      todayRecap: this.recapFacts(date),
      recentGroupChat: this.groupMemory(undefined, 60, localToDate(date, '06:00')),
      ...(day.originalFlow ? { alreadyAgreed: `Tomorrow's plan was already updated from the chat by ${this.s.dayOverrides[tomorrow]?.by || 'someone'}.` } : {}),
      ...(this.data.days[date]?.nightNote ? { tonight: this.data.days[date].nightNote } : {}),
      ...(day.base ? { tomorrowNightBase: day.base.name } : {}),
      ...(day.driveHours ? { drivingTomorrow: `~${day.driveHours}h` } : {}),
      ...(day.prebook ? { checkBookings: day.prebook } : {}),
    };
    const text = await this.compose(chatIds, 'night_wrap', facts, { unprompted: true });
    (this.s.journal ||= {})[date] = text;
  }

  async checkNewArea(now) {
    const loc = this.freshLocation(20);
    if (!loc || !this.inRegion(loc)) return;
    const area = areaAt(this.data.neighborhoods, loc);
    const st = this.tr.area;
    if (!area) { st.pending = null; st.current = null; return; }
    if (area.id !== st.current) {
      if (st.pending?.id !== area.id) { st.pending = { id: area.id, since: now.toISOString() }; return; }
      if (minutesBetween(new Date(st.pending.since), now) < 3) return; // must linger a few minutes
      st.current = area.id;
      st.pending = null;
    }
    const key = `area:${area.id}`;
    if (area.home || area.announce === false || this.tr.keys[key]) return;
    if (this.currentBlock(now)?.fixed || this.committedPlan(now) || this.tripOver(now) || !this.canUnprompted(now)) return;
    const gap = await this.exactGap(now, loc);
    const ranked = rankPlaces({ drive: this.driving(now),  places: this.allPlaces().filter((p) => p.neighborhood === area.id), here: loc, now, gapMin: Math.max(gap.gapMin, 30), exclude: this.excluded() });
    const picks = pickVaried(ranked, 2);
    const facts = {
      area: { name: area.name, blurb: area.blurb },
      places: await this.withRoutes(picks, loc, now),
      ...(gap.next ? { next: { title: gap.next.title, time: hhmm(gap.next.start), leaveAround: hhmm(gap.leaveAt) } } : {}),
    };
    await this.composeForTrack('new_area', facts, { places: picks.map((r) => r.place), from: loc, unprompted: true });
    this.markT(key);
    this.rememberSuggestion(picks.map((r) => r.place));
  }

  async checkFreeTime(now) {
    const p = londonParts(now);
    const [ws, we] = this.sched.freeTimeWindow.map(toMinutes);
    if (p.minutes < ws || p.minutes > we) return;
    const loc = this.freshLocation(30);
    if (!loc || !this.inRegion(loc) || !this.canUnprompted(now)) return;
    if (this.tr.snoozeUntil && now < new Date(this.tr.snoozeUntil)) return;
    if (this.tr.lastFreeTimeAt && minutesBetween(new Date(this.tr.lastFreeTimeAt), now) < this.sched.minGapBetweenFreeTimeMin) return;
    if (this.currentBlock(now) || this.committedPlan(now) || this.tripOver(now)) return;
    if (areaAt(this.data.neighborhoods, loc)?.announce === false) return; // airport, stadium
    // Road trip: no detour pitches while there are still scheduled stops ahead today.
    if (this.plans().some((pl) => pl.type === 'stop' && pl.start > now && londonParts(pl.start).date === p.date)) return;
    const gap = this.gapInfo(now, loc);
    if (gap.gapMin < 40) return;
    const ranked = rankPlaces({ drive: this.driving(now), 
      places: this.allPlaces(), here: loc, now, gapMin: gap.gapMin, nextStop: gap.next?.location,
      exclude: this.excluded(), dayAreas: this.data.days[p.date]?.areas || [],
    });
    const picks = pickVaried(ranked, 3);
    if (!picks.length) return;
    const facts = {
      now: hhmm(now),
      freeMinutes: gap.gapMin,
      next: gap.next ? { title: gap.next.title, time: hhmm(gap.next.start), leaveAt: hhmm(gap.leaveAt) } : null,
      places: await this.withRoutes(picks, loc, now),
    };
    await this.composeForTrack('free_time', facts, { places: picks.map((r) => r.place), from: loc, unprompted: true });
    this.tr.lastFreeTimeAt = now.toISOString();
    this.rememberSuggestion(picks.map((r) => r.place));
  }

  // ---------------------------------------------------------------- incoming Telegram updates

  handleUpdate(u) { return this.serial(() => this.processUpdate(u)); }

  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async processUpdate(u) {
    try {
      if (u.poll) return this.onPollUpdate(u.poll);
      if (u.my_chat_member) return await this.onMembership(u.my_chat_member);
      const msg = u.message || u.edited_message;
      if (!msg?.chat) return;
      if (msg.migrate_to_chat_id && this.s.groups[msg.chat.id]) {
        this.s.groups[msg.migrate_to_chat_id] = this.s.groups[msg.chat.id];
        delete this.s.groups[msg.chat.id];
        this.store.save();
        return;
      }
      const access = this.authorize(msg);
      if (access === 'deny') return;
      for (const m of msg.new_chat_members || []) if (!m.is_bot) this.s.members[m.id] ||= m.first_name || 'friend';
      if (typeof msg.text === 'string' && !u.edited_message) {
        const forwarded = msg.forward_origin || msg.forward_from || msg.forward_sender_name;
        if (msg.chat.type !== 'private') {
          this.remember(msg.chat.id, msg.from?.first_name || 'someone', msg.text, msg.date);
        } else if (forwarded) {
          // Forward old group messages to the bot privately and it adds them to the group's memory.
          const who = msg.forward_origin?.sender_user?.first_name || msg.forward_origin?.sender_user_name
            || msg.forward_from?.first_name || msg.forward_sender_name || 'someone';
          const when = msg.forward_origin?.date || msg.forward_date || msg.date;
          this.remember(this.broadcastTargets()[0], who, msg.text, when);
          const k = `fwdack:${msg.chat.id}`;
          if (!this.s.keys[k] || minutesBetween(new Date(this.s.keys[k]), this.now()) >= 2) {
            this.mark(k);
            await this.sendHtml([msg.chat.id], 'system', '📝 Got it, added to the group memory. Forward as many as you like; I\'ll use them as context when answering.');
          }
          return;
        }
      }
      if (msg.chat.type === 'private' && msg.from?.id) {
        this.s.dm[msg.from.id] = true;
        this.s.members[msg.from.id] ||= msg.from.first_name || 'friend';
      }
      const media = u.edited_message ? [] : (u.album || [msg]).map(mediaOf).filter(Boolean);
      await this.withTrack(msg.chat.id, async () => {
        if (media.length) return this.onMedia(u.album || [msg], media, access);
        if (msg.location) return this.onLocation(msg, Boolean(u.edited_message));
        if (typeof msg.text === 'string' && !u.edited_message) return this.onText(msg, access);
      });
    } catch (err) {
      this.log.error?.(`update failed: ${err.stack || err.message}`);
    } finally {
      this.store.save();
    }
  }

  authorize(msg) {
    const { chat } = msg;
    const user = msg.from || {};
    const isStart = /^\/start\b/.test(msg.text || '');
    if (chat.type === 'private') {
      if (!this.s.ownerChatId) {
        if (isStart && (!this.ownerUserId || String(user.id) === String(this.ownerUserId))) return 'claim';
        return 'deny';
      }
      if (chat.id === this.s.ownerChatId) return 'owner';
      if (this.s.members[user.id]) return 'member';
      return 'deny';
    }
    const g = this.s.groups[chat.id];
    if (g?.approved) {
      if (user.id && !user.is_bot) this.s.members[user.id] ||= user.first_name || 'friend';
      return 'group';
    }
    if (isStart && this.s.ownerChatId) this.requestGroupApproval(chat, user).catch((err) => this.log.error?.(err.message));
    return 'deny';
  }

  async requestGroupApproval(chat, user) {
    if (this.s.groups[chat.id]?.pending) return;
    this.s.groups[chat.id] = { title: chat.title || 'group', approved: false, pending: true };
    await this.sendHtml([this.s.ownerChatId], 'system',
      `👥 ${esc(user.first_name || 'Someone')} wants me active in the group <b>${esc(chat.title || '')}</b>.\nTo allow it, send: <code>/approve ${chat.id}</code>`);
  }

  async onMembership(m) {
    const chat = m.chat;
    if (chat.type === 'private') return;
    const status = m.new_chat_member?.status;
    if (['left', 'kicked'].includes(status)) { delete this.s.groups[chat.id]; return; }
    if (!['member', 'administrator'].includes(status) || !this.s.ownerChatId) return;
    if (String(m.from?.id) === String(this.s.ownerUserId)) {
      this.s.groups[chat.id] = { title: chat.title || 'group', approved: true };
      await this.sendHtml([chat.id], 'system', `👋 I'm in. Anyone here can share Live Location or ask me stuff (start your message with "${this.data.trip.wakeWord || 'Cench'}", or reply to me).\n\n${this.help}`);
      await this.sendHtml([this.s.ownerChatId], 'system', `✅ Group <b>${esc(chat.title || '')}</b> approved automatically because you added me. Alerts now go to the group.`);
    } else {
      await this.requestGroupApproval(chat, m.from || {});
    }
  }

  async onLocation(msg, edited) {
    const { latitude, longitude, live_period: live } = msg.location;
    const now = this.now();
    this.tr.location = { lat: latitude, lng: longitude, at: now.toISOString(), userId: msg.from?.id, name: msg.from?.first_name };
    if (this.isMainTrack()) this.addToTrail(now, { lat: latitude, lng: longitude });
    if (edited) return;
    const ackKey = `ack:${msg.chat.id}`;
    if (live && this.s.keys[ackKey] && minutesBetween(new Date(this.s.keys[ackKey]), now) < 360) return;
    if (live) this.mark(ackKey);
    const area = this.areaName({ lat: latitude, lng: longitude });
    const where = area ? ` You're in ${area}.` : this.inRegion({ lat: latitude, lng: longitude }) ? '' : ` (Outside ${this.data.trip.region.name}: I'll hold the local tips until you're there.)`;
    const solo = !this.tr.isGroup && !this.isMainTrack();
    const text = live
      ? solo
        ? `📍 Live location on for ${Math.round(live / 3600)}h. I'll guide <b>you</b> from here, privately, and make sure you're back in time for the group plans.${where}`
        : `📍 Live location on for ${Math.round(live / 3600)}h. I'll handle leave-by alerts and ideas from here.${where}`
      : `📍 Got your pin.${where} For automatic updates, share <b>Live Location</b> instead (📎 → Location → Share Live Location).`;
    await this.sendHtml([msg.chat.id], 'system', text);
  }

  // Screenshots, photos and files (PDF confirmations). In the group, only screenshot-shaped images, files,
  // or anything captioned with the wake word are read, so holiday snaps don't cost anything.
  async onMedia(msgs, media, access) {
    const msg = msgs[0];
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type !== 'private';
    const caption = msgs.map((m) => m.caption).filter(Boolean).join('\n').trim();
    const mention = this.botUsername ? new RegExp(`@${this.botUsername}\\b`, 'i') : null;
    const addressed = !isGroup || this.wake.test(caption) || (mention && mention.test(caption)) || msgs.some((m) => m.reply_to_message?.from?.is_bot);
    const who = msg.from?.first_name || 'someone';
    const label = `[shared ${media.length > 1 ? `${media.length} ` : 'a '}${media.every((m) => m.kind === 'pdf') ? 'PDF' : 'screenshot'}${media.length > 1 ? 's' : ''}]`;
    if (isGroup) this.remember(chatId, who, `${label}${caption ? ` ${caption}` : ''}`, msg.date);
    const receiptCaption = /\b(paid|receipt|split|bill|tab|cost|spent|dinner|lunch|breakfast|brunch|drinks|pints|round|petrol|fuel|diesel|parking|tickets?|groceries|ferry|toll|taxi|uber)\b|[€£$]\s?\d/i.test(caption);
    if (isGroup && !addressed && !receiptCaption && !media.some((m) => m.screenshot || m.kind !== 'photo')) return;
    const quiet = isGroup && !addressed; // guessed it's a screenshot: stay silent if it's nothing useful
    const tooBig = media.filter((m) => m.size > 5_000_000);
    if (!this.writer.usingClaude || !this.transport.download) {
      if (!quiet) await this.sendHtml([chatId], 'reply', "📷 I can't read screenshots right now (Claude isn't connected). Type the details and I'll save them.");
      return;
    }
    const attachments = [];
    const files = [];
    for (const m of media.filter((x) => x.size <= 5_000_000).slice(0, 6)) {
      try {
        const { base64 } = await this.transport.download(m.fileId);
        files.push({ base64, mime: m.kind === 'pdf' ? 'application/pdf' : sniffImage(base64) || m.mime });
        attachments.push(m.kind === 'pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
          : { type: 'image', source: { type: 'base64', media_type: sniffImage(base64) || m.mime, data: base64 } });
      } catch (err) {
        this.log.warn?.(`download failed: ${err.message}`);
      }
    }
    if (!attachments.length) {
      if (!quiet) await this.sendHtml([chatId], 'reply', tooBig.length ? '📷 That file is too big for me (5 MB max). Send a screenshot of the important part instead.' : "📷 Couldn't download that one. Try sending it again.");
      return;
    }
    const text = caption.replace(/@\w+/g, '').replace(this.wake, '').replace(/^[,:!\s]+/, '').trim();
    const question = `${label}${text ? ` ${text}` : ' (no caption: pull out anything useful for the trip)'}`;
    return this.replyAnswer(chatId, this.now(), question, msg.from, { attachments, quiet, receipt: files.length === 1 ? files[0] : null });
  }

  async onText(msg, access) {
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type !== 'private';
    const raw = msg.text.trim();
    const mention = this.botUsername ? new RegExp(`@${this.botUsername}\\b`, 'i') : null;
    const addressed = !isGroup || (mention && mention.test(raw)) || msg.reply_to_message?.from?.is_bot || this.wake.test(raw);
    const text = raw.replace(/@\w+/g, '').replace(this.wake, '').replace(/^[,:!\s]+/, '').trim();
    const cmd = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if (cmd) return this.onCommand(msg, access, cmd[1].toLowerCase(), (cmd[2] || '').trim());
    // A Google Maps link is always a "let's go here": add it to the wishlist, even without the wake word.
    const maps = raw.match(MAPS_LINK);
    if (maps) return this.addFromMapsLink(chatId, msg.from, maps[0], text.replace(MAPS_LINK, '').trim());
    // In the group, only respond when someone says the wake word (or @mentions / replies to the bot). Slash commands always work.
    if (isGroup && !addressed) return;
    // Any other link: let Claude read it (web_fetch), explain it and add the place.
    if (/https?:\/\/\S+/.test(text)) return this.replyAnswer(chatId, this.now(), `${text}\n\n(They sent this link: read it, tell them in a line or two what it is, and add the place to the wishlist.)`, msg.from);
    const intent = parseIntent(text);
    const now = this.now();
    // Replying to a message: give Claude the message they replied to.
    const quoted = msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption);
    const question = quoted
      ? `${text}\n\n(They are replying to ${msg.reply_to_message.from?.is_bot ? 'your earlier message' : `${msg.reply_to_message.from?.first_name || 'someone'}'s message`}: "${quoted.slice(0, 600)}")`
      : text;
    switch (intent.type) {
      case 'expense': {
        const e = parsePaid(intent.text, this.currencyNow());
        if (e) return this.sendHtml([chatId], 'reply', (await this.logExpense(msg.from, e)).html);
        return this.replyAnswer(chatId, now, question, msg.from);
      }
      case 'remind': {
        const at = intent.inMin ? addMin(now, intent.inMin) : this.nextClockTime(now, intent.hh, intent.mm);
        return this.sendHtml([chatId], 'reply', this.addReminder(chatId, msg.from, at, intent.text).html);
      }
      case 'essential': return this.replyEssential(chatId, now, intent.kind);
      case 'what_now': return this.replyWhatNow(chatId, now);
      case 'nearby': return this.replyNearby(chatId, now, intent.categories, text);
      case 'directions': return this.replyDirections(chatId, now, intent.query);
      case 'late': return this.setDelay(chatId, now, intent.minutes);
      case 'ontime': this.tr.delay = null; return this.sendHtml([chatId], 'reply', "👍 Back on normal timing. Alerts use the original plan.");
      case 'skip': return this.skip(chatId, now);
      case 'mute': return this.mute(chatId, now, intent.minutes);
      case 'wish': return this.sendHtml([chatId], 'reply', await this.addWish(msg.from, intent.text));
      case 'show_wishlist': return this.sendHtml([chatId], 'reply', this.wishlistText());
      case 'show_myplans': return this.sendHtml([chatId], 'reply', this.myPlansText(msg.from?.id));
      default:
        // Just the wake word ("Ed", "hey Cench") with nothing after it: show what I can do.
        if (!text) return this.sendHtml([chatId], 'reply', `👋 I'm here. Try <i>${this.data.trip.wakeWord || 'Cench'} what now?</i> or /help.`);
        return this.replyAnswer(chatId, now, question, msg.from);
    }
  }

  async onCommand(msg, access, cmd, arg) {
    const chatId = msg.chat.id;
    const isOwnerDm = access === 'owner' || access === 'claim';
    const now = this.now();
    switch (cmd) {
      case 'start':
        if (access === 'claim') {
          this.s.ownerChatId = chatId;
          this.s.ownerUserId = msg.from?.id;
          this.store.save();
          return this.sendHtml([chatId], 'system', `🔒 Locked to you, ${esc(msg.from?.first_name || '')}. I'll ignore everyone else unless you approve a group.\n\nNext: add me to your group chat with the boys (I'll auto-approve it since you're the one adding me).\n\n${this.help}`);
        }
        if (msg.chat.type === 'private') {
          return this.sendHtml([chatId], 'system', `👋 Hey ${esc(msg.from?.first_name || '')}! This is your private line. Share your Live Location here when you split from the group and I'll guide you, keeping you on time for the group plans.\n\n${this.help}`);
        }
        return this.sendHtml([chatId], 'system', this.help);
      case 'help': return this.sendHtml([chatId], 'system', this.help);
      case 'approve':
      case 'revoke': {
        if (!isOwnerDm) return;
        const g = this.s.groups[arg];
        if (!g) return this.sendHtml([chatId], 'system', `No group with id ${esc(arg)}. Pending: ${esc(Object.keys(this.s.groups).join(', ') || 'none')}`);
        if (cmd === 'revoke') { delete this.s.groups[arg]; return this.sendHtml([chatId], 'system', `🚫 Removed ${esc(g.title)}.`); }
        g.approved = true;
        delete g.pending;
        await this.sendHtml([Number(arg)], 'system', `👋 Approved. I'm live in here now.\n\n${this.help}`);
        return this.sendHtml([chatId], 'system', `✅ Approved ${esc(g.title)}. Alerts now go to the group.`);
      }
      case 'want':
      case 'add':
      case 'wish':
        if (!arg) return this.sendHtml([chatId], 'reply', 'Tell me what, e.g. <code>/want Arsenal museum</code>');
        return this.sendHtml([chatId], 'reply', await this.addWish(msg.from, arg));
      case 'wishlist':
      case 'list':
        return this.sendHtml([chatId], 'reply', this.wishlistText());
      case 'unwish':
      case 'remove':
        return this.removeWish(chatId, arg);
      case 'plan':
        return this.planCommand(chatId, now, msg.from, arg);
      case 'skipplan':
      case 'rejoin': {
        if (!arg) return this.sendHtml([chatId], 'reply', `Which group plan? e.g. <code>/${cmd} Chelsea</code>`);
        const r = cmd === 'skipplan' ? await this.skipGroupPlan(msg.from, arg) : await this.rejoinGroupPlan(msg.from, arg);
        return this.sendHtml([chatId], 'reply', r.html);
      }
      case 'myplans':
      case 'plans':
        return this.sendHtml([chatId], 'reply', this.myPlansText(msg.from?.id));
      case 'lockin':
      case 'lock': {
        const m = arg.match(/^(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?$/);
        if (!m) {
          if (arg && this.writer.usingClaude) return this.replyAnswer(chatId, now, `Lock in: ${arg}`, msg.from);
          return this.sendHtml([chatId], 'reply', 'Usage: <code>/lockin 3 2026-10-02 22:00</code> (wishlist number or name, date, time[-end]), or just say it: <i>lock in Summer Inn Friday 22:00</i>');
        }
        const r = await this.lockIn(msg.from, { wishlist_item: m[1], date: m[2], start: m[3], end: m[4] });
        return this.sendHtml([chatId], 'reply', r.html);
      }
      case 'unlock':
        return this.unlock(chatId, msg.from, arg);
      case 'unplan':
        return this.removePlan(chatId, msg.from, arg);
      case 'paid':
      case 'spent': {
        const e = parsePaid(arg, this.currencyNow());
        if (e) return this.sendHtml([chatId], 'reply', (await this.logExpense(msg.from, e)).html);
        if (arg && this.writer.usingClaude) return this.replyAnswer(chatId, now, `I paid ${arg}`, msg.from);
        return this.sendHtml([chatId], 'reply', `Usage: <code>/paid 45 dinner at Kai</code> (${esc(this.currencyNow())} unless you write € or £). Or send a photo of the receipt with a caption.`);
      }
      case 'expenses':
      case 'owe':
      case 'balances':
        return this.sendHtml([chatId], 'reply', await this.expensesText());
      case 'journal':
      case 'recap': {
        const days = Object.entries(this.s.journal || {}).sort(([a], [b]) => a.localeCompare(b));
        if (!days.length) return this.sendHtml([chatId], 'reply', '📓 No recaps yet. They come with the night wrap-up each evening.');
        return this.sendHtml([chatId], 'reply', `📓 <b>Trip journal</b>\n\n${days.map(([d, t]) => `<b>${dayLabel(d)}</b>\n${this.formatText(t.split(/\n\s*\n/)[0])}`).join('\n\n')}`);
      }
      case 'sun':
      case 'sunset':
      case 'sunrise':
        return this.sendHtml([chatId], 'reply', this.sunText(now));
      case 'report':
      case 'splitwisereport':
        return this.sendHtml([chatId], 'reply', this.splitwiseReport());
      case 'venmo': {
        const h = arg.replace(/^@/, '').trim();
        if (!/^[\w-]{3,40}$/.test(h)) return this.sendHtml([chatId], 'reply', 'Usage: <code>/venmo your-handle</code> (your Venmo username, without the @).');
        (this.s.venmo ||= {})[msg.from.id] = h;
        this.store.save();
        return this.sendHtml([chatId], 'reply', `✅ Saved @${esc(h)} for ${esc(msg.from.first_name || 'you')}. Settle-up links to you will open Venmo with the amount filled in.`);
      }
      case 'export': {
        const list = this.s.expenses || [];
        if (!list.length) return this.sendHtml([chatId], 'reply', '💸 Nothing to export yet.');
        if (!this.transport.sendFile) return this.sendHtml([chatId], 'reply', '⚠️ Exporting isn\'t available here.');
        await this.transport.sendFile(chatId, `${TRIP_SLUG(this.data.trip)}-expenses.csv`, toCsv(list, await this.rates()), `💸 ${list.length} expenses. Opens in Google Sheets, Numbers or Excel.`);
        return null;
      }
      case 'unpaid':
        return this.sendHtml([chatId], 'reply', await this.removeExpense(arg));
      case 'splitwise':
        return this.sendHtml([chatId], 'reply', await this.splitwiseCommand(msg.from, arg, isOwnerDm || String(msg.from?.id) === String(this.s.ownerUserId)));
      case 'swlink':
        return this.sendHtml([chatId], 'reply', await this.swLink(msg.from, arg));
      case 'remind': {
        const r = parseIntent(`remind ${arg}`);
        if (r.type === 'remind') return this.onText({ ...msg, text: `remind ${arg}` }, access);
        if (arg && this.writer.usingClaude) return this.replyAnswer(chatId, now, `Remind ${arg}`, msg.from);
        return this.sendHtml([chatId], 'reply', 'Usage: <code>/remind us in 2h to move the car</code> or <code>/remind me at 18:30 to book dinner</code>');
      }
      case 'reminders':
        return this.sendHtml([chatId], 'reply', this.remindersText(chatId));
      case 'unremind':
        return this.sendHtml([chatId], 'reply', this.removeReminder(arg));
      case 'poll': {
        const parts = arg.split('|').map((x) => x.trim()).filter(Boolean);
        if (parts.length < 3) return this.sendHtml([chatId], 'reply', 'Usage: <code>/poll Dinner? | Kai | Dough Bros</code>');
        const r = await this.createPoll(chatId, { question: parts[0], options: parts.slice(1) });
        return r.html ? this.sendHtml([chatId], 'reply', r.html) : null;
      }
      case 'usage':
      case 'cost':
        return this.sendHtml([chatId], 'reply', this.usageText());
      case 'tube':
      case 'tfl': {
        const st = await this.transit.lineStatus?.();
        if (this.data.trip.transport !== 'tfl') return this.sendHtml([chatId], 'reply', 'No Tube on this trip 🚗');
        if (!st) return this.sendHtml([chatId], 'reply', "Couldn't reach TfL just now. Try again in a minute.");
        return this.sendHtml([chatId], 'reply', st.length
          ? `🚇 <b>Live TfL status</b> (everything else is running fine)\n${st.map((l) => `• <b>${esc(l.line)}</b>: ${esc(l.status)}${l.reason ? `\n  <i>${esc(l.reason)}</i>` : ''}`).join('\n')}`
          : '🚇 Good service on every Tube, Elizabeth line, DLR and Overground line right now.');
      }
      case 'weather':
      case 'wx':
        return this.sendHtml([chatId], 'reply', await this.weatherText(now));
      case 'pack':
      case 'packing':
        return this.sendHtml([chatId], 'reply', await this.packText(now, arg));
      case 'bookings':
      case 'booking':
        return this.sendHtml([chatId], 'reply', this.bookingsText());
      case 'unbook':
        return this.sendHtml([chatId], 'reply', this.removeBooking(arg));
      case 'today': return this.withTrack(msg.chat.type === 'private' ? msg.from.id : chatId, () => this.sendHtml([chatId], 'reply', this.todayText(now)));
      case 'status': return this.sendHtml([chatId], 'reply', this.statusText(now));
      case 'map':
      case 'web':
        return this.sendHtml([chatId], 'reply', this.publicUrl
          ? `🗺 Today's timeline + map: <a href="${esc(this.webUrl())}">open</a>`
          : 'The web page needs PUBLIC_URL set on the server (see README).');
      case 'mute': return this.mute(chatId, now, Number(arg) || 120);
      case 'unmute': this.tr.muteUntil = null; return this.sendHtml([chatId], 'reply', '🔔 Unmuted.');
      case 'whatnow': return this.replyWhatNow(chatId, now);
      case 'brief': return this.sendMorningBrief(londonParts(now).date, [chatId]);
      case 'wrap': return this.sendNightWrap(londonParts(now).date, [chatId]);
      case 'fake': {
        if (!isOwnerDm || !this.clock.setNow) return;
        if (arg === 'off' || !arg) {
          this.clock.reset();
          this.s.fakeNow = null;
          this.store.resetTripProgress();
          return this.sendHtml([chatId], 'system', `🕒 Test clock off. Real London time is ${hhmm(this.now())}. Trip progress reset so the real trip starts clean (wishlist and personal plans kept).`);
        }
        const m = arg.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/);
        if (!m) return this.sendHtml([chatId], 'system', 'Usage: <code>/fake 2026-10-10 11:00</code> or <code>/fake off</code>');
        this.store.resetTripProgress();
        const at = localToDate(m[1], m[2].padStart(5, '0'));
        this.clock.setNow(at);
        this.s.fakeNow = { fake: at.toISOString(), real: new Date().toISOString() };
        this.store.save();
        return this.sendHtml([chatId], 'system', `🕒 Test clock set: it's now <b>${dayLabel(at)} ${hhmm(at)}</b> for me. Drop a location pin (📎 → Location → move the map) to pretend you're somewhere in London. Send <code>/fake off</code> when done.`);
      }
      case 'reset':
        if (!isOwnerDm) return;
        this.store.resetTripProgress();
        return this.sendHtml([chatId], 'system', '🧹 Trip progress reset (alerts, suggestions, areas). Access list, wishlist and personal plans kept.');
      default:
        return this.sendHtml([chatId], 'system', this.help);
    }
  }

  // ---------------------------------------------------------------- replies

  async replyWhatNow(chatId, now) {
    const from = this.origin();
    const block = this.currentBlock(now) || this.committedPlan(now);
    const gap = await this.exactGap(now, from);
    let picks = [];
    if (!block?.fixed && !this.tripOver(now) && gap.gapMin >= 30) {
      const date = londonParts(now).date;
      const base = { places: this.allPlaces(), here: from, now, gapMin: gap.gapMin, nextStop: gap.next?.location, dayAreas: this.data.days[date]?.areas || [] };
      picks = pickVaried(rankPlaces({ drive: this.driving(now),  ...base, exclude: this.excluded() }), 2);
      if (!picks.length) picks = pickVaried(rankPlaces({ drive: this.driving(now),  ...base, exclude: this.excluded({ includeSuggested: false }) }), 2);
    }
    const facts = {
      now: `${dayLabel(now)} ${hhmm(now)}`,
      from: from.label,
      area: this.areaName(from),
      current: block ? `${block.title} (until ${hhmm(block.end)})` : null,
      next: gap.next ? { ...this.planFacts(gap.next), leaveAt: hhmm(gap.leaveAt) } : null,
      freeMinutes: gap.gapMin,
      places: await this.withRoutes(picks, from, now),
    };
    await this.compose([chatId], 'what_now', facts, { places: picks.map((r) => r.place), from });
    this.rememberSuggestion(picks.map((r) => r.place));
  }

  async replyNearby(chatId, now, categories, request) {
    const from = this.origin();
    const base = { places: this.allPlaces(), here: from, now, gapMin: 240, categories };
    let ranked = rankPlaces({ drive: this.driving(now),  ...base, exclude: this.excluded() });
    if (ranked.length < 3) ranked = rankPlaces({ drive: this.driving(now),  ...base, exclude: this.excluded({ includeSuggested: false }) });
    ranked.sort((a, b) => (b.score - b.travelTo * 0.4) - (a.score - a.travelTo * 0.4));
    const picks = pickVaried(ranked, 3);
    const gap = await this.exactGap(now, from);
    const facts = {
      request,
      from: from.label,
      now: hhmm(now),
      places: await this.withRoutes(picks, from, now),
      ...(gap.next ? { next: { title: gap.next.title, time: hhmm(gap.next.start), leaveAt: hhmm(gap.leaveAt) } } : {}),
      ...(from.live ? {} : { note: 'No live location shared, so distances are from the Airbnb.' }),
    };
    await this.compose([chatId], 'nearby', facts, { places: picks.map((r) => r.place), from });
    this.rememberSuggestion(picks.map((r) => r.place));
  }

  findDestination(query, now) {
    const q = norm(query).replace(/^the /, '');
    if (!q) return null;
    if (/\b(home|airbnb|the flat|our place|base|bed|hotel|bnb|b&b|tonight'?s base)\b/.test(q)) {
      const h = this.homeFor(new Date(Math.max(now, localToDate(londonParts(now).date, '12:00'))));
      return { name: h.name, address: h.address, lat: h.lat, lng: h.lng };
    }
    if (/\b(airport|heathrow|lhr|flight|terminal)\b/.test(q)) {
      const flights = this.groupFixedPlans().filter((p) => p.type === 'flight' && p.leaveBy !== false);
      const flight = flights.find((p) => p.start > now && this.inRegion(p.location)) || flights.at(-1);
      if (!flight) return null;
      return { ...flight.location, plan: flight };
    }
    const scored = [];
    for (const plan of this.plans()) {
      if (!plan.location) continue;
      const names = [plan.id, plan.title, plan.location?.name].map(norm);
      if (names.some((n) => n && (n.includes(q) || q.includes(norm(plan.location?.name || '#'))))) scored.push({ score: 100, target: { ...plan.location, plan } });
      else if (/stadium|west ham|match|game/.test(q) && plan.type === 'match') scored.push({ score: 90, target: { ...plan.location, plan } });
    }
    for (const p of this.allPlaces()) {
      const n = norm(p.name);
      if (n.includes(q) || q.includes(n)) scored.push({ score: 80 + Math.min(n.length, q.length), target: p });
      else if (q.length >= 4 && n.split(' ')[0] === q.split(' ')[0]) scored.push({ score: 50, target: p });
    }
    for (const a of this.data.neighborhoods) {
      if (norm(a.name).includes(q) || q.includes(norm(a.name).split(' ')[0])) scored.push({ score: 40, target: { name: a.name, lat: a.lat, lng: a.lng } });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.target || null;
  }

  async replyDirections(chatId, now, query) {
    const target = this.findDestination(query, now);
    const from = this.origin();
    if (!target) {
      return this.sendHtml([chatId], 'reply', `I don't have "${esc(query)}" in the trip list. Here's a map search: <a href="${esc(googleSearchLink(query))}">Google Maps</a>`);
    }
    const route = await this.route(from, target, now);
    const plan = target.plan;
    const facts = {
      to: target.name,
      from: from.label,
      route: { minutes: route.minutes, summary: route.summary, source: route.source },
      ...(plan?.fixed ? { plan: this.planFacts(plan), leaveAt: hhmm(addMin(this.arrivalTarget(plan), -route.minutes)) } : {}),
    };
    await this.compose([chatId], 'directions', facts, { places: [target], from });
  }

  async setDelay(chatId, now, minutes) {
    const next = this.nextFixed(now);
    if (!next) return this.sendHtml([chatId], 'reply', 'No fixed plans coming up, so take your time.');
    const from = this.origin();
    const route = await this.route(from, next.location, now);
    const fallback = minutes >= 30 ? this.data.days[londonParts(now).date]?.fallback : null;
    const fb = fallback ? `\n💡 Plan B: ${esc(fallback)}` : '';
    if (next.immovable) {
      const leave = addMin(this.arrivalTarget(next), -route.minutes);
      const icon = next.type === 'ferry' ? '⛴' : '✈️';
      return this.sendHtml([chatId], 'reply', `${icon} <b>${esc(next.title)}</b> won't wait. You still need to be at <b>${esc(next.location.name)}</b> by <b>${hhmm(this.arrivalTarget(next))}</b>. Leave by <b>${hhmm(leave)}</b> (${esc(route.summary)}, ~${route.minutes} min).${next.ifMissed ? `\nIf you miss it: ${esc(next.ifMissed)}` : ''}${fb}`);
    }
    this.tr.delay = { minutes, planId: next.id, setAt: now.toISOString() };
    delete this.tr.keys[`leave15:${next.id}`];
    delete this.tr.keys[`leavenow:${next.id}`];
    const target = this.arrivalTarget(next);
    const leave = addMin(target, -route.minutes);
    const lateBy = minutesBetween(next.start, target);
    let html = `⏱ Got it, shifted <b>${esc(next.title)}</b> alerts by ${minutes} min. New plan: leave ~<b>${hhmm(leave)}</b>, arrive ~<b>${hhmm(target)}</b> (booking is ${hhmm(next.start)}).`;
    if (lateBy > 0) html += `\n⚠️ That's ${lateBy} min after the booking.${next.details?.phone ? ` Call them: <b>${esc(next.details.phone)}</b>` : ''}`;
    await this.sendHtml([chatId], 'reply', html + fb);
  }

  async skip(chatId, now) {
    const ids = this.tr.lastSuggestion || [];
    if (!ids.length) return this.sendHtml([chatId], 'reply', "Nothing to skip right now. (Fixed plans stay fixed; edit itinerary.json if something really changes.)");
    this.tr.skipped = [...new Set([...this.tr.skipped, ...ids])];
    this.tr.lastSuggestion = [];
    this.tr.snoozeUntil = addMin(now, 60).toISOString();
    const names = ids.map((id) => this.placeById(id)?.name).filter(Boolean).join(', ');
    await this.sendHtml([chatId], 'reply', `👌 Skipped ${esc(names)}. No more ideas for an hour unless you ask. Leave-by alerts stay on.`);
  }

  async mute(chatId, now, minutes) {
    this.tr.muteUntil = addMin(now, minutes).toISOString();
    await this.sendHtml([chatId], 'reply', `🔕 Muted ideas and tips until ${hhmm(addMin(now, minutes))}. Leave-by alerts still come through. /unmute to undo.`);
  }

  async replyAnswer(chatId, now, question, from, { attachments = [], quiet = false, receipt = null } = {}) {
    const origin = this.origin();
    const date = londonParts(now).date;
    const ranked = rankPlaces({ drive: this.driving(now),  places: this.allPlaces(), here: origin, now, gapMin: 300, exclude: new Set(this.tr.skipped) }).slice(0, 12);
    const wd = londonParts(now).weekday;
    const gap = await this.exactGap(now, origin);
    const asker = from?.first_name || 'someone';
    const facts = {
      question,
      askedBy: asker,
      now: `${dayLabel(now)} ${hhmm(now)}`,
      where: origin.live ? this.areaName(origin) || origin.label : origin.label,
      today: this.data.days[date] || null,
      tripDays: Object.fromEntries(Object.entries(this.data.days).map(([d, v]) => [dayLabel(d), { date: d, flow: v.flow, wakeBy: v.wakeBy, groupPlans: this.data.plans.filter((p) => londonParts(p.start).date === d).map((p) => `${hhmm(p.start)} ${p.title}`) }])),
      note: 'nearbyPlaces are near their current location right now; for questions about another day, build the answer around tripDays and the places named in that day\'s flow.',
      next: gap.next ? { ...this.planFacts(gap.next), leaveAt: hhmm(gap.leaveAt) } : null,
      fixedPlans: this.groupFixedPlans().map((p) => ({ date: dayLabel(p.start), ...this.planFacts(p) })),
      askersPersonalPlans: from?.id ? this.personalPlansOf(from.id).map((p) => ({ date: dayLabel(p.start), ...this.planFacts(p) })) : [],
      everyonesPersonalPlans: this.personalPlansFacts(),
      home: this.home,
      nearbyPlaces: ranked.map((r) => ({ ...this.placeFacts(r.place, null, wd), approxMin: r.travelTo })),
      groupWishlist: this.wishlistFacts(),
      bookings: this.bookingFacts(),
      ...(await this.onTheRoad(now, origin)),
      tripPeople: this.peopleNames(),
      currencyHere: this.currencyNow(),
      ...(Object.keys(this.s.polls || {}).length ? { recentPolls: this.pollFacts() } : {}),
      ...(this.data.trip.transport === 'tfl' ? { tubeDisruptions: (await this.transit.lineStatus?.()) || 'unknown' } : {}),
      recentGroupChat: this.groupMemory(this.tr.isGroup ? this.tr.chatId : undefined),
      fallbackText: `I'm best at: "what now?", "food near me", "how do I get to ${this.data.trip.helpExamples?.directions || this.data.trip.exampleDestination || 'the next plan'}", "skip", "we're running late 20 min". /help for more.`,
    };
    const history = cleanHistory(this.tr.history);
    const extras = [];
    const added = [];
    // Research can take 10–30 s: keep "typing…" showing until the answer is ready.
    this.transport.typing?.(chatId);
    const typingTimer = this.transport.typing ? setInterval(() => this.transport.typing(chatId), 4500) : null;
    const run = async (name, input) => {
      if (name === 'save_personal_plan') {
        const r = await this.addPersonalPlan(from, {
          title: input.title, date: input.date, start: input.start, end: input.end, place: input.place, arriveEarlyMin: input.arrive_early_min,
        });
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'lock_in_plan') {
        const r = await this.lockIn(from, input);
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'skip_group_plan') {
        const r = await this.skipGroupPlan(from, input.plan);
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'log_expense') {
        const r = await this.logExpense(from, input, { receipt });
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'set_reminder') {
        const m = String(input.when || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/);
        const r = m ? this.addReminder(chatId, from, localToDate(m[1], m[2].padStart(5, '0')), input.text) : { html: '', summary: { saved: false, error: 'when must be "YYYY-MM-DD HH:MM"' } };
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'create_poll') {
        const r = await this.createPoll(chatId, input);
        if (r.html) extras.push(r.html);
        return r.summary;
      }
      if (name === 'save_booking') {
        const r = await this.saveBooking(from, input);
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'update_day_plan') {
        const r = this.updateDayPlan(from, input);
        extras.push(r.html);
        return r.summary;
      }
      if (name === 'add_to_wishlist') {
        const r = await this.addWishItem(from, input.text, input.note);
        added.push(r);
        return { saved: r.status === 'added', status: r.status, name: r.name, area: r.area };
      }
      return { error: 'unknown tool' };
    };
    let text = await this.writer.answerWithTools?.(facts, history, this.tools, run, { attachments }).catch((err) => {
      this.log.warn?.(`answer with tools failed: ${err.message}`);
      return null;
    }).finally(() => typingTimer && clearInterval(typingTimer));
    if (attachments.length) {
      // Nothing trip-related in the screenshot: say so in private, stay quiet in the group.
      if (text == null || /^\s*SKIP\b/.test(text)) {
        if (extras.length || added.length) text = '';
        else if (quiet) return;
        else return this.sendHtml([chatId], 'reply', text == null ? "📷 Couldn't read that one right now. Try again in a minute." : "📷 Nothing trip-related I can pull from that one. If it's a booking, crop to the details and send it again.");
      }
    } else if (text == null) text = await this.writer.write('answer', facts, history);
    this.tr.history = cleanHistory([...history, { role: 'user', content: question }, { role: 'assistant', content: text || '(saved)' }]);
    if (added.length) extras.push(this.wishSummary(added));
    const html = [this.formatText(text || '', [], origin), ...extras].filter(Boolean).join('\n\n');
    await this.sendHtml([chatId], 'reply', html);
  }

  // ---------------------------------------------------------------- personal plans

  // "/plan 2026-10-10 14:15-17:00 Movie premiere @ Southbank Centre", or natural language via Claude.
  async planCommand(chatId, now, from, arg) {
    const m = arg.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?\s+(.+?)(?:\s+@\s+(.+))?$/);
    if (m) {
      const r = await this.addPersonalPlan(from, { date: m[1], start: m[2], end: m[3], title: m[4], place: m[5] || m[4] });
      return this.sendHtml([chatId], 'reply', r.html);
    }
    if (!arg) return this.sendHtml([chatId], 'reply', 'Tell me your plan, e.g. <code>/plan 2026-10-10 14:15-17:00 Movie premiere @ Southbank Centre</code> (or just describe it in words).');
    if (this.writer.usingClaude) return this.replyAnswer(chatId, now, `Save this as my personal plan: ${arg}`, from);
    return this.sendHtml([chatId], 'reply', 'Use this format: <code>/plan 2026-10-10 14:15-17:00 Movie premiere @ Southbank Centre</code>');
  }

  /**
   * Save a plan for one person. Group fixed plans are locked in, so a personal plan can't start during one;
   * if it runs into one, it's saved with a "leave by" warning.
   * Returns { ok, html, summary }.
   */
  async addPersonalPlan(from, { title, date, start, end, place, arriveEarlyMin }) {
    const who = from?.first_name || 'you';
    const uid = from?.id;
    const fail = (why) => ({ ok: false, html: `⚠️ Couldn't save that plan: ${esc(why)}`, summary: { saved: false, error: why } });
    if (!uid) return fail('unknown person');
    if (!this.data.days[date]) return fail(`the date must be one of the trip days (${Object.keys(this.data.days).join(', ')})`);
    if (!/^\d{1,2}:\d{2}$/.test(start || '')) return fail('I need a start time like 14:15');
    const startAt = localToDate(date, start.padStart(5, '0'));
    let endAt = end && /^\d{1,2}:\d{2}$/.test(end) ? localToDate(date, end.padStart(5, '0')) : addMin(startAt, 120);
    if (endAt <= startAt) endAt = addMin(endAt, 24 * 60);

    let location = null;
    if (place) {
      const { place: p } = await resolveWish(place, {
        places: this.allPlaces(), neighborhoods: this.data.neighborhoods,
        canonicalize: (t) => this.writer.canonicalPlace?.(t), log: this.log, offline: this.offlineWishes, region: this.data.trip.region,
      });
      if (p) location = { name: p.name, address: p.address || '', lat: p.lat, lng: p.lng };
    }

    // Check against the locked-in group plans that day.
    const warnings = [];
    for (const g of this.groupFixedPlans()) {
      if (this.optedOut(uid, g.id)) continue;
      if (londonParts(g.start).date !== date && londonParts(g.end).date !== date) continue;
      const travel = location && g.location ? this.quick(location, g.location, g.start) : 30;
      const mustLeave = addMin(this.baseArrival(g), -travel);
      const groupBusyFrom = g.leaveBy === false ? g.start : mustLeave;
      if (startAt >= groupBusyFrom && startAt < g.end) {
        return fail(`it starts during a locked-in group plan: ${g.title} (${hhmm(g.start)}–${hhmm(g.end)}). Pick a time before ${hhmm(groupBusyFrom)} or after ${hhmm(g.end)}, or if you're sitting that one out, send /skipplan ${g.title} first.`);
      }
      if (startAt < groupBusyFrom && endAt > groupBusyFrom) {
        warnings.push(`You'll need to leave by <b>${hhmm(mustLeave)}</b> to make <b>${esc(g.title)}</b> (${hhmm(g.start)}). I'll ping you.`);
      }
    }

    const list = (this.s.personalPlans[uid] ||= []);
    const n = (list.at(-1)?.n || 0) + 1;
    const plan = {
      n, id: `p-${uid}-${n}`, title: title.trim(), start: startAt.toISOString(), end: endAt.toISOString(),
      location, arriveEarlyMin: Number.isFinite(arriveEarlyMin) ? arriveEarlyMin : 10, by: who,
    };
    list.push(plan);
    list.sort((a, b) => new Date(a.start) - new Date(b.start));
    this.store.save();

    const lines = [`📌 Saved for ${esc(who)}: <b>${esc(plan.title)}</b> · ${dayLabel(startAt)} ${hhmm(startAt)}–${hhmm(endAt)}${location ? ` @ ${esc(location.name)}` : ''}`];
    if (location) lines.push(`I'll send your own leave-by alerts for it${this.s.dm[uid] ? ' in our private chat' : ' (DM me /start so they come privately)'}.`);
    else lines.push("<i>I couldn't find that place on the map, so no leave-by alert for it. Add the venue with /plan … @ place.</i>");
    lines.push(...warnings);
    return {
      ok: true,
      html: lines.join('\n'),
      summary: { saved: true, who, title: plan.title, when: `${dayLabel(startAt)} ${hhmm(startAt)}–${hhmm(endAt)}`, where: location?.name || null, clashes: warnings.map((w) => w.replace(/<[^>]+>/g, '')) },
    };
  }

  findGroupPlan(query) {
    const q = norm(query);
    if (!q) return null;
    const words = q.split(' ').filter((w) => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const p of this.groupFixedPlans()) {
      const hay = norm(`${p.id} ${p.title} ${p.location?.name || ''} ${p.type}`);
      const score = hay.includes(q) ? 100 : words.filter((w) => hay.includes(w)).length;
      if (score > bestScore) { best = p; bestScore = score; }
    }
    return best;
  }

  // One person sits out a group plan (the rest still go). Flights and the airport transfer can't be skipped.
  async skipGroupPlan(from, query) {
    const uid = from?.id;
    const who = from?.first_name || 'Someone';
    const g = this.findGroupPlan(query);
    if (!uid || !g) return { html: `I couldn't find a group plan matching "${esc(query)}". Send /today to see them.`, summary: { skipped: false, error: 'no matching group plan' } };
    if (g.type === 'flight') return { html: `✈️ Can't skip a flight: <b>${esc(g.title)}</b> is locked in.`, summary: { skipped: false, error: "flights can't be skipped" } };
    const list = (this.s.optOuts[uid] ||= []);
    if (!list.includes(g.id)) list.push(g.id);
    for (const t of Object.values(this.s.tracks)) if (t.chatId === uid) { delete t.keys[`leave15:${g.id}`]; }
    this.store.save();
    const next = this.groupFixedPlans().find((p) => p.start >= g.end && !this.optedOut(uid, p.id));
    const note = `👤 ${esc(who)} is sitting out <b>${esc(g.title)}</b> (${dayLabel(g.start)} ${hhmm(g.start)})${next ? ` and will meet you for <b>${esc(next.title)}</b> at ${hhmm(next.start)}` : ''}.`;
    await this.sendHtml(this.broadcastTargets(), 'system', note);
    return {
      html: `👍 Got it: you're sitting out <b>${esc(g.title)}</b>. I won't send you alerts for it${next ? `, but you're still on for <b>${esc(next.title)}</b> at ${hhmm(next.start)}` : ''}. Changed your mind? <code>/rejoin ${esc(g.title)}</code>`,
      summary: { skipped: true, plan: g.title, stillOnFor: next?.title || null },
    };
  }

  async rejoinGroupPlan(from, query) {
    const uid = from?.id;
    const g = this.findGroupPlan(query);
    const list = this.s.optOuts[uid] || [];
    if (!g || !list.includes(g.id)) return { html: "You weren't sitting that one out.", summary: {} };
    this.s.optOuts[uid] = list.filter((id) => id !== g.id);
    this.store.save();
    await this.sendHtml(this.broadcastTargets(), 'system', `👤 ${esc(from?.first_name || 'Someone')} is back in for <b>${esc(g.title)}</b>.`);
    return { html: `🙌 You're back in for <b>${esc(g.title)}</b>.`, summary: { rejoined: g.title } };
  }

  myPlansText(uid) {
    const list = this.personalPlansOf(uid);
    const skipped = (this.s.optOuts[uid] || []).map((id) => this.data.plans.find((p) => p.id === id)).filter(Boolean);
    if (!list.length && !skipped.length) return "You don't have any personal plans yet. Add one: <code>/plan 2026-10-10 14:15-17:00 Movie premiere @ Southbank Centre</code>";
    const lines = list.map((p) => `${p.n}. <b>${esc(p.title)}</b> · ${dayLabel(p.start)} ${hhmm(p.start)}–${hhmm(p.end)}${p.location ? ` @ ${esc(p.location.name)}` : ''}`);
    const out = [`👤 <b>Your plans</b> (the group plans you're in always come first)`, ...lines];
    if (skipped.length) out.push(`\nSitting out: ${skipped.map((p) => esc(p.title)).join(', ')} (<code>/rejoin …</code> to undo)`);
    out.push('\nRemove a plan with <code>/unplan N</code>');
    return out.join('\n');
  }

  async removePlan(chatId, from, arg) {
    const list = this.s.personalPlans[from?.id] || [];
    const n = Number(String(arg).replace('#', ''));
    const i = list.findIndex((p) => p.n === n);
    if (i < 0) return this.sendHtml([chatId], 'reply', 'Which one? Send /myplans to see the numbers, then e.g. <code>/unplan 1</code>');
    const [p] = list.splice(i, 1);
    this.store.save();
    return this.sendHtml([chatId], 'reply', `🗑 Removed your plan "${esc(p.title)}".`);
  }

  // ---------------------------------------------------------------- locked-in group plans (from the wishlist)

  lockedPlans() {
    return (this.s.groupPlans || []).map((p) => ({
      ...p, start: new Date(p.start), end: new Date(p.end), arriveBy: null, fixed: true, locked: true, type: 'locked', immovable: false,
    }));
  }

  findWish(query) {
    const q = String(query || '').trim().replace(/^#/, '');
    const wl = this.s.wishlist;
    if (/^\d+$/.test(q)) return wl.find((w) => w.n === Number(q)) || null;
    const nq = norm(q.split(',')[0]);
    if (!nq) return null;
    return wl.find((w) => {
      const p = w.placeId ? this.placeById(w.placeId) : w.place;
      const names = [w.text, p?.name].filter(Boolean).map((x) => norm(String(x).split(',')[0]));
      return names.some((n) => n && (n === nq || n.includes(nq) || nq.includes(n)));
    }) || null;
  }

  // Move a wishlist place (or a new place) into the group plan at a set time.
  async lockIn(from, { wishlist_item: item, title, date, start, end, arriveEarlyMin = 5 }) {
    const by = from?.first_name || 'someone';
    const fail = (why) => ({ html: `⚠️ Couldn't lock that in: ${esc(why)}`, summary: { locked: false, error: why } });
    if (!this.data.days[date]) return fail(`the date must be a trip day (${Object.keys(this.data.days).join(', ')})`);
    if (!/^\d{1,2}:\d{2}$/.test(start || '')) return fail('I need a start time like 21:30');
    const wish = this.findWish(item);
    let place = wish ? (wish.placeId ? this.placeById(wish.placeId) : wish.place) : null;
    if (!place && !wish) {
      const r = await resolveWish(String(item), {
        places: this.allPlaces(), neighborhoods: this.data.neighborhoods, canonicalize: (t) => this.writer.canonicalPlace?.(t),
        log: this.log, offline: this.offlineWishes, region: this.data.trip.region,
      });
      place = r.place;
    }
    const name = place?.name || wish?.text?.split(',')[0] || String(item).split(',')[0];
    const startAt = localToDate(date, start.padStart(5, '0'));
    let endAt = end && /^\d{1,2}:\d{2}$/.test(end) ? localToDate(date, end.padStart(5, '0')) : addMin(startAt, Math.min(place?.visitMin || 60, 120));
    if (endAt <= startAt) endAt = addMin(endAt, 24 * 60);
    // Locked-in plans can't overlap anything else that's locked in (flights, bookings, matches, other locks).
    const clash = this.groupFixedPlans().find((g) => g.type !== 'arrival' && startAt < g.end && endAt > this.baseArrival(g));
    if (clash) return fail(`it overlaps ${clash.title} (${dayLabel(clash.start)} ${hhmm(clash.start)}–${hhmm(clash.end)}). Pick a time before or after.`);
    const list = (this.s.groupPlans ||= []);
    const n = list.reduce((m, p) => Math.max(m, p.n), 0) + 1;
    const plan = {
      n, id: `lock-${n}`, title: title?.trim() || name, start: startAt.toISOString(), end: endAt.toISOString(),
      location: place ? { name: place.name, address: place.address || '', lat: place.lat, lng: place.lng } : null,
      arriveEarlyMin, by, ...(wish ? { wish } : {}),
    };
    list.push(plan);
    if (wish) this.s.wishlist = this.s.wishlist.filter((w) => w !== wish);
    this.store.save();
    const when = `${dayLabel(startAt)} ${hhmm(startAt)}–${hhmm(endAt)}`;
    return {
      html: `🔒 Locked in: <b>${esc(plan.title)}</b> · ${when}${plan.location ? ` @ ${esc(plan.location.name)}` : ''}${wish ? ' (moved off the wishlist)' : ''}. Everyone gets reminders and leave-by alerts. <code>/unlock ${n}</code> to undo.${plan.location ? '' : '\n<i>No map pin for it, so no leave-by alert.</i>'}`,
      summary: { locked: true, title: plan.title, when, where: plan.location?.name || null, number: n },
    };
  }

  async unlock(chatId, from, arg) {
    const n = Number(String(arg).replace('#', ''));
    const list = this.s.groupPlans || [];
    const i = list.findIndex((p) => p.n === n);
    if (i < 0) return this.sendHtml([chatId], 'reply', 'Which one? /today shows locked plans as 🔒#N, then e.g. <code>/unlock 2</code>');
    const [p] = list.splice(i, 1);
    if (p.wish) this.s.wishlist.push(p.wish);
    for (const t of Object.values(this.s.tracks)) { delete t.keys[`leave15:${p.id}`]; delete t.keys[`leavenow:${p.id}`]; }
    this.store.save();
    return this.sendHtml([chatId], 'reply', `🔓 Unlocked <b>${esc(p.title)}</b>${p.wish ? ' and put it back on the wishlist' : ''}.`);
  }

  // ---------------------------------------------------------------- wishlist

  // Adds a wish and returns the confirmation HTML (caller sends it).
  async addWish(from, rawText, note) {
    const r = await this.addWishItem(from, rawText, note);
    return r.html;
  }

  // One-line summary when several places were added at once (e.g. after "plan a pub crawl").
  wishSummary(results) {
    const fresh = results.filter((r) => r.status === 'added');
    const dup = results.filter((r) => r.status === 'dup');
    const lines = [];
    if (fresh.length) {
      lines.push(`⭐ Added to the wishlist: ${fresh.map((r) => `<b>${esc(r.name)}</b>${r.area ? ` (${esc(r.area)})` : ''}`).join(', ')}`);
      const mapped = fresh.filter((r) => r.place);
      if (mapped.length) lines.push(mapped.map((r) => `📍 <a href="${esc(googleMapsLink(null, r.place))}">${esc(r.name)}</a>`).join(' · '));
    }
    const ideas = results.filter((r) => r.status === 'idea');
    if (ideas.length) {
      lines.push(`⭐ Also saved (no exact map pin yet): ${ideas.map((r) => `<a href="${esc(googleSearchLink(r.query || r.name))}">${esc(r.name)}</a>`).join(', ')}`);
    }
    if (dup.length) lines.push(`Already on the list: ${dup.map((r) => esc(r.name)).join(', ')}`);
    return lines.join('\n');
  }

  // Core wishlist add. Returns { status: 'added'|'dup'|'idea', name, area, place, html }.
  async addWishItem(from, rawText, note) {
    const text = rawText.trim().replace(/[.!?]+$/, '');
    const by = from?.first_name || 'someone';
    const wl = this.s.wishlist;
    const shortName = text.split(',')[0].trim();
    if (wl.some((w) => norm(w.text) === norm(text))) return { status: 'dup', name: shortName, html: 'Already on the list 👍 (/wishlist to see it all)' };
    const { place, known } = await resolveWish(text, {
      places: this.data.places,
      neighborhoods: this.data.neighborhoods,
      canonicalize: (t) => this.writer.canonicalPlace?.(t),
      log: this.log,
      offline: this.offlineWishes,
      region: this.data.trip.region,
    });
    if (known && wl.some((w) => w.placeId === place.id)) return { status: 'dup', name: place.name, html: `${esc(place.name)} is already on the list 👍` };
    if (place && !known && wl.some((w) => w.place && distanceM(w.place, place) < 80)) return { status: 'dup', name: place.name, html: `${esc(place.name)} is already on the list 👍` };
    const n = (wl.at(-1)?.n || 0) + 1;
    const item = { n, text, by, at: this.now().toISOString(), ...(note ? { note } : {}) };
    if (known) item.placeId = place.id;
    else if (place) item.place = { ...place, id: `wish-${n}`, why: `On ${by}'s wishlist ("${text}")`, by };
    wl.push(item);
    this.store.save();
    const p = known ? place : item.place;
    if (!p) return { status: 'idea', name: shortName, query: text, html: `📝 Saved "${esc(text)}" for ${esc(by)}. It isn't one specific place I can map, so I'll keep it in mind for ideas and the morning briefs.` };
    const area = p.neighborhood ? this.data.neighborhoods.find((a) => a.id === p.neighborhood)?.name : null;
    let html = `✅ Added <b>${esc(p.name)}</b> for ${esc(by)}${area ? ` (${esc(area)})` : ''}. I'll suggest it when you're nearby with time to spare.`;
    if (!known) html += `\n<i>Mapped to: ${esc(p.address || '')}. Wrong spot? Send /unwish ${n} and add it with more detail.</i>`;
    html += `\n\n📍 ${esc(p.name)}: <a href="${esc(googleMapsLink(null, p))}">Google Maps</a>`;
    return { status: 'added', name: p.name, area, place: p, html };
  }

  // Someone pasted a Google Maps link: read the place straight from the link and add it.
  async addFromMapsLink(chatId, from, url, note) {
    const by = from?.first_name || 'someone';
    let r;
    try {
      r = await resolveMapsLink(url);
    } catch (err) {
      this.log.warn?.(`maps link failed: ${err.message}`);
    }
    if (r?.isList) return this.sendHtml([chatId], 'reply', "That's a whole Google Maps list. Send me single places (or tell me which ones) and I'll add them.");
    if (!r?.name || r.lat === null) {
      // Couldn't read it directly: let Claude fetch the page instead.
      return this.replyAnswer(chatId, this.now(), `${note ? `${note} ` : ''}${url}\n\n(They sent this Google Maps link: work out the place and add it to the wishlist.)`, from);
    }
    const wl = this.s.wishlist;
    const known = this.data.places.find((p) => distanceM(p, r) < 150 && norm(p.name).split(' ')[0] === norm(r.name).split(' ')[0]);
    if (known ? wl.some((w) => w.placeId === known.id) : wl.some((w) => w.place && distanceM(w.place, r) < 80)) {
      return this.sendHtml([chatId], 'reply', `${esc(r.name)} is already on the list 👍`);
    }
    const n = (wl.at(-1)?.n || 0) + 1;
    const item = { n, text: r.name, by, at: this.now().toISOString(), ...(note ? { note } : {}) };
    let p;
    if (known) { item.placeId = known.id; p = known; } else {
      const [category, hours] = guessCategory(r.fullName || r.name);
      p = item.place = {
        id: `wish-${n}`, name: r.name, category, hours, visitMin: 45, lat: r.lat, lng: r.lng,
        address: r.fullName && r.fullName !== r.name ? r.fullName : '', neighborhood: areaAt(this.data.neighborhoods, r)?.id || null,
        why: `On ${by}'s wishlist${note ? ` ("${note}")` : ''} (shared as a Google Maps link)`, by, verified: 'from a Google Maps link; hours are a rough guess',
      };
    }
    wl.push(item);
    this.store.save();
    const area = p.neighborhood ? this.data.neighborhoods.find((a) => a.id === p.neighborhood)?.name : null;
    const outside = !this.inRegion(p);
    return this.sendHtml([chatId], 'reply', `⭐ Added <b>${esc(p.name)}</b> to the wishlist for ${esc(by)}${area ? ` (${esc(area)})` : ''}.${outside ? ` <i>Heads up: that's outside ${esc(this.data.trip.region.name)}.</i>` : ''} I'll work it in when you're nearby.\n📍 <a href="${esc(googleMapsLink(null, p))}">${esc(p.name)}</a>`);
  }

  async removeWish(chatId, arg) {
    const n = Number(String(arg).replace('#', ''));
    const i = this.s.wishlist.findIndex((w) => w.n === n);
    if (i < 0) return this.sendHtml([chatId], 'reply', 'Which one? Send /wishlist to see the numbers, then e.g. <code>/unwish 2</code>');
    const [w] = this.s.wishlist.splice(i, 1);
    this.store.save();
    return this.sendHtml([chatId], 'reply', `🗑 Removed #${n} "${esc(w.text)}".`);
  }

  wishlistText() {
    const wl = this.s.wishlist;
    if (!wl.length) return 'Wishlist is empty. Add something: <code>/want Arsenal museum</code>';
    const lines = wl.map((w) => {
      const p = w.placeId ? this.placeById(w.placeId) : w.place;
      const area = p?.neighborhood ? this.data.neighborhoods.find((a) => a.id === p.neighborhood)?.name : null;
      return `${w.n}. <b>${esc(p?.name || w.text)}</b>${area ? ` · ${esc(area)}` : p ? '' : ' · <i>idea</i>'} (${esc(w.by)})${w.note ? ` · <i>${esc(w.note)}</i>` : ''}`;
    });
    return `⭐ <b>Group wishlist</b>\n${lines.join('\n')}\n\nRemove with <code>/unwish N</code>`;
  }

  // Compact wishlist for Claude; optionally only items in the given neighbourhoods (plus unmapped ideas).
  wishlistFacts(areas = null) {
    return this.s.wishlist
      .map((w) => {
        const p = w.placeId ? this.placeById(w.placeId) : w.place;
        return { number: w.n, wish: w.text, by: w.by, place: p?.name || null, neighborhood: p?.neighborhood || null, ...(w.note ? { note: w.note } : {}) };
      })
      .filter((w) => !areas || !w.place || areas.includes(w.neighborhood));
  }

  // ---------------------------------------------------------------- road context, sun pings, daily recap

  // When they're driving: where they are and the ETAs to the next stop and tonight's base (for "where can we eat on the way").
  async onTheRoad(now, origin) {
    if (!this.driving(now) || !origin?.live) return {};
    const date = londonParts(now).date;
    const next = this.plansOn(date).find((p) => p.location && p.start > now);
    const base = this.data.days[date]?.base;
    const leg = async (to) => {
      const r = await this.route(origin, to, now);
      return { minutes: r.minutes, eta: hhmm(addMin(now, r.minutes)) };
    };
    // Today's stops whose time has passed are behind them (don't send them back). Earlier stops they never reached too.
    const behind = this.plansOn(date).filter((p) => p.location && p.start <= now && p.type !== 'arrival').map((p) => p.title);
    return {
      onTheRoad: {
        here: { lat: Number(origin.lat.toFixed(4)), lng: Number(origin.lng.toFixed(4)), area: this.areaName(origin) || null },
        alreadyBehindThem: behind,
        ...(next ? { nextStop: { title: next.title, plannedAt: hhmm(next.start), ...(await leg(next.location)) } } : {}),
        ...(base ? { tonightsBase: { name: base.name, ...(await leg(base)) } } : {}),
      },
    };
  }

  addToTrail(now, pt) {
    const d = londonParts(now).date;
    if (!this.data.days[d]) return;
    const t = ((this.s.trail ||= {})[d] ||= { km: 0, last: null });
    if (t.last) {
      const m = distanceM(t.last, pt);
      if (m < 150) return; // GPS jitter
      if (m < 80_000) t.km = Math.round((t.km + m / 1000) * 10) / 10; // ignore jumps (e.g. a flight)
    }
    t.last = pt;
  }

  recapFacts(date) {
    const t = this.tr;
    const visited = this.plans().filter((p) => p.type === 'stop' && londonParts(p.start).date === date && t.keys[`at:${p.id}`])
      .map((p) => `${hhmm(new Date(t.keys[`at:${p.id}`]))} ${p.title}`);
    const spent = {};
    for (const e of (this.s.expenses || []).filter((x) => londonParts(new Date(x.at)).date === date)) spent[e.currency] = (spent[e.currency] || 0) + e.amount;
    const km = this.s.trail?.[date]?.km || 0;
    return {
      stopsVisited: visited,
      fixedPlansToday: this.plansOn(date).filter((p) => p.fixed).map((p) => `${hhmm(p.start)} ${p.title}`),
      ...(km >= 1 ? { kmCovered: Math.round(km) } : {}),
      spent: Object.entries(spent).map(([c, v]) => money(v, c)).join(' + ') || 'nothing logged',
      newBookings: (this.s.bookings || []).filter((b) => londonParts(new Date(b.at)).date === date).map((b) => b.title),
    };
  }

  // Sunrise/sunset heads-ups with the best nearby spot to watch from. One Claude call each (~1¢).
  async checkSunPings(now) {
    const events = this.data.trip.sunPings || [];
    if (!events.length) return;
    const date = londonParts(now).date;
    if (!this.data.days[date] || this.muted(now)) return;
    const here = this.freshLocation(90) || this.data.days[date]?.base || this.data.days[shiftDate(date, -1)]?.base || this.data.trip.home;
    const sun = sunTimes(localToDate(date, '12:00'), here.lat, here.lng);
    for (const event of events) {
      const key = `sun:${event}:${date}`;
      if (this.s.keys[key]) continue;
      const at = event === 'sunrise' ? sun.sunrise : sun.sunset;
      const lead = event === 'sunrise' ? 55 : 80;
      const pingAt = new Date(Math.max(addMin(at, -lead), localToDate(date, this.sched.quietEnd)));
      if (now < pingAt) continue;
      this.mark(key);
      if (now > addMin(at, -15) || this.isQuiet(now)) continue; // missed the window (e.g. bot restarted): skip today
      const busy = this.plansOn(date).find((p) => p.fixed && p.start <= addMin(at, 20) && p.end >= addMin(at, -40));
      if (busy && event === 'sunrise') continue;
      const drive = this.driving(now);
      const radius = drive ? (event === 'sunrise' ? 12_000 : 25_000) : 3_000;
      const vps = await this.essentials.viewpoints?.(here, radius).catch(() => null);
      const known = this.allPlaces().filter((p) => ['nature', 'sights', 'viewpoint'].includes(p.category) && distanceM(here, p) <= radius)
        .slice(0, 6).map((p, i) => ({ id: `kp${i + 1}`, name: p.name, kind: p.category, lat: p.lat, lng: p.lng, distM: Math.round(distanceM(here, p)) }));
      const candidates = [...(vps || []), ...known];
      const [series] = await this.weather.hourly([here]);
      const hour = hourAt(series, date, hhmm(at));
      const facts = {
        event, time: hhmm(at), goldenFrom: hhmm(event === 'sunset' ? sun.goldenStart : addMin(at, -20)),
        sunDirection: `${compass(event === 'sunrise' ? sun.riseAzimuth : sun.setAzimuth)} (${event === 'sunrise' ? sun.riseAzimuth : sun.setAzimuth}°)`,
        where: this.areaName(here) || here.name || 'where they are',
        driving: drive,
        cloudPct: hour?.cloudPct ?? 'unknown', rainPct: hour?.rainPct ?? 'unknown',
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, kind: c.kind, distKm: Math.round(c.distM / 100) / 10, ...(c.ele ? { heightM: c.ele } : {}) })),
        ...(busy ? { fixedPlanAtThatTime: `${busy.title} (${hhmm(busy.start)}–${hhmm(busy.end)}): only suggest something on the way or right there` } : {}),
        nextPlans: this.plansOn(date).filter((p) => p.start > now).slice(0, 3).map((p) => `${hhmm(p.start)} ${p.title}`),
      };
      await this.compose(this.broadcastTargets(), 'sun_ping', facts, { from: here, lookup: candidates, unprompted: true });
    }
  }

  sunText(now) {
    const date = londonParts(now).date;
    const here = this.freshLocation(120) || this.data.days[date]?.base || this.data.trip.home;
    const lines = [`🌅 <b>Sun times</b> · ${esc(this.areaName(here) || here.name || 'here')}`];
    for (const d of [date, shiftDate(date, 1)]) {
      const s = sunTimes(localToDate(d, '12:00'), here.lat, here.lng);
      lines.push(`${dayLabel(d)}: sunrise <b>${hhmm(s.sunrise)}</b> (${compass(s.riseAzimuth)}) · sunset <b>${hhmm(s.sunset)}</b> (${compass(s.setAzimuth)}) · golden hour from ${hhmm(s.goldenStart)}`);
    }
    lines.push('\n<i>I\'ll ping you before each one with the best spot nearby.</i>');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- money (Splitwise), reminders, polls, essentials

  currencyNow(now = this.now()) {
    return this.data.days[londonParts(now).date]?.currency || this.data.trip.currency || 'EUR';
  }

  // Everyone on the trip we know of (people seen in the approved chats).
  peopleNames() {
    return [...new Set(Object.values(this.s.members || {}).filter((n) => n && n !== 'friend'))];
  }

  // "alex", "Alexander" → "Alex" (the name we know them by in the chat), so the tab adds up per person.
  canonicalPerson(name) {
    const people = this.peopleNames();
    const q = norm(name);
    const hit = people.find((p) => norm(p) === q) || people.find((p) => norm(p).split(' ')[0] === q.split(' ')[0]);
    if (hit) return hit;
    const nick = people.filter((p) => q.length >= 3 && norm(p).slice(0, 3) === q.slice(0, 3));
    return nick.length === 1 ? nick[0] : name;
  }

  async rates() {
    if (this.fx && Date.now() - this.fx.at < 6 * 3600_000) return this.fx.value;
    const value = await usdRates();
    if (value) this.fx = { at: Date.now(), value };
    return value || this.fx?.value || null;
  }

  // A Splitwise group member for a Telegram user (linked with /swlink) or a first name.
  async swMember(group, name, telegramId = null) {
    const members = group?.members || [];
    const byId = (id) => members.find((m) => m.id === id);
    const tid = telegramId ?? Object.entries(this.s.members || {}).find(([, n]) => norm(n) === norm(name || ''))?.[0];
    if (tid && this.s.swLinks?.[tid]) return byId(this.s.swLinks[tid]);
    const q = norm(String(name || '').split(' ')[0]);
    if (q) {
      const m = members.find((x) => norm(x.first_name) === q) || members.find((x) => norm(memberName(x)) === norm(name))
        || members.find((x) => q.length >= 3 && (norm(x.first_name).startsWith(q) || q.startsWith(norm(x.first_name))));
      if (m) return m;
      // Nicknames: "Alex" ↔ "Alexander", "Sammy" ↔ "Samuel", as long as only one member starts that way.
      const nick = members.filter((x) => q.length >= 3 && norm(x.first_name).slice(0, 3) === q.slice(0, 3));
      if (nick.length === 1) return nick[0];
    }
    // Last resort: exactly one Splitwise member and one Telegram person are still unmatched (e.g. "Kith" ↔ "Ankith").
    if (tid) {
      const linked = new Set(Object.values(this.s.swLinks || {}));
      const matchedBy = (m) => this.peopleNames().some((n) => {
        const q2 = norm(n).split(' ')[0];
        return norm(m.first_name) === q2 || (q2.length >= 3 && norm(m.first_name).slice(0, 3) === q2.slice(0, 3));
      });
      const freeMembers = members.filter((m) => !linked.has(m.id) && !matchedBy(m));
      const unmatchedPeople = Object.entries(this.s.members || {}).filter(([id, n]) => !this.s.swLinks?.[id] && !members.some((m) => {
        const q2 = norm(n).split(' ')[0];
        return norm(m.first_name) === q2 || (q2.length >= 3 && norm(m.first_name).slice(0, 3) === q2.slice(0, 3));
      }));
      if (freeMembers.length === 1 && unmatchedPeople.length === 1 && String(unmatchedPeople[0][0]) === String(tid)) return freeMembers[0];
    }
    return null;
  }

  // Splitwise is usable: a key, and a group (picked automatically when exactly one group is named after the trip).
  async swReady() {
    if (!this.splitwise.enabled) return false;
    this.splitwise.groupId = Number(this.s.swGroupId || this.splitwise.groupId) || null;
    if (!this.splitwise.groupId) {
      const word = (this.data.trip.region?.name || '').toLowerCase();
      const match = word ? (await this.splitwise.groups().catch(() => [])).filter((g) => g.name.toLowerCase().includes(word)) : [];
      if (match.length === 1) {
        this.s.swGroupId = match[0].id;
        this.splitwise.groupId = match[0].id;
        this.store.save();
      }
    }
    return Boolean(this.splitwise.groupId);
  }

  /**
   * Log a shared expense: into Splitwise (with the receipt) when it's connected, otherwise tracked here.
   * Returns { html, summary }.
   */
  async logExpense(from, { amount, currency, what, payer, split_with: splitWith, details }, { receipt = null } = {}) {
    const by = from?.first_name || 'someone';
    const amt = Math.round(Number(amount) * 100) / 100;
    const cur = String(currency || this.currencyNow()).toUpperCase();
    if (!(amt > 0)) return { html: "⚠️ I couldn't tell how much it was. Say e.g. <code>/paid 45 dinner</code>.", summary: { saved: false, error: 'no amount' } };
    const payerName = this.canonicalPerson(String(payer || by).trim());
    const payerTid = payer && norm(payer) !== norm(by) ? null : from?.id;
    const list = (this.s.expenses ||= []);
    const rec = {
      n: list.reduce((m, x) => Math.max(m, x.n), 0) + 1,
      payer: payerName, amount: amt, currency: cur, what: String(what || 'Expense').trim(),
      split: splitWith?.length ? [...new Set(splitWith.map((n) => this.canonicalPerson(n)))] : null, details: details || null, by, at: this.now().toISOString(),
    };
    const undo = () => `<code>/unpaid ${rec.n}</code> to undo.`;
    if (await this.swReady()) {
      try {
        const g = await this.splitwise.group();
        const payerM = await this.swMember(g, payerName, payerTid);
        if (!payerM) {
          return { html: `⚠️ I can't match <b>${esc(payerName)}</b> to anyone in the Splitwise group "${esc(g.name)}" (${g.members.map((m) => esc(m.first_name)).join(', ')}). ${esc(payerName)}: send <code>/swlink your Splitwise first name</code>, then try again.`, summary: { saved: false, error: 'payer not in Splitwise group' } };
        }
        let owed = g.members;
        if (rec.split) {
          owed = [];
          for (const n of rec.split) {
            const m = await this.swMember(g, n);
            if (!m) return { html: `⚠️ I can't find <b>${esc(n)}</b> in the Splitwise group (${g.members.map((x) => esc(x.first_name)).join(', ')}).`, summary: { saved: false, error: `${n} not in Splitwise group` } };
            if (!owed.includes(m)) owed.push(m);
          }
        }
        const exp = await this.splitwise.createExpense({
          cost: amt, currency: cur, description: rec.what, date: this.now(), payerId: payerM.id, owedIds: owed.map((m) => m.id), receipt,
          details: [rec.details, `Added by ${by} via ${this.data.trip.wakeWord || 'the trip bot'}`].filter(Boolean).join(' · '),
        });
        Object.assign(rec, { swId: exp.id, payer: payerM.first_name, split: rec.split ? owed.map((m) => m.first_name) : null, ways: owed.length });
        list.push(rec);
        this.store.save();
        const each = money(amt / owed.length, cur);
        const r = exp.receiptFailed ? ' (the receipt photo didn\'t upload)' : receipt ? ' · receipt attached 🧾' : '';
        return {
          html: `💸 Added to Splitwise: <b>${esc(rec.what)}</b> ${money(amt, cur)} · paid by ${esc(payerM.first_name)} · split ${owed.length} ways (${each} each)${r}. ${undo()}`,
          summary: { saved: true, splitwise: true, number: rec.n, each, payer: payerM.first_name, ways: owed.length },
        };
      } catch (err) {
        this.log.warn?.(`Splitwise failed: ${err.message}`);
        list.push({ ...rec, swFailed: true });
        this.store.save();
        return { html: `⚠️ Splitwise didn't take it (${esc(err.message)}). I've kept it here (#${rec.n}: ${esc(rec.what)} ${money(amt, cur)}, paid by ${esc(payerName)}), so add it in the app later.`, summary: { saved: true, splitwise: false, error: err.message } };
      }
    }
    list.push(rec);
    this.store.save();
    const ways = rec.split?.length || this.peopleNames().length || this.data.trip.size || 1;
    return {
      html: `💸 Logged #${rec.n}: <b>${esc(rec.what)}</b> ${money(amt, cur)} · paid by ${esc(payerName)} · split ${ways} ways. /expenses shows who owes who. ${undo()}`,
      summary: { saved: true, splitwise: false, number: rec.n },
    };
  }

  async expensesText() {
    const recent = (this.s.expenses || []).slice(-6).reverse();
    const recentLines = recent.map((e) => `${e.n}. ${esc(e.what)} ${money(e.amount, e.currency)} · ${esc(e.payer)}${e.swFailed ? ' <i>(not in Splitwise)</i>' : ''}`);
    if (await this.swReady()) {
      try {
        const g = await this.splitwise.group(true);
        const lines = [];
        for (const m of g.members) {
          for (const b of (m.balance || []).filter((x) => Math.abs(Number(x.amount)) >= 0.01)) {
            const a = Number(b.amount);
            lines.push(`• ${esc(m.first_name)} ${a > 0 ? 'is owed' : 'owes'} <b>${money(Math.abs(a), b.currency_code)}</b>`);
          }
        }
        return `💸 <b>Splitwise: ${esc(g.name)}</b>\n${lines.join('\n') || '• All square 🙌'}${recentLines.length ? `\n\nAdded from the chat:\n${recentLines.join('\n')}` : ''}\n\nSettle up in the Splitwise app (it simplifies the debts).`;
      } catch (err) {
        return `⚠️ Couldn't reach Splitwise: ${esc(err.message)}`;
      }
    }
    const list = this.s.expenses || [];
    if (!list.length) return '💸 No expenses yet. Send a receipt photo with a caption, or <code>/paid 45 dinner</code>.';
    const people = [...new Set([...this.peopleNames(), ...list.map((e) => e.payer)])];
    const short = this.data.trip.size && people.length < this.data.trip.size
      ? `\n\n<i>I only know ${people.length} of the ${this.data.trip.size} of you (${people.map(esc).join(', ')}). Everyone say something in the group so the split is fair.</i>` : '';
    const byCur = settle(list, people);
    const spent = Object.entries(byCur).map(([cur, c]) => money(c.total, cur)).join(' + ');
    const fx = await this.rates();
    const lines = [`💸 <b>The tab</b>: ${spent} spent${fx && Object.keys(byCur).some((c) => c !== 'USD') ? ` (≈ ${money(list.reduce((t, e) => t + e.amount * fx[e.currency], 0), 'USD')})` : ''}`];
    if (fx) {
      // One settle-up in dollars, at today's rate, so it's a single Venmo each.
      const usd = settle(list.map((e) => ({ ...e, amount: e.amount * fx[e.currency], currency: 'USD' })), people).USD;
      const handleOf = (name) => {
        const uid = Object.entries(this.s.members || {}).find(([, n]) => n === name)?.[0];
        return uid && this.s.venmo?.[uid];
      };
      const note = `${this.data.trip.name.split(',')[0]} tab`;
      lines.push('\n<b>Settle up</b> (in $, today\'s rate):');
      lines.push(...(usd?.transfers.length ? usd.transfers.map((t) => {
        const h = handleOf(t.to);
        return `• ${esc(t.from)} → ${esc(t.to)} <b>${money(t.amount, 'USD')}</b>${h ? ` · <a href="${esc(venmoLink(h, t.amount, note))}">pay on Venmo</a>` : ''}`;
      }) : ['• All square 🙌']));
      const missing = (usd?.transfers || []).map((t) => t.to).filter((n, i, a) => a.indexOf(n) === i && !handleOf(n));
      if (missing.length) lines.push(`<i>${missing.map(esc).join(', ')}: send <code>/venmo your-handle</code> and the links appear.</i>`);
    } else {
      for (const [cur, c] of Object.entries(byCur)) lines.push(`\n<b>${cur}</b>\n${c.transfers.map((t) => `• ${esc(t.from)} → ${esc(t.to)} <b>${money(t.amount, cur)}</b>`).join('\n') || '• All square'}`);
    }
    lines.push(`\nLatest:\n${recentLines.join('\n')}\n\n/report turns it into Splitwise entries · /export for a spreadsheet`);
    return lines.join('\n') + short;
  }

  // End-of-trip: the whole tab as one Splitwise expense per currency (multiple payers, exact shares).
  splitwiseReport() {
    const all = this.s.expenses || [];
    const list = all.filter((e) => !e.swId); // ones already added to Splitwise directly don't need entering again
    const tripName = this.data.trip.name.split(',')[0];
    if (!list.length) return all.length ? `🧾 Everything (${all.length} expenses) is already in Splitwise. Settle up in the app.` : `🧾 Nothing on the tab yet for ${esc(tripName)}.`;
    const people = [...new Set([...this.peopleNames(), ...list.map((e) => e.payer)])];
    const shares = splitwiseShares(list, people);
    const row = (m, cur) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([n, v]) => `${esc(n)} ${money(v, cur)}`).join(' · ');
    const blocks = Object.entries(shares).map(([cur, c], i) => {
      const count = list.filter((e) => e.currency === cur).length;
      return `<b>${i + 1}) "${esc(tripName)} (${cur})"</b>: <b>${money(c.total, cur)}</b>, ${count} expense${count === 1 ? '' : 's'}\n  Paid by: ${row(c.paid, cur)}\n  Split: ${row(c.owed, cur)}`;
    });
    const net = settle(list, people);
    const owes = Object.entries(net).flatMap(([cur, c]) => c.transfers.map((t) => `• ${esc(t.from)} → ${esc(t.to)} ${money(t.amount, cur)}`));
    return `🧾 <b>Splitwise report: ${esc(tripName)}</b>
In Splitwise, add ${blocks.length === 1 ? 'this as one expense' : `these as ${blocks.length} expenses (one per currency)`}. Set the currency, choose <b>Paid by → Multiple people</b> and enter the paid amounts, then <b>Split → Unequally (exact amounts)</b> and enter the shares.

${blocks.join('\n\n')}

After that, Splitwise should show roughly:
${owes.join('\n') || '• All square'}

/export gives the line-by-line list. Paste it into the expense notes so everyone can see what's in it.`;
  }

  // On the last morning of the trip, post the Splitwise report (once), so nobody has to remember.
  async checkFinalReport(now) {
    const p = londonParts(now);
    const last = Object.keys(this.data.days).sort().at(-1);
    if (p.date !== last || p.minutes < toMinutes(this.sched.morningBrief) + 15 || this.s.keys.finalReport || !(this.s.expenses || []).some((e) => !e.swId)) return;
    this.mark('finalReport');
    await this.sendHtml(this.broadcastTargets(), 'report', `${this.splitwiseReport()}\n\n<i>Spent anything else today? Add it, then send /report again.</i>`);
  }

  async removeExpense(arg) {
    const n = Number(String(arg).replace('#', ''));
    const list = this.s.expenses || [];
    const i = list.findIndex((e) => e.n === n);
    if (i < 0) return `No expense #${esc(arg || '?')}. /expenses shows the numbers.`;
    const e = list[i];
    if (e.swId && this.splitwise.enabled) {
      try {
        await this.splitwise.deleteExpense(e.swId);
      } catch (err) {
        return `⚠️ Couldn't delete it in Splitwise (${esc(err.message)}). Delete it in the app instead.`;
      }
    }
    list.splice(i, 1);
    this.store.save();
    return `🗑 Removed #${n} ${esc(e.what)} ${money(e.amount, e.currency)}${e.swId ? ' (and from Splitwise)' : ''}.`;
  }

  async splitwiseCommand(from, arg, isOwner) {
    if (!this.splitwise.enabled) return '💸 Splitwise isn\'t connected yet, so I\'m keeping track of expenses here (/expenses). To connect it, the owner adds <code>SPLITWISE_API_KEY</code> on Railway.';
    try {
      if (/^\d+$/.test(arg)) {
        if (!isOwner) return 'Only the trip owner can change the Splitwise group.';
        this.s.swGroupId = Number(arg);
        this.splitwise.cache.delete('group');
        this.store.save();
      }
      if (!(await this.swReady())) {
        const gs = await this.splitwise.groups();
        return `💸 Which Splitwise group is this trip? Send <code>/splitwise ID</code>:\n${gs.map((g) => `• <code>${g.id}</code> ${esc(g.name)}`).join('\n') || '• (no groups: make one in the app first)'}`;
      }
      const g = await this.splitwise.group(true);
      const lines = [];
      for (const m of g.members) {
        const tid = Object.entries(this.s.swLinks || {}).find(([, id]) => id === m.id)?.[0];
        lines.push(`• ${esc(memberName(m))}${tid ? ` ↔ ${esc(this.s.members[tid] || 'linked')}` : ''}`);
      }
      return `💸 Connected to Splitwise group <b>${esc(g.name)}</b>\n${lines.join('\n')}\n\nI match people by first name. If yours differs, send <code>/swlink your Splitwise first name</code>.`;
    } catch (err) {
      return `⚠️ Splitwise: ${esc(err.message)}`;
    }
  }

  async swLink(from, arg) {
    if (!(await this.swReady())) return 'Splitwise isn\'t set up yet (/splitwise).';
    if (!arg) return 'Usage: <code>/swlink Ankith</code> (your first name in Splitwise).';
    try {
      const g = await this.splitwise.group();
      const q = norm(arg);
      const m = g.members.find((x) => norm(memberName(x)) === q || norm(x.first_name) === q) || g.members.find((x) => norm(memberName(x)).includes(q));
      if (!m) return `No one called "${esc(arg)}" in ${esc(g.name)} (${g.members.map((x) => esc(x.first_name)).join(', ')}).`;
      (this.s.swLinks ||= {})[from.id] = m.id;
      this.store.save();
      return `🔗 Linked: you're <b>${esc(memberName(m))}</b> in Splitwise.`;
    } catch (err) {
      return `⚠️ Splitwise: ${esc(err.message)}`;
    }
  }

  // The next time it's hh:mm (today, or tomorrow if that's passed).
  nextClockTime(now, hh, mm) {
    const today = londonParts(now).date;
    const t = localToDate(today, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
    return t > now ? t : localToDate(shiftDate(today, 1), `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }

  addReminder(chatId, from, at, text) {
    const now = this.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime()) || at <= now) return { html: "⚠️ That time's already passed. Give me a time later today, e.g. <i>remind us at 18:30 to book dinner</i>.", summary: { saved: false, error: 'time is in the past' } };
    if (minutesBetween(now, at) > 14 * 24 * 60) return { html: '⚠️ I can only set reminders up to two weeks ahead.', summary: { saved: false, error: 'too far ahead' } };
    const list = (this.s.reminders ||= []);
    const r = { n: list.reduce((m, x) => Math.max(m, x.n), 0) + 1, chatId, at: at.toISOString(), text: String(text).trim(), by: from?.first_name || null };
    list.push(r);
    this.store.save();
    const when = londonParts(at).date === londonParts(now).date ? hhmm(at) : `${dayLabel(at)} ${hhmm(at)}`;
    return { html: `⏰ I'll remind ${chatId < 0 ? 'everyone' : 'you'} at <b>${when}</b>: ${esc(r.text)}. <code>/unremind ${r.n}</code> to cancel.`, summary: { saved: true, at: when, number: r.n } };
  }

  async checkUserReminders(now) {
    const due = (this.s.reminders || []).filter((r) => new Date(r.at) <= now);
    if (!due.length) return;
    this.s.reminders = this.s.reminders.filter((r) => !due.includes(r));
    for (const r of due) await this.sendHtml([r.chatId], 'reminder', `⏰ <b>Reminder</b>${r.by ? ` (from ${esc(r.by)})` : ''}: ${esc(r.text)}`);
  }

  remindersText(chatId) {
    const list = (this.s.reminders || []).filter((r) => r.chatId === chatId).sort((a, b) => a.at.localeCompare(b.at));
    if (!list.length) return '⏰ No reminders set here. Try <i>remind us in 2h to move the car</i>.';
    return `⏰ <b>Reminders</b>\n${list.map((r) => `${r.n}. ${dayLabel(new Date(r.at))} <b>${hhmm(new Date(r.at))}</b> ${esc(r.text)}${r.by ? ` (${esc(r.by)})` : ''}`).join('\n')}\n\nCancel with <code>/unremind N</code>`;
  }

  removeReminder(arg) {
    const n = Number(String(arg).replace('#', ''));
    const before = (this.s.reminders || []).length;
    this.s.reminders = (this.s.reminders || []).filter((r) => r.n !== n);
    this.store.save();
    return before === this.s.reminders.length ? `No reminder #${esc(arg || '?')}. /reminders shows them.` : `🗑 Cancelled reminder #${n}.`;
  }

  async createPoll(chatId, { question, options, multiple_answers: multiple = false }) {
    const opts = [...new Set((options || []).map((o) => String(o).trim()).filter(Boolean))].slice(0, 10);
    if (!question || opts.length < 2) return { html: '⚠️ A poll needs a question and at least two options.', summary: { posted: false, error: 'need a question and 2+ options' } };
    if (!this.transport.poll) return { html: '', summary: { posted: false, error: 'polls not supported here' } };
    try {
      const msg = await this.transport.poll(chatId, question, opts, { multiple });
      const id = msg?.poll?.id;
      if (id) (this.s.polls ||= {})[id] = { question, chatId, at: this.now().toISOString(), options: opts.map((text) => ({ text, votes: 0 })), voters: 0, closed: false };
      this.remember(chatId, this.data.trip.wakeWord || 'bot', `[poll] ${question} ${opts.join(' / ')}`);
      this.store.save();
      return { html: '', summary: { posted: true, question, options: opts } };
    } catch (err) {
      return { html: `⚠️ Couldn't post the poll: ${esc(err.message)}`, summary: { posted: false, error: err.message } };
    }
  }

  onPollUpdate(poll) {
    const p = this.s.polls?.[poll.id];
    if (!p) return;
    p.options = poll.options.map((o) => ({ text: o.text, votes: o.voter_count }));
    p.voters = poll.total_voter_count;
    p.closed = poll.is_closed;
    this.store.save();
  }

  pollFacts() {
    const cutoff = addMin(this.now(), -48 * 60);
    return Object.values(this.s.polls || {}).filter((p) => new Date(p.at) >= cutoff).map((p) => ({
      question: p.question, asked: `${dayLabel(new Date(p.at))} ${hhmm(new Date(p.at))}`, voters: p.voters,
      results: p.options.map((o) => `${o.text}: ${o.votes}`).join(' · '),
    }));
  }

  // Petrol, toilets, ATMs… near the live location (OpenStreetMap). Free: no Claude call.
  async replyEssential(chatId, now, kind) {
    const loc = this.freshLocation(60);
    const here = loc ? { lat: loc.lat, lng: loc.lng } : null;
    if (!here) return this.sendHtml([chatId], 'reply', `📍 I need your location for that: share your Live Location (📎 → Location), then ask again.`);
    const found = await this.essentials.near(kind, here);
    if (found == null) return this.sendHtml([chatId], 'reply', "🗺 The map service isn't answering right now. Try again in a minute, or search Google Maps.");
    if (!found.length) return this.sendHtml([chatId], 'reply', `Nothing tagged as ${kind.label.toLowerCase()} within ${Math.round(kind.radius * 3 / 1000)} km, sorry. Try Google Maps.`);
    const drive = this.driving(now);
    const lines = found.map((p) => {
      const km = p.distM >= 1000 ? `${(p.distM / 1000).toFixed(1)} km` : `${Math.round(p.distM / 10) * 10} m`;
      const mode = drive && p.distM > 1200 ? 'driving' : 'walking';
      const extra = [p.hours && `hours: ${p.hours}`, kind.id === 'parking' && p.fee === 'yes' && 'paid', kind.id === 'toilets' && p.fee === 'no' && 'free'].filter(Boolean).join(', ');
      return `• <b>${esc(p.name)}</b>, ${km}${extra ? ` (${esc(extra)})` : ''} · <a href="${esc(googleMapsLink(here, p, mode))}">go</a>`;
    });
    await this.sendHtml([chatId], 'reply', `${kind.label} nearest you:\n${lines.join('\n')}\n<i>From OpenStreetMap: hours can be out of date.</i>`);
  }

  // ---------------------------------------------------------------- Claude spend + account problems

  recordUsage({ cost, searches }) {
    const d = londonParts(this.now()).date;
    const u = ((this.s.usage ||= {})[d] ||= { calls: 0, cost: 0, searches: 0 });
    u.calls += 1;
    u.cost += cost;
    u.searches += searches;
  }

  usageText() {
    const days = Object.entries(this.s.usage || {}).sort(([a], [b]) => a.localeCompare(b));
    if (!days.length) return '🤖 No Claude usage recorded yet.';
    const total = days.reduce((t, [, u]) => t + u.cost, 0);
    const today = this.s.usage[londonParts(this.now()).date];
    return `🤖 <b>Claude spend (estimate)</b>\nToday: <b>$${(today?.cost || 0).toFixed(2)}</b> (${today?.calls || 0} calls${today?.searches ? `, ${today.searches} web searches` : ''})\nSo far: <b>$${total.toFixed(2)}</b>\n${days.slice(-6).map(([d, u]) => `• ${dayLabel(d)}: $${u.cost.toFixed(2)} (${u.calls})`).join('\n')}\n\n<i>Free: slash commands, weather alerts, petrol/toilets/ATM lookups, Maps links. Paid: questions, research, screenshots and receipts.</i>`;
  }

  // Tell the owner (once every 6 hours) when Claude stops working because of the account.
  async trouble(kind) {
    const key = `trouble:${kind}`;
    if (this.s.keys[key] && minutesBetween(new Date(this.s.keys[key]), this.now()) < 360) return;
    this.mark(key);
    if (!this.s.ownerChatId) return;
    const text = kind === 'credit'
      ? `⚠️ <b>Claude is out of API credit.</b> ${esc(this.data.trip.wakeWord || 'The bot')} is on basic template replies until you top up: console.anthropic.com → Settings → Billing.`
      : `⚠️ <b>Claude rejected the API key.</b> ${esc(this.data.trip.wakeWord || 'The bot')} is on basic replies. Check ANTHROPIC_API_KEY in Railway Variables.`;
    await this.sendHtml([this.s.ownerChatId], 'system', text);
  }

  // ---------------------------------------------------------------- bookings (from screenshots) and day changes

  findPlanOn(date, query) {
    const q = norm(query || '');
    if (!q) return null;
    const words = q.split(' ').filter((w) => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const p of this.data.plans.filter((x) => londonParts(x.start).date === date || !date)) {
      const hay = norm(`${p.title} ${p.location?.name || ''}`);
      const score = hay.includes(q) ? 100 : words.filter((w) => hay.includes(w)).length;
      if (score > bestScore) { best = p; bestScore = score; }
    }
    return best;
  }

  /**
   * Save a reservation. Stays become that night's base (so routing, "how do I get home" and the briefs use it);
   * timed bookings become locked-in group plans (or a personal plan), replacing a matching itinerary stop if the time moved.
   */
  async saveBooking(from, b) {
    const by = from?.first_name || 'someone';
    const fail = (why) => ({ html: `⚠️ Couldn't save that booking: ${esc(why)}`, summary: { saved: false, error: why } });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return fail('I need the date it is for');
    const time = (t) => (/^\d{1,2}:\d{2}$/.test(t || '') ? t.padStart(5, '0') : null);
    let location = null;
    if (b.place) {
      const { place: p } = await resolveWish(b.place, {
        places: this.allPlaces(), neighborhoods: this.data.neighborhoods,
        canonicalize: (t) => this.writer.canonicalPlace?.(t), log: this.log, offline: this.offlineWishes, region: this.data.trip.region,
      });
      if (p) location = { name: p.name, address: p.address || b.place, lat: p.lat, lng: p.lng };
    }
    const list = (this.s.bookings ||= []);
    const rec = {
      n: list.reduce((m, x) => Math.max(m, x.n), 0) + 1,
      kind: b.kind || 'other', title: String(b.title || 'Booking').trim(), date: b.date, start: time(b.start),
      endDate: /^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '') ? b.end_date : null, end: time(b.end),
      place: b.place || null, location, confirmation: b.confirmation || null, details: b.details || null,
      by, at: this.now().toISOString(), justMe: Boolean(b.just_me), userId: from?.id,
    };
    // Same booking sent twice (or an updated confirmation): replace it.
    const i = list.findIndex((x) => (rec.confirmation && x.confirmation === rec.confirmation) || (norm(x.title) === norm(rec.title) && x.date === rec.date));
    if (i >= 0) { rec.n = list[i].n; rec.planId = list[i].planId; list[i] = rec; } else list.push(rec);

    const when = `${dayLabel(rec.date)}${rec.start ? ` ${rec.start}` : ''}${rec.endDate ? ` → ${dayLabel(rec.endDate)}${rec.end ? ` ${rec.end}` : ''}` : ''}`;
    const lines = [`🎟️ Saved booking #${rec.n}: <b>${esc(rec.title)}</b> · ${when}${rec.confirmation ? ` · ref <code>${esc(rec.confirmation)}</code>` : ''}`];
    const effects = {};

    if (rec.kind === 'stay') {
      const nights = [];
      for (let d = rec.date; d < (rec.endDate || shiftDate(rec.date, 1)); d = shiftDate(d, 1)) if (this.data.days[d]) nights.push(d);
      if (location && nights.length) {
        const base = { name: rec.place?.split(',')[0] || rec.title, address: rec.place || location.address, lat: location.lat, lng: location.lng, booking: rec.n };
        for (const d of nights) (this.s.dayOverrides ||= {})[d] = { ...this.s.dayOverrides[d], base };
        lines.push(`🛏 That's now the base for ${nights.map((d) => dayLabel(d)).join(', ')}. Directions "home" go there.`);
        effects.baseFor = nights;
      } else if (nights.length) {
        lines.push("<i>I couldn't pin that address on the map, so I haven't changed where you're staying. Send a Google Maps link to it.</i>");
      }
    } else if (rec.start && this.data.days[rec.date] && rec.kind !== 'flight') {
      const match = b.matches_plan ? this.findPlanOn(rec.date, b.matches_plan) : null;
      if (match && hhmm(match.start) === rec.start && !match.personal) {
        rec.planId = match.id; // same time as planned: just attach the booking to it
        lines.push(`Matched to <b>${esc(match.title)}</b> (${hhmm(match.start)}).`);
      } else if (rec.justMe) {
        const r = await this.addPersonalPlan(from, { title: rec.title, date: rec.date, start: rec.start, end: rec.end, place: rec.place || rec.title });
        lines.push(r.html);
      } else {
        // A different time than the itinerary: the booking wins, so drop the planned stop and lock the booking in.
        const moved = match && !match.locked && !match.immovable ? match : null;
        if (moved) (this.s.droppedStops ||= []).push(moved.id);
        const r = await this.lockIn(from, { wishlist_item: rec.place || rec.title, title: rec.title, date: rec.date, start: rec.start, end: rec.end, arriveEarlyMin: ['tickets', 'tour'].includes(rec.kind) ? 15 : 5 });
        if (r.summary.locked) {
          rec.planId = `lock-${r.summary.number}`;
          if (moved) lines.push(`Moved <b>${esc(moved.title)}</b> from ${hhmm(moved.start)} to the booked time.`);
        } else if (moved) {
          this.s.droppedStops = this.s.droppedStops.filter((id) => id !== moved.id);
        }
        lines.push(r.html);
      }
    }
    this.store.save();
    return { html: lines.join('\n'), summary: { saved: true, number: rec.n, title: rec.title, when, ...effects } };
  }

  bookingFacts() {
    return (this.s.bookings || []).map((b) => ({
      title: b.title, kind: b.kind, date: dayLabel(b.date), ...(b.start ? { time: b.start } : {}), ...(b.endDate ? { until: `${dayLabel(b.endDate)}${b.end ? ` ${b.end}` : ''}` } : {}),
      ...(b.place ? { place: b.place } : {}), ...(b.confirmation ? { ref: b.confirmation } : {}), ...(b.details ? { details: b.details } : {}), by: b.by,
    }));
  }

  bookingsText() {
    const list = [...(this.s.bookings || [])].sort((a, b) => `${a.date}${a.start || ''}`.localeCompare(`${b.date}${b.start || ''}`));
    if (!list.length) return '🎟️ No bookings saved yet. Drop a screenshot of a confirmation in the chat and I\'ll pull out the details.';
    const lines = list.map((b) => `${b.n}. <b>${esc(b.title)}</b> · ${dayLabel(b.date)}${b.start ? ` ${b.start}` : ''}${b.endDate ? ` → ${dayLabel(b.endDate)}` : ''}${b.confirmation ? ` · ref <code>${esc(b.confirmation)}</code>` : ''}${b.place ? `\n    ${esc(b.place)}` : ''}${b.details ? `\n    <i>${esc(b.details)}</i>` : ''}`);
    return `🎟️ <b>Bookings</b>\n${lines.join('\n')}\n\nRemove one with <code>/unbook N</code>`;
  }

  removeBooking(arg) {
    const n = Number(String(arg).replace('#', ''));
    const list = this.s.bookings || [];
    const i = list.findIndex((b) => b.n === n);
    if (i < 0) return `No booking #${esc(arg || '?')}. /bookings shows the numbers.`;
    const [b] = list.splice(i, 1);
    for (const [d, o] of Object.entries(this.s.dayOverrides || {})) if (o.base?.booking === n) delete o.base;
    this.store.save();
    return `🗑 Removed booking #${n} "${esc(b.title)}".${b.planId?.startsWith('lock-') ? ` It's still in the plan: <code>/unlock ${b.planId.slice(5)}</code> to take it out.` : ''}`;
  }

  // "Tomorrow we're doing X, Y, skipping Z", usually agreed in the chat the night before.
  updateDayPlan(from, { date, flow, drop_stops: drop = [], revert = false }) {
    const by = from?.first_name || 'someone';
    if (!this.data.days[date]) return { html: `⚠️ ${esc(date)} isn't a trip day.`, summary: { updated: false, error: 'not a trip day' } };
    const o = (this.s.dayOverrides ||= {});
    if (revert) {
      if (o[date]) delete o[date].flow;
      const thatDay = new Set(this.basePlans.filter((p) => londonParts(p.start).date === date).map((p) => p.id));
      this.s.droppedStops = (this.s.droppedStops || []).filter((id) => !thatDay.has(id));
      this.store.save();
      return { html: `↩️ Back to the original plan for ${dayLabel(date)}.`, summary: { reverted: true } };
    }
    o[date] = { ...o[date], flow: String(flow || '').trim(), by, at: this.now().toISOString() };
    const dropped = [];
    for (const q of drop || []) {
      const pl = this.findPlanOn(date, q);
      if (pl && !pl.locked && !pl.immovable && !pl.personal && !(this.s.droppedStops ||= []).includes(pl.id)) {
        this.s.droppedStops.push(pl.id);
        dropped.push(pl.title);
      }
    }
    this.store.save();
    return {
      html: `🗓 Updated the plan for <b>${dayLabel(date)}</b>${dropped.length ? `; dropped ${dropped.map(esc).join(', ')}` : ''}. The morning brief and nudges follow it now (/today to see it).`,
      summary: { updated: true, date, dropped },
    };
  }

  // ---------------------------------------------------------------- live weather + packing

  // The forecast at each stop at the time they'll be there (one Open-Meteo request for the whole day).
  async routeWeather(date) {
    const seen = new Set();
    const stops = this.plansOn(date).filter((p) => p.location?.lat && !seen.has(p.location.name) && seen.add(p.location.name)).slice(0, 12);
    const base = this.data.days[date]?.base || this.data.trip.home;
    const points = stops.length ? stops.map((p) => p.location) : [base];
    const ahead = Math.round((localToDate(date, '12:00') - this.now()) / 86_400_000);
    if (ahead > 14 || ahead < -1) return [];
    const series = await this.weather.hourly(points, { days: Math.min(16, Math.max(1, ahead + 2)) });
    const rows = stops.length
      ? stops.map((p, i) => ({ title: p.title, place: p.location.name, time: hhmm(p.start), weather: hourAt(series[i], date, hhmm(p.start)), exposed: EXPOSED.test(`${p.title} ${p.location.name}`) }))
      : [{ title: base.name, place: base.name, time: '12:00', weather: hourAt(series[0], date, '12:00') }];
    return rows;
  }

  async packFacts(date) {
    const day = this.data.days[date] || {};
    const stops = await this.routeWeather(date).catch(() => []);
    const list = packingList(day, stops, {
      prevBase: this.data.days[shiftDate(date, -1)]?.base || null,
      bookings: (this.s.bookings || []).filter((b) => b.date === date),
      dayWeather: await this.weatherFor(date),
    });
    const withWx = stops.filter((st) => st.weather);
    return {
      ...(withWx.length ? { weatherAlongRoute: withWx.map((st) => `${st.time} ${st.place}: ${st.weather.sky}, ${st.weather.tempC}°C (feels ${st.weather.feelsC}°C), rain ${st.weather.rainPct}%, gusts ${st.weather.gustKmh} km/h`) } : {}),
      packList: list.map((x) => (x.why ? `${x.item} (${x.why})` : x.item)),
    };
  }

  async packText(now, arg = '') {
    const today = londonParts(now).date;
    const days = Object.keys(this.data.days).sort();
    let date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : /tom/i.test(arg) ? shiftDate(today, 1) : today;
    if (!this.data.days[date]) date = days.find((d) => d >= date) || days[0];
    const day = this.data.days[date] || {};
    const stops = await this.routeWeather(date).catch(() => []);
    const list = packingList(day, stops, {
      prevBase: this.data.days[shiftDate(date, -1)]?.base || null,
      bookings: (this.s.bookings || []).filter((b) => b.date === date),
      dayWeather: await this.weatherFor(date),
    });
    const lines = [`🎒 <b>Pack for ${dayLabel(date)}</b>${day.label ? `\n<i>${esc(day.label.replace(/^[^:]+:\s*/, ''))}</i>` : ''}`];
    for (const x of list) lines.push(`☐ ${esc(x.item)}${x.why ? ` <i>(${esc(x.why)})</i>` : ''}`);
    if (!list.length) lines.push('☐ Nothing special: phone, wallet, keys.');
    if (!stops.some((st) => st.weather)) lines.push('\n<i>Live forecast isn\'t out yet for that day (it covers ~2 weeks ahead), so this uses typical October weather.</i>');
    return lines.join('\n');
  }

  async weatherText(now) {
    const today = londonParts(now).date;
    const loc = this.freshLocation(120);
    const days = Object.keys(this.data.days).sort();
    // Before the trip: an outlook for every trip day at that night's base.
    if (today < days[0]) {
      const lines = ['🌦 <b>Trip outlook</b> (live forecast, updates every few hours)'];
      for (const d of days) {
        const w = await this.weatherFor(d);
        const where = this.data.days[d]?.base?.name || this.data.trip.region?.name || '';
        lines.push(`${skyEmoji(w.sky)} <b>${dayLabel(d)}</b> ${where ? `(${esc(where)}) ` : ''}${w.lowC}–${w.highC}°C, ${esc(w.sky)}, rain ${w.rainChancePct ?? '?'}%, wind ${w.windKmh} km/h${w.source === 'forecast' ? '' : ' <i>(typical, not a forecast yet)</i>'}`);
      }
      lines.push('\n/pack shows what to bring for each day.');
      return lines.join('\n');
    }
    const here = loc ? { lat: loc.lat, lng: loc.lng, name: this.areaName(loc) || 'your location' } : { ...this.home, name: this.home.name };
    const [series] = await this.weather.hourly([here]);
    const lines = [`🌦 <b>Weather</b> · ${esc(here.name)}${loc ? '' : ' <i>(no live location, using the base)</i>'}`];
    if (series) {
      const i = series.hours.findIndex((h) => h.at === `${today}T${hhmm(now).slice(0, 2)}:00`);
      const cur = series.hours[i];
      if (cur) lines.push(`Now: ${skyEmoji(cur.sky)} ${cur.tempC}°C (feels ${cur.feelsC}°C), ${esc(cur.sky)}, gusts ${cur.gustKmh} km/h`);
      const next = series.hours.slice(i + 1, i + 7);
      if (next.length) lines.push(`Next hours: ${next.map((h) => `${h.at.slice(11, 13)}h ${skyEmoji(h.sky)}${h.rainPct >= 30 ? ` ${h.rainPct}%` : ''}`).join(' · ')}`);
    } else {
      const w = await this.weatherFor(today);
      lines.push(`${skyEmoji(w.sky)} ${w.lowC}–${w.highC}°C, ${esc(w.sky)}, rain ${w.rainChancePct}%`);
    }
    const stops = (await this.routeWeather(today).catch(() => [])).filter((st) => st.weather && st.time >= hhmm(addMin(now, -30)));
    if (stops.length) {
      lines.push('\n<b>Along today\'s route</b>');
      for (const st of stops) lines.push(`• ${st.time} ${esc(st.place)}: ${skyEmoji(st.weather.sky)} ${st.weather.tempC}°C${st.weather.rainPct >= 30 ? `, rain ${st.weather.rainPct}%` : ''}${st.weather.gustKmh >= 40 ? `, gusts ${st.weather.gustKmh} km/h` : ''}`);
    }
    return lines.join('\n');
  }

  // Live weather alerts: rain about to start where they are, and strong wind at an exposed stop coming up.
  // Free (no Claude), checked every 30 min, at most one rain alert per 3 hours.
  async checkWeather(now) {
    const date = londonParts(now).date;
    const mins = londonParts(now).minutes;
    if (!this.data.days[date] || this.tripOver(now) || mins < 7 * 60 || mins > 21 * 60 + 30 || this.isQuiet(now) || this.muted(now)) return;
    const last = this.tr.keys.wxcheck;
    if (last && minutesBetween(new Date(last), now) < 30) return;
    this.markT('wxcheck');
    const loc = this.freshLocation(60);
    const main = this.isMainTrack();
    if (!loc && !main) return;
    const upcoming = this.plansOn(date).filter((p) => p.location?.lat && p.start > now && minutesBetween(now, p.start) <= 180);
    const here = loc ? { lat: loc.lat, lng: loc.lng, name: this.areaName(loc) || 'where you are' } : upcoming[0]?.location;
    if (!here) return;
    const exposed = upcoming.filter((p) => EXPOSED.test(`${p.title} ${p.location.name}`) && !this.tr.keys[`wxwind:${p.id}`]);
    const series = await this.weather.hourly([here, ...exposed.map((p) => p.location)]);
    const { chatIds, prefix } = this.targetsFor();
    const hourKey = (d) => `${londonParts(d).date}T${hhmm(d).slice(0, 2)}:00`;

    const hours = series[0]?.hours || [];
    const i = hours.findIndex((h) => h.at === hourKey(now));
    if (i >= 0) {
      const cur = hours[i];
      const wetNow = cur.rainMm >= 0.3 || (cur.rainPct >= 70 && /rain|drizzle|shower|thunder/.test(cur.sky));
      const k = hours.slice(i + 1, i + 3).findIndex((h) => h.rainPct >= 65 && h.rainMm >= 0.3);
      const lastRain = this.tr.keys.wxrain;
      if (!wetNow && k >= 0 && (!lastRain || minutesBetween(new Date(lastRain), now) >= 180)) {
        const hit = hours[i + 1 + k];
        const clear = hours.slice(i + 2 + k, i + 9).find((h) => h.rainPct < 40);
        const where = loc ? esc(here.name) : `${esc(here.name)} (your next stop)`;
        const tip = this.driving(now) ? 'Good time to be in the car or grab food.' : 'Good time for a pub, café or shop.';
        await this.sendHtml(chatIds, 'weather', `${prefix}🌧 Rain heading for ${where} around <b>${hit.at.slice(11)}</b> (${hit.rainPct}%, ~${hit.rainMm} mm/h). ${clear ? `Should ease off around ${clear.at.slice(11)}.` : 'Looks like it sticks around, so hoods up.'} ${tip}`, { unprompted: true });
        this.markT('wxrain');
      }
    }
    for (const [j, p] of exposed.entries()) {
      const h = hourAt(series[j + 1], date, hhmm(p.start));
      if (!h || h.gustKmh < 55) continue;
      this.markT(`wxwind:${p.id}`);
      const bridge = /carrick-a-rede/i.test(`${p.title} ${p.location.name}`) ? ' The rope bridge closes in high winds, so check it\'s open before you drive there.' : '';
      await this.sendHtml(chatIds, 'weather', `${prefix}💨 Very windy at <b>${esc(p.location.name)}</b> around ${hhmm(p.start)} (gusts ~${h.gustKmh} km/h). Stay well back from edges, hold on to phones, hoods up.${bridge}`, { unprompted: true });
    }
  }

  // ---------------------------------------------------------------- text views

  todayText(now) {
    const date = londonParts(now).date;
    const day = this.data.days[date];
    const plans = this.plansOn(date);
    const lines = [`<b>${dayLabel(date)}</b>${day ? `: ${esc(day.label)}` : ''}`];
    for (const p of plans) lines.push(`• <b>${hhmm(p.start)}</b> ${p.personal ? '👤 ' : p.locked ? `🔒#${p.n} ` : ''}${esc(p.title)}${p.fixed || p.personal ? '' : ' <i>(flexible)</i>'}`);
    if (!plans.length) lines.push('• No fixed plans today.');
    const others = this.tr.isGroup || this.isMainTrack() ? this.personalPlansFacts(date) : [];
    if (others.length) lines.push(`\nDoing their own thing:\n${others.map((o) => `• ${esc(o.who)}: ${esc(o.time)} ${esc(o.title)}`).join('\n')}`);
    if (day?.flow) lines.push(`\n${esc(day.flow)}`);
    if (this.publicUrl) lines.push(`\n🗺 <a href="${esc(this.webUrl(date))}">Timeline + map</a>`);
    return lines.join('\n');
  }

  statusText(now) {
    const l = this.tr.location;
    const next = this.nextFixed(now);
    const solo = Object.values(this.s.tracks).filter((t) => !t.isGroup && !this.isMainTrack(t) && this.freshLocation(120, t));
    const lines = [
      `🕒 ${dayLabel(now)} ${hhmm(now)} London${this.clock.faked ? ' <b>(TEST CLOCK: /fake off to stop)</b>' : ''}`,
      `📍 ${l ? `${esc(this.areaName(l) || 'somewhere')} · ${minutesBetween(new Date(l.at), now)} min ago · from ${esc(l.name || '?')}` : 'no location shared in this chat yet'}`,
      `➡️ Next fixed: ${next ? `${esc(next.title)} ${dayLabel(next.start)} ${hhmm(next.start)}` : 'none'}`,
      `⏱ Delay: ${this.tr.delay ? `${this.tr.delay.minutes} min on ${this.tr.delay.planId}` : 'none'} · 🔕 ${this.muted(now) ? `muted until ${hhmm(new Date(this.tr.muteUntil))}` : 'not muted'}`,
      `💡 Suggested so far: ${this.tr.suggested.length} · skipped: ${this.tr.skipped.length} · ⭐ wishlist: ${this.s.wishlist.length}`,
      `👤 Solo right now: ${solo.map((t) => esc(this.personName(t.chatId))).join(', ') || 'nobody'}`,
      `🤖 Writer: ${this.writer.usingClaude ? `Claude (${this.writer.model})` : 'templates (no ANTHROPIC_API_KEY)'}`,
      `👥 Groups: ${Object.values(this.s.groups).map((g) => `${esc(g.title)}${g.approved ? ' ✅' : ' ⏳'}`).join(', ') || 'none'}`,
    ];
    return lines.join('\n');
  }

  webUrl(date) {
    const base = this.publicUrl.replace(/\/$/, '');
    return `${base}/today?k=${this.s.webKey}${date ? `&date=${date}` : ''}`;
  }
}

// Keep the last few Q&A turns, dropping anything empty or out of order (the API rejects empty messages
// and needs user/assistant turns to alternate, starting with the user).
export function cleanHistory(history = []) {
  const ok = (history || []).filter((m) => m && typeof m.content === 'string' && m.content.trim());
  const out = [];
  for (const m of ok) {
    const want = out.length % 2 === 0 ? 'user' : 'assistant';
    if (m.role === want) out.push({ role: m.role, content: m.content });
  }
  if (out.length % 2 === 1) out.pop();
  return out.slice(-6);
}

// ---------------------------------------------------------------- intent parsing (no AI needed)

// Wake word for the group chat, per trip: "Cench, what's the plan?" / "Ed what now?" (also "hey …", "yo …").
export const wakeRegex = (word = 'Cench') => new RegExp(`^(hey |yo |ok )?${word.replace(/[^\w]/g, '')}\\b[,:!]?\\s*`, 'i');


export function parseIntent(raw) {
  const original = raw.trim();
  const t = original.toLowerCase();
  // Wishlist: explicit forms work anywhere; casual forms ("I want to see X") only when talking to the bot.
  const grab = (re) => { const m = original.match(re); return m ? m[m.length - 1].trim().replace(/[.!?]+$/, '') : null; };
  let w = grab(/^(?:wishlist|wish ?list|add to (?:the )?list)\s*[:\-]\s*(.+)$/i)
    || grab(/^(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:the\s+|our\s+)?(?:list|wishlist|wish list|plan)\b.*$/i);
  if (w) return { type: 'wish', text: w, explicit: true };
  // A dated/timed statement is a personal plan, not a wish: let Claude handle it (it can save plans).
  const looksLikePlan = /\b(oct(ober)?\s*\d|\d{1,2}(st|nd|rd|th)?\s*oct|fri(day)?|sat(urday)?|sun(day)?|mon(day)?|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}:\d{2})\b/i.test(original);
  w = grab(/^(?:i|we)\s+(?:really\s+|also\s+)?(?:want|wanna|would like|need|have)\s+to\s+(?:see|go to|visit|try|check out|hit|eat at|eat|grab|get|watch|buy|shop at|do|go)\s+(.+)$/i)
    || grab(/^(?:we should|can we|let'?s|we gotta|we have to)\s+(?:go to|see|visit|try|check out|hit|do|eat at|eat|grab|get|watch|shop at)\s+(.+?)\??$/i);
  if (w && !looksLikePlan && !/\b(now|today|tonight|right now)\b/i.test(w)) return { type: 'wish', text: w, explicit: false };
  if (/\b(wish ?list|the list)\b/.test(t) && /\b(what|what's|whats|show|see|who|anything|on)\b/.test(t) && !/\b(add|put)\b/.test(t)) return { type: 'show_wishlist' };
  // "I paid 45 for dinner": the simple form is free; anything fancier (someone else paid, uneven split) goes to Claude.
  if (/^(?:i|we)\s+(?:just\s+)?(?:paid|spent|covered)\s+[€£$]?\d/.test(t) && !/\b(split|between|only|just me|for (?:me|him|us) and|except|half)\b/.test(t)) return { type: 'expense', text: original };
  const rem = original.match(/^remind\s+(?:me|us|everyone|the group)\s+(?:in\s+(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)|at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)\s+(?:to\s+|that\s+|about\s+)?(.+)$/i);
  if (rem) {
    const inMin = rem[1] ? Math.round(Number(rem[1]) * (/^h/i.test(rem[2]) ? 60 : 1)) : null;
    let hh = rem[3] ? Number(rem[3]) : null;
    if (hh !== null && /pm/i.test(rem[5] || '') && hh < 12) hh += 12;
    if (hh !== null && /am/i.test(rem[5] || '') && hh === 12) hh = 0;
    if ((inMin && inMin <= 7 * 24 * 60) || (hh !== null && hh < 24)) return { type: 'remind', inMin, hh, mm: Number(rem[4] || 0), text: rem[6].replace(/[.!]+$/, '') };
  }
  // Petrol, toilets, ATMs, parking… near where they are right now (not "is there parking at Kylemore?").
  const need = essentialFor(t);
  if (need && !/\b(?:at|in|by|near)\s+(?!me\b|us\b|here\b|the\s+(?:moment|end|area)\b)[a-z]/i.test(original.replace(/\bnear (?:me|us|here)\b/gi, ''))) return { type: 'essential', kind: need };
  if (/\b(my plans|my own plans|what am i doing)\b/.test(t)) return { type: 'show_myplans' };
  if (/^(what now|now what|what'?s next|whats next|what should we do|what do we do|wyd|what next)\b/.test(t)) return { type: 'what_now' };
  if (/\b(on time|not late anymore|back on track|cancel (the )?delay)\b/.test(t)) return { type: 'ontime' };
  if (/\b(late|behind|delayed)\b/.test(t) && !/late[- ]?night|open late|stay(ing)? out late|late (food|bite|eats|spot)/.test(t) && /\b(we|i|running|gonna|going|be|are|am|'re|'m)\b/.test(t)) {
    const h = t.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/);
    const m = t.match(/(\d+)\s*(m|min|mins|minutes)?\b/);
    const minutes = h ? Math.round(Number(h[1]) * 60) : m ? Number(m[1]) : /\b(an|one) hour\b/.test(t) ? 60 : /half (an )?hour/.test(t) ? 30 : 15;
    return { type: 'late', minutes: Math.min(Math.max(minutes, 5), 180) };
  }
  if (/^(skip|nah|pass|not feeling (it|that)|something else)\b/.test(t)) return { type: 'skip' };
  const mute = t.match(/^(mute|shh+|quiet|stop pinging)\b(?:.*?(\d+))?/);
  if (mute) return { type: 'mute', minutes: Number(mute[2]) || 120 };
  const dir = t.match(/(?:how (?:do|can|should|would) (?:i|we) get (?:back )?to|directions to|route to|take (?:me|us) to|get (?:me|us) to|how to get to|how far is|way to)\s+(.+?)[?.!]*$/);
  if (dir) return { type: 'directions', query: dir[1] };
  if (/\b(near (me|us|here|by)|nearby|around here|close by|closest|near where we are)\b/.test(t)) {
    return { type: 'nearby', categories: categoriesFor(t) };
  }
  return { type: 'answer' };
}
