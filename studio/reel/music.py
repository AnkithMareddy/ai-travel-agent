"""Song analysis: tempo, beat times, bar lines and where the energy hits (the drop).

Pure numpy: onset strength from spectral flux, tempo from the onset autocorrelation,
then dynamic-programming beat tracking (Ellis 2007), the same approach librosa uses.
"""
from __future__ import annotations

import numpy as np

from . import media

SR = 22050
HOP = 512
NFFT = 2048


def _onset_envelope(y: np.ndarray) -> np.ndarray:
    if len(y) < NFFT:
        y = np.pad(y, (0, NFFT - len(y)))
    n = 1 + (len(y) - NFFT) // HOP
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n)[:, None]
    win = np.hanning(NFFT).astype(np.float32)
    spec = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    # Log-compress and squash to ~64 bands so dense highs don't dominate.
    bands = np.array_split(np.log1p(100 * spec), 64, axis=1)
    logspec = np.stack([b.mean(1) for b in bands], 1)
    flux = np.maximum(0, np.diff(logspec, axis=0)).sum(1)
    flux = np.concatenate([[0], flux])
    # Remove slow trend, normalise.
    k = 16
    trend = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0, flux - trend)
    return env / (env.std() + 1e-9)


def _tempo(env: np.ndarray, fps: float, lo=70.0, hi=180.0) -> float:
    n = len(env)
    ac = np.correlate(env - env.mean(), env - env.mean(), mode="full")[n - 1:]
    lags = np.arange(len(ac))
    bpm = 60.0 * fps / np.maximum(lags, 1)
    ok = (bpm >= lo) & (bpm <= hi)
    # Log-normal preference around 120 BPM, like most pop/dance tracks.
    prior = np.exp(-0.5 * (np.log2(np.maximum(bpm, 1) / 120.0) / 0.9) ** 2)
    score = np.where(ok, ac * prior, -np.inf)
    lag = int(np.argmax(score))
    # Parabolic refinement for sub-frame accuracy.
    if 1 <= lag < len(ac) - 1:
        a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
        denom = a - 2 * b + c
        if denom != 0:
            lag = lag + 0.5 * (a - c) / denom
    return 60.0 * fps / lag


def _track(env: np.ndarray, fps: float, bpm: float, tightness=100.0) -> np.ndarray:
    period = 60.0 * fps / bpm
    n = len(env)
    score = env.astype(np.float64).copy()
    back = -np.ones(n, int)
    window = np.arange(-int(round(2 * period)), -int(round(period / 2)) + 1)
    txcost = -tightness * np.log(-window / period) ** 2
    for i in range(n):
        lo = i + window
        valid = lo >= 0
        if not valid.any():
            continue
        cand = score[lo[valid]] + txcost[valid]
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[i] += cand[j]
            back[i] = lo[valid][j]
    # Start from the best-scoring frame in the last period.
    tail = max(0, n - int(period))
    i = tail + int(np.argmax(score[tail:]))
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    beats = np.array(beats[::-1])
    # Trim weak beats at the edges (silence / fades).
    strong = env[beats] > 0.15 * np.median(env[beats] + 1e-9)
    if strong.any():
        first, last = np.argmax(strong), len(strong) - 1 - np.argmax(strong[::-1])
        beats = beats[first:last + 1]
    # Frame i is centred NFFT/2 samples after its start.
    return (beats + (NFFT / 2) / HOP) / fps


def analyse(path: str) -> dict:
    y = media.audio(path, SR)
    if len(y) < SR * 2:
        raise ValueError("song is too short or has no audio")
    duration = len(y) / SR
    fps = SR / HOP
    env = _onset_envelope(y)
    bpm = _tempo(env, fps)
    beats = _track(env, fps, bpm)
    if len(beats) > 8:
        # Least-squares period over all beats (frame quantisation makes single gaps jitter).
        k = np.arange(len(beats))
        bpm = 60.0 / float(np.polyfit(k, beats, 1)[0])

    # Energy (RMS, dB) per beat interval.
    edges = np.concatenate([beats, [duration]])
    rms = []
    for a, b in zip(edges[:-1], edges[1:]):
        seg = y[int(a * SR):max(int(b * SR), int(a * SR) + 1)]
        rms.append(float(np.sqrt(np.mean(seg ** 2)) + 1e-9))
    energy = 20 * np.log10(np.array(rms))

    # Downbeat phase: the phase (0-3) whose beats carry the most onset strength.
    onset_at = np.array([env[min(int(t * fps), len(env) - 1)] for t in beats])
    phase = int(np.argmax([onset_at[p::4].mean() if len(onset_at[p::4]) else 0 for p in range(4)]))
    bars = beats[phase::4]

    return {
        "duration": round(duration, 3),
        "bpm": round(float(bpm), 2),
        "beats": [round(float(b), 4) for b in beats],
        "bars": [round(float(b), 4) for b in bars],
        "energy": [round(float(e), 2) for e in energy],
        "drop": round(find_drop(beats, energy, bars), 3),
    }


def find_drop(beats, energy, bars) -> float:
    """Time of the biggest sustained jump in loudness, snapped to a bar line."""
    beats = np.asarray(beats)
    e = np.asarray(energy)
    if len(e) < 24:
        return float(beats[0]) if len(beats) else 0.0
    k = 8
    sm = np.convolve(e, np.ones(k) / k, mode="same")
    rise = np.full(len(sm), -np.inf)
    rise[k:-k] = sm[2 * k:] - sm[:-2 * k]
    # Prefer drops after the intro (first 10% of the song) and before the outro.
    lo, hi = int(len(e) * 0.1), int(len(e) * 0.85)
    i = lo + int(np.argmax(rise[lo:hi])) if hi > lo else int(np.argmax(rise))
    # Refine: the single beat inside that window where loudness steps up most.
    a, b = max(1, i - k), min(len(e) - 2, i + k)
    after = np.array([e[j:j + 2].mean() for j in range(a, b + 1)])
    before = np.array([e[max(0, j - 2):j].mean() for j in range(a, b + 1)])
    i = a + int(np.argmax(after - before))
    return float(beats[min(i, len(beats) - 1)])


def grid(bpm: float, duration: float, offset: float = 0.0) -> dict:
    """A beat grid for a song we only know the tempo of (song name, no file)."""
    period = 60.0 / bpm
    beats = np.arange(offset, duration, period)
    return {
        "duration": duration,
        "bpm": bpm,
        "beats": [round(float(b), 4) for b in beats],
        "bars": [round(float(b), 4) for b in beats[::4]],
        "energy": [0.0] * len(beats),
        "drop": 0.0,
        "grid_only": True,
    }


def default_start(song: dict, target: float, prefer: str = "drop") -> float:
    """Where in the song a `target`-second edit should start.

    Short edits start one bar before the drop, so the cut lands on the hit. Long
    edits start at the top so the song has room to build.
    """
    bars = song.get("bars") or [0.0]
    if prefer == "top" or target > song["duration"] * 0.6 or not song.get("drop"):
        return float(bars[0]) if bars[0] < 8 else 0.0
    drop = song["drop"]
    before = [b for b in bars if b < drop]
    start = before[-1] if before else drop
    if start + target > song["duration"]:
        start = max(0.0, song["duration"] - target - 1)
        start = max([b for b in bars if b <= start] or [0.0])
    return float(start)
