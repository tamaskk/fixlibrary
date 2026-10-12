from __future__ import annotations

import math
import os
import shutil
import struct
import subprocess
import sys
import threading
import time
import wave
from collections.abc import Iterator
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from typing import Any

import pytest

from fixlib_py import server
from fixlib_py.analysis import bpm_key, decode

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "synthetic"
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"

needs_ffmpeg = pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin/ffmpeg")


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))


def write_house_loop(path: Path, bpm: float = 124.0, seconds: int = 30) -> None:
    """A kick on every beat over an A minor chord, as 16 bit mono WAV."""
    rate = decode.SAMPLE_RATE
    beat = 60.0 / bpm
    chord = (220.0, 261.63, 329.63)
    frames = bytearray()
    for index in range(rate * seconds):
        time = index / rate
        since_beat = time % beat
        kick = math.sin(2 * math.pi * 55.0 * since_beat) * math.exp(-since_beat * 18)
        pad = sum(math.sin(2 * math.pi * frequency * time) for frequency in chord) / 3
        frames += struct.pack("<h", round((0.6 * kick + 0.3 * pad) * 32767))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(bytes(frames))


@pytest.mark.parametrize(
    ("measured", "expected"),
    [
        (84.9, 169.8),
        (85.0, 85.0),
        (175.0, 175.0),
        (175.1, 87.55),
        (62.0, 124.0),
        (174.0, 174.0),
        (248.0, 124.0),
        (31.0, 124.0),
    ],
)
def test_moves_a_tempo_into_the_range_by_octaves(measured: float, expected: float) -> None:
    folded = bpm_key.fold_bpm(measured, 85, 175)

    assert folded == pytest.approx(expected)


def test_a_house_track_measured_at_half_its_tempo_gets_its_tempo() -> None:
    folded = bpm_key.fold_bpm(62.0, 85, 175)

    assert round(folded) == 124


@pytest.mark.parametrize("measured", [0.0, -120.0, math.nan, math.inf])
def test_refuses_what_is_no_tempo(measured: float) -> None:
    with pytest.raises(ValueError, match="no tempo"):
        bpm_key.fold_bpm(measured, 85, 175)


@pytest.mark.parametrize(
    ("bpm_min", "bpm_max"),
    [
        (39, 175),
        (151, 300),
        (85, 79),
        (85, 301),
        (100, 199),
        (85, "175"),
        (True, 175),
        (85, math.nan),
    ],
)
def test_refuses_a_tempo_range_the_app_does_not_allow(bpm_min: Any, bpm_max: Any) -> None:
    with pytest.raises(ValueError, match="tempo range"):
        bpm_key.check_bpm_range(bpm_min, bpm_max)


def test_a_range_of_exactly_one_octave_is_allowed() -> None:
    assert bpm_key.check_bpm_range(85, 170) == (85.0, 170.0)


def test_refuses_a_path_that_is_not_absolute() -> None:
    with pytest.raises(ValueError, match="absolute"):
        bpm_key.bpm_key("track.mp3", "job-1", 85, 175)


def test_refuses_a_bad_range_before_any_work_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "cpu_pool", lambda: pytest.fail("no work may start"))

    with pytest.raises(ValueError, match="tempo range"):
        bpm_key.bpm_key("/music/track.mp3", "job-1", 85, 100)


class FakePool:
    """Stands in for the process pool: hands out the futures a test prepared."""

    def __init__(self, futures: list[Future[Any]]) -> None:
        self.futures = futures
        self.submitted: list[tuple[Any, ...]] = []
        self.shut_down = False

    def submit(self, function: Any, *arguments: Any) -> Future[Any]:
        self.submitted.append((function, *arguments))
        return self.futures.pop(0)

    def shutdown(self, wait: bool = True, cancel_futures: bool = False) -> None:
        self.shut_down = True


