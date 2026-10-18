from __future__ import annotations

import hashlib
import os
import shutil
import struct
import threading
from collections.abc import Iterator
from pathlib import Path

import numpy
import pytest
import soundfile
from mutagen.aiff import AIFF
from mutagen.id3 import APIC, ID3, TIT2, TPE1

from fixlib_py import normalize, server
from fixlib_py.analysis import decode, loudness

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"
MP3GAIN = ROOT / "resources" / "bin" / "mp3gain"

needs_ffmpeg = pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin")
needs_mp3gain = pytest.mark.skipif(
    not (FFMPEG.is_file() and MP3GAIN.is_file()), reason="needs resources/bin"
)
COVER = b"\xff\xd8\xff\xe0" + b"cover" * 200


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))
    monkeypatch.setenv(normalize.MP3GAIN_ENV, str(MP3GAIN))


def music(seconds: float = 6.0, rate: int = 44_100, level: float = 0.5) -> numpy.ndarray:
    rng = numpy.random.default_rng(3)
    time = numpy.arange(int(rate * seconds)) / rate
    tone = 0.3 * numpy.sin(2 * numpy.pi * 110 * time) + 0.1 * numpy.sin(2 * numpy.pi * 1500 * time)
    return level * (numpy.column_stack([tone, tone]) + rng.normal(0, 0.03, (time.size, 2)))


def temp_for(path: Path) -> Path:
    return path.with_name(f".{path.name}.0a1b2c3d.fixlib-tmp")


def tag(path: Path) -> None:
    """Gives an MP3 an ID3v2.3 tag with a title, an artist and a cover."""
    tags = ID3()
    tags.add(TIT2(encoding=3, text="Title"))
    tags.add(TPE1(encoding=3, text="Artist"))
    tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=COVER))
    tags.save(path, v2_version=3)


def mp3_of(tmp_path: Path, name: str = "a.mp3") -> Path:
    wav = tmp_path / "source.wav"
    soundfile.write(wav, music(), 44_100, subtype="PCM_16")
    mp3 = tmp_path / name
    done = decode.run_tool(
        [
            str(FFMPEG),
            "-v",
            "error",
            "-i",
            str(wav),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "256k",
            str(mp3),
        ],
        data=b"",
        timeout=60,
    )
    assert done.returncode == 0
    tag(mp3)
    return mp3


def measured(path: Path) -> dict[str, float]:
    """The loudness of a file, also of a temp file, whose name says no format."""
    named = path
    if path.name.endswith(".fixlib-tmp"):
        named = path.with_name(f"measured.{path.name.split('.')[2]}")
        shutil.copyfile(path, named)
    result = loudness.measure_file(str(named))
    assert result["status"] == "measured"
    return result


def frames_of(path: Path) -> list[int]:
    """The sizes of the MPEG frames of an MP3, after its ID3v2 tag."""
    data = path.read_bytes()
    offset = 0
    if data[:3] == b"ID3":
        size = 0
        for byte in data[6:10]:
            size = (size << 7) | byte
        offset = 10 + size
    bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    sizes = []
    while offset + 4 <= len(data) and data[offset] == 0xFF and data[offset + 1] & 0xE0 == 0xE0:
        bitrate = bitrates[data[offset + 2] >> 4] * 1000
        padding = (data[offset + 2] >> 1) & 1
        size = 144 * bitrate // 44_100 + padding
        sizes.append(size)
        offset += size
    return sizes


class TestCheckPlan:
    @pytest.mark.parametrize(
        "plan",
        [
            None,
            {"kind": "limit", "gainDb": 3},
            {"kind": "mp3gain", "steps": 0},
            {"kind": "mp3gain", "steps": 1.5},
            {"kind": "mp3gain", "steps": True},
            {"kind": "mp3gain", "steps": 40},
            {"kind": "pcm", "gainDb": 0},
            {"kind": "pcm", "gainDb": float("nan")},
            {"kind": "reencode", "gainDb": 41},
        ],
    )
    def test_refuses_a_plan_the_app_never_makes(self, plan: object) -> None:
        # Act / Assert
        with pytest.raises(ValueError):
            normalize._check_plan(plan)

    def test_takes_a_plan_of_steps(self) -> None:
        # Act
        plan = normalize._check_plan({"kind": "mp3gain", "steps": -2})

        # Assert
        assert plan == {"kind": "mp3gain", "steps": -2}


