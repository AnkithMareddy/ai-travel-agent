"""Photos as edit material: iPhone HEIC/JPEG stills become 'photo' shots.

A photo shot can be used three ways (the director picks per photo, or you do in the editor):
  full     its own cut, with a slow push-in
  flash    a few frames each, fired in bursts on the beat
  overlay  a white-bordered sticker that pops in over the video cut before it
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
import numpy as np

from . import config

PHOTO_EXT = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp"}
MAX_SIDE = 3200


def _open(src: Path):
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    try:
        img = Image.open(src)
        img.load()
    except (UnidentifiedImageError, OSError):
        # No HEIC support in Python: let macOS convert it (sips keeps the EXIF capture time).
        if src.suffix.lower() not in (".heic", ".heif") or not shutil.which("sips"):
            raise
        tmp = Path(tempfile.mkdtemp()) / (src.stem + ".jpg")
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "95", str(src), "--out", str(tmp)],
                       check=True, capture_output=True)
        img = Image.open(tmp)
        img.load()
        shutil.rmtree(tmp.parent, ignore_errors=True)
    exif = img.getexif()
    img = ImageOps.exif_transpose(img).convert("RGB")
    return img, exif


def _taken(exif, src: Path) -> str | None:
    tz = ZoneInfo(config.TIMEZONE)
    raw = None
    try:
        raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)  # DateTimeOriginal, else DateTime
        offset = exif.get_ifd(0x8769).get(36881)  # OffsetTimeOriginal, e.g. '+01:00'
    except Exception:
        offset = None
    if raw:
        try:
            dt = datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
            if offset:
                dt = datetime.fromisoformat(dt.isoformat() + str(offset).strip())
                return dt.astimezone(tz).isoformat()
            return dt.replace(tzinfo=tz).isoformat()  # phone clock = local time
        except ValueError:
            pass
    return None


def ingest(src: Path, out: Path, thumb: Path) -> dict:
    """Normalise one photo to an upright JPEG and score it like a video moment."""
    img, exif = _open(src)
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "JPEG", quality=92)
    t = img.copy()
    t.thumbnail((480, 480))
    thumb.parent.mkdir(parents=True, exist_ok=True)
    t.save(thumb, "JPEG", quality=82)

    rgb = np.asarray(img.resize((320, max(1, int(320 * img.height / img.width)))))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    sharp = float(cv2.Laplacian(gray, cv2.CV_32F).var())
    bright = float(gray.mean() / 255)
    sat = float(hsv[..., 1].mean() / 255)
    faces, cx = 0, 0.5
    try:
        det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        found = det.detectMultiScale(gray, 1.15, 5, minSize=(18, 18))
        if len(found):
            faces = len(found)
            x, y, w, h = max(found, key=lambda r: r[2] * r[3])
            cx = (x + w / 2) / gray.shape[1]
    except AttributeError:
        pass
    score = (0.35 * min(1.0, np.log1p(sharp) / 7) + 0.25 * (1 - min(abs(bright - 0.48) / 0.4, 1))
             + 0.2 * min(sat / 0.45, 1) + 0.2 * min(faces, 2) / 2)
    return {
        "kind": "photo", "width": img.width, "height": img.height, "fps": 30.0, "length": 600.0,
        "in": 0.0, "out": 4.0, "has_audio": False, "score": round(float(score), 4), "motion": 0.0,
        "bright": round(bright, 4), "sat": round(sat, 4), "faces": int(faces), "cx": round(float(cx), 4),
        "loud": -99.0, "captured_at": _taken(exif, src),
    }
