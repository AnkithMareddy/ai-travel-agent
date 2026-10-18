"""The director: turns a day of shots into stories.

Claude gets everything an editor would want before a cut: contact sheets of every shot,
what was said in each one (transcripts), when and where it was shot (the itinerary), the
group's own notes about the day, and how earlier days went. It plans every edit as a
story with a cold open, setup, journey, peak, resolution and a closing tag, and writes the
captions, YouTube chapters and post copy.

Without an API key a rule-based editor builds the same story shape from scores and time.
"""
from __future__ import annotations

import base64
import json
import logging
from datetime import datetime

import cv2
import numpy as np

from . import config, luts, styles, treatment as tr, trip

log = logging.getLogger("reel.director")

SHEET_COLS, CELL_W = 6, 260
ROLES = ["hook", "setup", "journey", "moment", "peak", "resolution", "tag"]


# ---------------------------------------------------------------- shot facts

def is_filler(s: dict) -> bool:
    """Generic b-roll: nobody in it, nothing said, nothing moving, nothing special about the frame."""
    if s.get("said") or s.get("faces") or s.get("kind") == "photo":
        return False
    return s.get("score", 0) < 0.5 and s.get("motion", 0) < 0.02 and s.get("loud", -99) < -25


def _shot_facts(shots: dict) -> list[dict]:
    rows = []
    for sid, s in sorted(shots.items(), key=lambda kv: (kv[1].get("captured_at") or "", kv[0])):
        row = {
            "id": sid,
            "time": (s.get("captured_at") or "")[11:16],
            "place": s.get("place") or "",
            "cam": s.get("device"),
            "orient": "portrait" if s["height"] > s["width"] else "landscape",
            "secs": round(s["out"] - s["in"], 1),
            "q": round(s.get("score", 0), 2),
            "motion": round(s.get("motion", 0), 3),
            "faces": s.get("faces", 0),
            "slowmo_ok": s.get("fps", 30) >= 48,
        }
        if s.get("kind") == "photo":
            row = {k: v for k, v in row.items() if k not in ("secs", "motion", "slowmo_ok")}
            row["photo"] = True
        if s.get("day"):
            row["day"] = s["day"]
        if s.get("said"):
            row["said"] = s["said"][:400]
        if s.get("loud", -99) > -20 and not s.get("said"):
            row["loud"] = True
        if is_filler(s):
            row["filler"] = True
        rows.append(row)
    return rows


