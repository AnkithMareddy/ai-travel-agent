import Anthropic from '@anthropic-ai/sdk';

// What each message type is for. Facts are always passed as JSON alongside.
const GOALS = {
  leave_warning: 'Heads-up: they need to leave for a fixed plan in about 15 minutes. Say when to leave, how to get there and how long it takes.',
  leave_now: 'Time to leave NOW for a fixed plan. Urgent but friendly. Say the route and travel time. If they are running late, say so and mention the phone number if one is given.',
  free_time: 'They have free time before the next plan. Pitch the suggested places (1–3) with why each one is worth it for this group, and travel time. Mention when they need to be back on track for the next plan.',
  new_area: 'They just walked into a new neighborhood. One-line vibe of the area plus what is worth checking out here right now.',
  morning_brief: "Morning brief for today: the day's fixed plans with times, the flow (if facts.agreedInChat or recentGroupChat shows what they decided last night, go with that and say so; mention any wishlistToday items that fit, and who asked for them), then the weather along the route (facts.weatherAlongRoute: call out when and where rain or strong wind hits, e.g. 'showers at Moher ~18:00'). End with a '🎒 Pack' checklist built from facts.packList (keep each item short, and add anything clearly needed for what they discussed in the chat). Up to ~16 lines.",
  night_wrap: "Night wrap-up. Start with '📓 Today' and a 2–4 line recap from facts.todayRecap and recentGroupChat: where they went, km driven, what they spent, and one fun or memorable moment from the chat (no inventing). Then tomorrow: the first fixed plan (or that the day is open), what time to be up and why, tomorrow's weather along the route in one line, and anything to prep or pack tonight (facts.packList). If they haven't settled tomorrow yet, end by inviting them to talk it through and tell you the plan (e.g. 'Ed, tomorrow we're doing …') so you can update it. Short.",
  reminder: 'A plan-related reminder. Turn the facts into clear, practical instructions.',
  exit_plan: 'Post-match exit plan. Give the options clearly, recommend one, keep it scannable.',
  what_now: 'They asked "what now?". Say where they stand (current/next plan, how much time they have), then suggest what to do with it.',
  nearby: 'They asked for places nearby matching a request. Recommend the given places in order, one line each with why and travel time.',
  directions: 'They asked how to get somewhere. Give the route, time, and when to leave if it is a fixed plan.',
  answer: 'Answer their question helpfully using the facts. Recommend places from facts.nearbyPlaces when relevant.',
  sun_ping: "A sunrise or sunset heads-up (facts.event). Pick the single best spot from facts.candidates to watch it from: it needs a clear view toward facts.sunDirection (open sea/coast or high ground facing that way) and to be reachable in time (facts.candidates[].distKm, facts.driving). Write its id in double braces once, like {{vp3}}. Say when to leave and be there (golden light from facts.goldenFrom), and the cloud outlook (facts.cloudPct: 80%+ means probably a dud; say so and keep it short). If no candidate fits, suggest a spot you are confident exists near facts.where, or none. Keep it optional and 2–4 lines; never pull them away from a fixed plan.",
  late_enroute: 'Urgent heads-up while they are on the way: at their current pace they will reach a fixed plan after it starts (facts.arriveAt vs facts.plan.time). Say it plainly with both times, then the best fix: facts.fallback / facts.nextOption if given (e.g. the next ferry), otherwise what to drop or who to call (facts.plan.phone). 2–4 lines.',
  move_on: 'Road-trip nudge: their planned time at this stop is up. Say where they go next, the drive time, and whether they are on schedule or behind (and by how much). If facts.fallback is present, suggest only the parts of it that are still ahead of them (they have already done or passed earlier stops). Keep it to 2–4 lines.',
};

