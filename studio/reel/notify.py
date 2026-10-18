"""Optional Telegram ping (through the trip bot's token) when a day's edits are ready."""
from __future__ import annotations

import logging

import httpx

from . import config, styles

log = logging.getLogger("reel.notify")


def day_ready(date: str, info: dict, ready: list[str]) -> None:
    if not (config.TELEGRAM_TOKEN and config.TELEGRAM_CHAT_ID):
        return
    names = ", ".join(styles.get(s)["name"] for s in ready if s in styles.STYLES)
    title = f"Day {info['number']} · {info['title']}" if info.get("number") else info["title"]
    text = f"🎬 {title} edits are ready: {names}."
    if config.PUBLIC_URL:
        text += f"\n{config.PUBLIC_URL}/#/day/{date}"
    try:
        httpx.post(f"https://api.telegram.org/bot{config.TELEGRAM_TOKEN}/sendMessage",
                   json={"chat_id": config.TELEGRAM_CHAT_ID, "text": text}, timeout=15)
    except httpx.HTTPError as e:
        log.warning("telegram notify failed: %s", e)
