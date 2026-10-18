from __future__ import annotations

import time
from concurrent.futures import Future
from pathlib import Path
from typing import Any

import numpy
import pytest
import soundfile

from fixlib_py import server
from fixlib_py.analysis import decode, energy

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"
RATE = decode.SAMPLE_RATE

needs_ffmpeg = pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin")


def pad(seconds: float) -> numpy.ndarray:
    """An A minor chord held still: no hits, no low end."""
    time = numpy.arange(int(seconds * RATE)) / RATE
    chord = sum(numpy.sin(2 * numpy.pi * f * time) for f in (220.0, 261.63, 329.63)) / 3
    return (0.3 * chord).astype(numpy.float32)


def drop(seconds: float, bpm: float = 124.0) -> numpy.ndarray:
    """The pad with a kick on every beat and a hi-hat between them."""
    time = numpy.arange(int(seconds * RATE)) / RATE
    beat = 60.0 / bpm
    since_beat = time % beat
    kick = numpy.sin(2 * numpy.pi * 55.0 * since_beat) * numpy.exp(-since_beat * 18)
    since_hat = (time + beat / 2) % beat
    noise = numpy.random.default_rng(1).standard_normal(len(time))
    hat = noise * numpy.exp(-since_hat * 120) * 0.2
    return (pad(seconds) + 0.6 * kick + hat).astype(numpy.float32)


@pytest.fixture(scope="module")
def essentia() -> None:
    pytest.importorskip("essentia")


def test_a_drop_has_more_of_every_energy_feature_than_a_pad(essentia: None) -> None:
    calm = energy.analyze_samples(pad(40))["features"]
    hard = energy.analyze_samples(drop(40))["features"]

    for name in ("rmsDb", "percussiveRatio", "onsetRate", "spectralFlux", "lowRatio"):
        assert hard[name] > calm[name], name
    assert hard["integratedLufs"] > calm["integratedLufs"]


def test_a_long_quiet_intro_and_outro_do_not_lower_the_drops(essentia: None) -> None:
    only_drops = energy.analyze_samples(drop(60))["features"]
    # 60 s of drops in 160 s: a quarter of the windows is above the 75th percentile.
    framed = numpy.concatenate([pad(50) * 0.3, drop(60), pad(50) * 0.3])
    with_intro = energy.analyze_samples(framed)["features"]

    for name in ("rmsDb", "percussiveRatio", "onsetRate", "lowRatio"):
        assert with_intro[name] == pytest.approx(only_drops[name], rel=0.1), name


def test_two_minutes_of_silence_before_the_track_change_no_feature_by_more_than_5_percent(
    essentia: None,
) -> None:
    track = drop(40)
    after_silence = numpy.concatenate([numpy.zeros(120 * RATE, numpy.float32), track])

    plain = energy.analyze_samples(track)["features"]
    later = energy.analyze_samples(after_silence)["features"]

    for name in energy.FEATURES:
        assert later[name] == pytest.approx(plain[name], rel=0.05), name


def test_a_kick_and_bass_has_more_low_end_and_more_onsets_than_white_noise(
    essentia: None,
) -> None:
    at = numpy.arange(30 * RATE) / RATE
    since_beat = at % (60.0 / 124)
    kick = numpy.sin(2 * numpy.pi * 55.0 * since_beat) * numpy.exp(-since_beat * 18)
    bass = 0.3 * numpy.sin(2 * numpy.pi * 41.2 * at)
    noise = 0.2 * numpy.random.default_rng(2).standard_normal(len(at))

    groove = energy.analyze_samples((0.6 * kick + bass).astype(numpy.float32))["features"]
    hiss = energy.analyze_samples(noise.astype(numpy.float32))["features"]

    # Not the percussive ratio: white noise has no pitch to hold, so HPSS puts it
    # with the hits, and a held bass line is harmonic.
    assert groove["lowRatio"] > hiss["lowRatio"]
    assert groove["onsetRate"] > hiss["onsetRate"]


def test_a_ten_minute_track_is_analysed_within_20_seconds(essentia: None) -> None:
    long = numpy.tile(drop(60), 10)

    started = time.monotonic()
    energy.analyze_samples(long)

    assert time.monotonic() - started < 20


def test_names_every_feature_and_the_analyzer_version(essentia: None) -> None:
    result = energy.analyze_samples(drop(20))

    assert set(result) == {"features", "analyzerVersion"}
    assert set(result["features"]) == set(energy.FEATURES)
    assert result["analyzerVersion"] == energy.ANALYZER_VERSION
    assert 0 <= result["features"]["percussiveRatio"] <= 1
    assert 0 <= result["features"]["lowRatio"] <= 1


def test_refuses_audio_shorter_than_one_window(essentia: None) -> None:
    with pytest.raises(ValueError, match="too short"):
        energy.analyze_samples(drop(9))


def test_refuses_silence(essentia: None) -> None:
    with pytest.raises(ValueError, match="silent"):
        energy.analyze_samples(numpy.zeros(30 * RATE, numpy.float32))


def test_refuses_a_path_that_is_not_absolute() -> None:
    with pytest.raises(ValueError, match="absolute"):
        energy.energy_features("track.mp3", "job-1")


def test_hands_the_file_to_a_pool_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    submitted: list[tuple[Any, ...]] = []

    class Pool:
        def submit(self, function: Any, *arguments: Any) -> Future[Any]:
            submitted.append((function, *arguments))
            future: Future[Any] = Future()
            future.set_result({"features": {}})
            return future

    monkeypatch.setattr(server, "cpu_pool", lambda: Pool())

    assert energy.energy_features("/music/track.mp3", "job-1") == {"features": {}}
    assert submitted == [(energy.analyze_file, "/music/track.mp3")]
    assert server._jobs == {}


@needs_ffmpeg
def test_analyses_a_file_through_the_apps_ffmpeg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, essentia: None
) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))
    path = tmp_path / "drop.wav"
    soundfile.write(path, drop(20), RATE, subtype="PCM_16")

    result = energy.analyze_file(str(path))

    assert set(result["features"]) == set(energy.FEATURES)