def finished(result: Any = None, error: BaseException | None = None) -> Future[Any]:
    future: Future[Any] = Future()
    if error is None:
        future.set_result(result)
    else:
        future.set_exception(error)
    return future


def test_hands_the_file_to_a_pool_worker_and_returns_its_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = FakePool([finished({"bpm": 124.0})])
    monkeypatch.setattr(server, "cpu_pool", lambda: pool)

    result = bpm_key.bpm_key("/music/track.mp3", "job-1", 85, 175)

    assert result == {"bpm": 124.0}
    assert pool.submitted == [(bpm_key.analyze_file, "/music/track.mp3", 85.0, 175.0)]
    assert server._jobs == {}


def test_a_job_that_is_told_to_stop_answers_without_waiting_for_its_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    never_done: Future[Any] = Future()
    monkeypatch.setattr(server, "cpu_pool", lambda: FakePool([never_done]))
    monkeypatch.setattr(bpm_key, "_POLL_S", 0.01)
    threading.Timer(0.05, lambda: server.cancel_job("job-1")).start()

    with pytest.raises(server.JobCancelled):
        bpm_key.bpm_key("/music/track.mp3", "job-1", 85, 175)

    assert never_done.cancelled()
    assert server._jobs == {}


def test_a_job_that_was_cancelled_before_it_started_starts_no_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server, "cpu_pool", lambda: pytest.fail("no work may start"))
    server.cancel_job("job-1")

    with pytest.raises(server.JobCancelled):
        bpm_key.bpm_key("/music/track.mp3", "job-1", 85, 175)


def broken() -> Future[Any]:
    return finished(error=BrokenProcessPool("a worker died"))


def test_tries_once_more_in_a_pool_of_its_own_when_a_worker_died(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shared = FakePool([broken()])
    alone = FakePool([finished({"bpm": 124.0})])
    discarded: list[Any] = []
    sizes: list[int] = []
    monkeypatch.setattr(server, "cpu_pool", lambda: shared)
    monkeypatch.setattr(server, "discard_cpu_pool", discarded.append)
    monkeypatch.setattr(server, "new_worker_pool", lambda size: sizes.append(size) or alone)

    result = bpm_key.bpm_key("/music/track.mp3", "job-1", 85, 175)

    assert result == {"bpm": 124.0}
    assert discarded == [shared]
    assert sizes == [1]
    assert alone.submitted == [(bpm_key.analyze_file, "/music/track.mp3", 85.0, 175.0)]
    assert alone.shut_down


def test_fails_when_its_own_pool_breaks_as_well(monkeypatch: pytest.MonkeyPatch) -> None:
    alone = FakePool([broken()])
    monkeypatch.setattr(server, "cpu_pool", lambda: FakePool([broken()]))
    monkeypatch.setattr(server, "discard_cpu_pool", lambda pool: None)
    monkeypatch.setattr(server, "new_worker_pool", lambda size: alone)

    with pytest.raises(BrokenProcessPool):
        bpm_key.bpm_key("/music/track.mp3", "job-1", 85, 175)

    assert alone.shut_down


def test_a_file_that_kills_its_worker_fails_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    # Both tracks were in the pool that the first one's file brought down.
    shared = FakePool([broken(), broken()])
    own_pools = {
        "/music/poison.mp3": FakePool([broken()]),
        "/music/fine.mp3": FakePool([finished({"bpm": 124.0})]),
    }
    current: list[str] = []
    monkeypatch.setattr(server, "cpu_pool", lambda: shared)
    monkeypatch.setattr(server, "discard_cpu_pool", lambda pool: None)
    monkeypatch.setattr(server, "new_worker_pool", lambda size: own_pools[current[-1]])

    current.append("/music/poison.mp3")
    with pytest.raises(BrokenProcessPool):
        bpm_key.bpm_key(current[-1], "job-1", 85, 175)
    current.append("/music/fine.mp3")
    fine = bpm_key.bpm_key(current[-1], "job-2", 85, 175)

    assert fine == {"bpm": 124.0}


def test_a_pool_worker_ends_when_the_sidecar_is_gone(tmp_path: Path) -> None:
    # A sidecar that starts a worker and then dies without closing anything.
    script = (
        "import os\n"
        "from fixlib_py import server\n"
        "print(server.cpu_pool().submit(os.getpid).result(), flush=True)\n"
        "os._exit(0)\n"
    )
    started = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=60, check=True
    )
    worker = int(started.stdout.strip())

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and _is_running(worker):
        time.sleep(0.1)

    assert not _is_running(worker)


