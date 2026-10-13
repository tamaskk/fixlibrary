from __future__ import annotations

import hashlib
import os
import struct
import threading
import zlib
from collections.abc import Iterator
from pathlib import Path

import numpy
import pytest
import soundfile
from mutagen.aiff import AIFF
from mutagen.id3 import APIC, TDRC, TIT2, TPE1
from mutagen.wave import WAVE

from fixlib_py import convert, server
from fixlib_py.analysis import decode
from fixlib_py.tags import read_file_tags

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"

needs_ffmpeg = pytest.mark.skipif(not FFMPEG.is_file(), reason="needs resources/bin")


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


@pytest.fixture
def ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(decode.FFMPEG_ENV, str(FFMPEG))


def write_wav(path: Path, rate: int, subtype: str, seconds: float = 1.5, channels: int = 2) -> None:
    """A tone of a known length, as libsndfile writes the subtype."""
    time = numpy.arange(int(rate * seconds)) / rate
    tone = 0.5 * numpy.sin(2 * numpy.pi * 440 * time)
    soundfile.write(path, numpy.column_stack([tone] * channels), rate, subtype=subtype)


def temp_for(path: Path) -> Path:
    """A name as the app's file rules give a temp file."""
    return path.with_name(f".{path.name}.0a1b2c3d.fixlib-tmp")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@needs_ffmpeg
@pytest.mark.parametrize(
    ("rate", "subtype", "wanted_rate", "wanted_subtype", "wanted_depth"),
    [
        (44_100, "PCM_16", 44_100, "PCM_16", 16),
        (48_000, "PCM_16", 48_000, "PCM_16", 16),
        (44_100, "PCM_24", 44_100, "PCM_24", 24),
        (96_000, "PCM_24", 48_000, "PCM_24", 24),
        (88_200, "PCM_16", 48_000, "PCM_16", 16),
        (48_000, "FLOAT", 48_000, "PCM_24", 24),
        (44_100, "PCM_32", 44_100, "PCM_24", 24),
        (96_000, "DOUBLE", 48_000, "PCM_24", 24),
        (44_100, "PCM_U8", 44_100, "PCM_16", 16),
        # A rate below 44.1 kHz is left as it is: only what is above 48 kHz comes down.
        (22_050, "PCM_16", 22_050, "PCM_16", 16),
    ],
)
def test_converts_a_wav_to_an_aiff_of_the_right_rate_and_depth(
    ffmpeg: None,
    tmp_path: Path,
    rate: int,
    subtype: str,
    wanted_rate: int,
    wanted_subtype: str,
    wanted_depth: int,
) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, rate, subtype)
    before = sha256(src)
    dst = temp_for(src)

    result = convert.wav_to_aiff(str(src), str(dst), "job-1")

    info = soundfile.info(dst)
    assert (info.format, info.samplerate, info.subtype) == ("AIFF", wanted_rate, wanted_subtype)
    assert info.channels == 2
    assert abs(info.duration * 1000 - 1500) <= 10
    assert result == {
        "sampleRateHz": wanted_rate,
        "bitDepth": wanted_depth,
        "channels": 2,
        "durationMs": 1500,
        "converted": True,
        "tagsLost": [],
    }
    # The source is read, never written.
    assert sha256(src) == before
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted([src.name, dst.name])


