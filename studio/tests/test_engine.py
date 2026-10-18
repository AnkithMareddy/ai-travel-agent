"""Fast checks for the parts with real logic: beats, timeline, grades, speech grouping, audio ducking.

Run from studio/:  python -m pytest -q tests
"""
import math
import subprocess
import wave

import numpy as np
import pytest

from reel import luts, music, render, styles, transcribe


def _click_track(path, bpm=120.0, seconds=30, loud_from=16.0):
    sr = 44100
    y = np.zeros(int(sr * seconds))
    for b in np.arange(0.5, seconds, 60 / bpm):
        i, n = int(b * sr), int(0.1 * sr)
        amp = 0.9 if b >= loud_from else 0.35
        y[i:i + n] += amp * np.exp(-np.arange(n) / sr * 30) * np.sin(2 * np.pi * 60 * np.arange(n) / sr)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(y, -1, 1) * 32000).astype(np.int16).tobytes())


@pytest.fixture(scope="module")
def song(tmp_path_factory):
    p = tmp_path_factory.mktemp("song") / "click.wav"
    _click_track(p)
    return music.analyse(str(p))


def test_tempo_and_beats(song):
    assert abs(song["bpm"] - 120) < 2
    # Beats every 0.5 s starting at 0.5 s, within 40 ms.
    for b in song["beats"][:10]:
        assert abs((b - 0.5) / 0.5 - round((b - 0.5) / 0.5)) * 0.5 < 0.04


def test_drop_found(song):
    assert abs(song["drop"] - 16.0) < 1.1


def test_default_start_short_edit_starts_before_drop(song):
    start = music.default_start(song, 12, "drop")
    assert start < song["drop"] <= start + 12


def _shot(i, length=6.0, said=None, fps=30):
    s = {"id": f"s{i}", "clip": f"c{i}", "length": length, "in": 1.0, "out": length - 1.0, "fps": fps,
         "width": 1920, "height": 1080, "motion": 0.02, "path": "x.mp4", "has_audio": True}
    if said:
        s["speech"] = [{"start": 1.5, "end": 4.5, "text": said}]
        s["said"] = said
    return s


def test_timeline_cuts_land_on_beats(song):
    shots = {f"s{i}": _shot(i) for i in range(8)}
    plan = {"shots": [{"id": f"s{i}"} for i in range(8)]}
    slots = render.build_timeline(plan, shots, styles.get("reel"), song, 0.0)
    beats = [b for b in song["beats"]]
    for s in slots[1:]:
        assert min(abs(s["t"] - b) for b in beats) < 0.01


def test_dialogue_runs_full_line_then_snaps_back(song):
    shots = {"a": _shot(0), "b": _shot(1, length=7, said="hello there this is a story"), "c": _shot(2)}
    for k, v in shots.items():
        v["id"] = k
    plan = {"shots": [{"id": "a"}, {"id": "b", "dialogue": True}, {"id": "c"}]}
    slots = render.build_timeline(plan, shots, styles.get("vlog"), song, 0.0)
    talk = slots[1]
    assert talk["dialogue"] and talk["speed"] == 1.0
    assert talk["dur"] >= 3.0 + render.PRE  # whole line plus breathing room
    nxt = slots[2]["t"]
    assert min(abs(nxt - b) for b in song["beats"]) < 0.01


def test_every_look_builds_a_valid_cube(tmp_path):
    for look in luts.LOOKS:
        cube = luts.build_cube(luts.LOOKS[look][2])
        assert cube.shape == (luts.SIZE ** 3, 3)
        assert np.isfinite(cube).all() and cube.min() >= 0 and cube.max() <= 1
        # Grades shouldn't invert: black stays dark, white stays bright.
        assert cube[0].mean() < 0.15 and cube[-1].mean() > 0.85
    assert luts.lut_path("emerald", tmp_path).read_text().startswith('TITLE "Emerald Isle"')


def test_speech_windows_group_lines():
    lines = [{"start": 1.0, "end": 2.0, "text": "who forgot"}, {"start": 2.3, "end": 3.5, "text": "the car keys"},
             {"start": 10.0, "end": 10.4, "text": "ok"}]
    w = transcribe.speech_windows(lines, 20.0)
    assert len(w) == 1 and "car keys" in w[0]["text"]


