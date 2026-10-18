"""All studio state in one JSON file on disk (clips, shots, days, plans, renders, jobs).

Small enough to keep in memory; every change is written atomically.
"""
from __future__ import annotations

import json
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from . import config

_lock = threading.RLock()
_state: dict | None = None


def _file() -> Path:
    return config.path("state.json")


def _empty() -> dict:
    return {"clips": {}, "shots": {}, "days": {}, "jobs": [], "version": 1}


def load() -> dict:
    global _state
    with _lock:
        if _state is None:
            f = _file()
            _state = json.loads(f.read_text()) if f.exists() else _empty()
            for k, v in _empty().items():
                _state.setdefault(k, v)
        return _state


def save() -> None:
    with _lock:
        f = _file()
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(_state, indent=1, sort_keys=True))
        tmp.replace(f)


@contextmanager
def edit():
    """with store.edit() as s: ... mutate s ...  (saved on exit)"""
    with _lock:
        s = load()
        yield s
        save()


def snapshot() -> dict:
    with _lock:
        return json.loads(json.dumps(load()))


def day(s: dict, date: str) -> dict:
    d = s["days"].setdefault(date, {})
    d.setdefault("plans", {})
    d.setdefault("renders", {})
    d.setdefault("requests", [])
    d.setdefault("song", None)
    d.setdefault("notes", "")
    d.setdefault("social", {})
    return d


def day_shots(s: dict, date: str, include_hidden=False) -> dict:
    if date == "trip":
        return {k: v for k, v in s["shots"].items() if include_hidden or not v.get("hidden")}
    return {k: v for k, v in s["shots"].items()
            if v["day"] == date and (include_hidden or not v.get("hidden"))}


def now() -> float:
    return round(time.time(), 3)
