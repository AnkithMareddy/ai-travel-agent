"""Reel Studio web app: watch the edits, pick songs, write notes, ask for changes, upload."""
from __future__ import annotations

import hashlib
import hmac
import json
import shutil
import tempfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from . import config, luts, songs, store, styles, trip, worker
from . import treatment as tr

WEB = config.STUDIO_DIR / "web"
app = FastAPI(title="Reel Studio")
app.state.inbox = None


# ---------------------------------------------------------------- auth

def _token() -> str:
    return hmac.new(config.SECRET.encode(), b"reel-studio", hashlib.sha256).hexdigest()


@app.middleware("http")
async def auth(request: Request, call_next):
    if config.PASSWORD and not request.url.path.startswith(("/login", "/api/login", "/static/", "/healthz")):
        if not hmac.compare_digest(request.cookies.get("reel", ""), _token()):
            if request.url.path.startswith(("/api/", "/media/")):
                return JSONResponse({"error": "login"}, status_code=401)
            return FileResponse(WEB / "login.html")
    return await call_next(request)


@app.post("/api/login")
async def login(request: Request):
    body = await request.json()
    if not hmac.compare_digest(str(body.get("password", "")), config.PASSWORD):
        raise HTTPException(401, "wrong password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie("reel", _token(), max_age=60 * 60 * 24 * 60, httponly=True, samesite="lax")
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------------------------------------------------------------- lifecycle

@app.on_event("startup")
def _startup():
    worker.start()
    if app.state.inbox:
        threading.Thread(target=_watch_inbox, args=(Path(app.state.inbox),), daemon=True).start()


inbox_state = {"arriving": 0, "bytes": 0}


def _watch_inbox(folder: Path):
    """Pick up files dropped into the inbox folder once they've finished copying."""
    folder.mkdir(parents=True, exist_ok=True)
    sizes: dict[Path, int] = {}
    while True:
        found = [p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in worker.MEDIA_EXT
                 and not p.name.startswith("._") and p.suffix.lower() != ".lrv"]
        inbox_state.update(arriving=len(found), bytes=sum(p.stat().st_size for p in found))
        for p in found:
            size = p.stat().st_size
            if sizes.get(p) == size and size > 0:
                worker.add_file(p)
                sizes.pop(p, None)
            else:
                sizes[p] = size
        time.sleep(5)


# ---------------------------------------------------------------- helpers

def _url(rel: str | None) -> str | None:
    if not rel:
        return None
    f = config.abs_(rel)
    v = int(f.stat().st_mtime) if f.exists() else 0
    return f"/media/{rel}?v={v}"


def _shot_view(s: dict) -> dict:
    return {
        "id": s["id"], "thumb": _url(s.get("thumb")), "video": _url(s.get("path")),
        "time": (s.get("captured_at") or "")[11:16], "place": s.get("place") or "",
        "said": s.get("said") or "", "kind": s.get("kind", "visual"), "hidden": bool(s.get("hidden")),
        "score": s.get("score", 0), "camera": s.get("device"), "secs": round(s["out"] - s["in"], 1),
        "portrait": s["height"] > s["width"], "day": s["day"], "photo": s.get("kind") == "photo",
    }


def _render_view(r: dict | None) -> dict:
    r = r or {}
    out = {k: r.get(k) for k in ("status", "error", "duration", "cuts", "look", "song_start", "version",
                                 "updated", "chapters", "description", "timeline")}
    out["video"] = _url(r.get("file"))
    out["natsound"] = _url(r.get("silent"))
    out["srt"] = _url(r.get("srt"))
    out["stills"] = [_url(x) for x in r.get("stills", [])] if r.get("stills") else None
    return out


def _queue(snap: dict, day: str | None = None) -> dict:
    jobs = [j for j in snap["jobs"] if j["status"] in ("queued", "running")]
    if day:
        jobs = [j for j in jobs if j["args"].get("day") == day or (j["kind"] == "ingest")]
    return {
        "current": worker.status["current"], "progress": round(worker.status["progress"], 3),
        "jobs": [{"kind": j["kind"], "status": j["status"], **{k: v for k, v in j["args"].items() if k != "request"}}
                 for j in jobs],
    }


def _disk() -> dict:
    used = sum(f.stat().st_size for f in config.DATA_DIR.rglob("*") if f.is_file())
    free = shutil.disk_usage(config.DATA_DIR).free
    return {"used": used, "free": free}


def _style_list() -> list[dict]:
    out = []
    for sid, st in styles.STYLES.items():
        out.append({"id": sid, "name": st["name"], "blurb": st["blurb"], "platform": st.get("platform"),
                    "aspect": st["aspect"], "still": bool(st.get("still")), "auto": st.get("auto", False)})
    return out


def _check_day(date: str) -> str:
    if date != "trip" and not (len(date) == 10 and date[4] == "-" and date[7] == "-"):
        raise HTTPException(404, "no such day")
    return date


# ---------------------------------------------------------------- read

@app.get("/api/overview")
def overview():
    snap = store.snapshot()
    shot_days: dict[str, list] = {}
    for s in snap["shots"].values():
        shot_days.setdefault(s["day"], []).append(s)
    dates = sorted(set(trip.days()) | set(shot_days))
    days = []
    for d in dates:
        info = trip.day(d)
        sd = snap["days"].get(d, {})
        sh = shot_days.get(d, [])
        cover = max(sh, key=lambda s: s.get("score", 0)) if sh else None
        clips = [c for c in snap["clips"].values() if (c.get("day") or c.get("day_guess") or c.get("day_hint")) == d]
        waiting = sum(1 for c in clips if c["status"] in ("queued", "analysing"))
        days.append({
            **{k: info[k] for k in ("date", "number", "label", "title", "region")},
            "shots": len(sh), "clips": len(clips), "waiting": waiting, "cover": _url(cover["thumb"]) if cover else None,
            "story": sd.get("story", ""), "song": (sd.get("song") or {}).get("name"),
            "renders": {k: v.get("status") for k, v in sd.get("renders", {}).items()},
        })
    film = snap["days"].get("trip", {})
    pending = [c for c in snap["clips"].values() if c["status"] in ("queued", "analysing")]
    failed = [{"name": c["name"], "error": (c.get("error") or "").splitlines()[0] if c.get("error") else ""}
              for c in snap["clips"].values() if c["status"] == "error"]
    return {
        "trip": trip.trip_name(), "days": days, "styles": _style_list(),
        "looks": [{"id": k, "name": v[0], "blurb": v[1]} for k, v in luts.LOOKS.items()],
        "film": {"render": _render_view(film.get("renders", {}).get("film")), "song": (film.get("song") or {}).get("name"),
                 "shots": len(snap["shots"])},
        "queue": _queue(snap), "pending": len(pending), "failed": failed, "disk": _disk(),
        "processing": {
            "total": len(snap["clips"]), "done": sum(1 for c in snap["clips"].values() if c["status"] == "ready"),
            "now": next((c["name"] for c in snap["clips"].values() if c["status"] == "analysing"), None),
            "arriving": inbox_state["arriving"], "arriving_bytes": inbox_state["bytes"],
            "undated": sum(1 for c in snap["clips"].values()
                           if not (c.get("day") or c.get("day_guess") or c.get("day_hint")) and c["status"] != "error"),
        },
        "ai": bool(config.ANTHROPIC_KEY), "inbox": str(app.state.inbox or ""),
    }


@app.get("/api/day/{date}")
def day_detail(date: str):
    _check_day(date)
    snap = store.snapshot()
    sd = store.day(snap, date)
    info = trip.day(date) if date != "trip" else {"date": "trip", "number": None, "label": "The whole trip",
                                                 "title": trip.trip_name(), "region": "ireland", "stops": [], "flow": ""}
    shots = store.day_shots(snap, date, include_hidden=True)
    plans = {}
    for sid, p in sd["plans"].items():
        plans[sid] = {**{k: v for k, v in p.items() if k != "shots"},
                      "shots": [e for e in p.get("shots", []) if e["id"] in shots]}
    song = sd.get("song")
    return {
        "info": {k: info.get(k) for k in ("date", "number", "label", "title", "region", "flow")},
        "story": sd.get("story", ""), "notes": sd.get("notes", ""),
        "song": ({k: song.get(k) for k in ("name", "bpm", "duration", "drop", "start")} | {"url": _url(song.get("file"))}) if song else None,
        "plans": plans,
        "renders": {k: _render_view(v) for k, v in sd["renders"].items()},
        "posts": sd.get("social", {}),
        "exports": {k: _url(v) for k, v in sd.get("exports", {}).items()},
        "treatment": worker.treatment_for(snap, date),
        "treatment_own": sd.get("treatment") is not None,
        "treatment_status": sd.get("treatment_status"),
        "presets": [{"id": k, "name": v["name"], "summary": v["summary"]} for k, v in tr.PRESETS.items()],
        "requests": sd.get("requests", [])[-20:],
        "shots": sorted((_shot_view(s) for s in shots.values()), key=lambda x: (x["day"], x["time"], x["id"])),
        "queue": _queue(snap, date),
    }


@app.get("/media/{rel:path}")
def media_file(rel: str):
    f = (config.DATA_DIR / rel).resolve()
    if config.DATA_DIR not in f.parents or not f.is_file():
        raise HTTPException(404)
    headers = {"Cache-Control": "private, max-age=3600"}
    if f.suffix in (".mp4", ".zip", ".srt", ".jpg") and "download" in rel:
        headers["Content-Disposition"] = f'attachment; filename="{f.name}"'
    return FileResponse(f, headers=headers)


@app.get("/download/{rel:path}")
def download(rel: str, name: str | None = None):
    f = (config.DATA_DIR / rel).resolve()
    if config.DATA_DIR not in f.parents or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, filename=name or f.name)