@needs_ffmpeg
def test_keeps_the_samples_of_a_16_bit_file_as_they_are(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    dst = temp_for(src)

    convert.wav_to_aiff(str(src), str(dst), "job-1")

    before, _ = soundfile.read(src, dtype="int16")
    after, _ = soundfile.read(dst, dtype="int16")
    assert numpy.array_equal(before, after)


@needs_ffmpeg
def test_carries_the_riff_info_texts_into_the_aiff_as_id3v2_3(ffmpeg: None, tmp_path: Path) -> None:
    plain = tmp_path / "plain.wav"
    write_wav(plain, 44_100, "PCM_16")
    src = tmp_path / "track.wav"
    # libsndfile writes these as a RIFF INFO list.
    with (
        soundfile.SoundFile(plain) as source,
        soundfile.SoundFile(src, "w", 44_100, 2, "PCM_16") as tagged,
    ):
        tagged.artist = "Bicep"
        tagged.title = "Glue"
        tagged.album = "Isles"
        tagged.write(source.read())
    dst = temp_for(src)

    convert.wav_to_aiff(str(src), str(dst), "job-1")

    # The app's own reader does not see RIFF INFO in a WAV; in the AIFF it sees the tags.
    assert read_file_tags(str(src))["artist"] is None
    aiff = dst.with_suffix(".aiff")
    dst.rename(aiff)
    tags = read_file_tags(str(aiff))
    assert (tags["artist"], tags["title"], tags["album"]) == ("Bicep", "Glue", "Isles")
    assert AIFF(aiff).tags.version[:2] == (2, 3)
    # No line that names the tool that wrote the file.
    assert AIFF(aiff).tags.getall("TSSE") == []


@needs_ffmpeg
def test_carries_the_id3_chunk_of_a_wav_with_its_cover(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_24")
    tagged = WAVE(src)
    tagged.add_tags()
    tagged.tags.add(TPE1(encoding=3, text="Ákos"))
    tagged.tags.add(TIT2(encoding=3, text="Ilyenek voltunk"))
    tagged.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="", data=b"\x89PNG cover"))
    tagged.save()
    dst = temp_for(src)

    convert.wav_to_aiff(str(src), str(dst), "job-1")

    tags = AIFF(dst).tags
    assert str(tags["TPE1"]) == "Ákos"
    assert str(tags["TIT2"]) == "Ilyenek voltunk"
    assert tags.getall("APIC")[0].data == b"\x89PNG cover"
    assert tags.version[:2] == (2, 3)
    # Tags are added after the audio is written; the audio is still what it must be.
    assert soundfile.info(dst).subtype == "PCM_24"


@needs_ffmpeg
def test_copies_a_file_that_is_an_aiff_already(ffmpeg: None, tmp_path: Path) -> None:
    # What a run finds that was stopped after it had written the content: the file
    # still under the name the conversion works on, holding the result.
    wav = tmp_path / "source.wav"
    write_wav(wav, 96_000, "PCM_24")
    first = temp_for(wav)
    convert.wav_to_aiff(str(wav), str(first), "job-1")
    src = tmp_path / "track.aiff"
    first.rename(src)
    dst = temp_for(src)

    result = convert.wav_to_aiff(str(src), str(dst), "job-2")

    assert result == {
        "sampleRateHz": 48_000,
        "bitDepth": 24,
        "channels": 2,
        "durationMs": 1500,
        "converted": False,
        "tagsLost": [],
    }
    assert sha256(dst) == sha256(src)


@needs_ffmpeg
def test_refuses_an_aiff_no_player_takes_instead_of_passing_it_on(
    ffmpeg: None, tmp_path: Path
) -> None:
    src = tmp_path / "track.aiff"
    time = numpy.arange(96_000) / 96_000
    soundfile.write(src, numpy.sin(time), 96_000, subtype="PCM_24", format="AIFF")
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="player"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@needs_ffmpeg
@pytest.mark.parametrize("content", [b"", b"not audio at all", b"RIFF\x00\x00\x00\x00WAVEjunk"])
def test_refuses_what_is_not_audio_and_leaves_nothing_behind(
    ffmpeg: None, tmp_path: Path, content: bytes
) -> None:
    src = tmp_path / "track.wav"
    src.write_bytes(content)
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert sorted(path.name for path in tmp_path.iterdir()) == [src.name]