// The system prompt is built from the trip's own description (trips/<trip>/itinerary.json -> trip).
export function systemFor(trip) {
  const place = trip.region?.name || 'the city';
  return `You are ${trip.wakeWord || 'Cench'}, the group's trip assistant for "${trip.name}", texting them on Telegram while they're out and about.
Who they are: ${trip.group}
${trip.about || ''}
${trip.planningRules ? `How to plan: ${trip.planningRules}\n` : ''}Voice: a friend who knows ${place} well: warm, quick, a little hype, never cheesy. No corporate tone.
Rules:
- Keep it short and scannable: 2–6 lines (briefs and wrap-ups may be up to ~12 lines). Plain text. You may use **bold** for times and place names, and "•" bullets. At most 2 emojis.
- Do NOT include links or URLs, except a booking link you found by researching (the restaurant's own booking page, OpenTable, TheFork, Resy) or a phone number. The app appends map links after your text.
- Only use facts you are given for times, prices, opening hours, travel times and bookings. Never invent them. If something is missing, leave it out.
- Times are local time in 24h format (e.g. 19:15).
- Fixed plans never move. If they are at risk of being late for one, say so plainly.
- Refer to places by the exact names given in the facts.
- Messages go to the whole group unless facts.forPerson (or askedBy) is set. Don't address anyone by name otherwise.`;
}

const ANSWER_EXTRA = `
facts.recentGroupChat is the group chat so far (oldest first), including your own earlier replies. Use it for context: what they've discussed, agreed, want or said they're doing. Times, bookings and opening hours still come only from the plans and place facts. If they ask what was said, summarise from it.
When you recommend a place that appears in facts.nearbyPlaces, write its id in double braces exactly once, like {{supreme}}; the app turns that into the place name plus a map link. Don't use braces for anything else.`;

const BOOKING_EXTRA = `
When you suggest places to eat, drink or do (especially for a set time like dinner), for each give: why it fits, roughly how far it is, whether it takes bookings, and how to book (the booking link you found, or the phone number) or "walk-in only". Then offer to lock it in, e.g. "Booked one? Tell me the time and I'll add it with reminders" (they reply and you call lock_in_plan). Never claim you've booked anything yourself.
On the road (facts.onTheRoad set): if they ask where to eat or stop, look for places ALONG the route still ahead of them (between facts.onTheRoad.here and the next stop / tonight's base, with their ETAs), not behind them or off on a detour. Prefer a town they'll reach around the meal time, with the kitchen still open when they get there (check closing times; rural kitchens often stop serving at 20:00–21:00). Say how far ahead each is in minutes.`;

const RESEARCH_EXTRA = `
You can use web_search and web_fetch. Use them whenever they ask you to find, recommend, compare or plan something (e.g. "best spice bags near us", "plan a pub crawl after dinner", "what time does Camden Market open"), or when they send a link. Prefer places near their route and bases on the relevant day (facts.tripDays, facts.fixedPlans). Give real names, rough times and opening hours you found, and keep the answer short. Don't say you can't recommend something because it isn't in your notes; look it up.
When they asked you to find, suggest or plan places, call add_to_wishlist once for each place you recommend (text = "Name, street/area, town"; note = a few words on when or why, e.g. "pub crawl stop 1, Sat after Kutir"). If they sent a link or just named a place, add that place.`;

const TOOLS_EXTRA = `
Group fixed plans (facts.fixedPlans) are locked in and mandatory for everyone; personal plans must fit around them.
If the person tells you about their OWN commitment with a day and time (e.g. "only I'm going to a premiere at 2:15 on the 10th at the Southbank Centre"), call save_personal_plan, then explain how their day fits around the group plans. If a tool result reports a clash, say so plainly.
If they say they're NOT going to one of the group plans (e.g. "I'm skipping the match"), call skip_group_plan for that plan FIRST, then save any personal plan that replaces it. Flights can't be skipped.
When the group decides to LOCK IN a place or plan at a time ("lock in Summer Inn Friday 22:00", "let's do the pub crawl after Kutir", "book it in for Sunday morning"), call lock_in_plan once per stop with a concrete date and start time (if they say "after Kutir", start ~15 min after it ends and chain the stops ~45 min apart). That moves it from the wishlist into the group plan. Use the wishlist number or name from facts.groupWishlist when it's already there.
When they tell you what they've decided for a day ("tomorrow we're doing X then Y, skipping Z"), call update_day_plan with the new flow for that date (and drop_stops for itinerary stops they're skipping); call lock_in_plan too for anything at a fixed time.
Call add_to_wishlist when they ask you to add/save a place, when they share a place or link, or for the places you recommend after they asked you to find, suggest or plan something. Never call tools just to summarise the chat, or for things someone else said earlier unless they ask you to.
When someone says they paid for something for the group ("I paid 60 for petrol", "Sam got the ferry, 45 quid"), call log_expense. When they ask to be reminded of something at a time, call set_reminder (work out the exact local time from facts.now). When they ask for a vote, call create_poll.
facts.recentPolls shows how the group voted in recent polls; use it when they ask what was decided.
The app adds a confirmation line after your text, so don't repeat IDs or numbers from tool results.`;

