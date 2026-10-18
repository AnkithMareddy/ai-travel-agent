# London Trip Bot 🇬🇧

A Telegram bot that follows the group around London (Fri 9 – Mon 12 Oct 2026) and texts us:

| When | What |
|---|---|
| 15 min before we need to leave for a fixed plan | ⏰ heads-up with the route and travel time (real TfL times from where we are) |
| When it's time to go | 🚨 "leave now" |
| We have a gap | 1–3 open places nearby that fit the time, on the way to the next plan |
| We walk into a new neighbourhood | 📍 "you're in Soho, worth checking out…" |
| 08:30 every day | ☀️ the day's plan, weather, what to wear/bring |
| Late evening (after dinner ends) | 🌙 tomorrow's first plan and what time to be up |
| After the West Ham match | the smart exit plan from Stratford |
| Landing at Heathrow / checkout morning | how to get to the Airbnb / airport |

Rules it follows: max ~1 unprompted message per 45 min (leave-by alerts excepted), nothing 01:00–08:00, never suggests the same place twice, and every place comes with Google Maps + Citymapper transit links from where you are.

You can text it anytime: **"what now?"**, **"food near me"**, **"best streetwear near me"**, **"how do I get to Kutir"**, **"skip"**, **"we're running late 20 min"**, or ask anything.

> ⚠️ **Date check:** Oct 9, 2026 is a **Friday** (your notes said Thursday). The West Ham vs QPR match is confirmed for Fri 9 Oct, 20:00 (Sky Sports). All dates below are correct; only the weekday was off.

---

## Two trips, one codebase

The same bot code runs each trip from its own folder:

| Trip | Folder | Railway service | Telegram bot |
|---|---|---|---|
| London, Oct 9–12 | `trips/london/` | `london-trip-bot` (no `TRIP` variable = london) | @your_trip_bot |
| Ireland road trip, Oct 2–9 | `trips/ireland/` | second service with `TRIP=ireland` | its own bot (also answers to "Cench") |

Each folder has `itinerary.json`, `places.json`, `neighborhoods.json` and `sim-route.json`. Run anything for Ireland by putting `TRIP=ireland` in front:

```bash
TRIP=ireland npm run simulate
```

```bash
TRIP=ireland npm run check-data
```

**What's different on the road trip:**
- **A base per night:** "home", weather and "how do I get to tonight's base" follow the itinerary night by night.
- **Driving times** come from OSRM (free, no key), padded 15% for Irish roads. Dublin days are walk/taxi.
- **"Time to move on" nudges:** at each timed stop, when your slot is up, you get where's next, the drive time, and whether you're ahead or behind. If you're 30+ min behind, you also get that day's Plan B. Nudges are skipped when there's slack (evening pubs, long gaps).
- **Immovable plans:** the Tarbert ferry and flights won't wait. "We're running late" tells you the next sailing and the Plan B.
- **No detour suggestions** while scheduled stops remain that day.
- **Links:** Google Maps driving links on car days, walking when it's close, and Citymapper only in Dublin.

## 🎬 Reel Studio (the trip's video editor)

`studio/` is its own project: drop each night's GoPro and iPhone footage on the Mac, and it cuts a vertical **Instagram vlog**, a **YouTube episode**, a **cinematic short**, a **teaser reel** and a **photo dump** for every day, plus a **trip film**. The edits are story-driven (Claude plans them from the footage, what was said and this itinerary), colour-graded and cut to the day's song. See [studio/README.md](studio/README.md).

---

## Part 1: Accounts and keys you need

You need **3 things** (plus 1 optional). Budget about 20 minutes.

### 1. Telegram bot token (required, free)

1. Install Telegram on your phone and sign up (all 5 of you need it).
2. In Telegram, search for **@BotFather** (blue check mark) and open it.
3. Send `/newbot`.
4. Give it a display name, e.g. `London Trip`.
5. Give it a username ending in `bot`, e.g. `ankith_london_trip_bot` (must be unique).
6. BotFather replies with a **token** like `7123456789:AAH...`. Copy it somewhere safe. **This is a password: don't share it.**
7. Still in BotFather, send `/setprivacy` → pick your bot → **Disable**. (This lets the bot see live locations shared in the group chat.)
8. *(Optional, recommended)* Search for **@userinfobot**, press Start, and note your numeric **Id**. This is your `OWNER_USER_ID`, which guarantees only you can claim the bot.