@needs_ffmpeg
def test_refuses_a_wav_that_holds_another_kind_of_samples(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 8_000, "ULAW")
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="not a WAV this app converts"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@needs_ffmpeg
def test_removes_what_it_wrote_when_the_result_does_not_match_its_source(
    ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    dst = temp_for(src)
    monkeypatch.setattr(convert, "MAX_LENGTH_DIFFERENCE_MS", -1)

    with pytest.raises(convert.ConvertError, match="does not match"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@pytest.mark.parametrize(
    ("src", "dst", "message"),
    [
        ("track.wav", "/music/.track.wav.0a1b2c3d.fixlib-tmp", "absolute"),
        ("/music/track.wav", ".track.wav.0a1b2c3d.fixlib-tmp", "absolute"),
        # Never a final path, and never a name the app's cleanup would not know as its own.
        ("/music/track.wav", "/music/track.aiff", "temp file"),
        ("/music/track.wav", "/music/track.wav.fixlib-tmp", "temp file"),
        ("/music/track.wav", "/music/.hidden.aiff", "temp file"),
        # Next to the source, where the file rules of the app put it.
        ("/music/track.wav", "/elsewhere/.track.wav.0a1b2c3d.fixlib-tmp", "next to src"),
    ],
)
def test_refuses_paths_it_is_not_meant_to_work_on(src: str, dst: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        convert.wav_to_aiff(src, dst, "job-1")


@needs_ffmpeg
def test_never_writes_over_a_file_that_is_there(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    dst = temp_for(src)
    dst.write_bytes(b"somebody else's")

    with pytest.raises(ValueError, match="must not exist"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert dst.read_bytes() == b"somebody else's"


@needs_ffmpeg
def test_does_not_read_a_source_that_is_a_link(ffmpeg: None, tmp_path: Path) -> None:
    real = tmp_path / "real.wav"
    write_wav(real, 44_100, "PCM_16")
    src = tmp_path / "track.wav"
    os.symlink(real, src)
    dst = temp_for(src)

    with pytest.raises(OSError):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


def test_a_job_that_was_cancelled_before_it_started_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(convert, "convert_file", lambda *_: pytest.fail("must not convert"))
    dst = temp_for(tmp_path / "track.wav")
    server.cancel_job("job-1")

    with pytest.raises(server.JobCancelled):
        convert.wav_to_aiff(str(tmp_path / "track.wav"), str(dst), "job-1")

    assert not dst.exists()


def test_a_job_that_is_stopped_while_ffmpeg_works_ends_it_and_removes_the_temp_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Stands in for ffmpeg: writes the start of a file, then works on for a long time.
    fake = tmp_path / "ffmpeg"
    fake.write_text('#!/bin/sh\nfor last; do :; done\necho partial > "$last"\nsleep 30\n')
    fake.chmod(0o755)
    monkeypatch.setenv(decode.FFMPEG_ENV, str(fake))
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    dst = temp_for(src)
    threading.Timer(0.5, lambda: server.cancel_job("job-1")).start()

    with pytest.raises(server.JobCancelled):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


def add_id3_chunk(path: Path, tag: bytes) -> None:
    """Appends an `id3 ` chunk to a WAV, as a tagger does, and puts the RIFF size right."""
    data = (
        path.read_bytes() + b"id3 " + struct.pack("<I", len(tag)) + tag + b"\x00" * (len(tag) & 1)
    )
    path.write_bytes(data[:4] + struct.pack("<I", len(data) - 8) + data[8:])


def id3v23(frames: bytes) -> bytes:
    size = len(frames)
    synchsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    return b"ID3\x03\x00\x00" + synchsafe + frames


@needs_ffmpeg
def test_writes_the_year_as_a_frame_of_id3v2_3(ffmpeg: None, tmp_path: Path) -> None:
    # A tagger of today writes the year as TDRC, which ID3v2.3 does not know.
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    tagged = WAVE(src)
    tagged.add_tags()
    tagged.tags.add(TDRC(encoding=3, text="2021"))
    tagged.tags.add(TIT2(encoding=3, text="Glue"))
    tagged.save()
    dst = temp_for(src)

    convert.wav_to_aiff(str(src), str(dst), "job-1")

    # The frame ids as they stand in the file, not as a reader translates them.
    raw = dst.read_bytes()
    assert b"TYER" in raw
    assert b"TDRC" not in raw
    assert AIFF(dst).tags.version[:2] == (2, 3)
    aiff = dst.with_suffix(".aiff")
    dst.rename(aiff)
    assert read_file_tags(str(aiff))["year"] == 2021


@needs_ffmpeg
def test_refuses_a_file_whose_tags_hold_a_compressed_frame(ffmpeg: None, tmp_path: Path) -> None:
    # 30 MB of text in 30 kB: unpacked by a tag reader, and written back unpacked.
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    text = b"\x00" + b"A" * (30 * 1024 * 1024)
    packed = struct.pack(">I", len(text)) + zlib.compress(text, 9)
    add_id3_chunk(src, id3v23(b"TIT2" + struct.pack(">I", len(packed)) + b"\x00\x80" + packed))
    before = sha256(src)
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="compressed or encrypted"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    # Refused whole: the WAV is not converted without its tags.
    assert not dst.exists()
    assert sha256(src) == before


@needs_ffmpeg
def test_refuses_an_id3_chunk_that_is_larger_than_a_tag_may_be(
    ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    add_id3_chunk(src, id3v23(b"TIT2" + struct.pack(">I", 5) + b"\x00\x00" + b"\x00Glue"))
    monkeypatch.setattr(convert, "MAX_TAG_BYTES", 16)
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="larger than a tag"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@needs_ffmpeg
def test_refuses_tags_it_cannot_read_instead_of_dropping_them(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    add_id3_chunk(src, b"this is no ID3 tag at all")
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="tags of the file cannot be read"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@needs_ffmpeg
def test_converts_a_small_tagged_wav(ffmpeg: None, tmp_path: Path) -> None:
    # Smaller than what a reader takes in at once: ffmpeg must still get it from its start.
    src = tmp_path / "track.wav"
    write_wav(src, 8_000, "PCM_16", seconds=0.1, channels=1)
    tagged = WAVE(src)
    tagged.add_tags()
    tagged.tags.add(TIT2(encoding=3, text="Glue"))
    tagged.save()
    assert src.stat().st_size < 8192
    dst = temp_for(src)

    result = convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert result["durationMs"] == 100
    assert str(AIFF(dst).tags["TIT2"]) == "Glue"


@needs_ffmpeg
def test_converts_a_wav_with_the_longer_header_most_24_bit_files_have(
    ffmpeg: None, tmp_path: Path
) -> None:
    src = tmp_path / "track.wav"
    time = numpy.arange(72_000) / 48_000
    tone = 0.5 * numpy.sin(2 * numpy.pi * 440 * time)
    soundfile.write(src, numpy.column_stack([tone, tone]), 48_000, subtype="PCM_24", format="WAVEX")
    dst = temp_for(src)

    result = convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert (result["sampleRateHz"], result["bitDepth"], result["durationMs"]) == (48_000, 24, 1500)
    before, _ = soundfile.read(src, dtype="int32")
    after, _ = soundfile.read(dst, dtype="int32")
    assert numpy.array_equal(before, after)


@pytest.mark.parametrize("magic", [b"fLaC", b"OggS", b"ID3\x03", b"RF64\x00\x00\x00\x00WAVE"])
def test_gives_no_parser_a_file_that_is_no_wav_by_its_first_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, magic: bytes
) -> None:
    src = tmp_path / "track.wav"
    src.write_bytes(magic + b"\x00" * 64)
    monkeypatch.setattr(convert, "_info", lambda _file: pytest.fail("must not be parsed"))
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="not a WAV this app converts"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@needs_ffmpeg
def test_reads_the_samples_as_the_header_says_whatever_the_data_look_like(
    ffmpeg: None, tmp_path: Path
) -> None:
    # A 16 bit PCM header over MP3 data: read as MP3 it would unpack to a hundred times its size.
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16", seconds=0.5)
    mp3 = (ROOT / "tests" / "fixtures" / "synthetic" / "sine.mp3").read_bytes()
    data = mp3[: len(mp3) // 4 * 4]
    header = src.read_bytes()[:36]
    whole = header + b"data" + struct.pack("<I", len(data)) + data
    src.write_bytes(whole[:4] + struct.pack("<I", len(whole) - 8) + whole[8:])
    dst = temp_for(src)

    convert.wav_to_aiff(str(src), str(dst), "job-1")

    # As many samples as the data hold as PCM, and not one more.
    assert soundfile.info(dst).frames == len(data) // 4
    assert dst.stat().st_size < len(data) + 4096


@needs_ffmpeg
def test_refuses_more_channels_than_a_music_file_has(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16", seconds=0.2, channels=12)
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="not a WAV this app converts"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@needs_ffmpeg
def test_refuses_a_wav_without_samples(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16", seconds=0)
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


def test_does_not_take_or_remove_a_file_that_was_put_in_the_place_of_its_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Stands in for ffmpeg, and for whoever swaps the file meanwhile: the file that
    # was made is taken away, and another one stands at its path.
    fake = tmp_path / "ffmpeg"
    fake.write_text('#!/bin/sh\nfor last; do :; done\nrm "$last"\necho foreign > "$last"\n')
    fake.chmod(0o755)
    monkeypatch.setenv(decode.FFMPEG_ENV, str(fake))
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="not the one that was made"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert dst.read_bytes() == b"foreign\n"


def test_does_not_write_through_a_link_at_the_place_of_the_temp_file(tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16")
    outside = tmp_path / "outside.aiff"
    dst = temp_for(src)
    os.symlink(outside, dst)

    with pytest.raises(ValueError, match="must not exist"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not outside.exists()
    assert dst.is_symlink()


def synchsafe(size: int) -> bytes:
    return bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])


def id3(major: int, flags: int, frames: bytes) -> bytes:
    return b"ID3" + bytes([major, 0, flags]) + synchsafe(len(frames)) + frames


def packed_frame(major: int, megabytes: int = 4) -> bytes:
    """A compressed TIT2 frame that stands for `megabytes` of text."""
    text = b"\x00" + b"A" * (megabytes * 1024 * 1024)
    data = zlib.compress(text, 9)
    if major == 3:
        body = struct.pack(">I", len(text)) + data
        return b"TIT2" + struct.pack(">I", len(body)) + b"\x00\x80" + body
    body = synchsafe(len(text)) + data
    return b"TIT2" + synchsafe(len(body)) + b"\x00\x09" + body


def plain_frame(name: bytes, text: bytes, major: int) -> bytes:
    body = b"\x00" + text
    size = struct.pack(">I", len(body)) if major == 3 else synchsafe(len(body))
    return name + size + b"\x00\x00" + body


# Tags a second reading of the frames came to another answer about than the reader
# that unpacks them: each hides a compressed frame from a walk over the tag.
BOMBS = {
    "v2.3": id3(3, 0, packed_frame(3)),
    "v2.4": id3(4, 0, packed_frame(4)),
    "v2.3, the flag of an extended header that is not there": id3(3, 0x40, packed_frame(3)),
    "v2.4, the flag of an extended header that is not there": id3(4, 0x40, packed_frame(4)),
    "v2.3, after a frame that looks like padding to a reader of v2.4 sizes": id3(
        3, 0, plain_frame(b"TALB", b"\x00" * 300, 3) + packed_frame(3)
    ),
    "v2.4, sizes written as plain numbers": id3(
        4,
        0,
        # 200 as a plain number is 0xC8, which is no synchsafe byte.
        b"TALB" + struct.pack(">I", 200) + b"\x00\x00" + b"\x00" + b"B" * 199 + packed_frame(4),
    ),
    "v2.3, marked unsynchronised without being so": id3(
        3, 0x80, plain_frame(b"TALB", b"\xff\x00\xff\xe0 odd", 3) + packed_frame(3)
    ),
}


@needs_ffmpeg
@pytest.mark.parametrize("name", list(BOMBS))
def test_refuses_a_compressed_frame_however_the_tag_hides_it(
    ffmpeg: None, tmp_path: Path, name: str
) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16", seconds=0.2)
    add_id3_chunk(src, BOMBS[name])
    assert src.stat().st_size < 400_000
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="tags of the file"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


def test_asks_the_reader_that_unpacks_a_frame_whether_it_is_packed() -> None:
    # Whatever tag mutagen would inflate, it inflates through the frame classes it
    # is handed: with the guarded ones, none of the tags above is ever unpacked.
    for tag in BOMBS.values():
        with pytest.raises(convert.ConvertError):
            convert._read_tags(tag)


@needs_ffmpeg
def test_keeps_the_sort_names_and_says_which_frames_it_could_not_carry(
    ffmpeg: None, tmp_path: Path
) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16", seconds=0.2)
    frames = (
        plain_frame(b"TIT2", b"Glue", 4)
        + plain_frame(b"TSOP", b"Bicep", 4)
        + plain_frame(b"TDRL", b"2021-01-22", 4)
        + plain_frame(b"XSOP", b"Bicep", 4)
    )
    add_id3_chunk(src, id3(4, 0, frames))
    dst = temp_for(src)

    result = convert.wav_to_aiff(str(src), str(dst), "job-1")

    tags = AIFF(dst).tags
    assert str(tags["TIT2"]) == "Glue"
    assert str(tags["TSOP"]) == "Bicep"
    # A release date has no frame in ID3v2.3, and a frame of another tagger no reader here.
    assert sorted(result["tagsLost"]) == ["TDRL", "XSOP"]


@needs_ffmpeg
def test_refuses_an_id3_chunk_that_ends_before_its_size_says(ffmpeg: None, tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    write_wav(src, 44_100, "PCM_16", seconds=0.2)
    add_id3_chunk(src, id3(3, 0, plain_frame(b"TIT2", b"Glue", 3)))
    src.write_bytes(src.read_bytes()[:-6])
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="tags of the file cannot be read"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()


@pytest.mark.parametrize(
    ("kind", "name"), [(2, "MS ADPCM"), (6, "A-law"), (7, "u-law"), (17, "IMA ADPCM"), (49, "GSM")]
)
def test_gives_no_parser_a_wav_of_packed_samples(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: int, name: str
) -> None:
    src = tmp_path / "track.wav"
    fmt = struct.pack("<HHIIHH", kind, 1, 8000, 8000, 1, 8)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", 8)
    src.write_bytes(b"RIFF" + struct.pack("<I", len(body) + 8) + body + b"\x00" * 8)
    monkeypatch.setattr(convert, "_info", lambda _file: pytest.fail(f"{name} must not be parsed"))
    dst = temp_for(src)

    with pytest.raises(convert.ConvertError, match="not a WAV this app converts"):
        convert.wav_to_aiff(str(src), str(dst), "job-1")

    assert not dst.exists()
