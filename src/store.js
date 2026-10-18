import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Per-chat "track": the group chat is one track, and each person who DMs the bot gets their own,
// so people can split up and still get guidance based on their own location.
export const newTrack = (chatId) => ({
  chatId: Number(chatId),
  isGroup: Number(chatId) < 0,
  location: null,      // { lat, lng, at, userId, name }
  area: { current: null, pending: null },
  keys: {},            // leave-by / new-area alerts already sent for this track
  suggested: [],       // place ids already suggested (never repeated unprompted)
  skipped: [],         // place ids this track said "skip" to
  lastSuggestion: [],  // ids in the most recent suggestion (for "skip")
  lastUnpromptedAt: null,
  lastFreeTimeAt: null,
  snoozeUntil: null,
  muteUntil: null,
  delay: null,         // { minutes, planId, setAt }
  history: [],         // recent Q&A turns for context
});

const fresh = () => ({
  ownerChatId: null,
  ownerUserId: null,
  groups: {},          // chatId -> { title, approved }
  members: {},         // userId -> first name (people seen in approved chats)
  dm: {},              // userId -> true once they've opened a private chat (bots can't DM people first)
  chatLog: {},         // chatId -> [{ at, who, text }] recent group conversation, used as context for answers
  tracks: {},          // chatId -> track (see newTrack)
  keys: {},            // group-wide alerts that must fire once (briefs, wrap-ups, reminders)
  wishlist: [],        // [{ n, text, by, at, placeId?, place? }] things friends asked for before/during the trip
  personalPlans: {},   // userId -> [{ n, id, title, start, end, location, arriveEarlyMin, by }]
  optOuts: {},         // userId -> [group plan ids they're sitting out, e.g. a match]
  groupPlans: [],      // plans the group locked in from the wishlist: [{ n, id, title, start, end, location, arriveEarlyMin, by, wish }]
  bookings: [],        // reservations read from screenshots/files: [{ n, kind, title, date, start, endDate, end, place, confirmation, details, by, at }]
  dayOverrides: {},    // date -> { flow?, base?, by, at }: tomorrow's plan as agreed in the chat, or a booked stay's address
  droppedStops: [],    // itinerary stop ids the group decided not to do
  expenses: [],        // [{ n, payer, amount, currency, what, split, details, by, at, swId? }] (mirrors what went to Splitwise)
  swGroupId: null,     // Splitwise group for this trip (else SPLITWISE_GROUP_ID)
  swLinks: {},         // Telegram userId -> Splitwise user id (/swlink)
  venmo: {},           // Telegram userId -> Venmo handle (/venmo), for settle-up links
  reminders: [],       // [{ n, chatId, at, text, by }] one-off reminders people asked for
  polls: {},           // pollId -> { question, chatId, at, options: [{ text, votes }], voters, closed }
  usage: {},           // date -> { calls, cost, searches } estimated Claude spend
  trail: {},           // date -> { km, last: { lat, lng } } distance covered (from the group's live location)
  journal: {},         // date -> the nightly recap text (the trip log)
  webKey: randomBytes(12).toString('hex'),
  fakeNow: null,
});

// Tiny JSON-file store. Pass file=null for in-memory (tests / simulator).
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'state.json') : null;
    this.state = fresh();
    if (this.file) {
      mkdirSync(dir, { recursive: true });
      try {
        this.state = { ...fresh(), ...JSON.parse(readFileSync(this.file, 'utf8')) };
      } catch { /* first run */ }
      this.save();
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  logMessage(entry) {
    this.onLog?.(entry);
    if (!this.dir) return;
    appendFileSync(path.join(this.dir, 'messages.log'), `${JSON.stringify(entry)}\n`);
  }

  // Clears trip progress (alerts sent, suggestions, areas) but keeps who is allowed in.
  resetTripProgress() {
    const keep = ['ownerChatId', 'ownerUserId', 'groups', 'members', 'dm', 'webKey', 'wishlist', 'personalPlans', 'optOuts', 'chatLog', 'groupPlans', 'bookings', 'dayOverrides', 'droppedStops', 'expenses', 'swGroupId', 'swLinks', 'venmo', 'reminders', 'usage', 'trail', 'journal'];
    const next = fresh();
    for (const k of keep) next[k] = this.state[k];
    this.state = next;
    this.save();
  }
}
