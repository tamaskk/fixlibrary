from __future__ import annotations

import os
import stat
import threading
import wave
from collections.abc import Iterator
from pathlib import Path

import numpy
import pytest

from fixlib_py import server
from fixlib_py.analysis import decode, stems

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"
MODELS = ROOT / "resources" / "models"
RATE = decode.SAMPLE_RATE

needs_model = pytest.mark.skipif(
    not FFMPEG.is_file() or not (MODELS / "htdemucs" / "state.pt").is_file(),
    reason="needs resources/bin/ffmpeg and scripts/fetch-demucs-weights.sh",
)


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def stems_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "stems"
    folder.mkdir()
    monkeypatch.setenv(stems.STEMS_DIR_ENV, str(folder))
    return folder


def fake_separator(audio: numpy.ndarray) -> numpy.ndarray:
    """Puts the left channel into bass and the right one into vocals, both in stereo."""
    result = numpy.zeros((4, 2, audio.shape[1]), dtype=numpy.float32)
    result[1] = audio[0]
    result[3] = audio[1]
    return result


def test_names_the_envelopes_of_a_track_by_its_id_only() -> None:
    assert stems.envelope_name(42) == "42.npz"
    for bad in (0, -1, True, "42", 4.0, 10**17):
        with pytest.raises(ValueError):
            stems.envelope_name(bad)  # type: ignore[arg-type]


def test_measures_each_stem_in_100_ms_windows_over_both_channels() -> None:
    # A stem of amplitude 0.5 for 150 ms on both channels, the rest silent.
    separated = numpy.zeros((4, 2, int(RATE * 0.25)), dtype=numpy.float32)
    separated[1, :, : int(RATE * 0.15)] = 0.5

    envelopes = stems.rms_envelopes(separated)

    assert envelopes.shape == (4, 3)
    # The second window holds 50 ms of the stem and 50 ms of silence.
    assert envelopes[1].tolist() == pytest.approx([0.5, 0.5 * 0.5**0.5, 0.0], abs=1e-6)
    assert envelopes[0].tolist() == [0.0, 0.0, 0.0]


def test_separates_a_long_track_a_minute_at_a_time_without_a_seam() -> None:
    length = int(RATE * 150.05)
    time = numpy.arange(length) / RATE
    audio = numpy.stack(
        [0.4 * numpy.sin(2 * numpy.pi * 55 * time), 0.2 * numpy.sin(2 * numpy.pi * 440 * time)]
    ).astype(numpy.float32)
    calls: list[int] = []

    def counting(chunk: numpy.ndarray) -> numpy.ndarray:
        calls.append(chunk.shape[1])
        return fake_separator(chunk)

    envelopes = stems.envelopes_of(audio, counting)

    assert envelopes.dtype == numpy.float16
    assert envelopes.shape == (4, 1501)
    whole = stems.rms_envelopes(fake_separator(audio)).astype(numpy.float16)
    assert numpy.array_equal(envelopes, whole)
    # Three minutes' worth of calls, each with its context, never the whole track.
    assert len(calls) == 3
    assert max(calls) <= (stems.CHUNK_SECONDS + 2 * stems.CONTEXT_SECONDS) * RATE


def test_stops_between_minutes_when_told_to() -> None:
    audio = numpy.zeros((2, RATE * 130), dtype=numpy.float32)
    stop = threading.Event()

    def stopping(chunk: numpy.ndarray) -> numpy.ndarray:
        stop.set()
        return fake_separator(chunk)

    with pytest.raises(server.JobCancelled):
        stems.envelopes_of(audio, stopping, stop)


def test_writes_the_envelopes_whole_and_small(stems_folder: Path) -> None:
    envelopes = numpy.random.default_rng(1).random((4, 6000)).astype(numpy.float16)

    size = stems.write_envelopes("7.npz", envelopes)

    assert sorted(os.listdir(stems_folder)) == ["7.npz"]
    assert size == (stems_folder / "7.npz").stat().st_size
    # Ten minutes of four stems stay well under the 200 KB of the acceptance criteria.
    assert size < 200 * 1024
    assert stat.S_IMODE((stems_folder / "7.npz").stat().st_mode) == 0o600
    with numpy.load(stems_folder / "7.npz", allow_pickle=False) as stored:
        assert numpy.array_equal(stored["envelopes"], envelopes)
        assert stored["stems"].tolist() == list(stems.STEMS)
        assert str(stored["version"]) == stems.ANALYZER_VERSION


