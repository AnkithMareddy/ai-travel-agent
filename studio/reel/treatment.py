"""Treatments: the visual language laid over an edit (AWGE camcorder, Super 8, a music video's look).

A treatment is a flat dict of knobs. Presets live here; Claude can also write one from
"edit like Sole Bennett" or "match this song's music video" (see director.research_treatment).
The renderer turns it into ffmpeg filters per cut, and marks cuts for flash frames,
stutters, freeze frames, punch-ins and black-and-white moments on the music.
"""
from __future__ import annotations

import hashlib

from . import luts

PACING = {
    "slow": [8, 4, 8, 4],
    "medium": [4, 2, 4, 2, 2, 4],
    "fast": [2, 1, 1, 2, 1, 1, 2],
    "frantic": [1, 1, 1, 1, 2, 1, 1, 1],
}

DEFAULT = {
    "name": "Clean", "summary": "", "look": "", "aspect": "full", "grain": None, "halation": None,
    "vignette": None, "vhs": 0.0, "rgb_split": 0, "fisheye": 0.0, "shake": 0.0, "timestamp": False,
    "flash": "none", "stutter": 0.0, "freeze": False, "punch_in": 0.0, "bw_moments": 0.0,
    "pacing": "", "text_font": "", "text_case": "as_is", "shot_notes": "",
    "whip": 0.0, "zoom_snap": False, "text_color": "", "photo_style": "",
}

