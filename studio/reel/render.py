"""Edit plan + song -> finished video (plus .srt subtitles and YouTube chapter times).

Each slot on the timeline is rendered on its own (crop, speed, exposure match, grade,
grain, text), then the segments are joined without re-encoding and the soundtrack is
mixed on top. B-roll slots land on the beat; dialogue slots run as long as the line and
the next cut snaps back onto the beat. The music dips under dialogue.
"""
from __future__ import annotations

import json
import math
import shutil
import tempfile
from pathlib import Path

from . import config, luts, media, styles, text as txt, treatment as tr

SUB_STYLES = ("vlog",)            # burn speech subtitles (most Instagram views are muted)
PRE, POST = 0.25, 0.45            # breathing room around a spoken line


# ---------------------------------------------------------------- timeline

def _speech_span(shot: dict) -> tuple[float, float] | None:
    sp = shot.get("speech") or []
    if not sp:
        return None
    a = max(0.0, min(x["start"] for x in sp) - PRE)
    b = min(shot["length"], max(x["end"] for x in sp) + POST)
    return (a, b) if b - a > 0.8 else None


def _beats(song: dict | None, start: float, need: float, loop: bool) -> list[float]:
    if not song or not song.get("beats"):
        return []
    beats = [b - start for b in song["beats"] if b >= start - 1e-3]
    if loop and song.get("duration"):
        base = [b - start for b in song["beats"]]
        k = 1
        while beats and beats[-1] < need + 4 and k < 20:
            beats += [b + k * song["duration"] for b in base if b + k * song["duration"] > beats[-1] + 0.2]
            k += 1
    if not beats or beats[0] > 0.05:
        beats = [0.0] + beats
    return beats


def build_timeline(plan: dict, shots: dict, style: dict, song: dict | None, song_start: float) -> list[dict]:
    """Give each planned shot a slot: (t, dur, src_in, speed, dialogue).

    Photos: 'full' gets its own cut, a run of 'flash' photos shares one or two beats as a
    burst, and 'overlay' rides on top of the cut before it as a sticker.
    """
    entries = [e for e in plan["shots"] if e["id"] in shots]
    if not entries:
        raise ValueError("the plan has no usable shots")
    pacing = plan.get("pacing") or style["pacing"]
    target = float(plan.get("duration") or style["target"])
    max_len = style["range"][1]
    beats = _beats(song, song_start, max(target, 60) * 3, style.get("loop_song", False))
    unit = (60.0 / song["bpm"]) if song and song.get("bpm") else 0.5
    slots: list[dict] = []
    t, pi = 0.0, 0
    burst: list[dict] = []

    def snap(x: float) -> float:
        """First beat at or after x (or x itself without a song)."""
        if not beats:
            return x
        for b in beats:
            if b >= x - 0.04:
                return b
        return beats[-1] + math.ceil((x - beats[-1]) / unit) * unit

    def flush():
        nonlocal t, burst
        if not burst:
            return
        span = snap(t + max(len(burst) * 0.12, unit) - 0.05) - t if beats else max(len(burst) * 0.12, 0.5)
        each = span / len(burst)
        for e in burst:
            slots.append({**e, "t": round(t, 4), "dur": round(each, 4), "src_in": 0.0, "speed": 1.0,
                          "dialogue": False, "photo": True, "photo_mode": "flash"})
            t += each
        burst = []

    for e in entries:
        shot = shots[e["id"]]
        is_photo = shot.get("kind") == "photo"
        mode = (e.get("photo_mode") or "full") if is_photo else None
        if mode == "overlay":
            if slots and not slots[-1].get("photo"):
                slots[-1].setdefault("overlays", []).append(e["id"])
                continue
            mode = "full"
        if mode == "flash":
            burst.append(e)
            continue
        flush()
        span = _speech_span(shot) if e.get("dialogue") and not is_photo else None
        if span:
            dur = snap(t + (span[1] - span[0])) - t
            src_in, speed = span[0], 1.0
            dur = min(dur, span[1] - span[0] + unit * 1.5)  # never hang on for long after the line
        else:
            n = int(e.get("beats") or pacing[pi % len(pacing)])
            pi += 1
            dur = (snap(t + n * unit - 0.05) - t) if beats else max(1.2, min(n * unit, 6.0))
            src_in, speed = (0.0, 1.0) if is_photo else _source_window(e, shot, dur, style)
        if dur < 0.3:
            continue
        slot = {**e, "t": round(t, 4), "dur": round(dur, 4), "src_in": src_in, "speed": speed, "dialogue": bool(span)}
        if is_photo:
            slot.update(photo=True, photo_mode="full")
        slots.append(slot)
        t += dur
        if t >= max_len:
            break
    flush()
    return slots


