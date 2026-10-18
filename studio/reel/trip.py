"""What the trip planner knows about each day: the label, where we were and when."""
from __future__ import annotations

import json
from datetime import datetime
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def _load() -> dict:
    days: dict[str, dict] = {}
    for folder in sorted(config.TRIPS_DIR.glob("*/itinerary.json")):
        region = folder.parent.name
        data = json.loads(folder.read_text())
        for date, d in (data.get("days") or {}).items():
            entry = days.setdefault(date, {"date": date, "labels": [], "regions": [], "stops": []})
            if d.get("label"):
                entry["labels"].append(d["label"])
            entry["regions"].append(region)
            if d.get("flow"):
                entry.setdefault("flow", d["flow"])
        for p in data.get("plans") or []:
            start = p.get("start")
            if not start:
                continue
            date = start[:10]
            entry = days.setdefault(date, {"date": date, "labels": [], "regions": [region], "stops": []})
            loc = p.get("location") or {}
            entry["stops"].append({
                "title": p.get("title", ""),
                "place": loc.get("name") or p.get("title", ""),
                "start": start,
                "end": p.get("end") or start,
                "region": region,
            })
    for d in days.values():
        d["stops"].sort(key=lambda s: s["start"])
    return days


def days() -> list[str]:
    return sorted(_load())


def day(date: str) -> dict:
    d = _load().get(date) or {"date": date, "labels": [], "regions": [], "stops": []}
    all_days = days()
    label = " / ".join(d["labels"]) if d["labels"] else datetime.fromisoformat(date).strftime("%a %-d %b")
    title = label.split(":", 1)[1].strip() if ":" in label else label
    region = d["regions"][-1] if d["regions"] else "ireland"
    return {
        "date": date,
        "number": all_days.index(date) + 1 if date in all_days else None,
        "label": label,
        "title": title,
        "region": region,
        "flow": d.get("flow", ""),
        "stops": d["stops"],
    }


def place_at(when_iso: str | None) -> str:
    """The itinerary stop we were at (or heading to) at a given time."""
    if not when_iso:
        return ""
    when = datetime.fromisoformat(when_iso)
    stops = _load().get(when_iso[:10], {}).get("stops", [])
    best, gap = "", 1e9
    for s in stops:
        a, b = datetime.fromisoformat(s["start"]), datetime.fromisoformat(s["end"])
        if a <= when <= b:
            return s["place"]
        g = min(abs((when - a).total_seconds()), abs((when - b).total_seconds()))
        if g < gap and g < 90 * 60:
            best, gap = s["place"], g
    return best


def trip_name() -> str:
    regions = {d["regions"][-1] for d in _load().values() if d["regions"]}
    if regions == {"ireland", "london"}:
        return "Ireland & London"
    return next(iter(regions), "Trip").title()