PRESETS = {
    "clean": {**DEFAULT, "name": "Clean", "summary": "The style's own grade and rhythm, no effects."},
    "awge": {
        **DEFAULT, "name": "AWGE camcorder",
        "summary": "Handycam energy: VHS bleed and scanlines, fisheye close-ups, RGB split, a date stamp, "
                   "white flash frames and stutters on the beat, freeze on the peak, black-and-white cutaways.",
        "look": "vhs_pop", "aspect": "full", "grain": 10, "halation": 0.12, "vignette": True,
        "vhs": 0.75, "rgb_split": 5, "fisheye": 0.55, "shake": 0.35, "timestamp": True,
        "flash": "bars", "stutter": 0.3, "freeze": True, "punch_in": 0.35, "bw_moments": 0.18,
        "pacing": "fast", "text_font": "vcr", "text_case": "upper",
        "shot_notes": "Faces close to the lens, friends goofing, motion, night lights, crowds, cars. "
                      "Chaos over postcards; landscapes only as quick cutaways.",
    },
    "cole": {
        **DEFAULT, "name": "Cole Bennett / Lyrical Lemonade",
        "summary": "Bright, poppy, hyper-saturated daylight colour, fisheye close to the lens, snap zooms and "
                   "whip transitions on the beat, white flash on the drop, bold yellow outlined text, photos as "
                   "sticker cut-outs and flash bursts.",
        "look": "lemonade", "aspect": "full", "grain": 2, "halation": 0.08, "vignette": False,
        "vhs": 0.0, "rgb_split": 2, "fisheye": 0.6, "shake": 0.0, "timestamp": False,
        "flash": "drop", "stutter": 0.12, "freeze": True, "punch_in": 0.45, "bw_moments": 0.0,
        "pacing": "fast", "text_font": "sans", "text_case": "upper", "whip": 0.35, "zoom_snap": True,
        "text_color": "#ffe14d", "photo_style": "overlay",
        "shot_notes": "Bright daylight and colour, people performing to the lens, low angles, fisheye close-ups, "
                      "jumping, dancing, goofing; photos as stickers over the action and quick flash bursts.",
    },
    "super8": {
        **DEFAULT, "name": "Super 8",
        "summary": "Warm home-movie film: 4:3 frame, heavy grain, gentle gate weave, soft halation, unhurried cuts.",
        "look": "super8", "aspect": "4:3", "grain": 16, "halation": 0.3, "vignette": True,
        "vhs": 0.0, "shake": 0.2, "timestamp": False, "flash": "none", "stutter": 0.0,
        "freeze": False, "punch_in": 0.0, "bw_moments": 0.0, "pacing": "medium",
        "text_font": "serif", "text_case": "lower",
        "shot_notes": "Golden light, people laughing, hands, details, landscapes that breathe.",
    },
    "oddfuture": {
        **DEFAULT, "name": "Odd Future skate tape",
        "summary": "Early-2010s Odd Future / Golf: Sony VX1000 fisheye skate-video energy, 4:3, crunchy saturated "
                   "DV colour, handheld chaos, jump cuts and stutters, goofing straight into the lens, crude caps text.",
        "look": "cross_process", "aspect": "4:3", "grain": 6, "halation": 0.0, "vignette": True,
        "vhs": 0.35, "rgb_split": 3, "fisheye": 0.85, "shake": 0.55, "timestamp": False,
        "flash": "none", "stutter": 0.4, "freeze": True, "punch_in": 0.3, "bw_moments": 0.1,
        "pacing": "frantic", "text_font": "sans", "text_case": "upper", "whip": 0.2, "zoom_snap": True,
        "text_color": "#ffffff", "photo_style": "flash",
        "shot_notes": "Friends messing around, faces in the fisheye, jumping, running, skating, cars, being loud. "
                      "No calm scenery unless something is happening in it.",
    },
    "underground": {
        **DEFAULT, "name": "Underground mix (AWGE × Odd Future × Cole Bennett)",
        "summary": "Camcorder grit from AWGE, fisheye chaos from Odd Future, colour and snap-zoom playfulness from "
                   "Cole Bennett: crunchy saturated grade, fisheye, date stamp, flashes on the bars, stutters, "
                   "whips, photo stickers and bursts, a freeze on the peak.",
        "look": "vhs_pop", "aspect": "full", "grain": 7, "halation": 0.1, "vignette": True,
        "vhs": 0.45, "rgb_split": 4, "fisheye": 0.65, "shake": 0.35, "timestamp": True,
        "flash": "bars", "stutter": 0.3, "freeze": True, "punch_in": 0.4, "bw_moments": 0.12,
        "pacing": "fast", "text_font": "vcr", "text_case": "upper", "whip": 0.3, "zoom_snap": True,
        "text_color": "#ffe14d", "photo_style": "overlay",
        "shot_notes": "People over places: faces close to the lens, reactions, jokes, motion. Scenery only as a "
                      "quick establishing beat or behind someone doing something.",
    },
    "noir": {
        **DEFAULT, "name": "Mono documentary",
        "summary": "Contrasty black and white, 2.39 frame, grain, slow deliberate cuts with freeze frames.",
        "look": "mono_film", "aspect": "2.39", "grain": 12, "halation": 0.0, "vignette": True,
        "freeze": True, "pacing": "slow", "text_font": "serif", "text_case": "upper",
        "shot_notes": "Silhouettes, faces in shadow, rain, streets, architecture.",
    },
}

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["name", "summary", "look", "aspect", "grain", "halation", "vignette", "vhs", "rgb_split",
                 "fisheye", "shake", "timestamp", "flash", "stutter", "freeze", "punch_in", "bw_moments",
                 "pacing", "text_font", "text_case", "shot_notes", "whip", "zoom_snap", "text_color", "photo_style"],
    "properties": {
        "name": {"type": "string", "description": "Short name, e.g. 'AWGE camcorder' or 'Praise the Lord video'."},
        "summary": {"type": "string", "description": "One or two sentences on the look and the cutting."},
        "look": {"type": "string", "enum": list(luts.LOOKS)},
        "aspect": {"type": "string", "enum": ["full", "4:3", "2.39"]},
        "grain": {"type": "integer", "description": "0-20"},
        "halation": {"type": "number", "description": "0-0.4 highlight glow"},
        "vignette": {"type": "boolean"},
        "vhs": {"type": "number", "description": "0-1 VHS/camcorder texture: chroma bleed, scanlines, softness"},
        "rgb_split": {"type": "integer", "description": "0-12 px chromatic aberration"},
        "fisheye": {"type": "number", "description": "0-1 barrel/fisheye lens"},
        "shake": {"type": "number", "description": "0-1 handheld jitter"},
        "timestamp": {"type": "boolean", "description": "camcorder date stamp in the corner"},
        "flash": {"type": "string", "enum": ["none", "drop", "bars", "every"]},
        "stutter": {"type": "number", "description": "0-1 share of cuts that open with a frame stutter"},
        "freeze": {"type": "boolean", "description": "freeze frame on the peak moment"},
        "punch_in": {"type": "number", "description": "0-1 share of cuts that punch in tight"},
        "bw_moments": {"type": "number", "description": "0-1 share of cuts in black and white"},
        "pacing": {"type": "string", "enum": ["slow", "medium", "fast", "frantic"]},
        "whip": {"type": "number", "description": "0-1 share of cuts that enter with a whip-pan blur"},
        "zoom_snap": {"type": "boolean", "description": "punch-ins snap-zoom in on the beat instead of a static crop"},
        "text_color": {"type": "string", "description": "hex colour for titles, empty for white"},
        "photo_style": {"type": "string", "enum": ["", "full", "flash", "overlay"], "description": "how this look uses still photos"},
        "text_font": {"type": "string", "enum": ["serif", "sans", "mono", "vcr"]},
        "text_case": {"type": "string", "enum": ["upper", "lower", "as_is"]},
        "shot_notes": {"type": "string", "description": "What footage this look wants the editor to favour."},
    },
}


