# AI Travel Agent

A Claude-powered travel agent that lives in a Telegram group chat and follows a group of friends around a trip. I built it for two real trips in October 2026, a London city break and an Ireland road trip, and ran it live for five of us.

It knows the itinerary, watches everyone's live location, and messages the group at the right moment: when to leave, what's nearby, what to book, and when a plan is about to fall apart.

The same repo also holds **[Reel Studio](studio/)**, an AI video editor that turns each day's footage into finished edits overnight.

## What it does

**Keeps the group on time**
- Leave-now alerts with live Tube, bus, and traffic times from wherever you are
- Warns mid-drive when you'll miss a fixed time (a ferry, a booking, a flight) and offers the next option
- Morning plan with weather and what to bring, and a late-night heads-up for tomorrow

**Finds things to do**
- Suggests pubs, food, and experiences near your location that fit the gap before your next plan
- Researches places on the web, including Reddit, and reads the Instagram and TikTok links the group drops in the chat
- Saves ideas to a shared wishlist, then locks them into the plan with times, alerts, and clash checks
- Prompts you to book when a place takes reservations

**Handles the boring parts**
- Reads booking screenshots and turns them into check-in and check-out reminders
- Tracks who paid for what and settles up through Splitwise
- Runs polls, remembers the group conversation, and answers questions in plain English

## How it works

- **Node.js** bot on the Telegram Bot API, deployed on **Railway**
- **Claude API** for reasoning, writing messages, reading screenshots, and web research
- A rules engine decides *when* to speak (rate limits, quiet hours, never repeating a place) and Claude decides *what* to say
- Transit and routing from **TfL**, **OSRM**, and optional live traffic (Google Routes or TomTom); weather from Open-Meteo
- One codebase runs multiple trips: each trip is a folder of JSON (`trips/london`, `trips/ireland`)
- **62 automated tests** (`npm test`), plus a simulator that replays a whole trip and prints every message the bot would send

## Reel Studio

An AI video editor for the same trips. Drop the day's GoPro and iPhone footage in a folder at night, and by morning there's an Instagram vlog, a YouTube episode, a cinematic short, a teaser reel, and a photo dump.

It scores every clip for sharpness, faces, and loud moments, transcribes speech with Whisper, then has Claude plan each edit as a story (hook, setup, journey, peak, payoff). It cuts to the beat of the day's song, color-grades with custom LUTs, and mixes to platform loudness. Python, FFmpeg, MLX Whisper, Claude API. See [studio/README.md](studio/README.md).

## Run it

```bash
npm install
npm test
npm run simulate
```

Full setup (Telegram bot, API keys, Railway deploy) is in [docs/SETUP.md](docs/SETUP.md).

*Trip data in this public copy is lightly anonymized: friends' names and private addresses are replaced.*