# ---------------------------------------------------------------- write

@app.post("/api/day/{date}/notes")
async def set_notes(date: str, request: Request):
    _check_day(date)
    body = await request.json()
    with store.edit() as s:
        store.day(s, date)["notes"] = str(body.get("notes", ""))[:4000]
    if body.get("replan"):
        worker.enqueue(pri=True, kind="plan", day=date) if date != "trip" else worker.enqueue(pri=True, kind="film", day="trip")
    return {"ok": True}


@app.post("/api/day/{date}/song")
async def upload_song(date: str, file: UploadFile = File(...), start: str = Form(""), name: str = Form("")):
    _check_day(date)
    suffix = Path(file.filename or "song.mp3").suffix.lower() or ".mp3"
    if suffix not in songs.AUDIO_EXT:
        raise HTTPException(400, "upload an audio file (mp3, m4a, wav…)")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=config.path("tmp", "x").parent) as tmp:
        shutil.copyfileobj(file.file, tmp)
    try:
        song = songs.set_song(date, Path(tmp.name), start=float(start) if start else None,
                              name=name or Path(file.filename or "song").stem)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    return {"name": song["name"], "bpm": song["bpm"], "drop": song["drop"], "duration": song["duration"]}


@app.post("/api/day/{date}/song-name")
async def song_name(date: str, request: Request):
    _check_day(date)
    body = await request.json()
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name required")
    bpm = float(body["bpm"]) if body.get("bpm") else None
    songs.set_song_name(date, name, bpm)
    return {"ok": True}


