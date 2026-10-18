"""The job queue. One background thread does the heavy lifting in order:

  ingest clip -> (when a day's clips are all in) plan day -> render each style -> trip film

Jobs live in state.json, so a restart picks up where it left off.
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import analyze, config, director, media, music, notify, render, store, styles, transcribe, trip
from . import photos, treatment as tr

log = logging.getLogger("reel.worker")
_wake = threading.Event()
_thread: threading.Thread | None = None
status = {"current": None, "progress": 0.0}

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mts", ".avi", ".mkv", ".360", ".lrv"}
MEDIA_EXT = VIDEO_EXT | photos.PHOTO_EXT


# ---------------------------------------------------------------- queueing

_local = threading.local()


def enqueue(kind: str, pri: bool | None = None, **args) -> None:
    """Queue a job. pri=True jumps ahead of background analysis (things you clicked);
    jobs queued by a running job inherit its priority."""
    if pri is None:
        pri = getattr(_local, "pri", False)
    key = f"{kind}:{args.get('clip') or ''}:{args.get('day') or ''}:{args.get('style') or ''}"
    with store.edit() as s:
        for j in s["jobs"]:
            if j["key"] == key and j["status"] == "queued":
                j["pri"] = j.get("pri") or pri
                j["args"] = args  # latest request wins (e.g. a newer change request)
                break
        else:
            s["jobs"].append({"key": key, "kind": kind, "args": args, "status": "queued", "at": store.now(), "pri": pri})
        s["jobs"] = [j for j in s["jobs"] if j["status"] in ("queued", "running")] + \
            [j for j in s["jobs"] if j["status"] not in ("queued", "running")][-60:]
    _wake.set()


RANK = {"ingest": 0, "treatment": 1, "plan": 1, "revise": 1, "render": 2, "stills": 2, "export": 2, "film": 3}


def _order(j: dict, clips: dict) -> tuple:
    """What runs next: your clicks first; then one day at a time, earliest day first
    (analyse its clips, plan it, render it) so edits appear day by day; the trip film last."""
    if j["kind"] == "film":
        return (2, "9999", 3, j["at"])
    day = j["args"].get("day")
    if j["kind"] == "ingest":
        c = clips.get(j["args"].get("clip"), {})
        day = c.get("day") or c.get("day_guess")
    return (0 if j.get("pri") else 1, day or "9998", RANK.get(j["kind"], 9), j["at"])


def _next_job():
    with store.edit() as s:
        for j in s["jobs"]:
            if j["status"] == "running":  # left over from a crash/restart
                j["status"] = "queued"
        queued = [j for j in s["jobs"] if j["status"] == "queued"]
        if not queued:
            return None
        j = min(queued, key=lambda j: _order(j, s["clips"]))
        j["status"] = "running"
        j["started"] = store.now()
        return dict(j)


def _finish(job, ok: bool, error: str = "") -> None:
    with store.edit() as s:
        for j in s["jobs"]:
            if j["key"] == job["key"] and j["status"] == "running":
                j["status"] = "done" if ok else "error"
                j["error"] = error[-800:]
                j["ended"] = store.now()


def _backfill_days() -> None:
    """Clips queued before day-guessing existed: read their dates now so day cards fill in."""
    snap = store.snapshot()
    todo = [c for c in snap["clips"].values()
            if c["status"] in ("queued", "analysing") and not (c.get("day") or c.get("day_guess"))]
    for c in todo:
        day = _guess_day(config.abs_(c["file"]))
        if day:
            with store.edit() as s:
                s["clips"][c["id"]]["day_guess"] = day


def start() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    threading.Thread(target=_backfill_days, daemon=True).start()
    _thread = threading.Thread(target=_loop, name="reel-worker", daemon=True)
    _thread.start()


def _loop():
    while True:
        job = _next_job()
        if not job:
            _wake.wait(30)
            _wake.clear()
            continue
        run_job(job)


def run_job(job) -> None:
    status["current"] = job["key"]
    status["progress"] = 0.0
    _local.pri = bool(job.get("pri"))
    try:
        {"ingest": ingest, "plan": plan, "revise": revise, "render": render_style,
         "stills": render_stills, "film": film, "export": export, "treatment": set_treatment}[job["kind"]](**job["args"])
        _finish(job, True)
    except Exception as e:
        log.error("job %s failed: %s", job["key"], e)
        _finish(job, False, f"{e}\n{traceback.format_exc()[-600:]}")
    finally:
        status["current"] = None
        _local.pri = False


def drain() -> None:
    """Run every queued job now, in this thread (used by the CLI)."""
    while (job := _next_job()):
        print(f"→ {job['kind']} {job['args']}", flush=True)
        run_job(job)
        with store.edit() as s:
            j = next((x for x in s["jobs"] if x["key"] == job["key"]), {})
        if j.get("status") == "error":
            print(f"  ✗ {j.get('error', '').splitlines()[0] if j.get('error') else 'failed'}", flush=True)


# ---------------------------------------------------------------- adding footage

def clip_id_for(path: Path) -> str:
    st = path.stat()
    return hashlib.sha1(f"{path.name}:{st.st_size}".encode()).hexdigest()[:12]


def add_file(path: Path, day_hint: str | None = None, move: bool = True) -> str | None:
    """Register a camera file and queue it for analysis. Returns the clip id (None if a duplicate)."""
    path = Path(path)
    if path.suffix.lower() not in MEDIA_EXT or path.name.startswith("._"):
        return None
    if path.suffix.lower() == ".lrv":  # GoPro low-res proxies: skip, we use the real file
        return None
    cid = clip_id_for(path)
    with store.edit() as s:
        if cid in s["clips"]:
            return None
    dest = config.path("originals", f"{cid}{path.suffix.lower()}")
    if move:
        try:
            os.replace(path, dest)
        except OSError:
            shutil.copy2(path, dest)
            path.unlink(missing_ok=True)
    else:
        shutil.copy2(path, dest)
    with store.edit() as s:
        s["clips"][cid] = {"id": cid, "name": path.name, "file": config.rel(dest), "status": "queued",
                           "day_hint": day_hint, "day_guess": day_hint if day_hint not in (None, "auto") else _guess_day(dest),
                           "added": store.now(), "shots": []}
    enqueue("ingest", clip=cid, pri=False)
    return cid


def _guess_day(path: Path) -> str | None:
    """Which day a file belongs to, read from its metadata in a fraction of a second."""
    try:
        if path.suffix.lower() in photos.PHOTO_EXT:
            _, exif = photos._open(path)
            when = photos._taken(exif, path)
        else:
            when = media.describe(path)["captured_at"]
        return when[:10] if when else None
    except Exception:
        return None


def retry_failed() -> int:
    with store.edit() as s:
        failed = [c["id"] for c in s["clips"].values()
                  if c["status"] == "error" and config.abs_(c["file"]).exists()]
        for cid in failed:
            s["clips"][cid]["status"] = "queued"
    for cid in failed:
        enqueue("ingest", clip=cid)
    return len(failed)


def scan_inbox(inbox: Path) -> list[str]:
    added = []
    for p in sorted(inbox.rglob("*")):
        if p.is_file():
            cid = add_file(p)
            if cid:
                added.append(cid)
    return added


# ---------------------------------------------------------------- jobs

def ingest(clip: str) -> None:
    with store.edit() as s:
        c = s["clips"][clip]
        c["status"] = "analysing"
    src = config.abs_(c["file"])
    if src.suffix.lower() in photos.PHOTO_EXT:
        return _ingest_photo(clip, c, src)
    try:
        info = media.describe(src)
        captured = info["captured_at"]
        tz = ZoneInfo(config.TIMEZONE)
        if c.get("day_hint") and c["day_hint"] != "auto":
            day = c["day_hint"]
        elif captured:
            day = captured[:10]
        else:
            day = datetime.fromtimestamp(c["added"], tz).date().isoformat()
        metrics = analyze.measure(src, info)
        windows = analyze.pick_windows(metrics, info["duration"])
        lines = transcribe.transcribe(src) if info.get("has_audio") else []
        if lines:
            windows = analyze.add_speech(windows, metrics, transcribe.speech_windows(lines, info["duration"]))
        new_shots = {}
        for i, w in enumerate(windows):
            sid = analyze.shot_id(clip, w["start"])
            out = config.path("shots", day, f"{sid}.mp4")
            thumb = config.path("thumbs", day, f"{sid}.jpg")
            got = analyze.extract(src, info, w, out, thumb)
            when = None
            if captured:
                when = datetime.fromtimestamp(datetime.fromisoformat(captured).timestamp() + w["start"], tz).isoformat()
            new_shots[sid] = {
                "id": sid, "clip": clip, "day": day, "path": config.rel(out), "thumb": config.rel(thumb),
                "captured_at": when, "place": trip.place_at(when), "device": info["device"],
                "score": round(w["score"], 4), "motion": round(w["motion"], 4), "bright": round(w["bright"], 4),
                "sat": round(w["sat"], 4), "faces": w["faces"], "cx": round(w["cx"], 4), "loud": round(w["loud"], 1),
                "kind": w.get("kind", "visual"),
                **got,
            }
            # What's said inside this shot, in shot-file seconds.
            off = w["start"] - got["in"]
            said = [{"start": round(l["start"] - off, 2), "end": round(l["end"] - off, 2), "text": l["text"]}
                    for l in lines if l["end"] > w["start"] and l["start"] < w["start"] + w["dur"]]
            if said:
                new_shots[sid]["speech"] = said
                new_shots[sid]["said"] = " ".join(x["text"] for x in said)
            status["progress"] = (i + 1) / max(1, len(windows))
        with store.edit() as s:
            s["shots"].update(new_shots)
            c = s["clips"][clip]
            c.update({"status": "ready", "day": day, "shots": list(new_shots), "info": info})
            store.day(s, day)["dirty"] = True
        if not config.KEEP_ORIGINALS:
            src.unlink(missing_ok=True)
    except Exception as e:
        with store.edit() as s:
            s["clips"][clip].update({"status": "error", "error": str(e)[-400:]})
        raise
    _maybe_plan_dirty_days(clip)


def _ingest_photo(clip: str, c: dict, src: Path) -> None:
    try:
        sid = analyze.shot_id(clip, 0.0)
        tmp_day = c.get("day_hint") if c.get("day_hint") not in (None, "auto") else None
        staging = config.path("photos", "_in", f"{sid}.jpg")
        thumb_tmp = config.path("thumbs", "_in", f"{sid}.jpg")
        info = photos.ingest(src, staging, thumb_tmp)
        tz = ZoneInfo(config.TIMEZONE)
        day = tmp_day or (info["captured_at"] or "")[:10] or datetime.fromtimestamp(c["added"], tz).date().isoformat()
        out = config.path("photos", day, f"{sid}.jpg")
        thumb = config.path("thumbs", day, f"{sid}.jpg")
        staging.replace(out)
        thumb_tmp.replace(thumb)
        shot = {"id": sid, "clip": clip, "day": day, "path": config.rel(out), "thumb": config.rel(thumb),
                "place": trip.place_at(info["captured_at"]), "device": "photo", **info}
        with store.edit() as s:
            s["shots"][sid] = shot
            s["clips"][clip].update({"status": "ready", "day": day, "shots": [sid], "info": {"photo": True}})
            store.day(s, day)["dirty"] = True
        if not config.KEEP_ORIGINALS:
            src.unlink(missing_ok=True)
    except Exception as e:
        with store.edit() as s:
            s["clips"][clip].update({"status": "error", "error": str(e)[-400:]})
        raise
    _maybe_plan_dirty_days(clip)


def _maybe_plan_dirty_days(finished: str | None = None) -> None:
    """Plan each day as soon as its own clips are analysed; the trip film once everything is in.
    `finished` is the clip whose ingest is completing right now (its job still reads 'running')."""
    with store.edit() as s:
        waiting = [s["clips"].get(j["args"].get("clip"), {}) for j in s["jobs"]
                   if j["kind"] == "ingest" and j["status"] in ("queued", "running")
                   and j["args"].get("clip") != finished]
        busy_days = {c.get("day") or c.get("day_guess") for c in waiting}
        ready = [d for d, v in s["days"].items() if v.get("dirty") and d != "trip" and d not in busy_days]
        for d in ready:
            s["days"][d]["dirty"] = False
        all_done = not waiting
    for d in ready:
        enqueue("plan", day=d, pri=False)
    if all_done and ready:
        enqueue("film", day="trip", pri=False)


def _song_for(day_state: dict) -> tuple[dict | None, Path | None]:
    song = day_state.get("song")
    if not song:
        return None, None
    f = config.abs_(song["file"]) if song.get("file") else None
    return song, f


def plan(day: str, styles_only: list[str] | None = None, keep_manual=True) -> None:
    snap = store.snapshot()
    d = store.day(snap, day)
    shots = store.day_shots(snap, day)
    if not shots:
        return
    song, _ = _song_for(d)
    wanted = styles_only or list(styles.AUTO_STYLES)
    # Don't overwrite plans the group edited by hand unless asked.
    todo = [sid for sid in wanted if not (keep_manual and d["plans"].get(sid, {}).get("manual"))]
    plans = director.plan_day(day, shots, song, todo, d.get("notes", ""), _history(snap, day),
                              treatment_for(snap, day)) if todo else {}
    with store.edit() as s:
        sd = store.day(s, day)
        for sid in todo:
            if sid in plans:
                sd["plans"][sid] = {**plans[sid], "planned": store.now(), "by": "claude" if config.ANTHROPIC_KEY else "auto"}
        if plans.get("_posts"):
            sd["social"].update(plans["_posts"])
        if plans.get("_story"):
            sd["story"] = plans["_story"]
        if plans.get("_bpm") and sd.get("song") and not sd["song"].get("bpm"):
            sd["song"].update(music.grid(float(plans["_bpm"]), sd["song"].get("duration") or 240))
    for sid in wanted:
        enqueue("stills" if styles.get(sid).get("still") else "render", day=day, style=sid)


def treatment_for(snap: dict, day: str) -> dict | None:
    """The day's own treatment, else the trip-wide default ('clean' switches it off for a day)."""
    own = snap["days"].get(day, {}).get("treatment")
    if own is not None:
        return tr.normalise(own) if own else None
    return tr.normalise(snap.get("settings", {}).get("treatment"))