const SCREENSHOT_EXTRA = `
They shared screenshots, photos or files (attached). Read them carefully and pull out what matters for the trip:
- Reservations and bookings (hotel/Airbnb, restaurant, tickets, tours, car hire, ferry, flights): call save_booking once per booking with every detail you can read (name, date, times, address, confirmation/reference number, party size, price, check-in/out). Match it to an itinerary plan when it's clearly the same thing.
- A place or location (a map pin, a restaurant or shop, an Instagram/TikTok post about a place): call add_to_wishlist with "Name, street/area, town". Look it up with web_search if the name or town isn't clear.
- A chat or note with a plan in it: summarise it; use update_day_plan or lock_in_plan only if they clearly decided.
Then reply in 1–4 lines with what you took from it. Never repeat full card numbers or passport numbers; confirmation codes are fine.
- A receipt or bill: call log_expense with the total actually paid (including tip if shown), the currency printed on it, and a short description built from their caption plus the merchant name (e.g. "Dinner at Kai, Galway"). The payer is the person who sent it unless the caption names someone else; use split_with only if the caption says it's not for everyone. If you can't read a total, ask them for it instead of guessing.
If there's nothing trip-related in it (a meme, a selfie, scenery), reply with exactly SKIP and call no tools.`;

export const answerTools = (trip) => {
  const days = Object.keys(trip.daysList || {}).sort();
  const range = days.length ? `${days[0]} to ${days.at(-1)}` : 'a trip day';
  return ANSWER_TOOLS.map((t) => (t.name !== 'save_personal_plan' ? t : {
    ...t,
    input_schema: {
      ...t.input_schema,
      properties: {
        ...t.input_schema.properties,
        date: { type: 'string', description: `YYYY-MM-DD, must be ${range}` },
        place: { type: 'string', description: `Venue name and/or address in ${trip.region?.name || 'the city'}, as specific as possible` },
      },
    },
  }));
};

