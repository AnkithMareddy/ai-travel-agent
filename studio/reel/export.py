"""Project pack for finishing an edit by hand in Palmier Pro (or Resolve, Premiere, CapCut).

The pack holds every shot already graded and cut to length, numbered in order, the song
trimmed to the edit, the LUT, an edit list, and a prompt to paste into Claude Desktop
with Palmier's MCP connected so Claude rebuilds the timeline for you.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from pathlib import Path

from . import config, luts, media, render, store, styles, trip

PROMPT = """You're connected to Palmier Pro. Build this edit on a new timeline, then wait for my notes.

Project: {title}
Folder: the folder this file is in (import everything in ./shots and ./audio).

1. Create a {w}x{h} timeline at {fps} fps named "{name}".
2. Put the files from ./shots on the main video track in filename order, back to back with
   no gaps. They're already graded, trimmed and speed-ramped; don't change their length.
3. Put ./audio/song{ext} on the music track from 0:00. It's already trimmed to start at the
   right moment, so the cuts land on the beat.
4. Each shot's own sound is already levelled in its file (dialogue shots at full volume).
   Duck the music to about {duck}% under the shots marked dialogue in edit.json{nat_open}.
5. Text: {text}
6. The LUT in ./lut is the grade already applied. Don't add it again.

edit.json lists every cut (time, length, shot, caption) if you need it.
When it's built, tell me the total length and ask what I want to change."""


def export_pack(day: str, style_id: str) -> Path:
    snap = store.snapshot()
    d = store.day(snap, day)
    plan = d["plans"].get(style_id)
    if not plan:
        raise ValueError("this edit hasn't been planned yet")
    style = styles.get(style_id)
    shots = store.day_shots(snap, day, include_hidden=True)
    song = d.get("song") if d.get("song") and d["song"].get("beats") else None
    song_file = config.abs_(d["song"]["file"]) if d.get("song") and d["song"].get("file") else None
    r = d["renders"].get(style_id, {})
    song_start = float(plan.get("song_start", r.get("song_start", (d.get("song") or {}).get("start") or 0)))
    info = trip.day(day) if day != "trip" else {"title": trip.trip_name(), "region": "ireland", "label": "Whole trip"}
    look = plan.get("look") or styles.look_for(style, info.get("region", "ireland"))
    W, H = plan.get("aspect") or style["aspect"]
    fps = style["fps"]
    slots = render.build_timeline(plan, shots, style, song, song_start)

    name = f"{day}-{style_id}"
    work = Path(tempfile.mkdtemp(prefix="pack-", dir=config.path("tmp", "x").parent))
    root = work / name
    (root / "shots").mkdir(parents=True)
    (root / "audio").mkdir()
    (root / "lut").mkdir()
    try:
        cuts = []
        # No burned-in text in the pack: titles get added in the editor so they stay editable.
        clean_style = {**style, "text": None}
        clean_plan = dict(plan)
        for i, slot in enumerate(slots):
            shot = shots[slot["id"]]
            fname = f"{i + 1:03d}_{slot['id']}.mp4"
            render.render_segment(shot, slot, clean_style, look, W, H, fps, root / "shots" / fname,
                                  work, i, len(slots), clean_plan, text=False, shots=shots)
            cuts.append({"file": f"shots/{fname}", "t": round(slot["t"], 3), "dur": round(slot["dur"], 3),
                         "shot": slot["id"], "speed": slot["speed"], "role": slot.get("role"),
                         "dialogue": slot["dialogue"], "said": shot.get("said") if slot["dialogue"] else None,
                         "chapter": slot.get("chapter"), "caption": slot.get("caption"),
                         "place": shot.get("place"), "time": (shot.get("captured_at") or "")[11:16]})
        total = sum(c["dur"] for c in cuts)
        ext = ".m4a"
        if song_file:
            media.ffmpeg(["-ss", f"{song_start:.3f}", "-i", str(song_file), "-t", f"{total + 1:.3f}",
                          "-af", f"afade=t=out:st={max(0, total - 2):.3f}:d=2", "-c:a", "aac", "-b:a", "256k",
                          str(root / "audio" / f"song{ext}")])
        shutil.copy(luts.lut_path(look, config.path("luts", "x").parent), root / "lut" / f"{look}.cube")
        texts = []
        if plan.get("title"):
            texts.append(f'title "{plan["title"]}"' + (f' / "{plan.get("subtitle")}"' if plan.get("subtitle") else "")
                         + " centred over the first shot, fading in at 1 s")
        if plan.get("hook"):
            texts.append(f'hook "{plan["hook"]}" big and bold, top third, for the first 2.5 s')
        caps = [c for c in cuts if c["caption"]]
        if caps:
            texts.append("captions bottom-left at the cut times in edit.json")
        if any(c["chapter"] for c in cuts):
            texts.append("a chapter card (the 'chapter' field) lower-left for 3 s where it's set")
        if any(c["dialogue"] for c in cuts):
            texts.append("subtitles for dialogue shots (the 'said' field)")
        edit = {"title": plan.get("title"), "subtitle": plan.get("subtitle"), "hook": plan.get("hook"),
                "end_card": plan.get("end_card"), "style": style_id, "look": look, "width": W, "height": H,
                "fps": fps, "duration": round(total, 3), "song": (d.get("song") or {}).get("name"),
                "song_start_in_original": song_start, "cuts": cuts}
        (root / "edit.json").write_text(json.dumps(edit, indent=1))
        (root / "PALMIER_PROMPT.md").write_text(PROMPT.format(
            title=f"{info.get('label', day)} · {style['name']}", w=W, h=H, fps=fps, name=name, ext=ext,
            duck=int(style.get("duck", 0.25) * 100),
            nat_open=(f", except the first {style['nat_open']:.1f} s which is natural sound only and the "
                      f"music fades in after" if style.get("nat_open") else ""),
            text="; ".join(texts) if texts else "none"))
        out = config.path("exports", f"{name}.zip")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
            for f in sorted(root.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(work))
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)
