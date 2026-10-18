"""Colour grades, generated as 3D LUTs (.cube) so ffmpeg's lut3d can apply them.

Each look is a function on an (N, 3) array of RGB values in 0..1 (Rec.709 display
values). We build a 33-point cube from it once and cache the file.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

SIZE = 33


def _luma(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def _scurve(x, strength):
    # Smooth contrast around mid-grey. strength 0 = identity.
    s = 1.0 / (1.0 + np.exp(-(x - 0.5) * (4 + 8 * strength)))
    lo = 1.0 / (1.0 + np.exp((4 + 8 * strength) * 0.5))
    hi = 1.0 / (1.0 + np.exp(-(4 + 8 * strength) * 0.5))
    curved = (s - lo) / (hi - lo)
    return x + (curved - x) * strength


def _saturate(rgb, amount):
    y = _luma(rgb)[:, None]
    return y + (rgb - y) * amount


def _lift_gamma_gain(rgb, lift=(0, 0, 0), gamma=(1, 1, 1), gain=(1, 1, 1)):
    lift, gamma, gain = map(np.asarray, (lift, gamma, gain))
    out = rgb * gain + lift * (1 - rgb)
    return np.clip(out, 0, 1) ** (1 / gamma)


def _split_tone(rgb, shadow, highlight, amount=1.0, balance=0.5):
    y = _luma(rgb)[:, None]
    w_hi = np.clip((y - balance) / (1 - balance), 0, 1) ** 1.2
    w_sh = np.clip((balance - y) / balance, 0, 1) ** 1.2
    return rgb + amount * (w_sh * np.asarray(shadow) + w_hi * np.asarray(highlight))


def _hsv(rgb):
    mx = rgb.max(1)
    mn = rgb.min(1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    i = nz & (mx == r)
    h[i] = ((g[i] - b[i]) / d[i]) % 6
    i = nz & (mx == g) & (mx != r)
    h[i] = (b[i] - r[i]) / d[i] + 2
    i = nz & (mx == b) & (mx != r) & (mx != g)
    h[i] = (r[i] - g[i]) / d[i] + 4
    h = h * 60.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def _hue_weight(h, centre, width):
    d = np.abs(((h - centre) + 180) % 360 - 180)
    return np.clip(1 - d / width, 0, 1)


def _hue_sat(rgb, centre, width, sat=1.0, toward=None, shift=0.0):
    """Change saturation of one hue band and optionally pull it toward another colour."""
    h, s, v = _hsv(rgb)
    w = (_hue_weight(h, centre, width) * np.clip(s * 2, 0, 1))[:, None]
    y = _luma(rgb)[:, None]
    out = rgb + w * (y + (rgb - y) * sat - rgb)
    if toward is not None:
        out = out + w * shift * (np.asarray(toward) - out) * 0.5
    return out


def _skin_protect(orig, graded, amount=0.6):
    # Skin sits around hue 15-40. Keep it closer to the ungraded value so faces stay natural.
    h, s, v = _hsv(orig)
    w = (_hue_weight(h, 25, 22) * np.clip(s * 3, 0, 1) * np.clip(v * 2, 0, 1))[:, None] * amount
    return graded * (1 - w) + orig * w


def _film_toe(rgb, black=0.03, white=0.97):
    # Lifted blacks and rolled-off whites, like a print stock.
    return black + rgb * (white - black)


# ---------------------------------------------------------------- looks

def teal_orange(rgb):
    o = _scurve(rgb, 0.35)
    o = _split_tone(o, (-0.05, 0.02, 0.06), (0.06, 0.02, -0.05), 0.9)
    o = _hue_sat(o, 120, 60, sat=0.75, toward=(0.1, 0.45, 0.45), shift=0.5)  # greens toward teal
    o = _saturate(o, 1.08)
    o = _skin_protect(rgb, o, 0.4)
    return _film_toe(o, 0.02, 0.98)


def emerald(rgb):
    """Ireland: deep, rich greens, cool shadows, warm soft highlights."""
    o = _scurve(rgb, 0.28)
    o = _hue_sat(o, 105, 55, sat=1.25, toward=(0.12, 0.42, 0.22), shift=0.35)
    o = _hue_sat(o, 210, 40, sat=0.85, toward=(0.25, 0.4, 0.55), shift=0.3)  # calmer skies
    o = _split_tone(o, (-0.02, 0.01, 0.035), (0.045, 0.025, -0.02), 1.0)
    o = _lift_gamma_gain(o, lift=(0.0, 0.01, 0.015), gamma=(1.0, 1.02, 1.0), gain=(1.0, 0.99, 0.97))
    o = _skin_protect(rgb, o, 0.5)
    return _film_toe(o, 0.025, 0.975)


def london_noir(rgb):
    """London: cool, restrained, inky blacks with warm practical lights."""
    o = _saturate(rgb, 0.72)
    o = _scurve(o, 0.4)
    o = _split_tone(o, (-0.03, 0.0, 0.05), (0.07, 0.035, -0.03), 1.0, balance=0.6)
    o = _hue_sat(o, 30, 30, sat=1.2)  # keep sodium/neon warmth
    o = _skin_protect(rgb, o, 0.35)
    return _film_toe(o, 0.035, 0.96)


def vivid_pop(rgb):
    """Short-form: punchy, warm, saturated without blowing skin."""
    o = _scurve(rgb, 0.45)
    o = _saturate(o, 1.28)
    o = _lift_gamma_gain(o, gamma=(1.03, 1.0, 0.98), gain=(1.03, 1.0, 0.96))
    o = _hue_sat(o, 210, 40, sat=1.15)  # bluer skies
    o = _skin_protect(rgb, o, 0.45)
    return np.clip(o, 0, 1)


def faded_film(rgb):
    """Moody: faded blacks, muted colour, green-cyan shadows, cream highlights."""
    o = _saturate(rgb, 0.68)
    o = _scurve(o, 0.18)
    o = _split_tone(o, (-0.02, 0.025, 0.02), (0.04, 0.03, 0.0), 1.0)
    o = _hue_sat(o, 120, 70, sat=0.7, toward=(0.3, 0.42, 0.33), shift=0.4)
    o = _skin_protect(rgb, o, 0.3)
    return _film_toe(o, 0.08, 0.93)


def clean_warm(rgb):
    """Day-in-the-life: natural with a gentle warm, sunny bias."""
    o = _scurve(rgb, 0.2)
    o = _saturate(o, 1.08)
    o = _lift_gamma_gain(o, gain=(1.025, 1.0, 0.965))
    o = _skin_protect(rgb, o, 0.3)
    return _film_toe(o, 0.01, 0.99)


def golden_hour(rgb):
    """Kodak-Gold-ish warmth, yellow highlights, soft contrast."""
    o = _scurve(rgb, 0.25)
    o = _split_tone(o, (0.0, -0.005, 0.02), (0.07, 0.05, -0.04), 1.0)
    o = _saturate(o, 1.1)
    o = _skin_protect(rgb, o, 0.35)
    return _film_toe(o, 0.03, 0.97)


def mono_film(rgb):
    y = _luma(rgb)
    y = _scurve(y, 0.45)
    y = 0.04 + y * 0.93
    return np.stack([y * 1.01, y, y * 0.98], 1)


def vhs_pop(rgb):
    """AWGE / camcorder: saturated, warm-magenta highlights, green-tinged shadows, crushed blacks."""
    o = _scurve(rgb, 0.5)
    o = _saturate(o, 1.35)
    o = _split_tone(o, (-0.02, 0.035, 0.0), (0.06, 0.0, 0.035), 1.0)
    o = _lift_gamma_gain(o, lift=(0.0, 0.01, 0.0), gamma=(1.04, 1.0, 0.97), gain=(1.04, 0.98, 1.0))
    o = _skin_protect(rgb, o, 0.25)
    return _film_toe(o, 0.015, 0.97)


def lemonade(rgb):
    """Lyrical-Lemonade bright: clean whites, candy saturation, warm yellow lean, punchy contrast."""
    o = _scurve(rgb, 0.4)
    o = _saturate(o, 1.42)
    o = _hue_sat(o, 55, 30, sat=1.25)            # yellows pop
    o = _hue_sat(o, 210, 45, sat=1.3)            # blue skies
    o = _lift_gamma_gain(o, gamma=(1.05, 1.04, 1.0), gain=(1.04, 1.02, 0.98))
    o = _skin_protect(rgb, o, 0.35)
    return _film_toe(o, 0.0, 1.0)


def super8(rgb):
    """Kodachrome-ish home movie: warm, dense reds, yellow highlights, faded blacks."""
    o = _scurve(rgb, 0.3)
    o = _split_tone(o, (0.02, 0.0, -0.01), (0.08, 0.05, -0.06), 1.0)
    o = _hue_sat(o, 0, 30, sat=1.25)
    o = _hue_sat(o, 210, 50, sat=0.8, toward=(0.3, 0.5, 0.55), shift=0.3)
    o = _saturate(o, 1.05)
    return _film_toe(o, 0.06, 0.94)


def bleach_bypass(rgb):
    """Silver-retained film: low saturation, hard contrast, metallic."""
    y = _luma(rgb)[:, None]
    o = rgb * 0.45 + y * 0.55
    o = _scurve(o, 0.6)
    return _film_toe(o, 0.02, 0.97)


def cross_process(rgb):
    """Cross-processed film: yellow-green highlights, blue shadows, punchy."""
    o = _scurve(rgb, 0.45)
    o = _lift_gamma_gain(o, lift=(0.0, 0.0, 0.06), gamma=(1.05, 1.08, 0.88), gain=(1.02, 1.04, 0.85))
    o = _saturate(o, 1.2)
    return np.clip(o, 0, 1)


LOOKS = {
    "emerald": ("Emerald Isle", "Rich greens, cool shadows, warm highlights", emerald),
    "teal_orange": ("Blockbuster", "Teal shadows, orange skin and highlights", teal_orange),
    "london_noir": ("London Noir", "Cool, inky, with warm street lights", london_noir),
    "vivid_pop": ("Vivid Pop", "Punchy and saturated for Reels/TikTok", vivid_pop),
    "faded_film": ("Faded Film", "Muted colour with lifted blacks", faded_film),
    "clean_warm": ("Clean Warm", "Natural colour with a sunny lean", clean_warm),
    "golden_hour": ("Golden Hour", "Warm, film-stock gold", golden_hour),
    "mono_film": ("Mono Film", "Contrasty black and white", mono_film),
    "lemonade": ("Lemonade", "Bright candy colour with clean whites", lemonade),
    "vhs_pop": ("VHS Pop", "Camcorder colour: saturated, crushed, magenta-warm", vhs_pop),
    "super8": ("Super 8", "Warm home-movie film stock", super8),
    "bleach_bypass": ("Bleach Bypass", "Desaturated, hard, metallic", bleach_bypass),
    "cross_process": ("Cross Process", "Yellow-green highs, blue shadows", cross_process),
}


def build_cube(fn) -> np.ndarray:
    g = np.linspace(0, 1, SIZE)
    # .cube order: red changes fastest, then green, then blue.
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    rgb = np.stack([r.ravel(), gg.ravel(), b.ravel()], 1)
    return np.clip(fn(rgb), 0, 1)


def lut_path(look: str, cache_dir: str | os.PathLike) -> Path:
    if look not in LOOKS:
        raise KeyError(f"unknown look {look!r}; choose from {', '.join(LOOKS)}")
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"{look}.cube"
    if not path.exists():
        cube = build_cube(LOOKS[look][2])
        lines = [f'TITLE "{LOOKS[look][0]}"', f"LUT_3D_SIZE {SIZE}", ""]
        lines += [f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in cube]
        tmp = path.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n")
        tmp.replace(path)
    return path