const ANSWER_TOOLS = [
  {
    name: 'log_expense',
    description: 'Record a shared expense (goes into the group\'s Splitwise when connected, with the receipt photo attached). Use for receipts/bills or when someone says they paid for something for the group.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Total paid, including tip/service if it was paid (e.g. 84.5)' },
        currency: { type: 'string', enum: ['EUR', 'GBP', 'USD'], description: 'Currency on the receipt (Republic of Ireland €, Northern Ireland and London £)' },
        what: { type: 'string', description: 'Short description for Splitwise, e.g. "Dinner at Kai, Galway" or "Petrol, Applegreen Tarbert"' },
        payer: { type: 'string', description: 'First name of who paid. Default: the person who sent the message' },
        split_with: { type: 'array', items: { type: 'string' }, description: 'First names of who it is split between, ONLY if not everyone on the trip (include the payer if they share it)' },
        details: { type: 'string', description: 'Optional extra notes, e.g. what was ordered or why it is split unevenly' },
      },
      required: ['amount', 'currency', 'what'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a one-off reminder message for this chat at a specific local time (e.g. move the car before the parking runs out, book dinner, check out).',
    input_schema: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'Local time "YYYY-MM-DD HH:MM" (24h)' },
        text: { type: 'string', description: 'What to remind them, e.g. "Move the car: parking runs out at 15:30"' },
      },
      required: ['when', 'text'],
    },
  },
  {
    name: 'create_poll',
    description: 'Post a Telegram poll in the chat so the group can vote (e.g. which dinner spot, what time to leave). Use when they ask for a vote/poll or clearly can\'t decide between a few options.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Short question, max 250 characters' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10, description: 'Answer options, each max 100 characters' },
        multiple_answers: { type: 'boolean', description: 'Allow voting for several options' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'save_booking',
    description: 'Save a reservation/booking read from a screenshot or message (hotel, Airbnb, restaurant, tickets, tour, car hire, ferry, flight). Stays update where they sleep; timed bookings become group plans with reminders.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['stay', 'restaurant', 'tickets', 'tour', 'car', 'transport', 'flight', 'other'] },
        title: { type: 'string', description: 'Short title, e.g. "Guinness Storehouse tickets" or "Kilcar Airbnb"' },
        place: { type: 'string', description: 'Venue name and full address as shown, e.g. "Teach Barnai, Kilcar, Co. Donegal"' },
        date: { type: 'string', description: 'YYYY-MM-DD: the booking date (check-in date for stays, pickup date for cars)' },
        start: { type: 'string', description: 'HH:MM 24h start/slot time (check-in time for stays), if shown' },
        end_date: { type: 'string', description: 'YYYY-MM-DD check-out/drop-off date, if any' },
        end: { type: 'string', description: 'HH:MM 24h end/check-out time, if shown' },
        confirmation: { type: 'string', description: 'Booking reference/confirmation number, if shown' },
        details: { type: 'string', description: 'Other useful details in a few words: party size, price, what is included, cancellation deadline, access codes, contact phone' },
        matches_plan: { type: 'string', description: 'If it confirms an existing itinerary plan (facts.fixedPlans / tripDays), that plan\'s title' },
        just_me: { type: 'boolean', description: 'True only if it is clearly one person\'s own booking, not the group\'s' },
      },
      required: ['kind', 'title', 'date'],
    },
  },
  {
    name: 'update_day_plan',
    description: "Replace a trip day's rough plan with what the group decided (usually the night before). Morning brief, 'what now' and nudges then follow it.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (a trip day)' },
        flow: { type: 'string', description: 'The new plan for the day in order with rough times, like the itinerary flow ("Leave 08:30 → Kylemore 10:00 → …")' },
        drop_stops: { type: 'array', items: { type: 'string' }, description: 'Titles of itinerary stops that day they are no longer doing' },
        revert: { type: 'boolean', description: 'True to go back to the original itinerary for that day (flow is then ignored)' },
      },
      required: ['date', 'flow'],
    },
  },
  {
    name: 'lock_in_plan',
    description: 'Lock in a wishlist place (or a new place) as a GROUP plan at a specific date/time. Moves it off the wishlist into the itinerary so everyone gets reminders and leave-by alerts.',
    input_schema: {
      type: 'object',
      properties: {
        wishlist_item: { type: 'string', description: 'Wishlist number (e.g. "3") or place name from facts.groupWishlist; or a new "Name, street, town"' },
        title: { type: 'string', description: 'Short title, e.g. "Pub crawl stop 1: The Phoenix"' },
        date: { type: 'string', description: 'YYYY-MM-DD (a trip day)' },
        start: { type: 'string', description: 'HH:MM 24h local start' },
        end: { type: 'string', description: 'HH:MM 24h local end (optional)' },
      },
      required: ['wishlist_item', 'date', 'start'],
    },
  },
  {
    name: 'save_personal_plan',
    description: "Save a plan that only the person messaging will do (not the whole group), with a date and start time. Use for their own tickets, meetups, events. Never for group plans or vague ideas.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Movie premiere"' },
        date: { type: 'string', description: 'YYYY-MM-DD, must be 2026-10-09 to 2026-10-12' },
        start: { type: 'string', description: 'HH:MM 24h local time when it starts' },
        end: { type: 'string', description: 'HH:MM 24h end time if known; otherwise your best estimate' },
        place: { type: 'string', description: 'Venue name and/or address in London, as specific as possible' },
        arrive_early_min: { type: 'integer', description: 'Minutes early they want to arrive (default 10)' },
      },
      required: ['title', 'date', 'start', 'place'],
    },
  },
  {
    name: 'skip_group_plan',
    description: "Record that the person messaging is sitting out one specific group plan (e.g. a match). The rest of the group still goes. Flights can't be skipped.",
    input_schema: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'Which group plan, by name, e.g. "Chelsea vs Bournemouth"' } },
      required: ['plan'],
    },
  },
  {
    name: 'add_to_wishlist',
    description: 'Add a place or activity the group wants to fit in sometime during the trip (no fixed time).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The place: "Name, street/area, town" (e.g. "The Palace Bar, Fleet St, Dublin"), or an activity' },
        note: { type: 'string', description: 'Optional few words on when/why, e.g. "spice bag for Alex, Dublin night 1"' },
      },
      required: ['text'],
    },
  },
];

