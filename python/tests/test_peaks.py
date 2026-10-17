from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from pathlib import Path

import numpy
import pytest
import soundfile

from fixlib_py import server
from fixlib_py.analysis import decode, peaks

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"

needs_ffmpeg = pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin")


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    made = tmp_path / "peaks"
    made.mkdir()
    monkeypatch.setenv(peaks.PEAKS_DIR_ENV, str(made))
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))
    return made


def test_keeps_the_highest_level_of_every_hundredth_of_a_second() -> None:
    # Arrange: a block at half scale, a silent one, and a short last one at full scale.
    samples = numpy.concatenate(
        [
            numpy.full(441, 16384, dtype=numpy.int16),
            numpy.zeros(441, dtype=numpy.int16),
            numpy.full(100, -32768, dtype=numpy.int16),
        ]
    )

    # Act
    levels = peaks.peaks_of(samples)

    # Assert
    assert levels == [500, 0, 1000]


@pytest.mark.parametrize("track_id", [0, -1, True, 1.5, "7"])
def test_names_peaks_by_a_positive_track_id_only(track_id: object) -> None:
    # Act / Assert
    with pytest.raises(ValueError):
        peaks.peaks_name(track_id)  # type: ignore[arg-type]


@needs_ffmpeg
def test_writes_the_peaks_of_a_track_with_the_file_it_was_made_of(
    tmp_path: Path, folder: Path
) -> None:
    # Arrange: three seconds, louder in the second one.
    rate = 44_100
    time = numpy.arange(rate * 3) / rate
    level = numpy.where((time >= 1) & (time < 2), 0.8, 0.2)
    path = tmp_path / "a.wav"
    soundfile.write(path, level * numpy.sin(2 * numpy.pi * 220 * time), rate, subtype="PCM_16")

    # Act
    result = peaks.peaks(str(path), 7, "job-1", 12_345, 1_700_000_000_000)

    # Assert
    written = json.loads((folder / "7.json").read_text())
    assert result["file"] == "7.json"
    assert written["version"] == 1
    assert written["peaksPerSecond"] == 100
    assert written["durationSeconds"] == pytest.approx(3, abs=0.01)
    assert (written["fileSizeBytes"], written["fileMtimeMs"]) == (12_345, 1_700_000_000_000)
    assert len(written["peaks"]) == 300
    assert max(written["peaks"][120:180]) == pytest.approx(800, abs=10)
    assert max(written["peaks"][:80]) == pytest.approx(200, abs=10)
    assert [entry.name for entry in folder.iterdir()] == ["7.json"]


def test_refuses_without_a_peaks_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Arrange
    monkeypatch.setenv(peaks.PEAKS_DIR_ENV, str(tmp_path / "missing"))

    # Act / Assert
    with pytest.raises(ValueError):
        peaks.write_peaks("1.json", {}, threading.Event())