def contact_sheets(shots: dict, max_per_sheet=36) -> list[bytes]:
    """JPEG grids of thumbnails, each labelled with its shot id."""
    items = sorted(shots.items(), key=lambda kv: (kv[1].get("captured_at") or "", kv[0]))
    sheets = []
    for k in range(0, len(items), max_per_sheet):
        cells = []
        for sid, s in items[k:k + max_per_sheet]:
            img = cv2.imread(str(config.abs_(s["thumb"]))) if s.get("thumb") else None
            if img is None:
                img = np.zeros((146, CELL_W, 3), np.uint8)
            cell = np.zeros((CELL_W, CELL_W, 3), np.uint8)
            scale = CELL_W / max(img.shape[:2])
            img = cv2.resize(img, (int(img.shape[1] * scale), int(img.shape[0] * scale)))
            y, x = (CELL_W - img.shape[0]) // 2, (CELL_W - img.shape[1]) // 2
            cell[y:y + img.shape[0], x:x + img.shape[1]] = img
            cv2.rectangle(cell, (0, 0), (118, 26), (0, 0, 0), -1)
            cv2.putText(cell, sid, (5, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
            if s.get("said"):
                cv2.putText(cell, "speech", (CELL_W - 70, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 220, 255), 1, cv2.LINE_AA)
            cells.append(cell)
        while len(cells) % SHEET_COLS:
            cells.append(np.zeros((CELL_W, CELL_W, 3), np.uint8))
        rows = [np.hstack(cells[i:i + SHEET_COLS]) for i in range(0, len(cells), SHEET_COLS)]
        ok, buf = cv2.imencode(".jpg", np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 82])
        sheets.append(buf.tobytes())
    return sheets


# ---------------------------------------------------------------- rule-based editor

def _energy(s):
    return s.get("score", 0) * 0.5 + min(s.get("motion", 0) / 0.05, 1) * 0.3 + min(s.get("sat", 0) / 0.5, 1) * 0.2


def _aesthetic(s):
    calm = 1 - min(s.get("motion", 0) / 0.06, 1)
    return s.get("score", 0) * 0.6 + calm * 0.25 + (0.15 if s.get("fps", 30) >= 48 else 0)


def _avg_slot(style) -> float:
    return 0.5 * sum(style["pacing"]) / len(style["pacing"])


def heuristic_plan(style_id: str, shots: dict, info: dict) -> dict:
    """Story shape without AI: cold open on the best moment, then the day in order, end on a calm shot."""
    style = styles.get(style_id)
    by_time = sorted(shots, key=lambda k: (shots[k].get("captured_at") or "", k))
    if style.get("still"):
        ranked = sorted(shots, key=lambda k: -_aesthetic(shots[k]))
        return {"shots": [{"id": k} for k in _spread(ranked, shots, style["count"])]}
    n = max(4, int(style["target"] / max(_avg_slot(style), 0.4)) + 2)
    if style_id == "reel":
        ranked = sorted(shots, key=lambda k: -_energy(shots[k]))
        picked = _spread(ranked, shots, n)
        entries = [{"id": k, "role": "peak"} for k in picked]
        entries[0]["role"] = "hook"
        return {"shots": entries, "hook": info.get("hook") or info.get("title", ""), "title": info.get("title", "")}

    photos_ = [k for k in by_time if shots[k].get("kind") == "photo"]
    shots_v = {k: v for k, v in shots.items() if v.get("kind") != "photo"}
    if photos_ and shots_v:
        plan = heuristic_plan(style_id, shots_v, info)
        return _sprinkle_photos(plan, photos_, shots, style_id)
    # Meaning first: drop filler b-roll unless the day has almost nothing else.
    keep = {k: v for k, v in shots.items() if not is_filler(v)}
    if len(keep) >= max(4, len(shots) // 3) and len(keep) < len(shots):
        return heuristic_plan(style_id, keep, info)
    talk = [k for k in by_time if shots[k].get("said")]
    ranked = sorted(shots, key=lambda k: -(shots[k].get("score", 0) + (0.15 if shots[k].get("said") else 0)))
    picked = set(_spread(ranked, shots, n))
    if style_id in ("vlog", "youtube", "film"):
        picked |= set(talk[: (12 if style_id != "vlog" else 4)])
    order = [k for k in by_time if k in picked]
    if not order:
        return {"shots": []}
    hook = max(order, key=lambda k: _energy(shots[k]) + (0.3 if shots[k].get("said") else 0))
    closer = max(order[-max(2, len(order) // 4):], key=lambda k: _aesthetic(shots[k]))
    body = [k for k in order if k not in (hook, closer)]
    entries = [{"id": hook, "role": "hook", "dialogue": bool(shots[hook].get("said"))}]
    last_place = None
    for i, k in enumerate(body):
        e = {"id": k, "role": "setup" if i < 2 else "journey"}
        if shots[k].get("said") and style_id != "cinematic":
            e["dialogue"] = True
        place = shots[k].get("place") or ""
        if place and place != last_place:
            e["chapter"] = place
            if style_id == "vlog":
                e["caption"] = f"{(shots[k].get('captured_at') or '')[11:16]} · {place}".strip(" ·")
            last_place = place
        entries.append(e)
    if closer != hook:
        entries.append({"id": closer, "role": "resolution"})
    return {
        "shots": entries,
        "title": info.get("title", ""),
        "subtitle": info.get("subtitle", ""),
        "hook": info.get("hook") or "",
        "end_card": trip.trip_name().upper() + " 2026" if style_id in ("cinematic", "youtube", "film") else "",
    }


def _sprinkle_photos(plan: dict, photo_ids: list, shots: dict, style_id: str) -> dict:
    """Rule-based photo use: a flash burst at the peak, stickers over the setup, best one full-frame."""
    ranked = sorted(photo_ids, key=lambda k: -shots[k].get("score", 0))
    entries = plan["shots"]
    if not entries or style_id in ("photos",):
        return plan
    burst = [{"id": k, "photo_mode": "flash"} for k in ranked[:6]]
    peak_i = next((i for i, e in enumerate(entries) if e.get("role") in ("peak", "resolution")), len(entries) // 2)
    if len(burst) >= 3:
        entries[peak_i:peak_i] = burst
    rest = ranked[6:] if len(burst) >= 3 else ranked
    if rest and style_id in ("vlog", "reel", "youtube", "film") and len(entries) >= 2:
        entries.insert(min(2, len(entries)), {"id": rest[0], "photo_mode": "overlay"})
    if len(rest) > 1 and style_id in ("youtube", "cinematic", "film"):
        entries.insert(min(len(entries), 4), {"id": rest[1], "photo_mode": "full"})
    return plan


def _spread(ranked: list, shots: dict, n: int) -> list:
    """Best shots, but at most two per source clip so one long clip can't take over."""
    picked, per_clip = [], {}
    for sid in ranked:
        c = shots[sid]["clip"]
        if per_clip.get(c, 0) >= 2 and len(ranked) > n:
            continue
        picked.append(sid)
        per_clip[c] = per_clip.get(c, 0) + 1
        if len(picked) >= n:
            break
    return picked


# ---------------------------------------------------------------- Claude

ENTRY = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "role"],
    "properties": {
        "id": {"type": "string"},
        "role": {"type": "string", "enum": ROLES},
        "dialogue": {"type": "boolean", "description": "Play this shot's speech at full volume; music dips under it."},
        "use": {"type": "string", "enum": ["start", "middle", "end"]},
        "beats": {"type": "integer"},
        "speed": {"type": "number"},
        "caption": {"type": "string", "description": "Small on-screen text for this shot."},
        "chapter": {"type": "string", "description": "Starts a new chapter/section here (YouTube chapter card / vlog section word)."},
        "flash": {"type": "boolean"},
        "photo_mode": {"type": "string", "enum": ["full", "flash", "overlay"],
                       "description": "Photos only: own cut with a push-in, a few frames in a burst on the beat, "
                                      "or a sticker card over the video cut placed just before it."},
    },
}

PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["day_story", "edits", "posts"],
    "properties": {
        "day_story": {"type": "string", "description": "2-3 sentences: the story of this day as the edits tell it."},
        "song_bpm_estimate": {"type": "number"},
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["style", "logline", "shots", "title", "subtitle", "hook", "end_card"],
                "properties": {
                    "style": {"type": "string"},
                    "logline": {"type": "string", "description": "One sentence: the idea/arc of this cut."},
                    "title": {"type": "string"},
                    "subtitle": {"type": "string"},
                    "hook": {"type": "string"},
                    "end_card": {"type": "string"},
                    "duration": {"type": "number"},
                    "look": {"type": "string"},
                    "shots": {"type": "array", "items": ENTRY},
                },
            },
        },
        "posts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["style", "title", "caption", "hashtags"],
                "properties": {
                    "style": {"type": "string"},
                    "title": {"type": "string", "description": "YouTube video title (empty for Instagram)."},
                    "caption": {"type": "string", "description": "Instagram caption, or YouTube description intro."},
                    "hashtags": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}

SYSTEM = """You are the editor behind a travel channel with tens of millions of views. Five friends
are on an Ireland road trip (2-9 Oct 2026) then London (9-12 Oct). Every night you cut their
GoPro and iPhone footage into edits that feel like a story they lived, not a slideshow.

You never watch the video. You get contact sheets (one frame per shot, labelled with its id),
a table of facts per shot (time, place from the itinerary, camera, quality, motion, faces,
and 'said': the transcript of what was spoken in that shot), the day's itinerary, notes from
the group, and what happened on earlier days. Use only shot ids that exist.

How you tell a day:
- Find the story first. What did this day mean? A first time, a disaster that became a joke,
  a view that shut everyone up, a race to make a ferry. Write it in day_story, then cut to it.
- hook (cold open, first 1-3 s): the funniest line, the biggest reaction or the most jaw-dropping
  frame of the day, out of order. It makes people stay. A great spoken line beats a pretty view.
- setup: where we are and what the plan is. Use the itinerary.
- journey / moment: the day unfolding in time order. Alternate b-roll (music-led, on the beat)
  with real moments (dialogue=true: someone talking, a reaction, a joke). Real moments are the
  heart of a vlog; keep them whole, never cut a sentence. Skip filler talk and anything private.
- peak: the highlight. Biggest landscape or moment, slow motion if slowmo_ok, longer beats.
- resolution: how the day ended: food, pub, sunset, the drive back, a quiet look.
- tag: a last beat that pays off the hook or a running joke. Ends with a smile.
- Meaning first. Every shot must earn its place: who we're with, where we are, what happened,
  or a feeling. Shots marked filler (nobody in frame, nothing said, nothing moving) are cut
  unless they establish a new place or let the music breathe for a beat; at most one in a row,
  and no more than a quarter of any edit is pure scenery. Repeated hikes, random walking, pans
  of the same hillside, the ground: gone. A shorter edit with meaning beats a longer one.
- Vary shot size and movement. Never two near-identical frames back to back. Never more than
  two shots in a row from the same clip.
- chapter: set it on the first shot of each new place (YouTube chapter cards, vlog sections).
  Short and evocative, e.g. 'Cliffs of Moher', 'The ferry we nearly missed'.
- beats: song beats a b-roll shot lasts (1-2 fast, 4-8 cinematic). Null for the style default.
  Dialogue shots ignore beats and run as long as the line.

Per style:
- vlog (Instagram, 9:16, 45-90 s): the daily vlog. Tight story: hook, 3-6 places, 2-4 real
  moments, a tag. caption on shots that need context ('10:42 · Cliffs of Moher', or a joke
  subtitle). hook text is on screen for the first seconds: under 8 words, first person or POV.
- youtube (16:9, 3-6 min): the daily episode. Same story with room to breathe: more dialogue,
  establishing shots per place, chapter on every place. title = YouTube title (curious, specific,
  no clickbait caps); subtitle = 'Ireland Ep. N' style.
- cinematic (16:9 short, 60-90 s): music-led short film. Little or no dialogue except one line
  that lands. Open wide and calm, build to the peak, end quiet.
- reel (9:16 teaser, 15-25 s): fastest hits only, hook in the first second, flash=true on the
  first shot after the drop.
- photos: the 10 most beautiful frames, varied: landscape, people, detail, food, night.
- film: the whole trip, a chapter per day.

Photos: shots marked photo are stills the group took. Use them creatively, not as a slideshow:
- flash: 3-8 photos in a row as a burst on one or two beats (great on a drop or as a transition
  between places);
- overlay: a sticker card popping over the video shot placed right before it (a portrait over
  the scenery, a food pic over the walk to the pub);
- full: its own cut with a slow push-in, only for a genuinely great frame.
Put photos where they add rhythm or context; skip weak ones.

Posts: Instagram captions lowercase, casual, one or two lines plus 5-8 relevant hashtags. YouTube:
a title, a two-sentence description intro, 8-12 tags (no '#'). No emoji spam."""


def _client():
    import anthropic

    return anthropic.Anthropic(api_key=config.ANTHROPIC_KEY)


def _ask(content: list, max_tokens=32000) -> dict:
    client = _client()
    with client.beta.messages.stream(
        model=config.MODEL,
        max_tokens=max_tokens,
        system=SYSTEM,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
        messages=[{"role": "user", "content": content}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise RuntimeError("Claude declined to plan this edit")
    if msg.stop_reason == "max_tokens":
        raise RuntimeError("plan was cut off")
    return json.loads("".join(b.text for b in msg.content if b.type == "text"))


def _context(date: str, shots: dict, song: dict | None, style_ids: list[str], notes: str, history: list[str],
             treat: dict | None = None) -> list:
    if date == "trip":
        info = {"label": f"{trip.trip_name()}: the whole trip", "flow": "", "stops": []}
    else:
        info = trip.day(date)
    style_text = "\n".join(
        f"- {sid}: {styles.get(sid)['name']} ({styles.get(sid).get('platform', '')}) - {styles.get(sid)['blurb']}"
        for sid in style_ids)
    if song:
        song_text = f"Song: {song.get('name') or 'uploaded track'}"
        if song.get("bpm") and song.get("file"):
            song_text += f", {song['bpm']:.0f} BPM, {song.get('duration', 0):.0f} s long, drop at {song.get('drop', 0):.1f} s"
        elif not song.get("file"):
            song_text += " (name only, no audio file: estimate its BPM in song_bpm_estimate)"
    else:
        song_text = "No song chosen yet: plan for the style's default rhythm."
    stops = "\n".join(f"- {s['start'][11:16]} {s['title']}" for s in info.get("stops", [])[:24])
    content: list = []
    for jpg in contact_sheets(shots):
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                     "data": base64.b64encode(jpg).decode()}})
    text = (f"Day: {info['label']}\nThe plan for the day: {info.get('flow', '') or '-'}\n"
            f"Itinerary:\n{stops or '-'}\n\n{song_text}\n")
    if notes:
        text += f"\nThe group's notes about today (use them, they know what mattered):\n{notes}\n"
    if treat:
        text += (f"\nTreatment for every edit today: {treat['name']}. {treat.get('summary', '')}\n"
                 f"Cutting rhythm: {treat.get('pacing') or 'style default'}. Favour this footage: {treat.get('shot_notes', '')}\n"
                 "Pick and order shots so this look lands (the renderer adds the grade and effects).\n")
    if history:
        text += "\nEarlier days (for continuity and running jokes):\n" + "\n".join(f"- {h}" for h in history[-8:]) + "\n"
    text += (f"\nEdits to plan:\n{style_text}\n\nShots:\n"
             f"{json.dumps(_shot_facts(shots), separators=(',', ':'), ensure_ascii=False)}")
    content.append({"type": "text", "text": text})
    return content


def plan_day(date: str, shots: dict, song: dict | None, style_ids: list[str], notes: str = "",
             history: list[str] | None = None, treat: dict | None = None) -> dict:
    """Plans for every requested style, plus '_posts', '_story' and maybe '_bpm'."""
    info = trip.day(date) if date != "trip" else {"title": trip.trip_name(), "label": trip.trip_name()}
    base = {"title": info.get("title", ""), "subtitle": _subtitle(date, info)}
    fallback = {sid: heuristic_plan(sid, shots, base) for sid in style_ids}
    if not config.ANTHROPIC_KEY or not shots:
        return fallback
    try:
        out = _ask(_context(date, shots, song, style_ids, notes, history or [], treat))
    except Exception as e:  # network, quota, bad JSON: never block the night's edit
        log.warning("Claude planning failed, using the rule-based editor: %s", e)
        return fallback
    plans = {}
    for ed in out.get("edits", []):
        if ed.get("style") in style_ids:
            plans[ed["style"]] = _clean(ed, shots, base)
    for sid in style_ids:
        if sid not in plans or not plans[sid]["shots"]:
            plans[sid] = fallback[sid]
    plans["_posts"] = {p["style"]: {k: p[k] for k in ("title", "caption", "hashtags")} for p in out.get("posts", [])}
    plans["_story"] = out.get("day_story", "")
    if out.get("song_bpm_estimate"):
        plans["_bpm"] = out["song_bpm_estimate"]
    return plans


def revise(date: str, style_id: str, current: dict, request: str, shots: dict, song: dict | None,
           notes: str = "", history: list[str] | None = None, treat: dict | None = None) -> dict:
    """Apply a plain-English change request to one edit."""
    info = trip.day(date) if date != "trip" else {"title": trip.trip_name()}
    base = {"title": info.get("title", ""), "subtitle": _subtitle(date, info)}
    if not config.ANTHROPIC_KEY:
        return _rule_based_revise(current, request)
    content = _context(date, shots, song, [style_id], notes, history or [], treat)
    content.append({"type": "text", "text": (
        f"The current plan for '{style_id}':\n{json.dumps(current, ensure_ascii=False)}\n\n"
        f"The group asked for this change: \"{request}\"\n\n"
        f"Return the revised plan for '{style_id}' only (one entry in edits, one in posts). "
        f"Keep everything they didn't ask to change.")})
    out = _ask(content)
    ed = next((e for e in out["edits"] if e["style"] == style_id), out["edits"][0])
    plan = _clean(ed, shots, base)
    for p in out.get("posts", []):
        plan["_post"] = {k: p[k] for k in ("title", "caption", "hashtags")}
    return plan


def _rule_based_revise(current: dict, request: str) -> dict:
    plan = json.loads(json.dumps(current))
    r = request.lower()
    if any(w in r for w in ("shorter", "tighter", "cut down")):
        plan["shots"] = plan["shots"][: max(4, int(len(plan["shots"]) * 0.75))]
        if plan.get("duration"):
            plan["duration"] = round(plan["duration"] * 0.75)
    if any(w in r for w in ("longer", "extend")) and plan.get("duration"):
        plan["duration"] = round(plan["duration"] * 1.3)
    if "faster" in r:
        plan["pacing"] = [1, 1, 2]
    if "slower" in r:
        plan["pacing"] = [4, 8]
    return plan


def _clean(ed: dict, shots: dict, base: dict) -> dict:
    keep = ("role", "dialogue", "use", "beats", "speed", "caption", "chapter", "flash", "photo_mode")
    seen, entries = set(), []
    for s in ed.get("shots", []):
        if s.get("id") in shots and s["id"] not in seen:
            seen.add(s["id"])
            e = {"id": s["id"], **{k: s[k] for k in keep if s.get(k) not in (None, "")}}
            if e.get("dialogue") and not shots[s["id"]].get("said"):
                e.pop("dialogue")
            entries.append(e)
    plan = {
        "shots": entries,
        "title": ed.get("title") or base["title"],
        "subtitle": ed.get("subtitle") or base.get("subtitle", ""),
        "hook": ed.get("hook", ""),
        "end_card": ed.get("end_card", ""),
        "logline": ed.get("logline", ""),
    }
    if ed.get("duration"):
        plan["duration"] = float(ed["duration"])
    if ed.get("look") in luts.LOOKS:
        plan["look"] = ed["look"]
    return plan


def _subtitle(date: str, info: dict) -> str:
    if date == "trip":
        return "October 2026"
    n = info.get("number")
    d = datetime.fromisoformat(date).strftime("%A %-d %B")
    return f"Day {n} · {d}" if n else d


# ---------------------------------------------------------------- treatments

RESEARCH_SYSTEM = """You are a music-video and travel-film editor. Someone wants their trip footage
(GoPro + iPhone, friends on a road trip) edited in a particular style. Research that style on the
web: the creator's or director's actual videos, the song's official music video. Then describe
concretely what makes it look and cut the way it does: colour and grade, film stock or camera
(VHS, camcorder, 16mm, digital), lens (fisheye, wide, long), aspect ratio, grain and texture,
camera movement, cutting rhythm against the music, transitions and effects (flash frames,
stutters, speed ramps, freeze frames, black-and-white inserts), and typography. Keep it practical:
these are things an editor can recreate from ordinary travel footage."""


def _research(query: str) -> str:
    client = _client()
    messages = [{"role": "user", "content": query}]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6}]
    for _ in range(4):  # resume server-tool turns that pause
        with client.beta.messages.stream(
            model=config.MODEL, max_tokens=16000, system=RESEARCH_SYSTEM, tools=tools,
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            output_config={"effort": "medium"}, messages=messages,
        ) as stream:
            msg = stream.get_final_message()
        if msg.stop_reason == "refusal":
            raise RuntimeError("Claude declined the research request")
        if msg.stop_reason != "pause_turn":
            return "".join(b.text for b in msg.content if b.type == "text")
        messages.append({"role": "assistant", "content": msg.content})
    return "".join(b.text for b in msg.content if b.type == "text")