// $ per million tokens [input, output] (cache writes cost 1.25x input, cache reads 0.1x; web search $0.01 each).
const RATES = { 'claude-sonnet-5': [2, 10], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-haiku-4-5': [1, 5], default: [2, 10] };

export class Writer {
  constructor({ apiKey, model = 'claude-sonnet-5', offline = false, log = console, trip = null } = {}) {
    this.model = model;
    this.trip = trip || { name: 'London, Oct 9–12 2026', group: '5 guys, ~25, from California.', region: { name: 'London' } };
    this.system = systemFor(this.trip);
    this.log = log;
    this.client = apiKey && !offline ? new Anthropic({ apiKey, maxRetries: 2, timeout: 45_000 }) : null;
    this.usage = { calls: 0, input: 0, output: 0 };
  }

  get usingClaude() { return Boolean(this.client); }

  // Every Claude call goes through here: tracks tokens and estimated cost, and reports account problems
  // (out of credit, bad key) so the owner can be told instead of the bot silently degrading.
  async create(params, opts) {
    let response;
    try {
      response = await this.client.messages.create(params, opts);
    } catch (err) {
      const kind = err.status === 401 || err.status === 403 ? 'auth'
        : err.status === 400 && /credit balance|billing/i.test(err.message) ? 'credit' : null;
      if (kind) this.onTrouble?.(kind, err);
      throw err;
    }
    const u = response.usage || {};
    const [inRate, outRate] = RATES[this.model] || RATES.default;
    const searches = u.server_tool_use?.web_search_requests || 0;
    const cost = ((u.input_tokens || 0) * inRate + (u.cache_creation_input_tokens || 0) * inRate * 1.25
      + (u.cache_read_input_tokens || 0) * inRate * 0.1 + (u.output_tokens || 0) * outRate) / 1e6 + searches * 0.01;
    this.usage.calls += 1;
    this.usage.input += u.input_tokens || 0;
    this.usage.output += u.output_tokens || 0;
    this.onUsage?.({ cost, searches, input: u.input_tokens || 0, output: u.output_tokens || 0 });
    return response;
  }

  async write(kind, facts, history = []) {
    if (this.client) {
      try {
        return await this.claude(kind, facts, history);
      } catch (err) {
        this.log.warn?.(`Claude call failed (${kind}), using template: ${err.message}`);
      }
    }
    return template(kind, facts);
  }

  // "that arsenal museum thing" -> "Arsenal Museum, Emirates Stadium". Returns null if it isn't a specific place.
  async canonicalPlace(wish) {
    if (!this.client) return null;
    const response = await this.create({
      model: this.model,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system: `You turn a traveller's wish into the searchable name of one specific place in ${this.trip.region?.name || 'the area'} (venue, shop, restaurant, pub, landmark, viewpoint), e.g. "Arsenal Museum, Emirates Stadium". Reply with only the name. If the wish is not one specific place (e.g. "eat a full English", "see a show"), reply NONE.`,
      messages: [{ role: 'user', content: wish }],
    });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return !text || /^none\b/i.test(text) || text.length > 80 ? null : text.replace(/^["']|["'.]$/g, '');
  }

  // Free-form answer where Claude may also save things (personal plans, wishlist) via tools.
  // run(name, input) executes a tool and returns a JSON-able result. Returns null without Claude.
  // attachments: Claude content blocks (images / PDFs) sent along with the message.
  async answerWithTools(facts, history, tools, run, { attachments = [] } = {}) {
    if (!this.client) return null;
    const prompt = `Message type: answer\nGoal: ${GOALS.answer}\nFacts (JSON):\n${JSON.stringify(facts, null, 1)}`;
    const content = attachments.length ? [...attachments, { type: 'text', text: prompt }] : prompt;
    const messages = [...history.filter((m) => m?.content && String(m.content).trim()), { role: 'user', content }];
    const extra = attachments.length ? SCREENSHOT_EXTRA : '';
    // Server-side tools: Claude can search the web and read links people send (runs on Anthropic's side).
    // (No user_location: web search rejects some countries, e.g. IE; the itinerary facts say where they are.)
    const serverTools = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
    ];
    const said = []; // text from every round (Claude often writes the answer, then calls tools)
    for (let round = 0; round < 8; round++) {
      const response = await this.create({
        model: this.model,
        max_tokens: 6000,
        output_config: { effort: 'low' },
        system: [
          { type: 'text', text: this.system + ANSWER_EXTRA + TOOLS_EXTRA + RESEARCH_EXTRA + BOOKING_EXTRA, cache_control: { type: 'ephemeral' } },
          ...(extra ? [{ type: 'text', text: extra }] : []),
        ],
        tools: [...tools, ...serverTools],
        messages,
        // Caches the conversation so far: the follow-up round after a tool call re-reads it at ~10% of the price.
        cache_control: { type: 'ephemeral' },
      }, { timeout: 120_000 });
      if (response.stop_reason === 'refusal') throw new Error('model declined');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) said.push(text);
      if (response.stop_reason === 'pause_turn') {
        // A long web search paused; send the turn back as-is and the server resumes.
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason !== 'tool_use') return said.join('\n\n');
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const block of response.content.filter((b) => b.type === 'tool_use')) {
        let out;
        try {
          out = await run(block.name, block.input);
        } catch (err) {
          out = { error: err.message };
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    return said.join('\n\n');
  }

  async claude(kind, facts, history) {
    const content = `Message type: ${kind}\nGoal: ${GOALS[kind] || GOALS.answer}\nFacts (JSON):\n${JSON.stringify(facts, null, 1)}`;
    const messages = [...history.filter((m) => m?.content && String(m.content).trim()), { role: 'user', content }];
    const response = await this.create({
      model: this.model,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: kind === 'answer' ? this.system + ANSWER_EXTRA : this.system, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    if (response.stop_reason === 'refusal') throw new Error('model declined');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('empty response');
    return text;
  }
}

// ---------- Fallback templates (used offline, in tests, or if Claude is unavailable) ----------

const list = (items, fmt) => items.map((x) => `• ${fmt(x)}`).join('\n');
const placeLine = (p) => `**${p.name}**: ${p.why}${p.travel ? ` (${p.travel})` : ''}`;

export function template(kind, f) {
  switch (kind) {
    case 'leave_warning':
      return `⏰ Leave in ~15 min for **${f.plan.title}** (${f.plan.time}).\nHead out by **${f.leaveAt}**: ${f.route.summary}, ~${f.route.minutes} min.${f.delayNote ? `\n${f.delayNote}` : ''}`;
    case 'leave_now':
      return `🚨 Time to go: **${f.plan.title}** at ${f.plan.time}.\nLeave now: ${f.route.summary}, ~${f.route.minutes} min, arriving ~${f.arriveAt}.${f.late ? `\nYou're cutting it close.${f.plan.phone ? ` Call ahead: ${f.plan.phone}.` : ''}` : ''}${f.delayNote ? `\n${f.delayNote}` : ''}`;
    case 'free_time':
      return `You've got ~${f.freeMinutes} min free${f.next ? ` before heading to **${f.next.title}** (leave ~${f.next.leaveAt})` : ''}. Ideas nearby:\n${list(f.places, placeLine)}`;
    case 'new_area':
      return `📍 You're in **${f.area.name}**. ${f.area.blurb}${f.places.length ? `\nWorth a look:\n${list(f.places, placeLine)}` : ''}`;
    case 'morning_brief': {
      const plans = f.plans.length ? list(f.plans, (p) => `**${p.time}** ${p.title}${p.where ? ` @ ${p.where}` : ''}`) : '• No fixed plans, it\'s an open day';
      const w = f.weather;
      return `☀️ Morning! ${f.day}\n${plans}\nFlow: ${f.flow || 'wing it'}\nWeather: ${w.sky}, ${w.lowC}–${w.highC}°C (${w.lowF}–${w.highF}°F), ${w.rainChancePct}% rain. Bring layers${w.rainChancePct >= 40 ? ' and a compact umbrella' : ''}.`;
    }
    case 'night_wrap':
      return `🌙 Wrap-up. Tomorrow (${f.tomorrow}): ${f.firstPlan ? `first up is **${f.firstPlan.title}** at **${f.firstPlan.time}**` : 'no fixed plans until later'}.\nBe up by **${f.wakeBy}**. ${f.flow || ''}`.trim();
    case 'reminder':
    case 'exit_plan':
      return `📌 ${f.topic}\n${Object.entries(f).filter(([k]) => k !== 'topic').map(([, v]) => `• ${v}`).join('\n')}`;
    case 'what_now':
      return `${f.current ? `Right now: ${f.current}. ` : ''}${f.next ? `Next: **${f.next.title}** at ${f.next.time} (leave ~${f.next.leaveAt}).` : 'Nothing fixed left today.'}${f.places?.length ? `\nWith the time you have:\n${list(f.places, placeLine)}` : ''}`;
    case 'nearby':
      return f.places.length ? `Closest good options for ${f.request}:\n${list(f.places, placeLine)}` : `Nothing in my list for ${f.request} that's open nearby right now.`;
    case 'sun_ping':
      return `🌅 ${f.event === 'sunrise' ? 'Sunrise' : 'Sunset'} at **${f.time}** (sun ${f.sunDirection}). Golden light from ${f.goldenFrom}.${typeof f.cloudPct === 'number' && f.cloudPct >= 80 ? ` Cloud cover ~${f.cloudPct}%, so it may be a dud.` : ''}`;
    case 'late_enroute':
      return `⚠️ At this pace you'll reach **${f.plan.title}** at **${f.arriveAt}**, about ${f.lateByMin} min after it starts (${f.plan.time}).${f.nextOption ? `\n${f.nextOption}` : f.fallback ? `\nPlan B: ${f.fallback}` : f.plan.phone ? `\nCall ahead: ${f.plan.phone}` : ''}`;
    case 'move_on':
      return `🚗 Time to move on from ${f.leaving}. Next: **${f.next.title}**${f.next.plannedArrival ? ` (planned ${f.next.plannedArrival})` : ''}, ${f.route.summary}. ETA **${f.eta}**, ${f.status}.${f.fallback ? `\nPlan B: ${f.fallback}` : ''}`;
    case 'directions':
      return `To **${f.to}**: ${f.route.summary}, ~${f.route.minutes} min.${f.leaveAt ? ` Leave by **${f.leaveAt}**.` : ''}`;
    default:
      return f.fallbackText || "I'm not sure. Try \"what now?\", \"food near me\" or \"how do I get to Kutir\".";
  }
}