def _source_window(entry: dict, shot: dict, dur: float, style: dict) -> tuple[float, float]:
    """In-point and speed so `dur` seconds of output come from the shot's best part."""
    length = shot["length"]
    best_in, best_out = shot["in"], shot["out"]
    speed = float(entry.get("speed") or 1.0)
    if (style.get("slowmo") and entry.get("speed") is None and shot["fps"] >= 48
            and shot.get("motion", 0) > 0.012 and entry.get("role") in ("peak", "resolution", "setup", None)):
        speed = 0.5
    need = dur * speed
    if need > length:
        speed = max(0.5, length / dur * 0.98)
        need = min(length, dur * speed)
    centre = (best_in + best_out) / 2
    where = entry.get("use") or "middle"
    start = best_in if where == "start" else (best_out - need if where == "end" else centre - need / 2)
    return min(max(0.0, start), max(0.0, length - need)), speed


# ---------------------------------------------------------------- filters

def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def _drawtext(text_file: Path, font: str, size: int, x: str, y: str, start: float, end: float,
              fade: float = 0.4, color="white", shadow=True, box=False, spacing=0, border=False) -> str:
    """A text overlay request (drawn by reel/text.py, so any ffmpeg build works)."""
    return txt.spec(text_file, font, size, x, y, start, end, fade, color, shadow, box, spacing, border)


def _frame_chain(shot: dict, W: int, H: int, crop_x: float | None) -> str:
    """Scale/crop to the output frame. Portrait footage in a 16:9 frame gets a blurred fill."""
    sw, sh = shot["width"], shot["height"]
    src_ar, out_ar = sw / sh, W / H
    cx = 0.5 if crop_x is None else min(max(crop_x, 0.0), 1.0)
    fit = shot.get("fit") or ("crop" if out_ar < 1 <= src_ar or abs(math.log(src_ar / out_ar)) < 0.75 else "blur")
    if fit == "crop":
        if src_ar > out_ar:
            cw = f"ih*{out_ar:.6f}"
            return f"crop={cw}:ih:(iw-{cw})*{cx:.4f}:0,scale={W}:{H}:flags=lanczos,setsar=1"
        ch = f"iw/{out_ar:.6f}"
        return f"crop=iw:{ch}:0:(ih-{ch})/2,scale={W}:{H}:flags=lanczos,setsar=1"
    return (f"split=2[bg][fg];[bg]scale={W}:{H}:force_original_aspect_ratio=increase,"
            f"crop={W}:{H},gblur=sigma=40,eq=brightness=-0.08:saturation=0.8[bgb];"
            f"[fg]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1")