@app.post("/api/day/{date}/song-start")
async def song_start(date: str, request: Request):
    _check_day(date)
    body = await request.json()
    start = body.get("start")
    songs.set_start(date, float(start) if start not in (None, "") else None, body.get("style"))
    return {"ok": True}


@app.delete("/api/day/{date}/song")
def delete_song(date: str):
    _check_day(date)
    songs.clear(date)
    return {"ok": True}


@app.post("/api/day/{date}/treatment")
async def treatment(date: str, request: Request):
    _check_day(date)
    body = await request.json()
    preset = body.get("preset")
    describe = str(body.get("describe") or "").strip()[:300]
    music_video = bool(body.get("music_video"))
    if preset and preset not in tr.PRESETS:
        raise HTTPException(400, "unknown preset")
    if not (preset or describe or music_video):
        raise HTTPException(400, "pick a preset or describe a style")
    if (describe or music_video) and not config.ANTHROPIC_KEY:
        raise HTTPException(400, "researching a style needs ANTHROPIC_API_KEY in .env")
    if music_video and not (store.snapshot()["days"].get(date, {}).get("song") or {}).get("name"):
        raise HTTPException(400, "set today's song first")
    with store.edit() as s:
        store.day(s, date)["treatment_status"] = "queued"
    worker.enqueue(pri=True, kind="treatment", day=date, preset=preset, describe=describe or None,
                   music_video=music_video, everywhere=bool(body.get("everywhere")))
    return {"ok": True}


@app.post("/api/day/{date}/ask")
async def ask(date: str, request: Request):
    _check_day(date)
    body = await request.json()
    style = body.get("style")
    text = str(body.get("text", "")).strip()
    if style not in styles.STYLES and style != "film":
        raise HTTPException(400, "unknown style")
    if not text:
        raise HTTPException(400, "say what to change")
    rid = hashlib.sha1(f"{time.time()}{text}".encode()).hexdigest()[:8]
    with store.edit() as s:
        store.day(s, date)["requests"].append({"id": rid, "style": style, "text": text, "at": store.now(), "status": "queued"})
    worker.enqueue(pri=True, kind="revise", day=date, style=style, request=text, req_id=rid)
    return {"ok": True, "id": rid}