@needs_ffmpeg
@pytest.mark.usefixtures("tools")
class TestPcm:
    @pytest.mark.parametrize(
        ("name", "subtype", "gain"),
        [
            ("a.aiff", "PCM_24", -4.3),
            ("a.aiff", "PCM_16", 2.7),
            ("a.wav", "PCM_16", -6.0),
            ("a.wav", "PCM_24", 3.1),
        ],
    )
    def test_changes_the_loudness_by_the_exact_gain(
        self, tmp_path: Path, name: str, subtype: str, gain: float
    ) -> None:
        # Arrange
        source = tmp_path / name
        soundfile.write(source, music(level=0.3), 44_100, subtype=subtype)
        before = measured(source)
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": gain}, "job-1")

        # Assert
        after = measured(dst)
        assert after["integratedLufs"] - before["integratedLufs"] == pytest.approx(gain, abs=0.2)
        info = soundfile.info(dst)
        assert (info.subtype, info.channels, info.frames) == (subtype, 2, 6 * 44_100)

    def test_keeps_every_byte_outside_the_samples(self, tmp_path: Path) -> None:
        # Arrange
        source = tmp_path / "a.aiff"
        soundfile.write(source, music(level=0.3), 44_100, subtype="PCM_24")
        tags = AIFF(source)
        tags.add_tags()
        tags.tags.add(TIT2(encoding=3, text="Title"))
        tags.tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=COVER))
        tags.save(v2_version=3)
        original = source.read_bytes()
        start, length, _, _ = normalize._pcm_layout(open(source, "rb"))  # noqa: SIM115
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": -3.0}, "job-1")

        # Assert
        written = dst.read_bytes()
        assert len(written) == len(original)
        assert written[:start] == original[:start]
        assert written[start + length :] == original[start + length :]
        assert written[start : start + length] != original[start : start + length]
        assert str(AIFF(dst).tags["TIT2"]) == "Title"
        assert AIFF(dst).tags.getall("APIC")[0].data == COVER

    def test_refuses_a_depth_it_does_not_normalize(self, tmp_path: Path) -> None:
        # Arrange
        source = tmp_path / "a.wav"
        soundfile.write(source, music(level=0.3), 44_100, subtype="FLOAT")
        dst = temp_for(source)

        # Act / Assert
        with pytest.raises(normalize.Refused):
            normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": -3.0}, "job-1")
        assert not dst.exists()


@needs_mp3gain
@pytest.mark.usefixtures("tools")
class TestMp3gain:
    def test_changes_the_gain_in_steps_without_encoding_again(self, tmp_path: Path) -> None:
        # Arrange
        source = mp3_of(tmp_path)
        before = measured(source)
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "mp3gain", "steps": -3}, "job-1")

        # Assert
        after = measured(dst)
        assert after["integratedLufs"] - before["integratedLufs"] == pytest.approx(-4.5, abs=0.2)
        assert frames_of(dst) == frames_of(source)
        assert len(frames_of(dst)) > 100
        assert os.path.getsize(dst) == os.path.getsize(source)

    def test_writes_no_ape_tag_and_keeps_the_id3_tag(self, tmp_path: Path) -> None:
        # Arrange
        source = mp3_of(tmp_path)
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "mp3gain", "steps": 2}, "job-1")

        # Assert
        assert b"APETAGEX" not in dst.read_bytes()
        tags = ID3(dst)
        assert str(tags["TIT2"]) == "Title"
        assert tags.getall("APIC")[0].data == COVER

    def test_refuses_a_plan_for_another_format(self, tmp_path: Path) -> None:
        # Arrange
        source = tmp_path / "a.aiff"
        soundfile.write(source, music(), 44_100, subtype="PCM_16")
        dst = temp_for(source)

        # Act / Assert
        with pytest.raises(normalize.Refused):
            normalize.apply(str(source), str(dst), {"kind": "mp3gain", "steps": 1}, "job-1")
        assert not dst.exists()