### 2. Claude API key (recommended, pay-as-you-go)

Without it the bot still works, but messages are plain fill-in-the-blank templates.

1. Go to **console.anthropic.com** and sign up.
2. **Billing** → add a card and buy credits. **$5 is plenty** (expected use is $1–4 for the whole trip).
3. **API Keys** → **Create Key** → name it `london-bot` → copy the key (starts with `sk-ant-`). You only see it once.
4. Optional: in **Limits**, set a monthly spend limit of $10 so nothing can surprise you.

### 3. Railway account (hosting, ~$5)

Railway runs the bot 24/7 in the cloud so it works while your laptop is closed.

1. Go to **railway.com** → **Login with GitHub** (create a free GitHub account at github.com first if you don't have one).
2. Choose the **Hobby** plan ($5/month, which includes $5 of usage; this bot uses well under that). Cancel after the trip.

### 4. TfL API key (optional, free)

The bot gets real Tube/bus times from TfL. It works **without a key** (with lower rate limits, which is fine for 5 people). If you want one:

1. Go to **api-portal.tfl.gov.uk** → Sign up → confirm email.
2. **Products** → **500 Requests per min** → Subscribe.
3. **Profile** → copy the **Primary key**. That's `TFL_APP_KEY`.

---

## Part 2: See what it does before the trip (test mode, 2 min)

This runs on your Mac and replays a fake walk through London over all 4 days, printing every message the bot would send. Nothing is sent to Telegram.

Open **Terminal**, then:

```bash
cd "ai-travel-agent"
```

```bash
npm install
```

```bash
npm run simulate
```

The output also gets saved to `sim-output.md`. Just one day:

```bash
npm run simulate -- --day 2026-10-10
```

To see the **real Claude-written messages** with live TfL times and weather, first create your `.env` file (below), then run this. It costs a few cents:

```bash
npm run simulate:live -- --day 2026-10-10
```

The fake walk is in `data/sim-route.json`. Edit it to try your own routes and texts.

### Your `.env` file (for running on your Mac)

```bash
cp .env.example .env
```

```bash
open -e .env
```

Paste your keys after the `=` signs (no quotes, no spaces), save, close. `.env` is ignored by git, so your keys never get uploaded.

---

## Part 3: Put it in the cloud (Railway)

### Step 1: Put the code on GitHub (private)

This folder is already a git repo. Create a **private** GitHub repo and push it:

```bash
gh auth login
```

```bash
gh repo create london-trip-bot --private --source . --push
```

(Or ask Claude Code to do it for you.)

### Step 2: Create the Railway service

1. In Railway: **New Project** → **Deploy from GitHub repo** → pick `london-trip-bot`. (Grant Railway access to the repo if asked.)
2. Click the new service → **Variables** → **Raw Editor**, and paste (with your real values):
   ```
   TELEGRAM_BOT_TOKEN=7123456789:AAH...
   ANTHROPIC_API_KEY=sk-ant-...
   CLAUDE_MODEL=claude-sonnet-5
   OWNER_USER_ID=123456789
   TFL_APP_KEY=
   DATA_DIR=/data
   ```
3. **Add a volume** so the bot's memory survives restarts: right-click the service (or ⌘K) → **Add Volume** → mount path `/data`.
4. **Settings** → **Networking** → **Generate Domain**. This gives the bot a web address for the `/map` page.
5. Railway deploys automatically. Open **Deployments** → **View logs** and look for `@yourbot running`.

### Step 3: Claim your bot and add the boys

1. In Telegram, open your bot (search its username) → press **Start** (sends `/start`). It replies "🔒 Locked to you". From now on it ignores everyone else.
2. Create a group chat with your 4 friends → group settings → **Add members** → add the bot. Because *you* added it, it's approved automatically. (If a friend adds it instead, you get a DM with an `/approve` command to tap.)
3. Friends who've been in the approved group can also DM the bot directly.

### Step 4: Rehearse with a fake date (do this before you fly)

In your **private chat** with the bot:

1. Send `/fake 2026-10-10 11:00`. The bot now thinks it's Saturday morning in London.
2. Send a location pin in London: 📎 → **Location** → drag the map to Soho → **Send selected location**.
3. Try `what now?`, `food near me`, `how do I get to Kutir`, `we're running late 20 min`, `/today`, `/status`, `/map`.
4. Wait a few minutes: you should get a "📍 You're in Soho & Carnaby" message.
5. **When done, send `/fake off`.** This resets everything so the real trip starts clean. (As a safety net, the bot also switches the fake clock off by itself from Oct 8.)

---

## Part 4: During the trip

**Every morning:** in the group chat, one person taps 📎 → **Location** → **Share Live Location** → **for 8 hours**. The bot uses whoever shared most recently, since you'll mostly be together. Live location stops after 8 hours, so re-share after dinner if you're still out.

Useful commands:
- `/today`: today's plan · `/map`: timeline + map web page
- `/status`: where the bot thinks you are and what's next
- `/mute 60`: pause tips for an hour (leave-by alerts still come) · `/unmute`
- In the group chat, start your message with **Cench** so the bot knows it's for it, e.g. *"Cench what now?"*, *"Cench food near me"*, *"Cench what's on the wishlist?"*. Replying to one of its messages also works, and `/commands` always work. Everything else is ignored, so normal chat stays normal. In a private chat with the bot, no wake word is needed.

---

## Splitting up: everyone can use the bot on their own

Group plans in `itinerary.json` are **locked in for everyone**. Around them, each person can do their own thing:

- **Private chat:** each friend opens a chat with @your_trip_bot and presses **Start** (they must be in the group chat first). Only people from the approved group can use it.
- **Solo guidance:** when someone splits off, they share **Live Location in their private chat** with the bot, not the group. Leave-by alerts, "what now?", "food near me" and free-time ideas then use *their* location and arrive privately. They still get every group-plan alert, so they're back for dinner.
- **Personal plans:** tell the bot in plain English (*"Cench, only I'm going to a premiere Oct 10 at 2:15 at the Southbank Centre"*) or use `/plan 2026-10-10 14:15-17:00 Movie premiere @ Southbank Centre`. `/myplans` lists yours and `/unplan 1` removes one.
  - A personal plan that **starts during a group plan is refused**.
  - One that **runs into** a group plan is saved with a warning ("leave by 18:40 to make Kutir"), and the leave-by alert fires on the day.
  - **Sitting out a group plan:** `/skipplan Chelsea` (or just say "I'm not going to the Chelsea game"). The group gets a message, that person stops getting alerts for it, and they're still held to every other group plan. `/rejoin Chelsea` undoes it. Flights can't be skipped.
  - The group's morning brief and `/today` list who's doing their own thing.
- If someone hasn't opened a private chat yet, their personal alerts go to the group, tagged "👤 Sam: …".
- Live Location shared in the **group** still drives the group's alerts. So: with the group, share in the group; on your own, share in your DM.

## Ask it to find or plan things (it researches live)

The bots can search the web and read links, so you can ask things like:
- *"Ed, Alex wants a spice bag, find the best ones near us"*
- *"Cench plan a pub crawl after Kutir"*
- *"Cench what days are the Camden and Portobello markets on?"*

The bot finds real places (near your route that day), gives names, times and hours, and **adds its picks to the wishlist** with a note like "pub crawl stop 2, Sat after Kutir".

**Links:** paste a **Google Maps link** in the group and it goes straight on the wishlist, no wake word needed. For any other link (Instagram, a restaurant site, an article), start with the wake word and the bot reads it and adds the place.

**Locking it in:** when you decide, say *"Cench lock in the pub crawl"* or *"Ed lock in Summer Inn Friday 22:00"*, or use `/lockin 3 2026-10-02 22:00` (wishlist number, date, time). It moves off the wishlist into the **group plan**: everyone gets it in `/today`, the morning brief and the map, plus leave-by alerts. It's refused if it overlaps something already locked in (dinner, a match, a flight). `/unlock N` puts it back on the wishlist.

Research answers take 10–30 s (you'll see "typing…") and cost ~3–7¢ each in Claude usage.

## Screenshots, bookings, weather and packing

- **Screenshots:** drop a booking confirmation (hotel/Airbnb, restaurant, tickets, car hire, ferry), a map pin or a place's Instagram/TikTok post in the chat. PDFs work too, and so do several at once as an album. The bot saves bookings with their reference numbers. A stay becomes that night's base, and a timed booking becomes a locked-in group plan (if the time differs from the itinerary, the booking wins). Places go on the wishlist. `/bookings` lists everything, and `/unbook N` removes one.
  - In the group it only reads tall phone-screenshot shapes, files, or images whose caption starts with the wake word, so holiday photos cost nothing. If a guessed screenshot turns out to be nothing trip-related, it stays quiet.
  - Cost: about 3–5¢ per screenshot, because images are big inputs.
- **Live weather (free, no AI):**
  - Every 30 minutes it checks the forecast where you are. It warns when rain is about to start (and says when it should clear) and when gusts over ~55 km/h are due at an exposed stop coming up (cliffs, the Causeway, the rope bridge).
  - `/weather` shows now, the next few hours and each stop on today's route. Before the trip it shows an outlook for every day.
- **Packing:** the morning brief ends with a 🎒 checklist built from the forecast at each stop plus the day's places (cliff shoes, ID for distilleries, £ in Northern Ireland, match bag rules, checking out of the base, chargers on driving days). `/pack` or `/pack tomorrow` gives the same list for free.
- **Nightly planning:** talk tomorrow through in the group, then tell the bot (*Ed, tomorrow we're doing X then Y, skipping Z*). It rewrites that day's plan and drops the skipped stops, and the morning brief follows it. The brief also reads last night's chat. To undo, say *go back to the original plan for Wednesday*.

## Money (Splitwise), reminders, polls and road-trip essentials

- **The tab (for Splitwise at the end):** snap a receipt and add a caption (*dinner at Kai, all of us* or *petrol, just me and Sam*), or just say *Ed, I paid 45 for petrol* or `/paid 45 petrol`. The bot reads the total and keeps a running tab, split evenly unless you say otherwise. The currency follows the day: € in the Republic, £ in Northern Ireland and London.
  - `/expenses` shows the running tab and `/unpaid N` removes one.
  - `/report` turns the whole tab into **one Splitwise expense per currency**. You enter it with *Paid by: multiple people* and *Split: exact amounts*, and the numbers add up to the cent. The bot posts it automatically on the last morning of the trip.
  - `/export` sends the line-by-line list as a CSV.
  - **Direct to Splitwise (optional):** whoever has Splitwise Pro (Sam) creates a personal API key at https://secure.splitwise.com/apps (Register your application, then Generate API key) and shares it privately. Add it as `SPLITWISE_API_KEY` in Railway on both services. From then on, every receipt goes straight into the Splitwise group whose name contains "Ireland" or "London" (or pick one with `/splitwise`), with the photo attached. Splits are matched to Splitwise members by first name. If someone doesn't match, they send `/swlink their Splitwise name`. `/report` then covers only what didn't make it into Splitwise.
  - `/venmo your-handle` adds Venmo pay links to `/expenses`.
- **Live traffic (optional):** leave-by alerts and "how long to X" use OSRM drive times padded by 15%. Add **one** key in Railway on the Ireland service and drives that start within the next 2 hours use live traffic instead (e.g. "drive ~74 min (68 km, incl. ~12 min of traffic)"):
  - `GOOGLE_MAPS_API_KEY`: console.cloud.google.com → create a project → enable **Routes API** → Credentials → Create API key. Billing has to be on, but this bot's use fits in Google's free monthly allowance.
  - or `TOMTOM_API_KEY`: developer.tomtom.com → sign up (free, no card) → copy the key from your dashboard (2,500 free lookups a day).
  - Each destination is looked up at most every 5 minutes while you drive. If the service fails, it falls back to the usual estimate.
- **"You'll miss it" warnings:** after "leave now", the bot keeps checking your live ETA every 10 minutes (with live traffic if a key is set). If you'll now reach a fixed time late (the ferry, the rope bridge slot, a flight), it says so with the fix, e.g. *"Next sailing is 17:30"*. At most two warnings per plan.
- **Hotel check-in and check-out (from booking screenshots):** when you arrive, a card with the booking reference, key-box code or check-in time. On the last morning, a check-out reminder about 75 minutes before check-out time.
- **Suggest, then book:** when Ed suggests food or things to do, it says whether each place takes bookings and how (booking link or phone), or that it's walk-in. Then it offers to lock one in once you've booked. On the road, *where can we eat on the way?* only looks at places ahead of you (it knows which stops are behind you and your ETAs to the next stop and tonight's base) and checks that kitchens will still be open when you arrive.
- **Direction of travel:** Ireland is planned as a one-way loop (Dublin → south → west coast → north → Belfast). Re-plans and suggestions never double back, and when you're behind it suggests what to drop. (`planningRules` in the itinerary.)
- **Sunrise and sunset:** Ed pings before sunrise (~55 min) and sunset (~80 min) with the best spot nearby that faces the sun. It uses viewpoints, headlands and beaches from OpenStreetMap plus your trip places, and the cloud forecast (if it's 80%+ cloud, it says the sunset will probably be a dud). London gets sunset only. `/sun` shows the times.
- **Nightly recap:** the night wrap-up starts with 📓 *Today*: where you went, km driven (from the group's live location), what you spent, and a moment from the chat. Each recap is saved, and `/journal` shows the whole trip log.
- **Reminders:** *Ed, remind us in 2h to move the car* or *remind me at 18:30 to book dinner*. `/reminders` lists them and `/unremind N` cancels one.
- **Polls:** *Ed, poll: Kai or Dough Bros for dinner* posts a Telegram poll. The bot sees the votes and knows what was decided.
- **Essentials (free, from OpenStreetMap):** *petrol near me*, *toilets?*, *nearest ATM*, *pharmacy*, *where can we park*, *supermarket*, *EV charger*.
- **London:** `/tube` shows live TfL delays, and the morning brief mentions disruptions.
- **Replies:** reply to any message with a question and the bot reads the message you replied to.
- **Spend:** `/usage` shows the estimated Claude spend per day. If the API credit runs out or the key stops working, the owner gets a DM (at most every 6 hours).

## Group wishlist (use it before the trip)

Anyone in the group can add places they want to hit, anytime, including before Oct 9:

- `/want Arsenal museum` · `/want Sketch` · `add Palace to the list` · `wishlist: Churchill War Rooms`
- In a private chat with the bot, casual phrasing works too: *"I want to see Abbey Road"*, *"we should try Dishoom"*. In the group, start with **Cench**.
- `/wishlist` shows everything with who asked · `/unwish 3` removes #3

The bot matches wishes to its places list, or finds them on OpenStreetMap (Claude cleans up vague wording like "that arsenal museum thing"). Wishlist places rank higher in free-time and "near me" suggestions, show up in the morning brief on days you're in that area, and appear as orange pins on the `/map` page. Things that aren't one place ("see a West End show") are kept as ideas. The wishlist survives `/fake off` and `/reset`.

## Editing plans and places

All trip data lives in the `data/` folder:

- **`itinerary.json`**: fixed plans (times, addresses, booking numbers, tips), the suggested flow per day, wake-up times, and the alert schedule (08:30 brief, 22:30 wrap, 01:00–08:00 quiet, 45 min between messages).
- **`places.json`**: 69 places with coordinates, neighbourhood, opening hours, and a one-line "why we'd like it". The `verified` field says what's been checked (see below).
- **`neighborhoods.json`**: the areas that trigger "you're in X" messages.

After editing, check for mistakes:

```bash
npm run check-data
```

Then push to GitHub and Railway redeploys automatically (about 1 minute):

```bash
git commit -am "Update plans" && git push
```

### What's been verified (checked on the web, 25 Sep 2026)

- ✅ **OMA** is at **3 Bedale Street, SE1 9AL** (upstairs from Agora, Borough Market). Sunday hours are listed as 12:00–22:00. Your booking is 21:00–23:30, so don't be late, and check with them if you plan to stay past 22:00.
- ✅ **VS141** departs Heathrow **Terminal 3**.
- ✅ **Kutir** (10 Lincoln St) is open Tue–Sun.
- ✅ **West Ham vs QPR** is Fri 9 Oct, 20:00.
- ⚠️ **Chelsea vs Bournemouth** is Sat 10 Oct at Stamford Bridge. Listings say **15:00** kick-off, but Premier League times can move for TV, so check the Chelsea app and edit `itinerary.json` if it changes. Add your block/seat details there too.
- ✅ **Kith London** opened Nov 2025 at 314 Regent Street, with Ronnie Fieg's restaurant inside.
- ✅ **Goodhood** moved to 15 Hanbury St (Shoreditch/Spitalfields).
- ✅ Supreme, ALD, END. (Broadwick St, not Glasshouse St), Stüssy (Wardour St), Carhartt WIP, Footpatrol, Dover Street Market, Selfridges, Sister Ray, Phonica, BFI IMAX, Borough Market (**closed Mondays**, Sunday until 16:00), Maltby Street (weekends only), Emirates tour are all operating in 2026.
- ⚠️ Marked `unverified` (they probably exist, but hours weren't checked): Nike London, Beyond Retro, Brick Lane Vintage Market, The Vintage Showroom, Padella, BAO Soho, Flat Iron, Tayyabs, The Golden Hind, Paul Rothe & Son. Run `npm run check-data` to see the list.
- ⚠️ Airbnb **checkout time is assumed to be 10:00**. Fix it in `itinerary.json` (the `checkout` plan) if yours is different.

---

## Costs for the 4 days

| Item | Cost |
|---|---|
| Telegram | Free |
| TfL Journey Planner, Open-Meteo weather, OpenStreetMap | Free |
| Railway Hobby plan (1 month, then cancel) | $5 |
| Claude API (Sonnet 5, ~35 messages/day × 4 days, ~2.5k tokens in / ~800 out each) | ~$1–4 |
| **Total** | **≈ $6–9** |

---

## Troubleshooting

- **Bot doesn't reply at all:** check Railway logs. `TELEGRAM_BOT_TOKEN` is probably wrong, or someone else pressed Start first. To re-lock, delete the volume's `state.json` (or the whole volume) and redeploy, then `/start` again.
- **Bot doesn't see live locations in the group:** BotFather `/setprivacy` must be **Disabled**, *then* remove and re-add the bot to the group.
- **Messages look robotic:** `ANTHROPIC_API_KEY` is missing or out of credit (`/status` shows "templates").
- **Travel times say "estimate":** TfL was unreachable. It falls back to a distance-based guess automatically.
- **Everything resets after a deploy:** the volume isn't mounted at `/data`, or `DATA_DIR` isn't `/data`.
- **Want to check what it sent?** Every message is logged to `messages.log` in the data folder.

---

## How it's built (for the curious)

```
src/index.js       starts everything: Telegram polling, a minute-by-minute scheduler, the web page
src/engine.js      the brain: leave-by alerts, free time, new areas, brief/wrap, anti-spam, commands, replies
src/recommend.js   picks places: open now, fits the gap, on the way, not repeated, matches your interests
src/transit.js     TfL Journey Planner (Elizabeth line, not Heathrow Express) + fallback estimates
src/writer.js      Claude (claude-sonnet-5) writes the messages from facts; templates if it's unavailable
src/telegram.js    Telegram Bot API (long polling, so no webhook setup needed)
src/web.js         /today page: timeline + map (the /map link)
scripts/simulate.js  test mode
test/              automated tests (npm test)
```

Claude only writes the wording. Times, routes, opening hours and links all come from the data files and TfL, so it can't invent a booking time. Map links are added by code, never by the AI.
