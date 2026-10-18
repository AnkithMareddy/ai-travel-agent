"""On-screen text drawn with Pillow and overlaid by ffmpeg.

Some ffmpeg builds (including recent Homebrew ones) ship without the drawtext filter, so
titles, hooks, captions, subtitles and date stamps are rendered to transparent PNGs here
and composited with ffmpeg's built-in overlay filter. That works with any ffmpeg.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageColor, ImageDraw, ImageFont

PREFIX = "TEXT:"


def spec(text_file: Path, font: str, size: int, x: str, y: str, start: float, end: float,
         fade: float = 0.4, color="white", shadow=True, box=False, spacing=0, border=False) -> str:
    """A text request, encoded as a string so it can travel through the filter lists."""
    return PREFIX + json.dumps({
        "file": str(text_file), "font": font, "size": int(size), "x": x, "y": y,
        "start": round(float(start), 3), "end": round(float(end), 3), "fade": float(fade),
        "color": color, "shadow": shadow, "box": box, "spacing": int(spacing), "border": border,
    })


def is_spec(s: str) -> bool:
    return isinstance(s, str) and s.startswith(PREFIX)


def _rgba(c: str) -> tuple[int, int, int, int]:
    alpha = 1.0
    if "@" in c:
        c, a = c.split("@", 1)
        alpha = float(a)
    r, g, b = ImageColor.getrgb(c)[:3]
    return r, g, b, int(255 * alpha)


def _font(path: str, size: int, bold: bool):
    try:
        f = ImageFont.truetype(path, size) if path else ImageFont.load_default(size)
    except OSError:
        f = ImageFont.load_default(size)
    try:  # variable fonts (Montserrat, Playfair): pick a confident weight
        axes = f.get_variation_axes()
        f.set_variation_by_axes([min(max(800 if bold else 600, a["minimum"]), a["maximum"]) if i == 0 else a["default"]
                                 for i, a in enumerate(axes)])
    except Exception:
        pass
    return f


def _render(sp: dict, out: Path) -> tuple[int, int, int]:
    """Draw the text to a transparent PNG. Returns (width, height, padding)."""
    text = Path(sp["file"]).read_text().strip("\n")
    size = sp["size"]
    font = _font(sp["font"], size, bold=sp.get("border") or "Montserrat" in sp["font"] or "Sans-Bold" in sp["font"])
    centred = "text_w)/2" in sp["x"]
    stroke = max(3, size // 14) if sp["border"] else 0
    spacing = sp["spacing"] or int(size * 0.18)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    l, t, r, b = probe.multiline_textbbox((0, 0), text, font=font, spacing=spacing, stroke_width=stroke,
                                          align="center" if centred else "left")
    l, t, r, b = math.floor(l), math.floor(t), math.ceil(r), math.ceil(b)
    pad = max(8, size // 3) if sp["box"] else max(4, size // 10) + stroke
    w, h = int((r - l) + 2 * pad), int((b - t) + 2 * pad + max(2, size // 20))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if sp["box"]:
        d.rounded_rectangle([0, 0, w - 1, h - 1], radius=max(4, size // 6), fill=(0, 0, 0, 128))
    origin = (pad - l, pad - t)
    kw = dict(font=font, spacing=spacing, align="center" if centred else "left")
    if sp["shadow"] and not sp["box"]:
        d.multiline_text((origin[0], origin[1] + max(2, size // 20)), text, fill=(0, 0, 0, 150),
                         stroke_width=stroke, stroke_fill=(0, 0, 0, 150), **kw)
    d.multiline_text(origin, text, fill=_rgba(sp["color"]), stroke_width=stroke, stroke_fill=(0, 0, 0, 255), **kw)
    img.save(out)
    return w, h, pad


def _place(expr: str, W: int, H: int, tw: int, th: int) -> float:
    env = {"w": W, "h": H, "W": W, "H": H, "text_w": tw, "text_h": th, "max": max, "min": min}
    return float(eval(expr, {"__builtins__": {}}, env))  # expressions are ours, never user input


def overlays(specs: list[str], first_input: int, base: str, W: int, H: int, fps: int, dur: float,
             work: Path, tag: str) -> tuple[list[str], list[str], str]:
    """Inputs + filter-graph lines that lay each text over `base`. Returns (args, graph, out_label)."""
    args, graph, cur = [], [], base
    for k, s in enumerate(specs):
        sp = json.loads(s[len(PREFIX):])
        png = work / f"txt_{tag}_{k}.png"
        tw, th, pad = _render(sp, png)
        x = round(_place(sp["x"], W, H, tw - 2 * pad, th - 2 * pad) - pad)
        y = round(_place(sp["y"], W, H, tw - 2 * pad, th - 2 * pad) - pad)
        a, b, f = sp["start"], sp["end"], max(0.01, min(sp["fade"], (sp["end"] - sp["start"]) / 2))
        idx = first_input + k
        args += ["-loop", "1", "-framerate", str(fps), "-t", f"{dur + 0.2:.3f}", "-i", str(png)]
        graph.append(f"[{idx}:v]format=rgba,fade=t=in:st={a:.3f}:d={f:.3f}:alpha=1,"
                     f"fade=t=out:st={max(a, b - f):.3f}:d={f:.3f}:alpha=1[{tag}t{k}]")
        nxt = f"{tag}o{k}"
        graph.append(f"[{cur}][{tag}t{k}]overlay=x={x}:y={y}:enable='between(t,{a:.3f},{b:.3f})':eof_action=pass[{nxt}]")
        cur = nxt
    return args, graph, cur