def set_treatment(day: str, preset: str | None = None, describe: str | None = None,
                  music_video: bool = False, everywhere: bool = False) -> None:
    """Pick a preset or research a style, store it, then re-cut the day (or every day)."""
    snap = store.snapshot()
    d = store.day(snap, day)
    if preset:
        t = dict(tr.PRESETS[preset], preset=preset)
    else:
        with store.edit() as s:
            store.day(s, day)["treatment_status"] = "researching"
        try:
            t = director.research_treatment(describe, d.get("song") if (music_video or describe) else None)
        except Exception as e:
            with store.edit() as s:
                store.day(s, day)["treatment_status"] = f"error: {e}"
            raise
    value = {} if preset == "clean" else t
    with store.edit() as s:
        store.day(s, day)["treatment_status"] = "ready"
        if everywhere:
            s.setdefault("settings", {})["treatment"] = value or None
            for dd in s["days"].values():
                dd.pop("treatment", None)
        else:
            store.day(s, day)["treatment"] = value
        days = sorted({sh["day"] for sh in s["shots"].values()}) if everywhere else [day]
    for dd in days:
        if dd == "trip":
            enqueue("render", day="trip", style="film")
        else:
            # Shot choice follows the look, so re-plan (hand-edited cuts are kept, just re-rendered).
            enqueue("plan", day=dd)
            with store.edit() as s:
                keep = [k for k, p in store.day(s, dd)["plans"].items()
                        if p.get("manual") or k not in styles.AUTO_STYLES]
            for sid in keep:
                enqueue("stills" if styles.get(sid).get("still") else "render", day=dd, style=sid)
    if everywhere or day != "trip":
        enqueue("film", day="trip")


