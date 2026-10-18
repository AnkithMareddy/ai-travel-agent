"""Speech-to-text for each clip, so the editor knows what was said and never cuts a line in half.

Runs locally. Uses mlx-whisper on Apple Silicon (fastest), else faster-whisper, else skips.
Install one of them: `pip install mlx-whisper` (Mac) or `pip install faster-whisper`.
"""
from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from . import media

log = logging.getLogger("reel.transcribe")
MODEL = os.environ.get("WHISPER_MODEL", "small")
_backend = None


def _pick():
    global _backend
    if _backend is not None:
        return _backend
    try:
        import mlx_whisper  # noqa: F401

        _backend = "mlx"
    except Exception:
        try:
            import faster_whisper  # noqa: F401

            _backend = "faster"
        except Exception:
            _backend = ""
    if not _backend:
        log.info("no whisper backend installed: skipping transcription")
    return _backend


def available() -> bool:
    return bool(_pick()) and os.environ.get("TRANSCRIBE", "1") != "0"


def transcribe(path: str | Path) -> list[dict]:
    """[{start, end, text}] in clip seconds. Empty if no speech or no backend."""
    if not available():
        return []
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "a.wav"
        try:
            media.ffmpeg(["-i", str(path), "-vn", "-ac", "1", "-ar", "16000", str(wav)])
        except media.FFmpegError:
            return []
        try:
            if _backend == "mlx":
                import mlx_whisper

                repo = MODEL if "/" in MODEL else f"mlx-community/whisper-{MODEL}-mlx"
                out = mlx_whisper.transcribe(str(wav), path_or_hf_repo=repo, condition_on_previous_text=False)
                segs = out.get("segments", [])
                rows = [(s["start"], s["end"], s["text"], s.get("no_speech_prob", 0)) for s in segs]
            else:
                from faster_whisper import WhisperModel

                global _fw
                try:
                    _fw
                except NameError:
                    _fw = WhisperModel(MODEL, device="auto", compute_type="int8")
                segs, _ = _fw.transcribe(str(wav), vad_filter=True, condition_on_previous_text=False)
                rows = [(s.start, s.end, s.text, s.no_speech_prob) for s in segs]
        except Exception as e:
            log.warning("transcription failed for %s: %s", Path(path).name, e)
            return []
    lines = []
    for start, end, text, nsp in rows:
        text = text.strip()
        # Whisper hallucinates on wind/music: drop low-confidence and stock phrases.
        if not text or nsp > 0.6 or text.lower() in {"you", "thank you.", "thanks for watching!", "bye."}:
            continue
        lines.append({"start": round(float(start), 2), "end": round(float(end), 2), "text": text})
    return lines


def speech_windows(lines: list[dict], duration: float, min_len=2.5, max_len=24.0, gap=1.2) -> list[dict]:
    """Group transcript lines into self-contained moments (a joke, a reaction, a story)."""
    groups, cur = [], None
    for ln in lines:
        if cur and ln["start"] - cur["end"] <= gap and ln["end"] - cur["start"] <= max_len:
            cur["end"] = ln["end"]
            cur["text"] += " " + ln["text"]
        else:
            if cur:
                groups.append(cur)
            cur = dict(ln)
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        # Breathing room: half a second before, a beat after the last word.
        start = max(0.0, g["start"] - 0.4)
        end = min(duration, g["end"] + 0.6)
        if end - start >= min_len or len(g["text"].split()) >= 4:
            out.append({"start": start, "dur": end - start, "text": g["text"], "words": len(g["text"].split())})
    return out