def _is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_discarding_a_pool_replaces_only_the_pool_that_is_named() -> None:
    current = FakePool([])
    older = FakePool([])
    server._cpu_pool = current  # type: ignore[assignment]
    try:
        server.discard_cpu_pool(older)  # type: ignore[arg-type]
        kept = server._cpu_pool
        server.discard_cpu_pool(current)  # type: ignore[arg-type]
        replaced = server._cpu_pool
    finally:
        server._cpu_pool = None

    assert kept is current
    assert replaced is None
    assert older.shut_down and current.shut_down


def test_refuses_an_ffmpeg_that_the_app_did_not_name(monkeypatch: pytest.MonkeyPatch) -> None:
    for value in ("", "ffmpeg", "/nonexistent/ffmpeg"):
        monkeypatch.setenv(decode.FFMPEG_ENV, value)

        with pytest.raises(decode.DecodeError, match="FIXLIB_FFMPEG does not name"):
            decode.ffmpeg_path()


def test_refuses_a_file_that_is_not_one_of_the_formats(tmp_path: Path, ffmpeg: None) -> None:
    path = tmp_path / "track.flac"
    path.write_bytes(b"fLaC")

    with pytest.raises(decode.DecodeError, match="formats"):
        decode.decode_mono(str(path))


def test_finds_the_samples_behind_other_chunks_of_a_piped_wav() -> None:
    stream = (
        b"RIFF\xff\xff\xff\xffWAVE"
        + b"fmt \x10\x00\x00\x00"
        + bytes(16)
        + b"LIST\x03\x00\x00\x00abc\x00"
        + b"data\xff\xff\xff\xff"
        + b"\x01\x00\x02\x00"
    )

    samples = decode._samples_of_wav(stream)

    assert bytes(samples) == b"\x01\x00\x02\x00"


@pytest.mark.parametrize("stream", [b"", b"RIFF\x00\x00\x00\x00WAVE", b"ID3\x03" + bytes(64)])
def test_refuses_output_that_holds_no_samples(stream: bytes) -> None:
    with pytest.raises(decode.DecodeError, match="no audio"):
        decode._samples_of_wav(stream)


@needs_ffmpeg
@pytest.mark.parametrize("name", ["sine.mp3", "sine.wav", "sine.aiff"])
def test_decodes_every_format_to_mono_samples(name: str, ffmpeg: None) -> None:
    pytest.importorskip("numpy")

    audio = decode.decode_mono(str(FIXTURES / name))

    assert audio.dtype.name == "float32"
    assert len(audio) == pytest.approx(0.2 * decode.SAMPLE_RATE, rel=0.3)
    assert 0.2 < float(abs(audio).max()) < 0.4


@needs_ffmpeg
def test_decoding_does_not_follow_a_link(tmp_path: Path, ffmpeg: None) -> None:
    link = tmp_path / "link.wav"
    os.symlink(FIXTURES / "sine.wav", link)

    with pytest.raises(OSError):
        decode.decode_mono(str(link))


@needs_ffmpeg
def test_reports_a_file_ffmpeg_cannot_read(tmp_path: Path, ffmpeg: None) -> None:
    pytest.importorskip("numpy")
    path = tmp_path / "broken.wav"
    path.write_bytes(b"this is not audio" * 100)

    with pytest.raises(decode.DecodeError):
        decode.decode_mono(str(path))


