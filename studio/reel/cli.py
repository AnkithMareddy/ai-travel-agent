"""reel: the studio from the terminal.

  reel serve                       studio web app + background editor (http://localhost:8787)
  reel nightly [FOLDER]            import a folder of footage, edit everything, exit
  reel add FILE... [--day DATE]    import specific files
  reel song DATE FILE [--start S]  set the song for a day (DATE can be 'trip')
  reel plan DATE                   re-plan a day's edits (Claude, or the built-in editor)
  reel render DATE [STYLE]         re-render a day (all styles or one)
  reel ask DATE STYLE "request"    plain-English change, e.g. "open on the cliffs, shorter"
  reel treat DATE awge             treatment: awge | super8 | noir | clean | music-video | "edit like …"
  reel doctor                      check every component and explain what's wrong
  reel retry                       re-run clips that failed to import
  reel status                      what's in the studio
  reel looks                       list colour grades (and write .cube files to --out)
  reel export DATE STYLE           project pack for Palmier / any NLE
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import config, luts, store, styles, trip, worker


def _p(*a):
    print(*a, flush=True)


def cmd_serve(a):
    import uvicorn

    from .server import app

    _p(f"🎬 Reel Studio on http://localhost:{a.port}  (data: {config.DATA_DIR})")
    if a.inbox:
        _p(f"   watching {a.inbox} for new footage")
    app.state.inbox = Path(a.inbox).expanduser() if a.inbox else None
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


def cmd_nightly(a):
    folder = Path(a.folder or config.DATA_DIR / "inbox").expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    added = worker.scan_inbox(folder)
    _p(f"Imported {len(added)} new clip(s) from {folder}")
    worker.drain()
    _summary()


def cmd_add(a):
    n = 0
    for f in a.files:
        if worker.add_file(Path(f).expanduser(), day_hint=a.day, move=not a.copy):
            n += 1
    _p(f"Queued {n} clip(s)")
    if not a.no_run:
        worker.drain()
        _summary()


def cmd_song(a):
    from .songs import set_song

    song = set_song(a.date, Path(a.file).expanduser(), start=a.start, name=a.name)
    _p(f"♪ {song['name']}: {song['bpm']:.0f} BPM, {len(song['beats'])} beats, drop at {song['drop']:.1f}s")
    if not a.no_run:
        worker.drain()


def cmd_plan(a):
    worker.enqueue("plan", day=a.date) if a.date != "trip" else worker.enqueue("film", day="trip")
    worker.drain()
    _summary()


def cmd_render(a):
    targets = [a.style] if a.style else (["film"] if a.date == "trip" else list(styles.STYLES))
    for sid in targets:
        worker.enqueue("stills" if sid == "photos" else "render", day=a.date, style=sid)
    worker.drain()
    _summary()


def cmd_ask(a):
    worker.enqueue("revise", day=a.date, style=a.style, request=a.request)
    worker.drain()
    _summary()


def cmd_retry(a):
    n = worker.retry_failed()
    _p(f"Retrying {n} clip(s)")
    worker.drain()
    _summary()


def cmd_treat(a):
    from . import treatment as tr

    if a.style in tr.PRESETS:
        worker.enqueue("treatment", day=a.date, preset=a.style, everywhere=a.all)
    elif a.style == "music-video":
        worker.enqueue("treatment", day=a.date, music_video=True, everywhere=a.all)
    else:
        worker.enqueue("treatment", day=a.date, describe=a.style, everywhere=a.all)
    worker.drain()
    _summary()


def cmd_doctor(a):
    """Check every part of the studio and say exactly what's wrong."""
    import shutil
    import subprocess

    import httpx

    from . import media, transcribe

    ok_all = True

    def line(ok, what, fix=""):
        nonlocal ok_all
        ok_all &= bool(ok) or ok is None
        mark = "✓" if ok else ("·" if ok is None else "✗")
        _p(f"  {mark} {what}" + (f"\n      → {fix}" if fix and ok is False else ""))

    _p("\nVideo engine")
    ff = shutil.which("ffmpeg")
    line(ff, f"ffmpeg: {ff or 'missing'}", "brew install ffmpeg")
    if ff:
        ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.split("\n")[0]
        _p(f"      {ver[:70]}")
        for f, why in (("lut3d", "colour grades"), ("overlay", "stickers, titles, captions and subtitles (drawn by the studio)"),
                       ("zscale", "iPhone HDR conversion (a simpler fallback is used without it)"),
                       ("loudnorm", "audio levels"), ("lenscorrection", "fisheye"), ("rgbashift", "RGB split")):
            line(media.has_filter(f) or (None if f == "zscale" else False), f"filter {f}: {why}",
                 "brew reinstall ffmpeg")
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        line("libx264" in enc, "H.264 encoder (libx264)", "brew reinstall ffmpeg")
        hw = subprocess.run(["ffmpeg", "-hide_banner", "-hwaccels"], capture_output=True, text=True).stdout
        line(("videotoolbox" in hw) if config.HWACCEL else None,
             f"hardware decoding: {config.HWACCEL or 'off'}", "set HWACCEL= in .env to turn it off if clips fail")

    _p("\nAnalysis")
    import cv2
    line(hasattr(cv2, "CascadeClassifier"), f"OpenCV {cv2.__version__} with face detection", "./setup-mac.sh")
    try:
        import pillow_heif  # noqa: F401
        line(True, "HEIC photos (pillow-heif)")
    except ImportError:
        line(bool(shutil.which("sips")) or False, "HEIC photos via macOS sips (pillow-heif missing)", "./setup-mac.sh")
    line(transcribe.available() or None, f"speech-to-text: {transcribe._pick() or 'not installed (edits work, no dialogue moments)'}",
         "./setup-mac.sh")

    _p("\nClaude (story planning, change requests, style research)")
    if not config.ANTHROPIC_KEY:
        line(False, "ANTHROPIC_API_KEY not set (a rule-based editor is used)", "open -e .env and paste the key")
    else:
        try:
            import anthropic

            anthropic.Anthropic(api_key=config.ANTHROPIC_KEY).models.retrieve(config.MODEL)
            line(True, f"API key works, model {config.MODEL}")
        except Exception as e:
            line(False, f"API key/model problem: {str(e)[:120]}", "check the key in .env and your credit at console.anthropic.com")

    _p("\nTrip + files")
    from . import trip as _trip
    line(bool(_trip.days()), f"itinerary: {len(_trip.days())} days from {config.TRIPS_DIR}", "run from inside the repo")
    du = shutil.disk_usage(config.DATA_DIR)
    line(du.free > 20e9, f"studio data: {config.DATA_DIR} ({du.free / 1e9:.0f} GB free)", "free up disk space (4K needs room)")
    inbox = Path(__import__("os").environ.get("STUDIO_INBOX", config.DATA_DIR / "inbox")).expanduser()
    waiting = [p for p in inbox.rglob("*") if p.is_file()] if inbox.exists() else []
    line(None, f"inbox: {inbox} ({len(waiting)} file(s) not picked up yet)")
    try:
        r = httpx.get("http://127.0.0.1:8787/healthz", timeout=2)
        line(r.status_code == 200, "studio running at http://localhost:8787")
    except httpx.HTTPError:
        line(False, "studio not running", "./studio serve   (and keep that window open)")

    _p("\nFootage")
    s = store.snapshot()
    counts = {}
    for c in s["clips"].values():
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    _p(f"  clips: {counts or 'none yet'} · shots: {len(s['shots'])}")
    by_day = {}
    for c in s["clips"].values():
        d = c.get("day") or c.get("day_guess") or c.get("day_hint") or "no date"
        by_day[d] = by_day.get(d, 0) + 1
    for d, n in sorted(by_day.items()):
        _p(f"    {d}: {n} file(s)")
    for c in [c for c in s["clips"].values() if c["status"] == "error"][:8]:
        line(False, f"{c['name']}: {(c.get('error') or '').strip().splitlines()[-1][:140] if c.get('error') else ''}",
             "./studio retry")
    q = [j for j in s["jobs"] if j["status"] in ("queued", "running")]
    _p(f"  queue: {len(q)} job(s)" + (f", running: {next((j['key'] for j in q if j['status'] == 'running'), '-')}" if q else ""))
    for d, v in sorted(s["days"].items()):
        for sid, r in v.get("renders", {}).items():
            if r.get("status") == "error":
                line(False, f"render {d} {sid}: {(r.get('error') or '').strip().splitlines()[-1][:140]}",
                     f"./studio render {d} {sid}")
    _p("\n" + ("All good." if ok_all else "Fix the ✗ items above (paste this output to Claude if unsure)."))