def research_treatment(describe: str | None = None, song: dict | None = None) -> dict:
    """'Edit like Sole Bennett' / 'match this song's music video' -> a treatment dict."""
    if not config.ANTHROPIC_KEY:
        raise RuntimeError("needs ANTHROPIC_API_KEY to research a style")
    if describe:
        ask = f"Research this editing style: {describe}."
        if song and song.get("name"):
            ask += f" The edit is cut to the song '{song['name']}'."
    elif song and song.get("name"):
        ask = (f"Find the official music video for the song '{song['name']}' (the file name may include the artist) "
               f"and research how it is shot and edited.")
    else:
        raise ValueError("describe a style or set a song first")
    brief = _research(ask)
    client = _client()
    with client.beta.messages.stream(
        model=config.MODEL, max_tokens=8000,
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": tr.SCHEMA}},
        system="Translate an editing-style brief into the renderer's treatment settings. Be bold where "
               "the style is bold; leave effects at 0 where the style doesn't use them. 'look' must be the "
               "closest of the available colour grades.",
        messages=[{"role": "user", "content": f"Style asked for: {describe or 'the song music video'}\n\nBrief:\n{brief}\n\n"
                   f"Available grades: " + "; ".join(f"{k} = {v[0]}: {v[1]}" for k, v in luts.LOOKS.items())}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        raise RuntimeError("Claude declined to build the treatment")
    t = json.loads("".join(b.text for b in msg.content if b.type == "text"))
    t["source"] = describe or f"music video: {song.get('name')}"
    t["brief"] = brief[:3000]
    return t