def _look_chain(style: dict, look: str, exposure: float, W: int, H: int, strength: float = 1.0) -> str:
    cube = _esc(str(luts.lut_path(look, config.path("luts", "x").parent)))
    chain = []
    if exposure > 0.02:  # shot matching: nudge exposure toward mid-grey before the grade
        g = math.log(0.46) / math.log(min(max(exposure, 0.08), 0.92))
        g = min(max(1 / g, 0.75), 1.35)
        if abs(g - 1) > 0.03:
            chain.append(f"eq=gamma={g:.3f}")
    chain.append("format=gbrp")
    if strength >= 0.99:
        chain.append(f"lut3d=file='{cube}':interp=tetrahedral")
    else:
        chain.append(f"split=2[o][g];[g]lut3d=file='{cube}':interp=tetrahedral[gr];"
                     f"[o][gr]blend=all_mode=normal:all_opacity={strength:.2f}")
    if style.get("halation"):
        chain.append(f"split=2[base][hl];[hl]curves=all='0/0 0.72/0 1/1',gblur=sigma={W / 90:.1f},"
                     f"colorchannelmixer=rr=1:gg=0.35:bb=0.15[glow];"
                     f"[base][glow]blend=all_mode=screen:all_opacity={style['halation']:.2f}")
    if style.get("vignette"):
        chain.append("vignette=angle=PI/5:mode=forward")
    chain.append("format=yuv420p")
    if style.get("grain"):
        chain.append(f"noise=c0s={int(style['grain'])}:c0f=t+u")
    lb = style.get("letterbox")
    if lb and W / H < lb:
        bar = int(round((H - W / lb) / 2))
        chain.append(f"drawbox=x=0:y=0:w=iw:h={bar}:color=black:t=fill,"
                     f"drawbox=x=0:y=ih-{bar}:w=iw:h={bar}:color=black:t=fill")
    return ",".join(chain)


# ---------------------------------------------------------------- render

