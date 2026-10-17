from __future__ import annotations

import math
from collections.abc import Iterator
from pathlib import Path

import numpy
import pytest
import soundfile

from fixlib_py import server
from fixlib_py.analysis import decode, loudness

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"

needs_ffmpeg = pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin")

# As ffmpeg 9 prints it, the frame lines of an older build above the summary.
SUMMARY = """\
[Parsed_ebur128_0 @ 0x9a502c900] t: 0.1      TARGET:-23 LUFS    M: -12.0 S:-120.7     I: -12.0 LUFS
[Parsed_ebur128_0 @ 0x9a502c900] Summary:

  Integrated loudness:
    I:         -11.1 LUFS
    Threshold: -21.2 LUFS

  Loudness range:
    LRA:         4.3 LU
    Threshold: -31.2 LUFS
    LRA low:   -13.0 LUFS
    LRA high:   -8.7 LUFS

  True peak:
    Peak:       -0.4 dBFS
[out#0/null @ 0x9a502c180] video:0KiB audio:18KiB subtitle:0KiB other streams:0KiB
"""


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))


def music(seconds: float = 8.0, rate: int = 44_100, level: float = 1.0) -> numpy.ndarray:
    """A stereo signal with something of the spectrum of a track: tones and noise."""
    rng = numpy.random.default_rng(7)
    time = numpy.arange(int(rate * seconds)) / rate
    left = 0.2 * numpy.sin(2 * numpy.pi * 55 * time) + 0.1 * numpy.sin(2 * numpy.pi * 880 * time)
    noise = rng.normal(0, 0.05, (time.size, 2))
    return level * (numpy.column_stack([left, left * 0.9]) + noise)


def write(path: Path, samples: numpy.ndarray, subtype: str = "PCM_24") -> Path:
    soundfile.write(path, samples, 44_100, subtype=subtype)
    return path


class TestParseSummary:
    def test_reads_the_values_of_the_summary_only(self) -> None:
        # Act
        values = loudness.parse_summary(SUMMARY)

        # Assert
        assert values == {"integratedLufs": -11.1, "lra": 4.3, "truePeakDbtp": -0.4}

    def test_reads_a_peak_of_minus_infinity(self) -> None:
        # Arrange
        log = SUMMARY.replace("Peak:       -0.4 dBFS", "Peak:       -inf dBFS")

        # Act
        values = loudness.parse_summary(log)

        # Assert
        assert values["truePeakDbtp"] == -math.inf

    @pytest.mark.parametrize(
        "log",
        ["", "Summary:\n  Integrated loudness:\n    I: -11.1 LUFS\n", SUMMARY.split("Summary:")[0]],
    )
    def test_refuses_a_log_without_a_whole_summary(self, log: str) -> None:
        # Act / Assert
        with pytest.raises(loudness.LoudnessError):
            loudness.parse_summary(log)


class TestJudge:
    def test_takes_a_measured_track(self) -> None:
        # Act
        result = loudness.judge({"integratedLufs": -11.1, "lra": 4.3, "truePeakDbtp": -0.4})

        # Assert
        assert result == {
            "status": "measured",
            "integratedLufs": -11.1,
            "truePeakDbtp": -0.4,
            "lra": 4.3,
        }

    @pytest.mark.parametrize(
        "values",
        [
            {"integratedLufs": -70.0, "lra": 0.0, "truePeakDbtp": -10.5},
            {"integratedLufs": -11.0, "lra": 0.0, "truePeakDbtp": -math.inf},
            {"integratedLufs": math.nan, "lra": 0.0, "truePeakDbtp": -3.0},
        ],
    )
    def test_calls_a_silent_track_unreadable(self, values: dict[str, float]) -> None:
        # Act
        result = loudness.judge(values)

        # Assert
        assert result == {"status": "unreadable", "reason": "silent"}


@needs_ffmpeg
@pytest.mark.usefixtures("ffmpeg")
class TestMeasure:
    def test_measures_six_lu_between_a_signal_and_it_six_db_lower(self, tmp_path: Path) -> None:
        # Arrange
        loud = write(tmp_path / "loud.wav", music())
        quiet = write(tmp_path / "quiet.wav", music(level=10 ** (-6 / 20)))

        # Act
        first = loudness.loudness(str(loud), "job-1")
        second = loudness.loudness(str(quiet), "job-2")

        # Assert
        assert first["status"] == second["status"] == "measured"
        assert first["integratedLufs"] - second["integratedLufs"] == pytest.approx(6.0, abs=0.1)
        assert first["truePeakDbtp"] - second["truePeakDbtp"] == pytest.approx(6.0, abs=0.2)

    @pytest.mark.parametrize(("name", "subtype"), [("a.wav", "PCM_16"), ("a.aiff", "PCM_24")])
    def test_agrees_with_pyloudnorm_within_a_fifth_of_a_unit(
        self, tmp_path: Path, name: str, subtype: str
    ) -> None:
        # Arrange
        import pyloudnorm

        samples = music(seconds=12)
        path = write(tmp_path / name, samples, subtype)
        read, rate = soundfile.read(path)
        expected = pyloudnorm.Meter(rate).integrated_loudness(read)

        # Act
        result = loudness.loudness(str(path), "job-1")

        # Assert
        assert result["integratedLufs"] == pytest.approx(expected, abs=0.2)

    def test_measures_an_mp3(self, tmp_path: Path) -> None:
        # Arrange
        wav = write(tmp_path / "long.wav", music(), "PCM_16")
        mp3 = tmp_path / "long.mp3"
        decode.run_tool(
            [str(FFMPEG), "-v", "error", "-i", str(wav), "-c:a", "libmp3lame", str(mp3)],
            data=b"",
            timeout=60,
        )

        # Act
        result = loudness.loudness(str(mp3), "job-1")

        # Assert
        assert result["status"] == "measured"
        assert math.isfinite(result["integratedLufs"])
        assert math.isfinite(result["truePeakDbtp"])

    def test_calls_a_silent_file_unreadable(self, tmp_path: Path) -> None:
        # Arrange
        path = write(tmp_path / "silence.wav", numpy.zeros((44_100 * 3, 2)))

        # Act
        result = loudness.loudness(str(path), "job-1")

        # Assert
        assert result == {"status": "unreadable", "reason": "silent"}

    def test_calls_a_damaged_file_unreadable(self, tmp_path: Path) -> None:
        # Arrange
        path = tmp_path / "broken.mp3"
        path.write_bytes(b"\x00" * 4096)

        # Act
        result = loudness.loudness(str(path), "job-1")

        # Assert
        assert result["status"] == "unreadable"

    def test_calls_a_file_of_another_format_unreadable(self, tmp_path: Path) -> None:
        # Arrange
        path = tmp_path / "a.flac"
        path.write_bytes(b"fLaC")

        # Act
        result = loudness.loudness(str(path), "job-1")

        # Assert
        assert result == {"status": "unreadable", "reason": "format"}


def test_refuses_a_relative_path() -> None:
    # Act / Assert
    with pytest.raises(ValueError):
        loudness.loudness("a.wav", "job-1")