def normalise(t: dict | None) -> dict | None:
    if not t:
        return None
    out = {**DEFAULT, **{k: v for k, v in t.items() if k in DEFAULT or k in ("source", "preset", "brief")}}
    clamp = lambda v, lo, hi: max(lo, min(hi, float(v or 0)))
    out["vhs"] = clamp(out["vhs"], 0, 1)
    out["fisheye"] = clamp(out["fisheye"], 0, 1)
    out["shake"] = clamp(out["shake"], 0, 1)
    out["stutter"] = clamp(out["stutter"], 0, 1)
    out["punch_in"] = clamp(out["punch_in"], 0, 1)
    out["bw_moments"] = clamp(out["bw_moments"], 0, 1)
    out["rgb_split"] = int(clamp(out["rgb_split"], 0, 16))
    out["whip"] = clamp(out["whip"], 0, 1)
    tc = str(out.get("text_color") or "")
    out["text_color"] = tc if (len(tc) == 7 and tc.startswith("#")) else ""
    if out["look"] and out["look"] not in luts.LOOKS:
        out["look"] = ""
    if out["name"] == "Clean" and not any(out[k] for k in ("vhs", "fisheye", "shake", "stutter", "punch_in", "bw_moments", "rgb_split")) \
            and not out["look"] and out["flash"] == "none":
        return None
    return out


def style_with(style: dict, t: dict | None) -> dict:
    """The style dict with the treatment's grain/glow/frame/rhythm swapped in."""
    if not t:
        return style
    s = dict(style)
    s["treatment"] = t
    for k in ("grain", "halation", "vignette"):
        if t.get(k) is not None:
            s[k] = t[k]
    if t.get("aspect") == "2.39":
        s["letterbox"] = 2.39
    elif t.get("aspect") in ("4:3", "full"):
        s["letterbox"] = None
    if t.get("pacing") in PACING:
        p = PACING[t["pacing"]]
        if style["id"] in ("youtube", "film"):  # long-form breathes a step slower
            p = [b * 2 for b in p]
        s["pacing"] = p
    if t.get("flash") != "none":
        s["flash_on_drop"] = True
    return s