def write_wav_claiming(path: Path, sample_rate: int) -> None:
    """A small WAV whose header claims a sample rate; its second of audio is silence."""
    samples = bytes(2 * 8000)
    header = (
        b"RIFF"
        + struct.pack("<I", 36 + len(samples))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, (sample_rate * 2) % 2**32, 2, 16)
        + b"data"
        + struct.pack("<I", len(samples))
    )
    path.write_bytes(header + samples)


@needs_ffmpeg
def test_refuses_a_file_whose_header_claims_an_absurd_sample_rate(
    tmp_path: Path, ffmpeg: None
) -> None:
    pytest.importorskip("numpy")
    path = tmp_path / "huge-rate.wav"
    write_wav_claiming(path, 800_000_000)
    started = time.monotonic()

    with pytest.raises(decode.DecodeError, match="ffmpeg failed"):
        decode.decode_mono(str(path))

    # Refused by the allocation limit, not after the resampler took a gigabyte.
    assert time.monotonic() - started < 5


@needs_ffmpeg
def test_decodes_a_file_with_an_unusual_but_real_sample_rate(tmp_path: Path, ffmpeg: None) -> None:
    pytest.importorskip("numpy")
    path = tmp_path / "hi-res.wav"
    write_wav_claiming(path, 192_000)

    audio = decode.decode_mono(str(path))

    assert len(audio) == pytest.approx(decode.SAMPLE_RATE * 8000 / 192_000, rel=0.2)


def test_refuses_a_folder_that_is_named_like_a_track(tmp_path: Path, ffmpeg: None) -> None:
    folder = tmp_path / "folder.wav"
    folder.mkdir()
    open_before = len(os.listdir("/dev/fd"))

    with pytest.raises(decode.DecodeError, match="regular file"):
        decode.decode_mono(str(folder))

    assert len(os.listdir("/dev/fd")) == open_before


def test_what_ffmpeg_says_reaches_the_log_as_one_clean_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("numpy")
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!/bin/sh\nprintf 'bad\\r\\n\\033[31mfile\\n' >&2\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setenv(decode.FFMPEG_ENV, str(fake))

    with pytest.raises(decode.DecodeError) as raised:
        decode.decode_mono(str(FIXTURES / "sine.wav"))

    assert str(raised.value) == "ffmpeg failed (1): bad [31mfile"


@needs_ffmpeg
def test_decoding_leaves_the_file_as_it_was(tmp_path: Path, ffmpeg: None) -> None:
    pytest.importorskip("numpy")
    path = tmp_path / "sine.mp3"
    shutil.copyfile(FIXTURES / "sine.mp3", path)
    before = (path.read_bytes(), path.stat().st_mtime_ns)

    decode.decode_mono(str(path))

    assert (path.read_bytes(), path.stat().st_mtime_ns) == before


@needs_ffmpeg
def test_measures_the_tempo_and_key_of_a_generated_house_loop(tmp_path: Path, ffmpeg: None) -> None:
    pytest.importorskip("essentia")
    path = tmp_path / "loop.wav"
    write_house_loop(path)

    result = bpm_key.analyze_file(str(path), 85, 175)

    assert round(result["bpm"]) == 124
    assert (result["camelot"], result["musical"]) == ("8A", "Am")
    assert (result["keyName"], result["scale"]) == ("A", "minor")
    assert result["analyzerVersion"] == bpm_key.ANALYZER_VERSION
    assert set(result) == {
        "bpm",
        "rawBpm",
        "bpmConfidence",
        "keyName",
        "scale",
        "keyStrength",
        "camelot",
        "musical",
        "analyzerVersion",
    }


@needs_ffmpeg
def test_refuses_audio_that_is_too_short_to_have_a_tempo(ffmpeg: None) -> None:
    pytest.importorskip("essentia")

    with pytest.raises(ValueError, match="too short"):
        bpm_key.analyze_file(str(FIXTURES / "sine.wav"), 85, 175)
