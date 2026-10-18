"""The edit styles. Each is a recipe the director fills with a story and the renderer cuts.

pacing: how many song beats each b-roll cut lasts, cycled. Dialogue moments ignore it and
run as long as the line needs, then the next cut snaps back onto the beat.
"""
from __future__ import annotations

STYLES = {
    "vlog": {
        "name": "Instagram Vlog",
        "blurb": "The daily vlog. 9:16, 45-90 s, a story with a cold open, captions and real moments.",
        "platform": "Instagram",
        "aspect": (1080, 1920),
        "fps": 30,
        "target": 60,
        "range": (30, 90),
        "look": "auto",
        "letterbox": None,
        "grain": 3,
        "halation": 0.1,
        "vignette": False,
        "pacing": [2, 2, 4, 2, 1, 1, 2, 4],
        "slowmo": True,
        "nat_open": 0,
        "nat_level": 0.22,
        "duck": 0.18,             # music level under dialogue
        "song_from": "top",
        "text": "vlog",           # hook up top, place/time captions, chapter words
        "auto": True,
    },
    "youtube": {
        "name": "YouTube Episode",
        "blurb": "16:9 daily episode, 3-6 min. Chapters per stop, dialogue-led, cinematic grade.",
        "platform": "YouTube",
        "aspect": (1920, 1080),
        "fps": 24,
        "target": 240,
        "range": (90, 480),
        "look": "auto",
        "letterbox": None,
        "grain": 5,
        "halation": 0.15,
        "vignette": True,
        "pacing": [4, 4, 8, 4, 2, 2, 4, 8],
        "slowmo": True,
        "nat_open": 3.0,
        "nat_level": 0.3,
        "duck": 0.14,
        "song_from": "top",
        "loop_song": True,
        "text": "episode",        # title card + chapter cards
        "auto": True,
    },
    "cinematic": {
        "name": "Cinematic Short",
        "blurb": "16:9, 60-90 s, 2.39 letterbox, film grain, music-led. The day as a short film.",
        "platform": "YouTube",
        "aspect": (1920, 1080),
        "fps": 24,
        "target": 75,
        "range": (40, 150),
        "look": "auto",
        "letterbox": 2.39,
        "grain": 7,
        "halation": 0.22,
        "vignette": True,
        "pacing": [4, 4, 8, 4, 2, 2, 4, 8],
        "slowmo": True,
        "nat_open": 2.5,
        "nat_level": 0.18,
        "duck": 0.3,
        "song_from": "top",
        "text": "title",
        "auto": True,
    },
    "reel": {
        "name": "Teaser Reel",
        "blurb": "9:16, 15-25 s, beat-synced fast cuts with a hook in the first second.",
        "platform": "Instagram",
        "aspect": (1080, 1920),
        "fps": 30,
        "target": 20,
        "range": (8, 45),
        "look": "vivid_pop",
        "letterbox": None,
        "grain": 0,
        "halation": 0.0,
        "vignette": False,
        "pacing": [2, 2, 1, 1, 2, 1, 1, 1, 1, 2, 4],
        "slowmo": False,
        "nat_open": 0,
        "nat_level": 0.12,
        "duck": 0.3,
        "song_from": "drop",
        "text": "hook",
        "flash_on_drop": True,
        "auto": True,
    },
    "moody": {
        "name": "Moody",
        "blurb": "9:16 slow, faded film look. Slow motion, lots of grain, quiet lower-case text.",
        "platform": "Instagram",
        "aspect": (1080, 1920),
        "fps": 24,
        "target": 24,
        "range": (12, 60),
        "look": "faded_film",
        "letterbox": None,
        "grain": 12,
        "halation": 0.3,
        "vignette": True,
        "pacing": [4, 4, 8],
        "slowmo": True,
        "nat_open": 0,
        "nat_level": 0.1,
        "duck": 0.3,
        "song_from": "top",
        "text": "quiet",
        "auto": False,
    },
    "photos": {
        "name": "Photo Dump",
        "blurb": "Ten graded 4:5 stills pulled from the footage. Instagram carousel.",
        "platform": "Instagram",
        "aspect": (1080, 1350),
        "look": "auto",
        "count": 10,
        "still": True,
        "auto": True,
    },
}

FILM = {
    **STYLES["youtube"],
    "name": "Trip Film",
    "blurb": "The whole trip for YouTube: a chapter per day, 6-10 minutes.",
    "target": 480,
    "range": (120, 900),
    "letterbox": 2.39,
    "text": "episode",
    "auto": False,
}

VIDEO_STYLES = [k for k, v in STYLES.items() if not v.get("still")]
AUTO_STYLES = [k for k, v in STYLES.items() if v.get("auto")]


def get(style_id: str) -> dict:
    if style_id == "film":
        return FILM
    return STYLES[style_id]


def look_for(style: dict, region: str) -> str:
    look = style.get("look", "auto")
    if look != "auto":
        return look
    return "london_noir" if region == "london" else "emerald"


for _k, _v in STYLES.items():
    _v["id"] = _k
FILM["id"] = "film"