@app.post("/api/day/{date}/plan/{style}")
async def save_plan(date: str, style: str, request: Request):
    """Manual edit from the timeline editor."""
    _check_day(date)
    if style not in styles.STYLES and style != "film":
        raise HTTPException(400, "unknown style")
    body = await request.json()
    allowed = {"title", "subtitle", "hook", "end_card", "look", "duration", "grade_strength", "pacing", "song_start"}
    entry_keys = {"id", "role", "dialogue", "use", "beats", "speed", "caption", "chapter", "flash", "crop_x", "fit",
                  "photo_mode"}
    with store.edit() as s:
        sd = store.day(s, date)
        plan = sd["plans"].setdefault(style, {"shots": []})
        for k, v in body.items():
            if k in allowed:
                if v in (None, ""):
                    plan.pop(k, None)
                else:
                    plan[k] = v
        if "shots" in body:
            plan["shots"] = [{k: v for k, v in e.items() if k in entry_keys and v not in (None, "")}
                             for e in body["shots"] if e.get("id") in s["shots"]]
        plan["manual"] = True
        plan["by"] = "you"
    kind = "stills" if styles.get(style).get("still") else "render"
    worker.enqueue(pri=True, kind=kind if style != "film" else "render", day=date, style=style)
    return {"ok": True}


@app.post("/api/day/{date}/replan")
async def replan(date: str, request: Request):
    _check_day(date)
    body = await request.json() if (await request.body()) else {}
    style = body.get("style")
    if date == "trip":
        with store.edit() as s:
            store.day(s, "trip")["plans"].pop("film", None)
        worker.enqueue(pri=True, kind="film", day="trip")
    else:
        worker.enqueue(pri=True, kind="plan", day=date, styles_only=[style] if style else None, keep_manual=False)
    return {"ok": True}


@app.post("/api/day/{date}/render/{style}")
def rerender(date: str, style: str):
    _check_day(date)
    worker.enqueue(pri=True, kind="stills" if style == "photos" else "render", day=date, style=style)
    return {"ok": True}


@app.post("/api/day/{date}/export/{style}")
def export(date: str, style: str):
    _check_day(date)
    worker.enqueue(pri=True, kind="export", day=date, style=style)
    return {"ok": True}


@app.post("/api/shot/{sid}")
async def shot_update(sid: str, request: Request):
    body = await request.json()
    with store.edit() as s:
        if sid not in s["shots"]:
            raise HTTPException(404)
        if "hidden" in body:
            s["shots"][sid]["hidden"] = bool(body["hidden"])
    return {"ok": True}


# ---------------------------------------------------------------- resumable upload

def _upload_dir() -> Path:
    return config.path("uploads", "x").parent


@app.post("/api/upload/init")
async def upload_init(request: Request):
    body = await request.json()
    name = Path(str(body.get("name", "clip.mp4"))).name
    size = int(body.get("size", 0))
    if Path(name).suffix.lower() not in worker.MEDIA_EXT:
        raise HTTPException(400, f"{name} isn't a video or photo")
    uid = hashlib.sha1(f"{name}:{size}:{body.get('lastModified', '')}".encode()).hexdigest()[:16]
    part = _upload_dir() / f"{uid}.part"
    meta = _upload_dir() / f"{uid}.json"
    if not meta.exists():
        meta.write_text(json.dumps({"name": name, "size": size, "day": body.get("day") or "auto"}))
    have = part.stat().st_size if part.exists() else 0
    return {"id": uid, "offset": have, "done": False}


@app.put("/api/upload/{uid}")
async def upload_chunk(uid: str, request: Request, offset: int = 0):
    if not uid.isalnum():
        raise HTTPException(400)
    part = _upload_dir() / f"{uid}.part"
    meta_f = _upload_dir() / f"{uid}.json"
    if not meta_f.exists():
        raise HTTPException(404, "start the upload first")
    meta = json.loads(meta_f.read_text())
    have = part.stat().st_size if part.exists() else 0
    if offset != have:
        return JSONResponse({"offset": have}, status_code=409)
    with part.open("ab") as f:
        async for chunk in request.stream():
            f.write(chunk)
    have = part.stat().st_size
    if have >= meta["size"]:
        final = _upload_dir() / uid / meta["name"]
        final.parent.mkdir(parents=True, exist_ok=True)
        part.replace(final)
        meta_f.unlink(missing_ok=True)
        cid = worker.add_file(final, day_hint=None if meta["day"] == "auto" else meta["day"])
        shutil.rmtree(final.parent, ignore_errors=True)
        return {"offset": have, "done": True, "clip": cid, "duplicate": cid is None}
    return {"offset": have, "done": False}


@app.get("/api/clips")
def clips():
    snap = store.snapshot()
    rows = sorted(snap["clips"].values(), key=lambda c: -c.get("added", 0))[:200]
    return [{"name": c["name"], "status": c["status"], "day": c.get("day") or c.get("day_hint"),
             "shots": len(c.get("shots", [])), "error": (c.get("error") or "").splitlines()[0] if c.get("error") else ""}
            for c in rows]


@app.post("/api/retry")
def retry():
    return {"retried": worker.retry_failed()}


# ---------------------------------------------------------------- static

@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/static/{name}")
def static(name: str):
    f = (WEB / name).resolve()
    if WEB not in f.parents or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "no-cache"})


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)