@needs_ffmpeg
@pytest.mark.usefixtures("tools")
class TestReencode:
    def test_reaches_the_exact_gain_and_keeps_the_tag_and_cover(self, tmp_path: Path) -> None:
        # Arrange
        source = mp3_of(tmp_path)
        before = measured(source)
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "reencode", "gainDb": -2.2}, "job-1")

        # Assert
        after = measured(dst)
        assert after["integratedLufs"] - before["integratedLufs"] == pytest.approx(-2.2, abs=0.2)
        tags = ID3(dst)
        assert (str(tags["TIT2"]), str(tags["TPE1"])) == ("Title", "Artist")
        assert tags.getall("APIC")[0].data == COVER
        assert tags.version[:2] == (2, 3)
        assert b"APETAGEX" not in dst.read_bytes()

    def test_removes_what_it_made_when_the_file_cannot_be_read(self, tmp_path: Path) -> None:
        # Arrange
        source = tmp_path / "a.mp3"
        source.write_bytes(b"\x00" * 4096)
        dst = temp_for(source)

        # Act / Assert
        with pytest.raises(normalize.Refused):
            normalize.apply(str(source), str(dst), {"kind": "reencode", "gainDb": 2.0}, "job-1")
        assert not dst.exists()


def test_writes_only_to_a_temp_file_of_the_app(tmp_path: Path) -> None:
    # Arrange
    source = tmp_path / "a.mp3"
    source.write_bytes(b"\x00")

    # Act / Assert
    with pytest.raises(ValueError):
        normalize.apply(str(source), str(tmp_path / "b.mp3"), {"kind": "pcm", "gainDb": 1}, "j")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@needs_ffmpeg
@pytest.mark.usefixtures("tools")
class TestPcmEdges:
    def test_reads_the_longer_header_of_a_24_bit_wav(self, tmp_path: Path) -> None:
        # Arrange
        source = tmp_path / "a.wav"
        soundfile.write(source, music(level=0.3), 44_100, subtype="PCM_24", format="WAVEX")
        before = measured(source)
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": -2.5}, "job-1")

        # Assert
        assert measured(dst)["integratedLufs"] - before["integratedLufs"] == pytest.approx(
            -2.5, abs=0.2
        )

    def test_finds_the_samples_after_a_chunk_of_odd_length(self, tmp_path: Path) -> None:
        # Arrange: a chunk of three bytes, and its pad byte, before the samples.
        plain = tmp_path / "plain.wav"
        soundfile.write(plain, music(level=0.3), 44_100, subtype="PCM_16")
        data = plain.read_bytes()
        at = data.index(b"data")
        odd = b"junk" + struct.pack("<I", 3) + b"abc" + b"\x00"
        built = data[:at] + odd + data[at:]
        source = tmp_path / "a.wav"
        source.write_bytes(built[:4] + struct.pack("<I", len(built) - 8) + built[8:])
        before = measured(source)
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": -3.0}, "job-1")

        # Assert
        written = dst.read_bytes()
        head = at + len(odd) + 8
        assert written[:head] == source.read_bytes()[:head]
        assert measured(dst)["integratedLufs"] - before["integratedLufs"] == pytest.approx(
            -3.0, abs=0.2
        )

    def test_keeps_digital_silence_silent_at_16_bit(self, tmp_path: Path) -> None:
        # Arrange
        samples = music(level=0.3)
        samples[: 44_100 * 2] = 0
        source = tmp_path / "a.wav"
        soundfile.write(source, samples, 44_100, subtype="PCM_16")
        dst = temp_for(source)

        # Act
        normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": 3.0}, "job-1")

        # Assert
        written, _ = soundfile.read(path_named(dst, "out.wav"), dtype="int16")
        assert not written[: 44_100 * 2].any()

    def test_refuses_an_aiff_whose_samples_are_cut_short(self, tmp_path: Path) -> None:
        # Arrange
        whole = tmp_path / "whole.aiff"
        soundfile.write(whole, music(level=0.3), 44_100, subtype="PCM_16")
        source = tmp_path / "a.aiff"
        source.write_bytes(whole.read_bytes()[:-100_000])
        dst = temp_for(source)

        # Act / Assert
        with pytest.raises(normalize.Refused):
            normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": -3.0}, "job-1")
        assert not dst.exists()

    def test_leaves_the_source_as_it_was(self, tmp_path: Path) -> None:
        # Arrange
        source = tmp_path / "a.aiff"
        soundfile.write(source, music(level=0.3), 44_100, subtype="PCM_24")
        before = sha256(source)

        # Act
        normalize.apply(str(source), str(temp_for(source)), {"kind": "pcm", "gainDb": 2}, "job-1")

        # Assert
        assert sha256(source) == before


