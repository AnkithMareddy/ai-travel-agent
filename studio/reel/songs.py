"""Per-day songs: an audio file (beat-synced edit) or just a name (approximate grid)."""
from __future__ import annotations

import shutil
from pathlib import Path

from . import config, music, store, styles, worker

AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".opus", ".mp4", ".mov"}


def set_song(day: str, file: Path, start: float | None = None, name: str | None = None, rerender=True) -> dict:
    if file.suffix.lower() not in AUDIO_EXT:
        raise ValueError(f"not an audio file: {file.name}")
    dest = config.path("songs", day, f"song{file.suffix.lower()}")
    for old in dest.parent.glob("song.*"):
        old.unlink()
    shutil.copyfile(file, dest)
    info = music.analyse(str(dest))
    song = {"name": name or file.stem, "file": config.rel(dest), **info}
    if start is not None:
        song["start"] = float(start)
    with store.edit() as s:
        d = store.day(s, day)
        d["song"] = song
        for p in d["plans"].values():
            p.pop("song_start", None)
    if rerender:
        _rerender(day)
    return song


def set_song_name(day: str, name: str, bpm: float | None = None) -> dict:
    """No audio file: we cut to a beat grid and you add the track in Instagram/TikTok."""
    with store.edit() as s:
        d = store.day(s, day)
        d["song"] = {"name": name, "file": None, "duration": 240.0}
        if bpm:
            d["song"].update(music.grid(float(bpm), 240.0))
    # The planner estimates the BPM if we don't know it.
    worker.enqueue(pri=True, kind="plan", day=day) if day != "trip" else _rerender(day)
    return d["song"]


def set_start(day: str, start: float | None, style: str | None = None) -> None:
    with store.edit() as s:
        d = store.day(s, day)
        if style:
            d["plans"].setdefault(style, {})["song_start"] = start
        elif d.get("song"):
            d["song"]["start"] = start
    _rerender(day, [style] if style else None)


def clear(day: str) -> None:
    with store.edit() as s:
        store.day(s, day)["song"] = None
    _rerender(day)


def _rerender(day: str, only: list[str] | None = None) -> None:
    if only:
        targets = only
    elif day == "trip":
        targets = ["film"]
    else:
        with store.edit() as s:
            planned = set(store.day(s, day)["plans"])
        targets = [k for k in styles.VIDEO_STYLES if k in planned]
    for sid in targets:
        worker.enqueue(pri=True, kind="render", day=day, style=sid)
