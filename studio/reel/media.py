"""ffprobe/ffmpeg helpers: what a file is, when it was shot, and running ffmpeg."""
from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from . import config


class FFmpegError(RuntimeError):
    pass


def run(cmd: list[str], timeout: float | None = None) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-12:])
        raise FFmpegError(f"{Path(cmd[0]).name} failed ({proc.returncode}):\n{tail}")
    return proc.stdout


def ffmpeg(args: list[str], timeout: float | None = None) -> str:
    base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if config.THREADS:
        base += ["-threads", str(config.THREADS)]
    return run(base + args, timeout=timeout)


def probe(path: str | Path) -> dict:
    out = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    return json.loads(out)


def _rate(s: str | None) -> float:
    if not s or s == "0/0":
        return 0.0
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b) if float(b) else 0.0
    return float(s)


def _rotation(v: dict) -> int:
    rot = 0
    if "rotate" in v.get("tags", {}):
        rot = int(v["tags"]["rotate"])
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    return rot % 360


def describe(path: str | Path) -> dict:
    """The facts the editor cares about, in one flat dict."""
    p = probe(path)
    fmt = p.get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    v = next((s for s in p["streams"] if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    if v is None:
        raise FFmpegError("no video stream")
    a = next((s for s in p["streams"] if s.get("codec_type") == "audio"), None)
    vtags = {k.lower(): str(val) for k, val in (v.get("tags") or {}).items()}
    rot = _rotation(v)
    w, h = int(v["width"]), int(v["height"])
    if rot in (90, 270):
        w, h = h, w
    fps = _rate(v.get("avg_frame_rate")) or _rate(v.get("r_frame_rate"))
    transfer = v.get("color_transfer", "")
    name = Path(path).name
    handler = " ".join([vtags.get("handler_name", ""), tags.get("encoder", "")])
    device = "iphone" if ("com.apple.quicktime.model" in tags or "apple" in tags.get("com.apple.quicktime.make", "").lower()) else (
        "gopro" if ("gopro" in handler.lower() or re.match(r"^(GX|GH|GL|GOPR|GP)\w*\.(mp4|MP4)$", name)) else "other"
    )
    return {
        "duration": float(fmt.get("duration") or v.get("duration") or 0),
        "width": w,
        "height": h,
        "fps": round(fps, 3),
        "codec": v.get("codec_name"),
        "pix_fmt": v.get("pix_fmt"),
        "hdr": transfer in ("arib-std-b67", "smpte2084"),
        "transfer": transfer,
        "primaries": v.get("color_primaries", ""),
        "has_audio": a is not None,
        "device": device,
        "model": tags.get("com.apple.quicktime.model", "GoPro" if device == "gopro" else ""),
        "captured_at": capture_time(tags, vtags, device),
        "size": int(fmt.get("size") or 0),
    }


def capture_time(tags: dict, vtags: dict, device: str) -> str | None:
    """ISO time in the trip timezone, or None if the file carries no date."""
    tz = ZoneInfo(config.TIMEZONE)
    apple = tags.get("com.apple.quicktime.creationdate")
    if apple:
        try:
            return datetime.strptime(apple, "%Y-%m-%dT%H:%M:%S%z").astimezone(tz).isoformat()
        except ValueError:
            pass
    raw = tags.get("creation_time") or vtags.get("creation_time")
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.year < 2015:
        return None  # camera clock was never set
    if device == "gopro":
        # GoPro writes the camera's local clock but labels it UTC.
        return dt.replace(tzinfo=tz).isoformat()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz).isoformat()


_filters: set[str] | None = None


def has_filter(name: str) -> bool:
    global _filters
    if _filters is None:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        _filters = {line.split()[1] for line in out.splitlines() if len(line.split()) > 2 and line.startswith(" ")}
    return name in _filters


def hwaccel() -> list[str]:
    return ["-hwaccel", config.HWACCEL] if config.HWACCEL else []


def hdr_to_sdr(info: dict) -> str:
    """Filter chain converting iPhone HLG / PQ footage to Rec.709 SDR (empty for SDR)."""
    if not info.get("hdr"):
        return ""
    if not has_filter("zscale"):
        # ffmpeg built without zimg: an approximate conversion (HLG is close to SDR anyway).
        return ("format=yuv420p10le,colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:fast=1,"
                "format=yuv420p,eq=saturation=1.08")
    tin = "arib-std-b67" if info["transfer"] == "arib-std-b67" else "smpte2084"
    return (
        f"zscale=tin={tin}:min=bt2020nc:pin=bt2020:t=linear:npl=203,format=gbrpf32le,"
        "zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=4,"
        "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
    )


def frames(path: str | Path, fps: float, width: int, start: float = 0, duration: float | None = None):
    """Yield small RGB frames (H, W, 3 uint8) sampled at `fps`."""
    info = describe(path)
    h = int(round(width * info["height"] / info["width"] / 2) * 2)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += hwaccel() + ["-i", str(path)]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vf", f"fps={fps},scale={width}:{h}:flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = width * h * 3
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, width, 3)
    finally:
        proc.stdout.close()
        proc.wait()


def audio(path: str | Path, rate: int = 22050, start: float = 0, duration: float | None = None) -> np.ndarray:
    """Mono float32 samples, or an empty array if there is no audio."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        return np.zeros(0, np.float32)
    return np.frombuffer(proc.stdout, np.float32).copy()
