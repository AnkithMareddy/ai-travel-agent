"""Turn a raw camera file into a handful of scored, ready-to-edit shots.

1. Sample small frames (4 fps) and score each moment: sharpness, exposure, colour,
   motion, shake and faces.
2. Split on scene changes, then pick the best non-overlapping windows in each scene.
3. Cut each window (plus handles for trimming) into a mezzanine file: HDR tone-mapped
   to SDR, scaled, constant frame rate. Save a thumbnail.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

import cv2
import numpy as np

from . import config, media

SAMPLE_FPS = 4.0
SAMPLE_W = 320
SHOT_MIN, SHOT_MAX = 2.5, 6.0
HANDLE = 1.0  # extra seconds kept either side for trimming

_face = None


def _faces(gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    global _face
    if _face is None:
        try:
            _face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        except AttributeError:  # OpenCV builds without the Haar module
            _face = False
    if _face is False:
        return []
    found = _face.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(18, 18))
    return [tuple(map(int, f)) for f in found] if len(found) else []


def measure(path: str | Path, info: dict) -> dict:
    """Per-sample metrics arrays for the whole clip."""
    sharp, bright, sat, motion, color_hist, cx, faces = [], [], [], [], [], [], []
    prev = None
    for i, rgb in enumerate(media.frames(path, SAMPLE_FPS, SAMPLE_W)):
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        sharp.append(float(cv2.Laplacian(gray, cv2.CV_32F).var()))
        bright.append(float(gray.mean() / 255.0))
        sat.append(float(hsv[..., 1].mean() / 255.0))
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256]).ravel()
        color_hist.append(hist / (hist.sum() + 1e-9))
        small = cv2.resize(gray, (80, int(80 * gray.shape[0] / gray.shape[1]))).astype(np.float32)
        motion.append(float(np.abs(small - prev).mean() / 255.0) if prev is not None else 0.0)
        prev = small
        # Where's the subject (for 9:16 crops)? Faces first, else edge energy.
        f = _faces(gray) if i % 2 == 0 else []
        faces.append(len(f))
        if f:
            x, y, w, h = max(f, key=lambda r: r[2] * r[3])
            cx.append((x + w / 2) / gray.shape[1])
        else:
            edges = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0)) + np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1))
            col = edges.sum(0)
            cx.append(float((col * np.arange(len(col))).sum() / (col.sum() + 1e-9) / len(col)))
    n = len(sharp)
    if n == 0:
        raise media.FFmpegError("could not decode any frames")
    m = {
        "sharp": np.array(sharp), "bright": np.array(bright), "sat": np.array(sat),
        "motion": np.array(motion), "cx": np.array(cx), "faces": np.array(faces),
        "hist": np.array(color_hist), "n": n,
    }
    # Audio loudness per sample, to spot laughs, cheers and crowd moments.
    loud = np.zeros(n)
    if info.get("has_audio"):
        y = media.audio(path, 8000)
        if len(y):
            hop = int(8000 / SAMPLE_FPS)
            k = min(n, len(y) // hop)
            if k:
                frames = y[: k * hop].reshape(k, hop)
                loud[:k] = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-6)
    m["loud"] = loud
    return m


def scene_cuts(hist: np.ndarray, motion: np.ndarray) -> list[int]:
    if len(hist) < 2:
        return [0, len(hist)]
    d = np.array([0] + [cv2.compareHist(hist[i - 1].astype(np.float32), hist[i].astype(np.float32), cv2.HISTCMP_BHATTACHARYYA) for i in range(1, len(hist))])
    thr = max(0.35, np.median(d) + 4 * d.std())
    cuts = [0]
    for i in np.where(d > thr)[0]:
        if i - cuts[-1] >= SAMPLE_FPS * 1.5:
            cuts.append(int(i))
    cuts.append(len(hist))
    return cuts


def score_samples(m: dict) -> np.ndarray:
    """0..1 'how good does this moment look' per sample."""
    sharp = np.log1p(m["sharp"])
    sharp = (sharp - np.percentile(sharp, 10)) / (np.ptp(sharp) + 1e-9)
    expo = 1 - np.clip(np.abs(m["bright"] - 0.48) / 0.4, 0, 1)
    sat = np.clip(m["sat"] / 0.45, 0, 1)
    mot = m["motion"]
    # Some movement is good (life!), too much is a whip pan or a shaky mess.
    movement = np.clip(mot / 0.03, 0, 1) * (1 - np.clip((mot - 0.08) / 0.1, 0, 1))
    # Shake: frame-to-frame change in motion itself.
    jitter = np.abs(np.diff(mot, prepend=mot[:1]))
    steady = 1 - np.clip(jitter / 0.05, 0, 1)
    faces = np.clip(m["faces"], 0, 2) / 2
    loud = m["loud"]
    moment = np.clip((loud - np.median(loud)) / 15, 0, 1) if loud.any() else np.zeros_like(loud)
    s = (0.28 * np.clip(sharp, 0, 1) + 0.2 * expo + 0.14 * sat + 0.12 * movement
         + 0.12 * steady + 0.08 * faces + 0.06 * moment)
    return np.clip(s, 0, 1)


def pick_windows(m: dict, duration: float) -> list[dict]:
    score = score_samples(m)
    cuts = scene_cuts(m["hist"], m["motion"])
    budget = max(1, min(14, int(math.ceil(duration / 7))))
    cands = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        length = (b - a) / SAMPLE_FPS
        if length < 1.2:
            continue
        win = int(min(SHOT_MAX, max(SHOT_MIN, length * 0.6)) * SAMPLE_FPS)
        win = min(win, b - a)
        taken = []
        # Up to 3 windows per scene, best first, not overlapping.
        csum = np.concatenate([[0], np.cumsum(score[a:b])])
        means = (csum[win:] - csum[:-win]) / win if win <= b - a else np.array([score[a:b].mean()])
        order = np.argsort(-means)
        for o in order:
            s0 = a + int(o)
            if any(abs(s0 - t) < win for t in taken):
                continue
            taken.append(s0)
            seg = slice(s0, s0 + win)
            cands.append({
                "start": s0 / SAMPLE_FPS,
                "dur": win / SAMPLE_FPS,
                "score": float(means[o]),
                "scene": len([c for c in cuts if c <= a]) - 1,
                "motion": float(m["motion"][seg].mean()),
                "bright": float(m["bright"][seg].mean()),
                "sat": float(m["sat"][seg].mean()),
                "faces": int(m["faces"][seg].max()),
                "cx": float(np.median(m["cx"][seg])),
                "loud": float(m["loud"][seg].max()) if m["loud"].any() else -99.0,
            })
            if len(taken) >= 3 or len(taken) * win >= (b - a) * 0.7:
                break
    for c in cands:
        c["kind"] = "visual"
    cands.sort(key=lambda c: -c["score"])
    keep = cands[:budget]
    keep.sort(key=lambda c: c["start"])
    return keep


def add_speech(visual: list[dict], m: dict, speech: list[dict]) -> list[dict]:
    """Speech moments become their own shots; visual shots that would cut a line in half go."""
    score = score_samples(m)
    talk = []
    for w in speech:
        a = int(w["start"] * SAMPLE_FPS)
        b = max(a + 1, int((w["start"] + w["dur"]) * SAMPLE_FPS))
        seg = slice(a, min(b, m["n"]))
        if seg.start >= m["n"]:
            continue
        talk.append({
            "start": w["start"], "dur": w["dur"], "kind": "talk", "text": w["text"],
            "score": float(score[seg].mean()), "scene": -1,
            "motion": float(m["motion"][seg].mean()), "bright": float(m["bright"][seg].mean()),
            "sat": float(m["sat"][seg].mean()), "faces": int(m["faces"][seg].max()),
            "cx": float(np.median(m["cx"][seg])),
            "loud": float(m["loud"][seg].max()) if m["loud"].any() else -99.0,
        })

    def overlap(a, b):
        lo = max(a["start"], b["start"])
        hi = min(a["start"] + a["dur"], b["start"] + b["dur"])
        return max(0.0, hi - lo) / min(a["dur"], b["dur"])

    kept = [v for v in visual if not any(overlap(v, t) > 0.35 for t in talk)]
    out = kept + talk[:20]
    out.sort(key=lambda c: c["start"])
    return out


def _mezz_scale(info: dict) -> str:
    w, h = info["width"], info["height"]
    long_side = max(w, h)
    if long_side <= config.MEZZ_LONG_SIDE:
        return ""
    if w >= h:
        return f"scale={config.MEZZ_LONG_SIDE}:-2:flags=lanczos"
    return f"scale=-2:{config.MEZZ_LONG_SIDE}:flags=lanczos"


def extract(src: str | Path, info: dict, win: dict, out: Path, thumb: Path) -> dict:
    """Cut one window (with handles) into an edit-friendly mezzanine file."""
    start = max(0.0, win["start"] - HANDLE)
    end = min(info["duration"], win["start"] + win["dur"] + HANDLE)
    fps = min(60.0, info["fps"] or 30.0)
    chain = [c for c in [media.hdr_to_sdr(info), _mezz_scale(info), f"fps={fps:g}", "format=yuv420p"] if c]
    args = ["-ss", f"{start:.3f}", *media.hwaccel(), "-i", str(src), "-t", f"{end - start:.3f}",
            "-vf", ",".join(chain),
            "-c:v", "libx264", "-preset", "fast", "-crf", str(config.MEZZ_CRF),
            "-g", str(int(fps)), "-bf", "2",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    if info.get("has_audio"):
        args += ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]
    else:
        args += ["-an"]
    out.parent.mkdir(parents=True, exist_ok=True)
    media.ffmpeg(args + ["-movflags", "+faststart", str(out)])
    mid = (win["start"] - start) + win["dur"] / 2
    thumb.parent.mkdir(parents=True, exist_ok=True)
    media.ffmpeg(["-ss", f"{mid:.3f}", "-i", str(out), "-frames:v", "1",
                  "-vf", "scale=480:-2", "-q:v", "4", str(thumb)])
    got = media.describe(out)
    return {
        "in": round(win["start"] - start, 3),   # best part, relative to the shot file
        "out": round(win["start"] - start + win["dur"], 3),
        "length": round(got["duration"], 3),
        "fps": got["fps"],
        "width": got["width"],
        "height": got["height"],
        "has_audio": got["has_audio"],
    }


def shot_id(clip_id: str, start: float) -> str:
    return hashlib.sha1(f"{clip_id}:{start:.2f}".encode()).hexdigest()[:10]