def test_refuses_without_a_stems_folder(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(stems.STEMS_DIR_ENV, raising=False)
    with pytest.raises(stems.Refused):
        stems.stems_dir()
    link = tmp_path / "link"
    link.symlink_to(tmp_path)
    monkeypatch.setenv(stems.STEMS_DIR_ENV, str(link))
    with pytest.raises(stems.Refused):
        stems.stems_dir()


def test_puts_nothing_in_place_when_told_to_stop_while_writing(stems_folder: Path) -> None:
    stop = threading.Event()
    stop.set()

    with pytest.raises(server.JobCancelled):
        stems.write_envelopes("7.npz", numpy.zeros((4, 10), dtype=numpy.float16), stop)

    assert os.listdir(stems_folder) == []


def test_makes_floats_of_16_bit_samples_a_minute_at_a_time() -> None:
    length = RATE * 70
    floats = (0.25 * numpy.sin(numpy.arange(length) / 7)).astype(numpy.float32)
    stereo = numpy.stack([floats, floats])
    sixteen = numpy.round(stereo * 32768).astype(numpy.int16)

    from_floats = stems.envelopes_of(stereo, fake_separator)
    from_sixteen = stems.envelopes_of(sixteen, fake_separator)

    assert numpy.allclose(
        from_floats.astype(numpy.float32), from_sixteen.astype(numpy.float32), atol=1e-3
    )


@pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin/ffmpeg")
def test_ends_as_a_stopped_job_when_told_to_stop_while_decoding(
    tmp_path: Path, stems_folder: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))
    path = tmp_path / "loop.wav"
    tone = numpy.zeros(RATE * 10, dtype=numpy.float32)
    write_stereo(path, tone, tone)
    stop = threading.Event()
    stop.set()

    with pytest.raises(server.JobCancelled):
        stems.separate_file(str(path), 3, stop)

    assert os.listdir(stems_folder) == []


def test_ends_as_a_stopped_job_when_ffmpeg_is_stopped(
    stems_folder: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def stopped(*_arguments: object) -> None:
        raise decode.ToolStopped()

    monkeypatch.setattr(stems, "decode_stereo", stopped)

    with pytest.raises(server.JobCancelled):
        stems.separate_file("/Music/a.mp3", 3, threading.Event())


def write_stereo(path: Path, left: numpy.ndarray, right: numpy.ndarray) -> None:
    frames = numpy.stack([left, right], axis=1)
    pcm = numpy.clip(frames * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())


@needs_model
def test_finds_the_bassline_where_it_plays_and_writes_its_envelopes(
    tmp_path: Path, stems_folder: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))
    monkeypatch.setenv(stems.MODELS_DIR_ENV, str(MODELS))
    # 24 s: a plucked 55 Hz bassline in the first half only, a sung-like tone (a
    # sawtooth at 220 Hz with vibrato) in the second half only, on both channels.
    time = numpy.arange(RATE * 24) / RATE
    first = time < 12
    pluck = numpy.exp(-(time % 0.5) * 6)
    bass = numpy.where(first, 0.5 * pluck * numpy.sin(2 * numpy.pi * 55 * time), 0)
    phase = 2 * numpy.pi * 220 * time + 0.8 * numpy.sin(2 * numpy.pi * 5 * time)
    voice = numpy.where(~first, 0.25 * ((phase / (2 * numpy.pi)) % 1 - 0.5), 0)
    mix = (bass + voice).astype(numpy.float32)
    path = tmp_path / "loop.wav"
    write_stereo(path, mix, mix)

    result = stems.stems(str(path), 5, "stems-job")

    assert result["file"] == "5.npz"
    assert result["analyzerVersion"] == stems.ANALYZER_VERSION
    assert result["frames"] == 240
    assert result["durationSeconds"] == 24
    assert result["truncated"] is False
    assert result["bytes"] < 200 * 1024
    with numpy.load(stems_folder / "5.npz", allow_pickle=False) as stored:
        envelopes = stored["envelopes"].astype(numpy.float32)
    bass_envelope = envelopes[stems.STEMS.index("bass")]
    assert bass_envelope[:110].mean() > 5 * bass_envelope[130:].mean()