def cmd_status(a):
    _summary(verbose=True)


def cmd_looks(a):
    for k, (name, desc, _) in luts.LOOKS.items():
        _p(f"  {k:12s} {name:14s} {desc}")
        if a.out:
            luts.lut_path(k, Path(a.out).expanduser())
    if a.out:
        _p(f"\n.cube files written to {a.out} (load them in Palmier, Resolve, Premiere, CapCut…)")


def cmd_export(a):
    from .export import export_pack

    path = export_pack(a.date, a.style)
    _p(f"📦 {path}")


def _summary(verbose=False):
    s = store.snapshot()
    days = sorted({sh["day"] for sh in s["shots"].values()})
    if not days:
        _p("No footage yet.")
        return
    for d in days + (["trip"] if "trip" in s["days"] else []):
        info = trip.day(d) if d != "trip" else {"label": "Whole trip"}
        sd = s["days"].get(d, {})
        n = sum(1 for sh in s["shots"].values() if sh["day"] == d) if d != "trip" else len(s["shots"])
        _p(f"\n{d}  {info['label']}  ({n} shots)")
        for sid, r in sorted(sd.get("renders", {}).items()):
            mark = {"ready": "✓", "rendering": "…", "error": "✗"}.get(r.get("status"), "·")
            where = r.get("file") or (f"{len(r.get('stills', []))} stills" if r.get("stills") else "")
            _p(f"   {mark} {sid:10s} {where} {('— ' + r['error'].splitlines()[0]) if r.get('error') else ''}")
    if verbose:
        bad = [c for c in s["clips"].values() if c["status"] == "error"]
        for c in bad:
            _p(f"\n✗ {c['name']}: {c.get('error', '').splitlines()[0] if c.get('error') else ''}")
        q = [j for j in s["jobs"] if j["status"] in ("queued", "running")]
        if q:
            _p(f"\n{len(q)} job(s) waiting")


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(prog="reel", description="Reel Studio: nightly travel edits")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("serve")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--inbox", help="folder to watch for new footage")
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("nightly")
    p.add_argument("folder", nargs="?")
    p.set_defaults(fn=cmd_nightly)

    p = sub.add_parser("add")
    p.add_argument("files", nargs="+")
    p.add_argument("--day", help="YYYY-MM-DD if the camera date is wrong")
    p.add_argument("--copy", action="store_true", help="copy instead of moving the files")
    p.add_argument("--no-run", action="store_true")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("song")
    p.add_argument("date")
    p.add_argument("file")
    p.add_argument("--start", type=float, help="seconds into the song to start the edit")
    p.add_argument("--name")
    p.add_argument("--no-run", action="store_true")
    p.set_defaults(fn=cmd_song)

    for name, fn in (("plan", cmd_plan),):
        p = sub.add_parser(name)
        p.add_argument("date")
        p.set_defaults(fn=fn)

    p = sub.add_parser("render")
    p.add_argument("date")
    p.add_argument("style", nargs="?", choices=list(styles.STYLES) + ["film"])
    p.set_defaults(fn=cmd_render)

    p = sub.add_parser("ask")
    p.add_argument("date")
    p.add_argument("style", choices=list(styles.STYLES) + ["film"])
    p.add_argument("request")
    p.set_defaults(fn=cmd_ask)

    p = sub.add_parser("doctor")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("retry")
    p.set_defaults(fn=cmd_retry)

    p = sub.add_parser("treat")
    p.add_argument("date")
    p.add_argument("style", help="awge | super8 | noir | clean | music-video | 'edit like …'")
    p.add_argument("--all", action="store_true", help="use for every day")
    p.set_defaults(fn=cmd_treat)

    p = sub.add_parser("status")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("looks")
    p.add_argument("--out")
    p.set_defaults(fn=cmd_looks)

    p = sub.add_parser("export")
    p.add_argument("date")
    p.add_argument("style", choices=list(styles.STYLES) + ["film"])
    p.set_defaults(fn=cmd_export)

    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
