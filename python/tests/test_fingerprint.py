from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from test_bpm_key import write_house_loop

from fixlib_py import fingerprint, server
from fixlib_py.analysis import decode

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "synthetic"
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"
FPCALC = ROOT / "resources" / "bin" / "fpcalc"

needs_tools = pytest.mark.skipif(
    not FFMPEG.is_file() or not FPCALC.is_file(), reason="needs resources/bin"
)


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))
    monkeypatch.setenv(fingerprint.FPCALC_ENV, str(FPCALC))


def fake_fpcalc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, script: str) -> None:
    fake = tmp_path / "fpcalc"
    fake.write_text(f"#!/bin/sh\ncat > /dev/null\n{script}\n")
    fake.chmod(0o755)
    monkeypatch.setenv(fingerprint.FPCALC_ENV, str(fake))


def test_refuses_a_path_that_is_not_absolute() -> None:
    with pytest.raises(ValueError, match="absolute"):
        fingerprint.compute("track.mp3", "job-1")


def test_a_job_that_was_cancelled_before_it_started_reads_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(fingerprint, "read_file_tags", lambda path: pytest.fail("must not read"))
    server.cancel_job("job-1")

    with pytest.raises(server.JobCancelled):
        fingerprint.compute("/music/track.mp3", "job-1")


def test_refuses_an_fpcalc_that_the_app_did_not_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(fingerprint.FPCALC_ENV, "fpcalc")

    with pytest.raises(decode.DecodeError, match="FIXLIB_FPCALC"):
        fingerprint.fingerprint_of_wav(b"RIFF")


@pytest.mark.parametrize(
    "output",
    [
        "not json",
        "[]",
        '{"duration": 1}',
        '{"fingerprint": ""}',
        '{"fingerprint": 7}',
        '{"fingerprint": "AQAA; rm -rf"}',
        json.dumps({"fingerprint": "A" * 8193}),
    ],
)
def test_refuses_output_that_is_no_fingerprint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, output: str
) -> None:
    fake_fpcalc(tmp_path, monkeypatch, f"printf '%s' '{output}'")

    with pytest.raises(decode.DecodeError, match="no fingerprint"):
        fingerprint.fingerprint_of_wav(b"RIFF")


def test_reports_an_fpcalc_that_fails_without_quoting_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_fpcalc(tmp_path, monkeypatch, "echo 'ERROR: secret detail' >&2; exit 2")

    with pytest.raises(decode.DecodeError) as raised:
        fingerprint.fingerprint_of_wav(b"RIFF")

    assert str(raised.value) == "fpcalc failed (2)"


def test_a_job_that_is_told_to_stop_ends_its_tool_at_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    marker = tmp_path / "pid"
    slow = tmp_path / "ffmpeg"
    slow.write_text(f"#!/bin/sh\necho $$ > {marker}\nexec /bin/sleep 30\n")
    slow.chmod(0o755)
    monkeypatch.setenv(decode.FFMPEG_ENV, str(slow))
    monkeypatch.setattr(fingerprint, "read_file_tags", lambda path: {"durationMs": 20_000})
    threading.Timer(0.5, lambda: server.cancel_job("job-1")).start()
    started = time.monotonic()

    with pytest.raises(server.JobCancelled):
        fingerprint.compute(str(FIXTURES / "sine.wav"), "job-1")

    assert time.monotonic() - started < 5
    # The tool is gone, not left to run out its thirty seconds.
    with pytest.raises(ProcessLookupError):
        os.kill(int(marker.read_text()), 0)


def test_a_tool_that_takes_too_long_is_ended(tmp_path: Path) -> None:
    started = time.monotonic()

    with pytest.raises(decode.DecodeError, match="sleep did not finish in time"):
        decode.run_tool(["/bin/sleep", "30"], timeout=0.5)

    assert time.monotonic() - started < 5


def test_a_tool_gets_its_input_once_and_its_output_is_returned_whole() -> None:
    data = b"x" * 5_000_000

    done = decode.run_tool(["/bin/cat"], data=data, timeout=30)

    assert done.returncode == 0
    assert done.stdout == data


@needs_tools
def test_fingerprints_a_track_and_reports_its_whole_length(tmp_path: Path, tools: None) -> None:
    path = tmp_path / "loop.wav"
    write_house_loop(path, seconds=20)

    result = fingerprint.compute(str(path), "job-1")

    assert result["duration"] == 20
    assert fingerprint._FINGERPRINT.match(result["fingerprint"])
    assert set(result) == {"fingerprint", "duration"}
    assert server._jobs == {}


@needs_tools
def test_the_fingerprint_is_the_one_fpcalc_makes_of_the_file_itself(
    tmp_path: Path, tools: None
) -> None:
    path = tmp_path / "loop.wav"
    write_house_loop(path, seconds=20)
    direct = subprocess.run(
        [str(FPCALC), "-json", "-length", "120", str(path)],
        capture_output=True,
        check=True,
    )

    result = fingerprint.compute(str(path), "job-1")

    assert result["fingerprint"] == json.loads(direct.stdout)["fingerprint"]


@needs_tools
def test_fails_a_file_too_short_for_a_fingerprint(tools: None) -> None:
    with pytest.raises(decode.DecodeError, match="fpcalc failed"):
        fingerprint.compute(str(FIXTURES / "sine.wav"), "job-1")


@needs_tools
def test_fingerprinting_leaves_the_file_as_it_was(tmp_path: Path, tools: None) -> None:
    path = tmp_path / "loop.wav"
    write_house_loop(path, seconds=20)
    copy = tmp_path / "copy.wav"
    shutil.copyfile(path, copy)
    before = (path.read_bytes(), path.stat().st_mtime_ns)

    fingerprint.compute(str(path), "job-1")

    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