def _history(snap: dict, day: str) -> list[str]:
    """One line per earlier day, for continuity."""
    out = []
    for d in sorted(k for k in snap["days"] if k < day and k != "trip"):
        if snap["days"][d].get("story"):
            out.append(f"{d}: {snap['days'][d]['story']}")
        if snap["days"][d].get("notes"):
            out.append(f"{d} notes: {snap['days'][d]['notes'][:300]}")
    return out


def revise(day: str, style: str, request: str, req_id: str | None = None) -> None:
    snap = store.snapshot()
    d = store.day(snap, day)
    shots = store.day_shots(snap, day)
    song, _ = _song_for(d)
    current = d["plans"].get(style) or director.heuristic_plan(style, shots, {"title": ""})
    new = director.revise(day, style, current, request, shots, song, d.get("notes", ""), _history(snap, day),
                          treatment_for(snap, day))
    with store.edit() as s:
        sd = store.day(s, day)
        social = new.pop("_post", None)
        sd["plans"][style] = {**new, "manual": True, "planned": store.now(), "by": "request"}
        if social:
            sd["social"][style] = social
        for r in sd["requests"]:
            if r.get("id") == req_id:
                r["status"] = "done"
    enqueue("stills" if styles.get(style).get("still") else "render", day=day, style=style)