def render(plan: dict, shots: dict, style_id: str, out_path: Path, song: dict | None = None,
           song_file: Path | None = None, song_start: float | None = None, region: str = "ireland",
           progress=None) -> dict:
    treat = tr.normalise(plan.get("treatment"))
    style = tr.style_with(styles.get(style_id), treat)
    W, H = plan.get("aspect") or style["aspect"]
    fps = style["fps"]
    look = plan.get("look") or (treat or {}).get("look") or styles.look_for(style, region)
    if song and song_start is None:
        from .music import default_start
        song_start = default_start(song, float(plan.get("duration") or style["target"]), style.get("song_from", "top"))
    song_start = float(song_start or 0.0)
    slots = build_timeline(plan, shots, style, song, song_start)
    tr.decorate(slots, treat, song, song_start)
    work = Path(tempfile.mkdtemp(prefix="render-", dir=config.path("tmp", "x").parent))
    try:
        segs = []
        for i, slot in enumerate(slots):
            seg = work / f"seg{i:03d}.mp4"
            render_segment(shots[slot["id"]], slot, style, look, W, H, fps, seg, work, i, len(slots), plan, shots=shots)
            segs.append(seg)
            if progress:
                progress((i + 1) / (len(slots) + 2))
        total = sum(s["dur"] for s in slots)
        joined = work / "joined.mp4"
        (work / "list.txt").write_text("".join(f"file '{p.name}'\n" for p in segs))
        media.ffmpeg(["-f", "concat", "-safe", "0", "-i", str(work / "list.txt"), "-c", "copy", str(joined)])
        specs = _global_text(plan, style, W, H, total, work, slots)
        if specs:
            titled = work / "titled.mp4"
            extra, graph, label = txt.overlays(specs, 1, "0:v", W, H, fps, total, work, "g")
            media.ffmpeg(["-i", str(joined), *extra, "-filter_complex", ";".join(graph + [f"[{label}]format=yuv420p[v]"]),
                          "-map", "[v]", "-map", "0:a", "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", config.PRESET,
                          "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", str(titled)])
            joined = titled
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _mix(joined, out_path, total, style, song_file, song_start, slots)
        silent = out_path.with_name(out_path.stem + "-natsound.mp4")
        _mix(joined, silent, total, style, None, 0, slots)
        srt = out_path.with_suffix(".srt")
        n_subs = write_srt(slots, shots, srt)
        if progress:
            progress(1.0)
        return {
            "duration": round(total, 2),
            "cuts": len(slots),
            "look": look,
            "song_start": round(song_start, 2),
            "silent": silent.name,
            "srt": srt.name if n_subs else None,
            "chapters": chapters(slots),
            "timeline": [{"id": s["id"], "t": s["t"], "dur": s["dur"], "role": s.get("role"),
                          "dialogue": s["dialogue"]} for s in slots],
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _photo_motion(shot: dict, slot: dict, W: int, H: int) -> str:
    """Cover the frame; full-frame photos get a slow push-in (and drift toward the subject)."""
    base = max(W / shot["width"], H / shot["height"])
    if slot.get("photo_mode") == "flash":
        return (f"scale={math.ceil(shot['width'] * base / 2) * 2}:{math.ceil(shot['height'] * base / 2) * 2},"
                f"crop={W}:{H},setsar=1")
    d = max(slot["dur"], 0.5)
    z = f"(1.04+0.10*t/{d:.3f})"
    cx = min(max(shot.get("cx", 0.5), 0.2), 0.8)
    return (f"scale=w='ceil({shot['width'] * base:.1f}*{z}/2)*2':h='ceil({shot['height'] * base:.1f}*{z}/2)*2':eval=frame,"
            f"crop={W}:{H}:(iw-{W})*{cx:.3f}:(ih-{H})/2,setsar=1")


def _sticker(k: int, W: int, H: int, dur: float, idx: int) -> tuple[str, str]:
    """A white-bordered photo card that pops in, slightly rotated, alternating corners."""
    portrait = W < H
    w = int((W * 0.5 if portrait else H * 0.62) // 2 * 2)
    border = max(10, w // 28)
    angle = (-0.07, 0.06, -0.04, 0.08)[idx % 4]
    x = ["W*0.08", "W-w-W*0.08", "W*0.1", "W-w-W*0.1"][idx % 4]
    y0 = ["H*0.12", "H*0.2", "H*0.45", "H*0.5"][idx % 4] if portrait else ["H*0.12", "H*0.18", "H*0.4", "H*0.35"][idx % 4]
    st = min(0.15 + idx * 0.35, max(0.0, dur - 0.6))
    card = (f"[{k}:v]scale={w}:-2,pad=iw+{2 * border}:ih+{2 * border}:{border}:{border}:white,format=rgba,"
            f"rotate={angle}:c=none:ow=rotw({angle}):oh=roth({angle})[st{idx}]")
    place = (f"overlay=x='{x}':y='{y0}+H*0.06*max(0,1-(t-{st:.3f})/0.18)':enable='gte(t,{st:.3f})'")
    return card, place


def render_segment(shot, slot, style, look, W, H, fps, out, work, i, n, plan, text=True, shots=None):
    src = config.abs_(shot["path"])
    dur, speed, start = slot["dur"], slot["speed"], slot["src_in"]
    t = style.get("treatment")
    is_photo = shot.get("kind") == "photo"
    if is_photo:
        vf = [_photo_motion(shot, slot, W, H)]
    else:
        vf = [_frame_chain({**shot, "fit": slot.get("fit")}, W, H, slot.get("crop_x", shot.get("cx")))]
    vf += tr.pre_grade(t, slot, W, H, fps)
    if speed != 1.0:
        vf.append(f"setpts=PTS/{speed:.4f}")
    vf.append(f"fps={fps}")
    vf += tr.time_fx(t, slot, fps)
    vf.append(_look_chain(style, look, shot.get("bright", 0.46), W, H, float(plan.get("grade_strength", 1.0))))
    vf += tr.post_grade(t, slot, W, H)
    if style.get("flash_on_drop") and slot.get("flash") and not t:
        vf.append("fade=t=in:st=0:d=0.12:color=white")
    if i == 0 and style.get("text") in ("title", "quiet"):
        vf.append("fade=t=in:st=0:d=0.8")
    if i == n - 1 and style["id"] != "reel":
        vf.append(f"fade=t=out:st={max(0, dur - 0.8):.3f}:d=0.8")
    text_filters = [f for f in (_slot_text(shot, slot, style, W, H, work, i, start, speed) if text else []) if f]

    # Inputs: 0 = the shot (looped still for photos), 1..k = sticker photos, then silence if needed.
    if is_photo:
        args = ["-loop", "1", "-framerate", str(fps), "-t", f"{dur + 0.2:.3f}", "-i", str(src)]
    else:
        args = ["-ss", f"{start:.3f}", "-i", str(src)]
    overlays = [o for o in slot.get("overlays", []) if shots and o in shots]
    for o in overlays:
        args += ["-loop", "1", "-framerate", str(fps), "-t", f"{dur + 0.2:.3f}", "-i", str(config.abs_(shots[o]["path"]))]
    graph = [f"[0:v]{','.join(vf)}[g0]"]
    last = "g0"
    for k, o in enumerate(overlays):
        card, place = _sticker(k + 1, W, H, dur, k)
        graph.append(card)
        graph.append(f"[{last}][st{k}]{place}[g{k + 1}]")
        last = f"g{k + 1}"
    first_text = len(overlays) + 1
    extra, tgraph, last = txt.overlays(text_filters, first_text, last, W, H, fps, dur, work, f"s{i}")
    args += extra
    graph += tgraph
    graph.append(f"[{last}]format=yuv420p,tpad=stop_mode=clone:stop_duration={dur:.3f}[v]")
    use_audio = shot.get("has_audio") and speed == 1.0 and not is_photo
    level = 1.0 if slot.get("dialogue") else float(style.get("nat_level", 0.2))
    if i == 0 and style.get("nat_open"):
        level = max(level, 0.9)
    if use_audio:
        graph.append(f"[0:a]volume={level:.3f},apad[a]")
    else:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        graph.append(f"[{len(overlays) + 1 + len(text_filters)}:a]anull[a]")
    args += ["-t", f"{dur:.4f}", "-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", config.PRESET, "-crf", "18", "-pix_fmt", "yuv420p",
             "-r", str(fps), "-video_track_timescale", str(fps * 1000),
             "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(out)]
    media.ffmpeg(args)


def _slot_text(shot, slot, style, W, H, work, i, start, speed) -> list[str]:
    kind = style.get("text")
    portrait = W < H
    t = style.get("treatment")
    out = []
    if t and t.get("timestamp") and shot.get("captured_at"):
        from datetime import datetime
        when = datetime.fromisoformat(shot["captured_at"])
        stamp = work / f"stamp{i:03d}.txt"
        stamp.write_text(f"{when.strftime('%p').replace('AM', 'A.M.').replace('PM', 'P.M.')} {when.strftime('%-I:%M')}\n"
                         f"{when.strftime('%b. %d %Y').upper()}")
        size = int(min(W, H) * 0.045)
        if t.get("aspect") == "4:3" and portrait:
            y = f"{H / 2 + W * 3 / 8 - size * 2.6:.0f}"
        else:
            y = "h*0.80" if portrait else "h*0.86"
        out.append(_drawtext(stamp, config.FONT_VCR, size, "w*0.07", y, 0, slot["dur"], fade=0.01,
                             color="#f6c56f", spacing=4))
    small = int(H * (0.024 if portrait else 0.034))
    cap = slot.get("caption")
    chapter = slot.get("chapter")
    if kind == "vlog":
        if chapter and not cap:
            cap = chapter
        if cap:
            tf = work / f"cap{i:03d}.txt"
            tf.write_text(_wrap(cap, 26 if portrait else 44))
            out.append(_drawtext(tf, tr.font(t, config.FONT_MONO), small, "w*0.07", "h*0.70", 0.1,
                                 max(0.6, min(slot["dur"], 3.2) - 0.05), fade=0.15, box=True))
    elif kind == "episode" and chapter:
        tf = work / f"chap{i:03d}.txt"
        tf.write_text(_wrap(chapter.upper(), 30 if portrait else 40))
        out.append(_drawtext(tf, tr.font(t, config.FONT_SERIF), int(H * 0.05), "w*0.06", "h*0.78", 0.4,
                             min(slot["dur"], 3.6), fade=0.5))
    elif kind == "quiet" and cap:
        tf = work / f"cap{i:03d}.txt"
        tf.write_text(cap.lower())
        out.append(_drawtext(tf, config.FONT_SERIF, small, "(w-text_w)/2", "h*0.82", 0.3, max(0.8, slot["dur"] - 0.2)))
    # Burned subtitles for dialogue in the Instagram vlog.
    if style["id"] in SUB_STYLES and slot.get("dialogue"):
        for k, line in enumerate(shot.get("speech") or []):
            a = (line["start"] - start) / speed
            b = (line["end"] - start) / speed
            if b <= 0 or a >= slot["dur"]:
                continue
            tf = work / f"sub{i:03d}_{k}.txt"
            tf.write_text(_wrap(line["text"], 28 if portrait else 48))
            out.append(_drawtext(tf, config.FONT_SANS, int(W * (0.048 if portrait else 0.026)), "(w-text_w)/2",
                                 "h*0.60" if portrait else "h*0.82", max(0, a), min(slot["dur"], b + 0.15),
                                 fade=0.08, box=True, spacing=8))
    return out


def _global_text(plan, style, W, H, total, work, slots) -> list[str]:
    kind = style.get("text")
    t = style.get("treatment")
    parts = []
    hook_end = slots[0]["dur"] if slots else 2.5
    if kind in ("title", "episode") and plan.get("title"):
        # Episodes run a cold open first; the title card comes after the hook.
        t0 = 1.2 if kind == "title" else min(hook_end + 0.2, total * 0.3)
        tf = work / "title.txt"
        tf.write_text(tr.case(t, plan["title"].upper() if kind == "title" else plan["title"]))
        parts.append(_drawtext(tf, tr.font(t, config.FONT_SERIF), int(H * (0.075 if kind == "title" else 0.065)),
                               "(w-text_w)/2", "(h-text_h)/2-h*0.03", t0, min(total - 0.5, t0 + 4.0), fade=0.8, **tr.text_style(t)))
        if plan.get("subtitle"):
            sub = work / "sub.txt"
            sub.write_text(plan["subtitle"])
            parts.append(_drawtext(sub, tr.font(t, config.FONT_SANS), int(H * 0.024), "(w-text_w)/2", "(h/2)+h*0.05",
                                   t0 + 0.6, min(total - 0.5, t0 + 4.0), fade=0.8, color="white@0.85"))
    if kind in ("title", "episode") and plan.get("end_card") and total > 8:
        ec = work / "end.txt"
        ec.write_text(tr.case(t, plan["end_card"]))
        parts.append(_drawtext(ec, tr.font(t, config.FONT_SERIF), int(H * 0.045), "(w-text_w)/2", "(h-text_h)/2",
                               total - 3.5, total - 0.2, fade=0.6, **tr.text_style(t)))
    if kind in ("hook", "vlog") and plan.get("hook"):
        tf = work / "hook.txt"
        tf.write_text(tr.case(t, _wrap(plan["hook"], 18)))
        parts.append(_drawtext(tf, tr.font(t, config.FONT_SANS), int(W * 0.075), "(w-text_w)/2", "h*0.14",
                               0.0, min(max(2.4, hook_end), 3.5, total), fade=0.15, spacing=12, **tr.text_style(t)))
    if kind == "quiet" and plan.get("title"):
        tf = work / "title.txt"
        tf.write_text(plan["title"].lower())
        parts.append(_drawtext(tf, tr.font(t, config.FONT_SERIF), int(W * 0.05), "(w-text_w)/2", "h*0.45", 0.8, min(4.0, total), fade=0.9, **tr.text_style(t)))
    return [p for p in parts if p]


def _wrap(text: str, width: int) -> str:
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def _duck_expr(slots: list[dict], duck: float, nat_open: float) -> str:
    """Music volume over time: 1 normally, `duck` under dialogue, 0 during the natural-sound open."""
    terms = []
    for s in slots:
        if s.get("dialogue"):
            a, b = s["t"], s["t"] + s["dur"]
            # 0.25 s ramps either side.
            terms.append(f"clip(min((t-{a - 0.25:.3f})/0.25,({b + 0.25:.3f}-t)/0.25),0,1)")
    dip = "1"
    if terms:
        folded = terms[0]
        for t in terms[1:]:  # ffmpeg's max() takes two arguments
            folded = f"max({folded},{t})"
        dip = f"(1-{1 - duck:.3f}*{folded})"
    if nat_open:
        dip = f"{dip}*clip((t-{nat_open:.3f})/1.2,0,1)"
    return dip


def _mix(video: Path, out: Path, total: float, style: dict, song_file: Path | None, song_start: float, slots: list[dict]):
    # An inaudible (-90 dB) noise floor keeps loudnorm from dividing by zero on silent edits
    # (photo-only days, clips without sound), which otherwise aborts the render with NaN audio.
    floor = ["-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.00003:r=48000"]
    if song_file:
        fade_out = min(2.5, total * 0.15)
        vol = _duck_expr(slots, float(style.get("duck", 0.25)), float(style.get("nat_open", 0)))
        loop = "aloop=loop=-1:size=2e9," if style.get("loop_song") else ""
        fc = (f"[1:a]atrim=start={song_start:.3f},asetpts=PTS-STARTPTS,{loop}"
              f"atrim=duration={total + 0.5:.3f},volume='{vol}':eval=frame,"
              f"afade=t=out:st={max(0, total - fade_out):.3f}:d={fade_out:.3f}[m];"
              f"[0:a][m][2:a]amix=inputs=3:normalize=0:duration=first,"
              f"loudnorm=I=-14:TP=-1.0:LRA=11,aresample=48000[a]")
        args = ["-i", str(video), "-i", str(song_file), *floor, "-filter_complex", fc]
    else:
        fc = "[0:a][1:a]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]"
        args = ["-i", str(video), *floor, "-filter_complex", fc]
    args += ["-map", "0:v", "-map", "[a]", "-t", f"{total:.3f}", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out)]
    media.ffmpeg(args)


# ---------------------------------------------------------------- sidecars

def _ts(t: float, sep=",") -> str:
    h, rem = divmod(max(0.0, t), 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d}{sep}{int(round((s % 1) * 1000)):03d}"


def write_srt(slots: list[dict], shots: dict, path: Path) -> int:
    cues = []
    for s in slots:
        if not s.get("dialogue"):
            continue
        for line in shots[s["id"]].get("speech") or []:
            a = s["t"] + (line["start"] - s["src_in"]) / s["speed"]
            b = s["t"] + (line["end"] - s["src_in"]) / s["speed"]
            a, b = max(a, s["t"]), min(b, s["t"] + s["dur"])
            if b - a > 0.2:
                cues.append((a, b, line["text"]))
    if cues:
        path.write_text("\n".join(f"{i + 1}\n{_ts(a)} --> {_ts(b)}\n{t}\n" for i, (a, b, t) in enumerate(cues)))
    return len(cues)


def chapters(slots: list[dict]) -> list[dict]:
    """YouTube chapters: must start at 0:00 and be at least 10 s apart."""
    out = [{"t": 0.0, "title": "Cold open"}] if slots else []
    for s in slots:
        if s.get("chapter") and s["t"] - out[-1]["t"] >= 10:
            out.append({"t": round(s["t"], 1), "title": s["chapter"]})
    return out if len(out) >= 3 else []


def youtube_description(post: dict | None, chapter_list: list[dict]) -> str:
    lines = [(post or {}).get("caption", "").strip()]
    if chapter_list:
        lines.append("")
        for c in chapter_list:
            m, s = divmod(int(c["t"]), 60)
            lines.append(f"{m}:{s:02d} {c['title']}")
    return "\n".join(lines).strip()


# ---------------------------------------------------------------- stills

def stills(plan: dict, shots: dict, out_dir: Path, look: str) -> list[str]:
    """Graded 4:5 frames for an Instagram carousel."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.jpg"):
        old.unlink()
    style = {**styles.get("photos"), "grain": 4, "vignette": True, "halation": 0.15}
    W, H = style["aspect"]
    names = []
    for i, e in enumerate(plan["shots"][: style["count"]]):
        shot = shots.get(e["id"])
        if not shot:
            continue
        t = 0.0 if shot.get("kind") == "photo" else (shot["in"] + shot["out"]) / 2
        name = f"{i + 1:02d}.jpg"
        chain = _frame_chain(shot, W, H, e.get("crop_x", shot.get("cx"))) + "," + \
            _look_chain(style, look, shot.get("bright", 0.46), W, H)
        seek = ["-ss", f"{t:.3f}"] if t else []
        media.ffmpeg([*seek, "-i", str(config.abs_(shot["path"])), "-frames:v", "1",
                      "-filter_complex", f"[0:v]{chain}[v]", "-map", "[v]", "-q:v", "2", str(out_dir / name)])
        names.append(name)
    return names


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)