def test_duck_expression_parses_in_ffmpeg():
    slots = [{"t": 0, "dur": 2, "dialogue": True}, {"t": 2, "dur": 2}, {"t": 4, "dur": 3, "dialogue": True},
             {"t": 7, "dur": 2, "dialogue": True}]
    expr = render._duck_expr(slots, 0.15, 2.0)
    out = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=9",
                          "-af", f"volume='{expr}':eval=frame", "-f", "null", "-"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr


def test_youtube_chapters_need_three_and_ten_seconds_apart():
    slots = [{"t": 0, "chapter": None}, {"t": 12, "chapter": "Cork"}, {"t": 15, "chapter": "too close"},
             {"t": 40, "chapter": "Killarney"}]
    ch = render.chapters(slots)
    assert [c["title"] for c in ch] == ["Cold open", "Cork", "Killarney"]
    assert "0:12 Cork" in render.youtube_description({"caption": "x"}, ch)


def test_treatment_marks_cuts_and_filters_parse(song, tmp_path):
    from reel import treatment as tr

    t = tr.normalise(tr.PRESETS["awge"])
    style = tr.style_with(styles.get("vlog"), t)
    assert style["pacing"] == tr.PACING["fast"] and style["treatment"] is t
    shots = {f"s{i}": {**_shot(i), "id": f"s{i}"} for i in range(10)}
    plan = {"shots": [{"id": f"s{i}", "role": "peak" if i == 5 else "journey"} for i in range(10)]}
    slots = render.build_timeline(plan, shots, style, song, 0.0)
    tr.decorate(slots, t, song, 0.0)
    assert any(s.get("flash") for s in slots) and sum(bool(s.get("freeze")) for s in slots) == 1
    for slot in slots[:4]:
        chain = ",".join(tr.pre_grade(t, {**slot, "punch": True, "stutter": True}, 1080, 1920, 30)
                         + ["fps=30"] + tr.time_fx(t, {**slot, "stutter": True}, 30)
                         + tr.post_grade(t, {**slot, "bw": True, "flash": True}, 1080, 1920))
        out = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                              "testsrc2=s=1920x1080:r=30:d=1", "-vf", f"scale=1080:1920,{chain}", "-f", "null", "-"],
                             capture_output=True, text=True)
        assert out.returncode == 0, out.stderr
    assert tr.normalise(tr.PRESETS["clean"]) is None


def test_four_three_box_keeps_frame_size():
    from reel import treatment as tr

    t = tr.normalise(tr.PRESETS["super8"])
    for W, H in ((1080, 1920), (1920, 1080)):
        chain = ",".join(tr.pre_grade(t, {"dur": 2}, W, H, 24))
        out = subprocess.run(["ffprobe", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s={W}x{H}:d=0.1,{chain}",
                              "-show_entries", "stream=width,height", "-of", "csv=p=0"], capture_output=True, text=True)
        assert out.stdout.strip() == f"{W},{H}", out.stderr


def test_text_overlays_render_without_drawtext(tmp_path):
    """Titles/captions are drawn by Pillow and composited with overlay, so any ffmpeg works."""
    from reel import config, text as txt

    tf = tmp_path / "t.txt"
    tf.write_text("WE LOST THE KEYS\nAGAIN")
    specs = [txt.spec(tf, config.FONT_SANS, 90, "(w-text_w)/2", "h*0.14", 0.0, 1.5, border=True, color="#ffe14d"),
             txt.spec(tf, config.FONT_MONO, 40, "w*0.07", "h*0.70", 0.2, 1.8, box=True, color="white@0.9")]
    extra, graph, last = txt.overlays(specs, 1, "0:v", 1080, 1920, 30, 2.0, tmp_path, "t")
    out = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=2",
                          *extra, "-filter_complex", ";".join(graph + [f"[{last}]format=yuv420p[v]"]),
                          "-map", "[v]", "-f", "null", "-"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