def _set_render(day: str, style: str, **fields) -> None:
    with store.edit() as s:
        r = store.day(s, day)["renders"].setdefault(style, {})
        r.update(fields)


def render_style(day: str, style: str) -> None:
    snap = store.snapshot()
    d = store.day(snap, day)
    plan_ = d["plans"].get(style)
    if not plan_:
        return
    plan_ = {**plan_, "treatment": treatment_for(snap, day)}
    shots = store.day_shots(snap, day, include_hidden=True)
    song, song_file = _song_for(d)
    info = trip.day(day) if day != "trip" else {"region": "ireland"}
    version = int(d["renders"].get(style, {}).get("version", 0)) + 1
    out = config.path("renders", day, f"{style}-v{version}.mp4")
    _set_render(day, style, status="rendering", started=store.now(), error="")

    def prog(p):
        status["progress"] = p

    try:
        meta = render.render(plan_, shots, style, out, song=song if (song and song.get("beats")) else None,
                             song_file=song_file, song_start=plan_.get("song_start", song.get("start") if song else None),
                             region=info.get("region", "ireland"), progress=prog)
    except Exception as e:
        _set_render(day, style, status="error", error=str(e)[-600:])
        raise
    old = d["renders"].get(style, {})
    for k in ("file", "silent", "srt"):
        if old.get(k):
            config.abs_(old[k]).unlink(missing_ok=True)
    srt = meta.pop("srt")
    silent = meta.pop("silent")
    if meta.get("chapters") and styles.get(style)["aspect"][0] > styles.get(style)["aspect"][1]:
        meta["description"] = render.youtube_description(d["social"].get(style), meta["chapters"])
    _set_render(day, style, status="ready", file=config.rel(out), silent=config.rel(out.with_name(silent)),
                srt=config.rel(out.with_name(srt)) if srt else None, version=version, updated=store.now(), **meta)
    _maybe_notify(day)


