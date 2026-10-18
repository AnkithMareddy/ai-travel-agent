# Reel Studio 🎬

The trip's own video editor. Every night you drop the day's GoPro and iPhone footage on the Mac. By morning there's a **vertical Instagram vlog**, a **YouTube episode**, a **cinematic short**, a **teaser reel** and a **photo dump** for that day, all cut to the day's song and colour-graded. A **trip film** rebuilds itself as the days add up.

It lives next to the trip bot and reads the same itinerary (`../trips/*/itinerary.json`). Each day's edits are titled with that day's plan, and every shot knows where you were when it was filmed.

| Format | For | Shape |
|---|---|---|
| **Instagram Vlog** | the daily post | 9:16, 45–90 s. Cold-open hook, time and place captions, real moments with burned-in subtitles |
| **YouTube Episode** | the daily upload | 16:9, 3–6 min. Cold open, then the title, chapter cards for each stop. Comes with `.srt` subtitles and a description with chapter timestamps |
| **Cinematic Short** | YouTube / the big screen | 16:9, 60–90 s. 2.39 letterbox, film grain, halation, music-led |
| **Teaser Reel** | Instagram / TikTok | 9:16, 15–25 s. Fast cuts on the beat, a flash on the drop |
| **Photo Dump** | Instagram carousel | Ten graded 4:5 stills pulled from the footage |
| **Moody** (on request) | Instagram | 9:16 slow-motion with a faded film look |
| **Trip Film** | YouTube | 16:9, the whole trip with a chapter per day |

## How it edits

1. **Sorts** each clip into its day by the camera clock. GoPros write local time but label it UTC, and the studio corrects for that.
2. **Watches every clip** (4 samples a second): sharpness, exposure, colour, movement, shake, faces and loud moments. It splits on scene changes and keeps the best few seconds of each scene. iPhone HDR is tone-mapped to SDR.
3. **Listens.** Speech is transcribed on the Mac (MLX Whisper on Apple Silicon). Anything said becomes its own shot, and visual cuts never chop a sentence in half.
4. **Plans the story.** Claude gets contact sheets of every shot plus the transcripts, the itinerary, your notes for the day and what happened on earlier days. It then plans each format as a story: **hook** (the best line or reaction, out of order) → **setup** (where we are, the plan) → **journey** with real moments → **peak** → **resolution** → **tag** (a callback to the hook). It also writes the Instagram captions, YouTube titles, descriptions and tags. Without an API key, a rule-based editor builds the same shape from scores and time order.
5. **Cuts to the song.** B-roll cuts land on the beat. Dialogue runs as long as the line, the music dips under it, and the next cut snaps back onto the beat. Short edits start one bar before the drop so the drop hits on a cut. Slow motion is used on 60 fps footage.
6. **Grades.** The grades are generated as 3D LUTs: *Emerald Isle* (Ireland), *London Noir*, *Blockbuster* teal/orange, *Vivid Pop*, *Faded Film*, *Golden Hour*, *Clean Warm* and *Mono*. Before the grade, each shot's exposure is matched so cuts don't jump in brightness. Skin tones are protected.
7. **Mixes** to −14 LUFS (the Instagram/YouTube loudness target).

Every edit comes in two versions: **with the music**, and **without it**. Post the no-music version on Instagram or TikTok and add the same song in the app: you get licensed music and the reach of a trending sound, and the cuts still line up if you start the song at the same point.

## Setup on the Mac (10 minutes, once)

```bash
cd "ai-travel-agent/studio"
```

```bash
./setup-mac.sh
```

```bash
open -e .env
```

Paste your `ANTHROPIC_API_KEY` (the same one the trip bot uses), save, close. Then start it:

```bash
./studio serve
```

Open **http://localhost:8787**. Leave this Terminal window open while you want edits made.

## Every night

1. **GoPro:** plug in the card, open it in Finder and drag the `.MP4` files from `DCIM/100GOPRO` into **`~/Trip Footage/Inbox`**. Skip the `.LRV` and `.THM` files; they're ignored anyway.
2. **iPhone:** AirDrop the videos to the Mac (they keep their original quality and the time they were shot), then drag them into the same Inbox. Or upload them on the studio's **Upload** page.
3. In the studio, open the day and:
   - **Pick the song.** Upload the track (mp3/m4a/wav) for exact beat-sync, or just type its name and the cuts follow its tempo.
   - **Write what happened** ("Sam left the keys in the pub, best sunset at Slea Head"). The story is built around it.
4. Edits appear as they finish. The trip bot can also ping the group chat (see `.env`).

Prefer the terminal? `./studio nightly` imports the Inbox, edits everything and exits.

### Treatments: AWGE, Super 8, "edit like…", or the song's own music video

The **Treatment** card on each day sets the look and cutting style laid over every edit:

- **AWGE camcorder:** VHS bleed and scanlines, fisheye, RGB split, handheld jitter and an orange camcorder date stamp. White flash frames land on the bar lines, cuts stutter, the peak freezes, and some cuts punch in or go black and white. Cutting is fast.
- **Cole Bennett / Lyrical Lemonade:** bright candy colour, fisheye close to the lens, snap zooms and whip-pan transitions on the beat, a white flash on the drop, bold yellow outlined titles, and photos as sticker cut-outs. (The hand-drawn cartoon animation from his videos is drawn by animators and isn't generated.)
- **Super 8:** a warm 4:3 home-movie look with heavy grain. **Mono documentary:** black and white in a 2.39 frame.
- **Edit like…** Type any creator, director or video (*AWGE*, *Cole Bennett*, *a Wes Anderson trailer*). Claude researches it on the web and turns it into these settings. It also picks shots to suit it: AWGE favours faces and chaos, Super 8 golden light.
- **Match the song's music video.** With the day's song set, Claude finds the official video and recreates its grade, texture, framing and cutting rhythm.
- Tick **use for every day** to make it the trip's house style. **Clean** switches it off.

From the terminal: `./studio treat 2026-10-04 cole`, `./studio treat 2026-10-04 awge`, `./studio treat 2026-10-04 music-video`, or `./studio treat 2026-10-04 "edit like Cole Bennett" --all`.

### Photos

Drop iPhone photos (HEIC or JPG) into the Inbox with the videos. They're sorted into days by when they were taken, and the editor uses them three ways:
- **Flash burst:** a few frames each, fired on one or two beats. Good on the drop, or as a transition between places.
- **Sticker:** a white-bordered card that pops in over the video cut before it, like a portrait over the scenery.
- **Full frame:** its own cut with a slow push-in, for a really great shot.

Claude chooses per photo. In **Edit the cut yourself**, tap ⟳ on a photo to switch between full frame, flash burst and sticker. The best photos also go into the Photo Dump carousel, graded to match.

Dialogue is never stuttered or flashed, so the real moments stay clean.

### Changing an edit

- **Ask for changes** on any format: *"open on Sam losing the keys"*, *"less driving, more of us"*, *"tighter, under 45 seconds"*. Claude re-cuts that edit.
- **Edit the cut yourself:** reorder or remove cuts, add any shot from the day, switch dialogue on or off per shot, write captions or YouTube chapter names, and change the title, hook or grade. Then **Save & render**. Long-press a bad shot to hide it for good.
- **Start the song elsewhere:** set "start the edit at" to any second of the song.
- **Open in Palmier:** downloads a pack with every shot already graded and cut, numbered in order, plus the song trimmed to the edit, the LUT, `edit.json` and a `PALMIER_PROMPT.md`. Open [Palmier Pro](https://www.palmier.io/), connect it to Claude Desktop (its MCP), and paste the prompt; Claude rebuilds the timeline so you can polish by hand. The same pack works in Resolve, Premiere or CapCut.

### From your phone

On the same Wi-Fi as the Mac, set `STUDIO_PASSWORD` in `.env`, then:

```bash
./studio serve --host 0.0.0.0
```

Open `http://<your-mac-name>.local:8787` on the phone.

## Terminal commands

```
./studio serve                         the studio + background editor
./studio nightly                       import the Inbox, edit everything, exit
./studio song 2026-10-05 ~/song.mp3    set a day's song (add --start 42 to begin 42 s in)
./studio ask 2026-10-05 vlog "open on the cliffs, shorter"
./studio render 2026-10-05 youtube     re-render one format
./studio plan 2026-10-05               re-plan the whole day
./studio export 2026-10-05 vlog        Palmier pack
./studio looks --out ~/Desktop/luts    write the grades as .cube files for other editors
./studio status                        what's done
./studio doctor                        check every component (ffmpeg, HEIC, speech, Claude key, queue, errors)
./studio retry                         retry clips that failed to import
```

## Shooting tips that make the edits better

- **GoPro: 4K or 2.7K at 60 fps.** 60 fps unlocks smooth slow motion in the cinematic, YouTube and peak shots. Leave HyperSmooth on.
- **iPhone: 4K 30 or 60.** HDR is fine (it's converted).
- **Hold every shot 5+ seconds.** The editor picks the best 2–6 seconds, and it needs room.
- **Talk to the camera.** Real lines ("we actually made it") become the hooks and the heart of the vlog.
- **Film the in-betweens:** the car, the walk to the pub, food arriving, a quiet look out the window. That's the story's glue.

## Disk

Originals are deleted once they're cut into shots (set `KEEP_ORIGINALS=1` to keep them, but GoPro files are huge). Shots plus edits come to about 0.5–1 GB per day. Everything lives in `~/Trip Footage/Studio`.

## How it's built

```
reel/analyze.py     shot detection and scoring, face/subject-aware crops, mezzanine cuts
reel/transcribe.py  on-device speech-to-text (mlx-whisper / faster-whisper)
reel/music.py       tempo, beats, bars, drop (numpy: spectral flux + dynamic-programming beat tracking)
reel/director.py    Claude story planning + rule-based fallback
reel/render.py      timeline, crop, slow-mo, grade, text, subtitles, ducking, loudness
reel/luts.py        the colour grades, generated as 3D LUTs
reel/export.py      Palmier / NLE project packs
reel/worker.py      the nightly job queue (survives restarts)
reel/server.py      the web app API · web/ the interface
tests/              python -m pytest -q tests
```