def _roll(seed: str, salt: str) -> float:
    return int(hashlib.sha1(f"{seed}:{salt}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def decorate(slots: list[dict], t: dict | None, song: dict | None, song_start: float) -> None:
    """Mark cuts for flash / stutter / punch / freeze / black-and-white, in place."""
    if not t:
        return
    bars = [b - song_start for b in (song or {}).get("bars", []) if b >= song_start]
    drop = ((song or {}).get("drop") or 0) - song_start
    if t.get("freeze"):
        # Freeze the longest non-dialogue cut at/after the peak (or the drop), else in the back half.
        peak_t = next((s["t"] for s in slots if s.get("role") == "peak"), None)
        start = peak_t if peak_t is not None else (drop if drop > 0 else (slots[-1]["t"] / 2 if slots else 0))
        cands = [s for s in slots if not s.get("dialogue") and not s.get("photo")
                 and s["t"] >= start - 0.01 and s["dur"] >= 0.45]
        if cands:
            max(cands, key=lambda s: s["dur"])["freeze"] = True
    for i, s in enumerate(slots):
        if s.get("dialogue"):
            continue  # never mess with someone talking
        key = f"{s['id']}:{i}"
        mode = t.get("flash", "none")
        on_bar = any(abs(s["t"] - b) < 0.05 for b in bars)
        if mode == "every" or (mode == "bars" and on_bar) or (mode == "drop" and drop > 0 and abs(s["t"] - drop) < 0.3):
            s["flash"] = True
        if i and not s.get("photo") and _roll(key, "stutter") < t.get("stutter", 0):
            s["stutter"] = True
        if i and s.get("photo_mode") != "flash" and _roll(key, "whip") < t.get("whip", 0):
            s["whip_in"] = True
            slots[i - 1]["whip_out"] = True
        if _roll(key, "punch") < t.get("punch_in", 0):
            s["punch"] = True
        if _roll(key, "bw") < t.get("bw_moments", 0):
            s["bw"] = True


# ---------------------------------------------------------------- filters

def pre_grade(t: dict | None, slot: dict, W: int, H: int, fps: int) -> list[str]:
    """Lens and time effects, before the colour grade."""
    if not t:
        return []
    f = []
    if t.get("fisheye", 0) > 0.05:
        k = 0.12 + 0.3 * t["fisheye"]
        crop = 0.9 - 0.24 * t["fisheye"]  # cut away the stretched, dark corners
        f.append(f"lenscorrection=k1={k:.3f}:k2={k / 3:.3f}:i=bilinear,"
                 f"crop=iw*{crop:.3f}:ih*{crop:.3f},scale={W}:{H}")
    if slot.get("punch") and t.get("zoom_snap"):
        # Snap zoom: hit the cut 35% tight and ease back out over a quarter second.
        f.append(f"scale=w='ceil(iw*(1+0.35*max(0,1-t/0.25))/2)*2':h='ceil(ih*(1+0.35*max(0,1-t/0.25))/2)*2':eval=frame,"
                 f"crop={W}:{H}")
    elif slot.get("punch"):
        f.append(f"crop=iw*0.8:ih*0.8,scale={W}:{H}")
    if t.get("shake", 0) > 0.05:
        a = int(4 + 18 * t["shake"])
        f.append(f"crop=iw-{2 * a}:ih-{2 * a}:{a}+{a}*sin(n*1.9)*cos(n*0.7):{a}+{a}*cos(n*1.3)*sin(n*0.5),scale={W}:{H}")
    if t.get("aspect") == "4:3":
        if W > H:
            w = int(H * 4 / 3) // 2 * 2
            f.append(f"crop=ih*4/3:ih,scale={w}:{H},pad={W}:{H}:(ow-iw)/2:0:black")
        else:
            h = int(W * 3 / 4) // 2 * 2
            f.append(f"crop=iw:iw*3/4,scale={W}:{h},pad={W}:{H}:0:(oh-ih)/2:black")
    return f


def time_fx(t: dict | None, slot: dict, fps: int) -> list[str]:
    """Stutters and freeze frames (after the frame rate is fixed)."""
    if not t:
        return []
    f = []
    if slot.get("stutter"):
        f.append(f"loop=loop=2:size=3:start=0,setpts=N/({fps}*TB)")
    if slot.get("freeze"):
        f.append(f"trim=end={max(0.2, slot['dur'] * 0.5):.3f},setpts=PTS-STARTPTS")
    return f


def post_grade(t: dict | None, slot: dict, W: int, H: int) -> list[str]:
    """Texture after the grade: black-and-white, VHS, chromatic split, flash frames."""
    if not t:
        return []
    f = []
    if slot.get("bw"):
        f.append("hue=s=0,eq=contrast=1.15")
    v = t.get("vhs", 0)
    if v > 0.05:
        soft = 1 + 2.2 * v
        bleed = int(2 + 6 * v)
        f.append(f"scale=iw/{soft:.2f}:ih,scale={W}:{H}:flags=bilinear,"
                 f"chromashift=cbh={bleed}:crh=-{bleed},"
                 f"drawgrid=w=iw:h=4:t=1:c=black@{0.08 + 0.2 * v:.2f},"
                 f"noise=alls={int(6 + 10 * v)}:allf=t,eq=saturation={1 + 0.35 * v:.2f}")
    if t.get("rgb_split"):
        px = int(t["rgb_split"])
        f.append(f"format=gbrp,rgbashift=rh=-{px}:bh={px},format=yuv420p")
    if slot.get("whip_in"):
        f.append("gblur=sigma=60:sigmaV=0.01:enable='lt(t,0.09)'")
    if slot.get("whip_out"):
        f.append(f"gblur=sigma=60:sigmaV=0.01:enable='gt(t,{slot['dur'] - 0.07:.3f})'")
    if slot.get("flash"):
        f.append("fade=t=in:st=0:d=0.1:color=white")
    if slot.get("freeze"):
        at = max(0.2, slot["dur"] * 0.5)
        f.append(f"drawbox=c=white@0.85:t=fill:enable='between(t,{at - 0.07:.3f},{at:.3f})'")
    return f


def font(t: dict | None, default: str) -> str:
    from . import config

    if not t or not t.get("text_font"):
        return default
    return {"serif": config.FONT_SERIF, "sans": config.FONT_SANS, "mono": config.FONT_MONO,
            "vcr": config.FONT_VCR}.get(t["text_font"], default)


def text_style(t: dict | None) -> dict:
    """Extra drawtext options for titles under this treatment (colour + outline)."""
    if not t or not t.get("text_color"):
        return {}
    return {"color": t["text_color"], "border": True}


def case(t: dict | None, text: str) -> str:
    if not t:
        return text
    return text.upper() if t.get("text_case") == "upper" else text.lower() if t.get("text_case") == "lower" else text