def render_stills(day: str, style: str = "photos") -> None:
    snap = store.snapshot()
    d = store.day(snap, day)
    plan_ = d["plans"].get(style)
    if not plan_:
        return
    shots = store.day_shots(snap, day, include_hidden=True)
    info = trip.day(day) if day != "trip" else {"region": "ireland"}
    look = plan_.get("look") or styles.look_for(styles.get(style), info.get("region", "ireland"))
    _set_render(day, style, status="rendering", started=store.now(), error="")
    out_dir = config.path("renders", day, "photos", "x").parent
    names = render.stills(plan_, shots, out_dir, look)
    _set_render(day, style, status="ready", stills=[config.rel(out_dir / n) for n in names],
                version=int(d["renders"].get(style, {}).get("version", 0)) + 1, updated=store.now(), look=look)
    _maybe_notify(day)


def film(day: str = "trip") -> None:
    """The whole-trip film: the best shots of every day, chaptered."""
    snap = store.snapshot()
    d = store.day(snap, "trip")
    shots = store.day_shots(snap, "trip")
    if len(shots) < 4:
        return
    if not d["plans"].get("film", {}).get("manual"):
        days = sorted({s["day"] for s in shots.values()})
        per_day = max(3, min(10, 60 // max(1, len(days))))
        entries = []
        for dd in days:
            ds = {k: v for k, v in shots.items() if v["day"] == dd}
            picked = director.heuristic_plan("cinematic", ds, {})["shots"][:per_day]
            info = trip.day(dd)
            if picked:
                picked[0]["chapter"] = f"Day {info['number']} · {info['title']}" if info.get("number") else info["title"]
            entries += picked
        with store.edit() as s:
            store.day(s, "trip")["plans"]["film"] = {
                "shots": entries, "title": trip.trip_name(), "subtitle": "October 2026",
                "end_card": "see you next time", "planned": store.now(), "by": "auto"}
    render_style("trip", "film")


def export(day: str, style: str) -> None:
    from .export import export_pack

    path = export_pack(day, style)
    with store.edit() as s:
        store.day(s, day).setdefault("exports", {})[style] = config.rel(path)


def _maybe_notify(day: str) -> None:
    snap = store.snapshot()
    d = store.day(snap, day)
    if day == "trip" or d.get("notified_version") == _versions(d):
        return
    busy = any(j["status"] in ("queued", "running") and j["args"].get("day") == day
               and j["kind"] in ("render", "stills", "plan") for j in snap["jobs"])
    if busy:
        return
    ready = [k for k, v in d["renders"].items() if v.get("status") == "ready"]
    if not ready:
        return
    info = trip.day(day)
    notify.day_ready(day, info, ready)
    with store.edit() as s:
        store.day(s, day)["notified_version"] = _versions(d)


def _versions(d):
    return ",".join(f"{k}{v.get('version')}" for k, v in sorted(d["renders"].items()))