@needs_mp3gain
@pytest.mark.usefixtures("tools")
class TestMp3Edges:
    @pytest.mark.parametrize("kind", ["mp3gain", "reencode"])
    def test_leaves_the_source_as_it_was(self, tmp_path: Path, kind: str) -> None:
        # Arrange
        source = mp3_of(tmp_path)
        before = sha256(source)
        plan = {"kind": kind, "steps": 1} if kind == "mp3gain" else {"kind": kind, "gainDb": 1.0}

        # Act
        normalize.apply(str(source), str(temp_for(source)), plan, "job-1")

        # Assert
        assert sha256(source) == before

    def test_refuses_to_encode_again_an_mp3_with_an_id3v1_tag_only(self, tmp_path: Path) -> None:
        # Arrange
        source = mp3_of(tmp_path)
        ID3(source).delete(source)
        source.write_bytes(source.read_bytes() + b"TAG" + b"\x00" * 125)
        dst = temp_for(source)

        # Act / Assert
        with pytest.raises(normalize.Refused):
            normalize.apply(str(source), str(dst), {"kind": "reencode", "gainDb": 1.0}, "job-1")
        assert not dst.exists()

    def test_refuses_a_tag_of_too_many_frames(self, tmp_path: Path) -> None:
        # Arrange: six thousand empty text frames.
        source = mp3_of(tmp_path)
        audio = source.read_bytes()
        audio = audio[10 + int.from_bytes(bytes(b & 0x7F for b in audio[6:10]), "big") :]
        frames = (b"TXXX" + struct.pack(">I", 1) + b"\x00\x00" + b"\x00") * 6000
        size = len(frames)
        safe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
        source.write_bytes(b"ID3\x03\x00\x00" + safe + frames + audio)
        dst = temp_for(source)

        # Act / Assert
        with pytest.raises(normalize.Refused):
            normalize.apply(str(source), str(dst), {"kind": "reencode", "gainDb": 1.0}, "job-1")
        assert not dst.exists()


def path_named(path: Path, name: str) -> Path:
    """A copy of a temp file under a name that says its format."""
    named = path.with_name(name)
    shutil.copyfile(path, named)
    return named


def test_a_job_cancelled_before_it_started_writes_nothing(tmp_path: Path) -> None:
    # Arrange
    source = tmp_path / "a.wav"
    soundfile.write(source, music(level=0.3), 44_100, subtype="PCM_16")
    dst = temp_for(source)
    server.cancel_job("job-1")

    # Act / Assert
    with pytest.raises(server.JobCancelled):
        normalize.apply(str(source), str(dst), {"kind": "pcm", "gainDb": 1.0}, "job-1")
    assert not dst.exists()


def test_a_job_stopped_while_mp3gain_works_ends_it_and_removes_the_temp_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Arrange: stands in for mp3gain, and works on for a long time.
    fake = tmp_path / "mp3gain"
    fake.write_text("#!/bin/sh\nsleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setenv(normalize.MP3GAIN_ENV, str(fake))
    source = tmp_path / "a.mp3"
    source.write_bytes(b"\xff\xfb" + b"\x00" * 4096)
    dst = temp_for(source)
    threading.Timer(0.5, lambda: server.cancel_job("job-1")).start()

    # Act / Assert
    with pytest.raises(server.JobCancelled):
        normalize.apply(str(source), str(dst), {"kind": "mp3gain", "steps": 1}, "job-1")
    assert not dst.exists()
