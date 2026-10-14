from __future__ import annotations

import hashlib
import io
import shutil
import struct
import threading
import zlib
from collections.abc import Iterator
from pathlib import Path

import pytest
from mutagen.aiff import AIFF
from mutagen.id3 import APIC, ID3, TALB, TDRC, TIT2, TSOP, TXXX
from mutagen.mp3 import MP3
from PIL import Image

from fixlib_py import server, tag_write
from fixlib_py.safe_files import Refused, Stopped
from fixlib_py.tags import read_file_tags

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "synthetic"
COVER = "0123456789abcdef0123456789abcdef01234567.jpg"
FIELDS = {
    "artist": "Ákos feat. Őze Áron",
    "title": "Ilyenek voltunk (Extended Mix)",
    "album": "Új törvény",
    "label": "Fehér Sólyom – 日本",
    "year": 1997,
    "bpm": 124,
    "key": "F#m",
}


def jpeg(size: tuple[int, int] = (600, 600)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, (200, 40, 90)).save(output, format="JPEG", quality=90)
    return output.getvalue()


@pytest.fixture
def covers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The covers folder of the app, holding one cover the app made."""
    folder = tmp_path / "covers"
    folder.mkdir()
    (folder / COVER).write_bytes(jpeg())
    monkeypatch.setenv("FIXLIB_COVERS_DIR", str(folder))
    return folder


@pytest.fixture(autouse=True)
def clean_job_registry() -> Iterator[None]:
    yield
    server._jobs.clear()
    server._cancelled_early.clear()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def track(tmp_path: Path, extension: str) -> Path:
    path = tmp_path / f"track{extension}"
    shutil.copyfile(FIXTURES / f"sine{'.mp3' if extension == '.mp3' else '.aiff'}", path)
    return path


def synchsafe(size: int) -> bytes:
    return bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])


def temp_for(path: Path) -> Path:
    """A name as the app's file rules give a temp file."""
    return path.with_name(f".{path.name}.0a1b2c3d.fixlib-tmp")


def written(src: Path, fields: dict[str, object]) -> Path:
    """Writes the fields and puts the result under a name its format is known by."""
    dst = temp_for(src)
    assert tag_write.write_tags(str(src), str(dst), fields, "job-1") == {"written": True}
    result = src.with_name(f"written{src.suffix}")
    dst.rename(result)
    server._jobs.clear()
    return result


def tags_of(path: Path) -> ID3:
    return AIFF(path).tags if path.suffix != ".mp3" else ID3(path)


def audio_of(path: Path) -> bytes:
    """The bytes of an MP3 after its ID3v2 tag and before an ID3v1 tag."""
    data = path.read_bytes()
    if data[:3] == b"ID3":
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        data = data[10 + size :]
    return data[:-128] if data[-128:-125] == b"TAG" else data


@pytest.mark.parametrize("extension", [".mp3", ".aiff", ".aif"])
def test_writes_every_field_and_reads_it_back_with_its_accents(
    tmp_path: Path, extension: str
) -> None:
    src = track(tmp_path, extension)
    before = sha256(src)

    result = written(src, FIELDS)

    read = read_file_tags(str(result))
    assert (read["artist"], read["title"], read["album"], read["label"], read["year"]) == (
        "Ákos feat. Őze Áron",
        "Ilyenek voltunk (Extended Mix)",
        "Új törvény",
        "Fehér Sólyom – 日本",
        1997,
    )
    tags = tags_of(result)
    assert str(tags["TBPM"]) == "124"
    assert str(tags["TKEY"]) == "F#m"
    # The source is read, never written.
    assert sha256(src) == before


@pytest.mark.parametrize("extension", [".mp3", ".aiff"])
def test_writes_id3v2_3_in_utf_16_with_the_year_as_its_own_frame(
    tmp_path: Path, extension: str
) -> None:
    src = track(tmp_path, extension)

    result = written(src, FIELDS)

    tags = tags_of(result)
    assert tags.version[:2] == (2, 3)
    assert all(tags[name].encoding == 1 for name in ("TPE1", "TIT2", "TALB", "TPUB", "TKEY"))
    # The frame ids as they stand in the file, not as a reader translates them.
    raw = result.read_bytes()
    assert b"TYER" in raw
    assert b"TDRC" not in raw


def test_removes_an_id3v1_tag_so_that_the_file_has_one_answer(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    with src.open("ab") as file:
        file.write(b"TAG" + b"Old title".ljust(125, b"\x00"))
    assert src.read_bytes()[-128:-125] == b"TAG"

    result = written(src, {"title": "Glue"})

    assert result.read_bytes()[-128:-125] != b"TAG"
    assert read_file_tags(str(result))["title"] == "Glue"


def test_leaves_the_audio_of_an_mp3_byte_for_byte_as_it_was(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")

    result = written(src, FIELDS)

    assert audio_of(result) == audio_of(src)
    assert MP3(result).info.length == MP3(src).info.length


@pytest.mark.parametrize("extension", [".mp3", ".aiff"])
def test_leaves_a_field_that_is_not_named_as_it_is(tmp_path: Path, extension: str) -> None:
    src = track(tmp_path, extension)
    first = written(src, {"album": "Isles", "artist": "Bicep", "year": 2021})

    result = written(first, {"artist": "BICEP"})

    read = read_file_tags(str(result))
    assert (read["artist"], read["album"], read["year"]) == ("BICEP", "Isles", 2021)


def test_makes_a_real_v2_3_tag_of_one_that_was_v2_4_and_keeps_the_sort_name(
    tmp_path: Path,
) -> None:
    src = track(tmp_path, ".mp3")
    old = ID3()
    old.add(TDRC(encoding=3, text="2021-01-22"))
    old.add(TALB(encoding=3, text="Isles"))
    old.add(TSOP(encoding=3, text="Bicep"))
    old.save(src, v2_version=4)

    result = written(src, {"title": "Glue"})

    tags = ID3(result)
    assert tags.version[:2] == (2, 3)
    assert str(tags["TSOP"]) == "Bicep"
    assert read_file_tags(str(result))["year"] == 2021
    assert read_file_tags(str(result))["album"] == "Isles"


@pytest.mark.parametrize("extension", [".mp3", ".aiff"])
def test_puts_one_front_cover_in_the_place_of_whatever_pictures_were_there(
    tmp_path: Path, extension: str, covers: Path
) -> None:
    src = track(tmp_path, extension)
    first = written(src, {"title": "Glue"})
    audio = AIFF(first) if extension != ".mp3" else MP3(first)
    audio.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="front", data=b"\x89PNG old"))
    audio.tags.add(APIC(encoding=3, mime="image/png", type=4, desc="back", data=b"\x89PNG back"))
    audio.save()

    result = written(first, {"cover": COVER})

    pictures = tags_of(result).getall("APIC")
    assert [(picture.type, picture.mime, bytes(picture.data)) for picture in pictures] == [
        (3, "image/jpeg", (covers / COVER).read_bytes())
    ]
    assert read_file_tags(str(result))["hasCover"] is True
    assert read_file_tags(str(result))["title"] == "Glue"


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"\x89PNG not a jpeg", "cannot be read as an image"),
        (b"\xff\xd8\xff" + b"x" * 100, "cannot be read as an image"),
        (b"\xff\xd8\xff" + b"x" * (4 * 1024 * 1024), "larger than a cover may be"),
        (jpeg((300, 300)), "not a JPEG the app made"),
    ],
)
def test_refuses_a_cover_that_is_not_a_600_pixel_jpeg_as_the_app_makes_one(
    tmp_path: Path, covers: Path, content: bytes, message: str
) -> None:
    src = track(tmp_path, ".mp3")
    (covers / COVER).write_bytes(content)
    dst = temp_for(src)

    with pytest.raises(Refused, match=message):
        tag_write.write_tags(str(src), str(dst), {"cover": COVER}, "job-1")

    assert not dst.exists()


def test_refuses_a_cover_when_the_app_named_no_covers_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = track(tmp_path, ".mp3")
    monkeypatch.delenv("FIXLIB_COVERS_DIR", raising=False)

    with pytest.raises(Refused, match="no covers folder"):
        tag_write.would_change(str(src), {"cover": COVER})


@pytest.mark.parametrize("extension", [".mp3", ".aiff"])
def test_says_whether_writing_would_change_the_file_without_touching_it(
    tmp_path: Path, extension: str, covers: Path
) -> None:
    src = track(tmp_path, extension)
    fields = {**FIELDS, "cover": COVER}
    result = written(src, fields)
    before = sha256(result)

    same = tag_write.would_change(str(result), fields)
    other_title = tag_write.would_change(str(result), {"title": "Ilyenek voltunk"})
    other_tempo = tag_write.would_change(str(result), {"bpm": 125})
    untagged = tag_write.would_change(str(src), {"title": "Glue"})

    assert same == {"changed": False}
    assert (other_title, other_tempo, untagged) == ({"changed": True},) * 3
    assert sha256(result) == before
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted(
        [src.name, result.name, covers.name]
    )


def test_does_not_write_tags_into_a_wav(tmp_path: Path) -> None:
    src = tmp_path / "track.wav"
    shutil.copyfile(FIXTURES / "sine.wav", src)
    dst = temp_for(src)

    with pytest.raises(Refused, match="not written into a file of this format"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")
    with pytest.raises(Refused, match="not written into a file of this format"):
        tag_write.would_change(str(src), {"title": "Glue"})

    assert not dst.exists()


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {"genre": "House"},
        {"title": ""},
        {"title": "two\nlines"},
        {"title": "turned ‮ around"},
        {"title": 7},
        {"year": 99},
        {"year": "1997"},
        {"bpm": 124.5},
        {"bpm": True},
        {"key": "8A"},
        {"cover": "cover.jpg"},
        {"cover": "/abs/0123456789abcdef0123456789abcdef01234567.jpg"},
        {"cover": "../0123456789abcdef0123456789abcdef01234567.jpg"},
        {"coverPath": "/abs/cover.jpg"},
        None,
    ],
)
def test_refuses_fields_it_does_not_write_or_cannot_write_as_they_are(
    tmp_path: Path, fields: object
) -> None:
    src = track(tmp_path, ".mp3")
    dst = temp_for(src)

    with pytest.raises(ValueError):
        tag_write.write_tags(str(src), str(dst), fields, "job-1")  # type: ignore[arg-type]

    assert not dst.exists()


@pytest.mark.parametrize(
    ("src", "dst", "message"),
    [
        ("track.mp3", "/music/.track.mp3.0a1b2c3d.fixlib-tmp", "absolute"),
        ("/music/track.mp3", "/music/track.mp3", "temp file"),
        ("/music/track.mp3", "/elsewhere/.track.mp3.0a1b2c3d.fixlib-tmp", "next to src"),
    ],
)
def test_refuses_paths_it_is_not_meant_to_work_on(src: str, dst: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        tag_write.write_tags(src, dst, {"title": "Glue"}, "job-1")


def test_never_writes_over_a_file_that_is_there(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    dst = temp_for(src)
    dst.write_bytes(b"somebody else's")

    with pytest.raises(ValueError, match="must not exist"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert dst.read_bytes() == b"somebody else's"


def packed_tag() -> bytes:
    """An ID3v2.3 tag whose one frame is compressed: 4 MB of text in a few kilobytes."""
    text = b"\x00" + b"A" * (4 * 1024 * 1024)
    body = struct.pack(">I", len(text)) + zlib.compress(text, 9)
    frame = b"TIT2" + struct.pack(">I", len(body)) + b"\x00\x80" + body
    size = len(frame)
    synchsafe = bytes([(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F])
    return b"ID3\x03\x00\x00" + synchsafe + frame


def test_refuses_a_file_whose_tag_holds_a_compressed_frame(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    src.write_bytes(packed_tag() + audio_of(src))
    before = sha256(src)
    dst = temp_for(src)

    with pytest.raises(Refused, match="compressed or encrypted"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")
    with pytest.raises(Refused, match="compressed or encrypted"):
        tag_write.would_change(str(src), {"title": "Glue"})

    assert not dst.exists()
    assert sha256(src) == before


def test_refuses_a_tag_that_claims_to_be_larger_than_a_tag_may_be(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    # 64 MiB, as a synchsafe size.
    src.write_bytes(b"ID3\x03\x00\x00\x20\x00\x00\x00" + audio_of(src))
    dst = temp_for(src)

    # No read of that size is ever made: the file is refused as one that cannot be read.
    with pytest.raises(Refused, match="cannot be read"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()


def test_removes_what_it_wrote_when_the_tags_do_not_read_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = track(tmp_path, ".mp3")
    monkeypatch.setattr(tag_write, "_differs", lambda _held, _wanted: True)
    dst = temp_for(src)

    with pytest.raises(Refused, match="do not read back"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()


def test_a_job_that_was_cancelled_before_it_started_writes_nothing(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    dst = temp_for(src)
    server.cancel_job("job-1")

    with pytest.raises(server.JobCancelled):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()


def test_a_job_that_is_stopped_while_the_file_is_copied_leaves_nothing_behind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = track(tmp_path, ".mp3")
    dst = temp_for(src)
    stop = threading.Event()
    stop.set()
    monkeypatch.setattr(tag_write, "raise_if_cancelled", lambda _stop: None)
    identity = tag_write.create_made(str(dst))

    with pytest.raises(tag_write.Stopped):
        tag_write.write_file(str(src), str(dst), identity, {"title": TIT2 and "Glue"}, stop)

    # The caller, `write_tags`, removes the file it made when the work is stopped.
    tag_write.remove_made(str(dst), identity)
    assert not dst.exists()


def id3v1(title: str, artist: str, album: str, year: str) -> bytes:
    def field(text: str, length: int) -> bytes:
        return text.encode("latin1").ljust(length, b"\x00")

    return (
        b"TAG"
        + field(title, 30)
        + field(artist, 30)
        + field(album, 30)
        + field(year, 4)
        + (field("", 30) + b"\xff")
    )


def test_carries_what_an_id3v1_tag_says_into_the_new_tag_before_it_goes(tmp_path: Path) -> None:
    # An old rip: no ID3v2 tag at all, and everything it knows in the 128 bytes at its end.
    src = track(tmp_path, ".mp3")
    src.write_bytes(audio_of(src) + id3v1("Glue", "Bicep", "Isles", "2021"))
    assert src.read_bytes()[:3] != b"ID3"

    result = written(src, {"bpm": 124})

    read = read_file_tags(str(result))
    assert (read["artist"], read["title"], read["album"], read["year"]) == (
        "Bicep",
        "Glue",
        "Isles",
        2021,
    )
    assert str(ID3(result)["TBPM"]) == "124"
    assert result.read_bytes()[-128:-125] != b"TAG"
    assert audio_of(result) == audio_of(src)


def packed_v24() -> bytes:
    """An ID3v2.4 tag whose one frame is compressed: 8 MB of zeros in a few kilobytes."""
    data = zlib.compress(bytes(8 * 1024 * 1024), 9)

    body = synchsafe(8 * 1024 * 1024) + data
    frame = b"APIC" + synchsafe(len(body)) + b"\x00\x09" + body
    return b"ID3\x04\x00\x00" + synchsafe(len(frame)) + frame


def with_chunks(path: Path, chunks: list[tuple[bytes, bytes]]) -> None:
    """Appends chunks to an AIFF and puts its FORM size right."""
    data = path.read_bytes()
    for name, body in chunks:
        data += name + struct.pack(">I", len(body)) + body + b"\x00" * (len(body) & 1)
    path.write_bytes(data[:4] + struct.pack(">I", len(data) - 8) + data[8:])


@pytest.mark.parametrize(
    "chunks",
    [
        # Each is a tag to mutagen under a rule another reader might not share.
        [(b"ID3 ", packed_v24())],
        [(b"ID3\t", packed_v24())],
        [(b"id3 ", b"ID3\x03\x00\x00\x00\x00\x00\x00"), (b"ID3 ", packed_v24())],
    ],
)
def test_refuses_a_compressed_frame_in_whichever_chunk_of_an_aiff_is_its_tag(
    tmp_path: Path, chunks: list[tuple[bytes, bytes]]
) -> None:
    src = track(tmp_path, ".aiff")
    with_chunks(src, chunks)
    before = sha256(src)
    dst = temp_for(src)

    with pytest.raises(Refused, match="compressed or encrypted"):
        tag_write.would_change(str(src), {"title": "Glue"})
    with pytest.raises(Refused, match="compressed or encrypted"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    # Refused before anything was copied, and nothing was unpacked into a file.
    assert not dst.exists()
    assert sha256(src) == before


@pytest.mark.parametrize("extension", [".mp3", ".aiff"])
def test_refuses_a_result_whose_audio_is_not_byte_for_byte_what_it_was(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extension: str
) -> None:
    src = track(tmp_path, extension)
    save = tag_write._save

    def save_and_damage(target, kind, wanted):  # type: ignore[no-untyped-def]
        save(target, kind, wanted)
        # One byte in the middle of the audio, as a write that went wrong would leave it.
        target.seek(-2000, 2)
        byte = target.read(1)
        target.seek(-1, 1)
        target.write(bytes([byte[0] ^ 0xFF]))

    monkeypatch.setattr(tag_write, "_save", save_and_damage)
    dst = temp_for(src)

    with pytest.raises(Refused, match="audio of the file is not what it was"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()


def test_refuses_an_aiff_whose_sound_cannot_be_found_whole(tmp_path: Path) -> None:
    src = track(tmp_path, ".aiff")
    data = src.read_bytes()
    at = data.index(b"SSND")
    # The sound chunk claims to be longer than the file.
    src.write_bytes(data[: at + 4] + struct.pack(">I", len(data) * 2) + data[at + 8 :])
    dst = temp_for(src)

    with pytest.raises(Refused):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()


def tag_of_frames(version: int, frame: bytes, count: int) -> bytes:
    body = frame * count
    return b"ID3" + bytes([version, 0, 0]) + synchsafe(len(body)) + body


@pytest.mark.parametrize(
    ("version", "frame"),
    [
        (3, b"TIT2" + bytes(6)),
        (4, b"TXXX" + synchsafe(1) + bytes(2) + b"\x00"),
        (2, b"TT2" + bytes(3)),
    ],
)
@pytest.mark.parametrize("extension", [".mp3", ".aiff"])
def test_refuses_a_tag_of_more_frames_than_a_tag_has_before_it_is_read(
    tmp_path: Path, extension: str, version: int, frame: bytes
) -> None:
    # Each frame costs the reader a copy of the rest of the tag: this many take minutes.
    src = track(tmp_path, extension)
    tag = tag_of_frames(version, frame, 200_000)
    if extension == ".mp3":
        src.write_bytes(tag + audio_of(src))
    else:
        with_chunks(src, [(b"ID3 ", tag)])
    before = sha256(src)
    dst = temp_for(src)

    with pytest.raises(Refused, match="more frames than a tag has"):
        tag_write.would_change(str(src), {"title": "Glue"})
    with pytest.raises(Refused, match="more frames than a tag has"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()
    assert sha256(src) == before


def test_writes_into_a_tag_of_as_many_frames_as_a_real_one_may_have(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    tags = ID3()
    for number in range(300):
        tags.add(TXXX(encoding=3, desc=f"note {number}", text=[str(number)]))
    tags.save(src, v2_version=3)

    result = written(src, {"title": "Glue"})

    assert len(ID3(result).getall("TXXX")) == 300
    assert str(ID3(result)["TIT2"]) == "Glue"


def test_refuses_an_mp3_whose_tag_counts_audio_as_its_own(tmp_path: Path) -> None:
    # The tag says it is 5000 bytes long, and those bytes are the start of the audio:
    # a rewrite would take the tag at its word and drop them.
    src = track(tmp_path, ".mp3")
    src.write_bytes(b"ID3\x03\x00\x00" + synchsafe(5000) + audio_of(src))
    before = sha256(src)
    dst = temp_for(src)

    with pytest.raises(Refused, match="reach into its audio"):
        tag_write.would_change(str(src), {"title": "Glue"})
    with pytest.raises(Refused, match="reach into its audio"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue"}, "job-1")

    assert not dst.exists()
    assert sha256(src) == before


def test_gives_an_mp3_without_any_tag_its_first_one(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    src.write_bytes(audio_of(src))

    result = written(src, {"title": "Glue", "bpm": 124})

    tags = ID3(result)
    assert tags.version[:2] == (2, 3)
    assert (str(tags["TIT2"]), str(tags["TBPM"])) == ("Glue", "124")
    assert audio_of(result) == src.read_bytes()


def test_lets_the_id3v2_tag_speak_where_an_id3v1_tag_says_something_else(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["Glue"]))
    tags.save(src, v1=0)
    src.write_bytes(src.read_bytes() + id3v1("Old Title", "Bicep", "Isles", "2021"))

    result = written(src, {"bpm": 124})

    tags = ID3(result)
    assert str(tags["TIT2"]) == "Glue"
    # What only the old tag knew is carried, once.
    assert [str(frame) for frame in tags.getall("TPE1")] == ["Bicep"]
    assert result.read_bytes()[-128:-125] != b"TAG"
    assert audio_of(result) == audio_of(src)


def test_refuses_half_a_character_before_anything_is_copied(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    dst = temp_for(src)

    with pytest.raises(ValueError, match="title must be one clean line"):
        tag_write.write_tags(str(src), str(dst), {"title": "Glue \ud83d"}, "job-1")

    assert not dst.exists()


def test_says_before_any_backup_that_the_audio_of_a_file_cannot_be_found(tmp_path: Path) -> None:
    src = track(tmp_path, ".aiff")
    data = src.read_bytes()
    at = data.index(b"SSND")
    src.write_bytes(data[: at + 4] + struct.pack(">I", len(data) * 2) + data[at + 8 :])

    with pytest.raises(Refused, match="cannot be read as audio"):
        tag_write.would_change(str(src), {"title": "Glue"})


def chunks_of(path: Path) -> list[tuple[bytes, bytes]]:
    data = path.read_bytes()
    chunks = []
    position = 12
    while position + 8 <= len(data):
        length = struct.unpack(">I", data[position + 4 : position + 8])[0]
        chunks.append((data[position : position + 4], data[position + 8 : position + 8 + length]))
        position += 8 + length + (length & 1)
    return chunks


def test_writes_into_an_aiff_whose_tag_stands_before_its_sound(tmp_path: Path) -> None:
    # As some taggers leave it, and with a chunk of an odd length in front.
    src = written(track(tmp_path, ".aiff"), {"title": "Glue"})
    chunks = chunks_of(src)
    sound = dict(chunks)[b"SSND"]
    ordered = sorted(chunks, key=lambda chunk: chunk[0] == b"SSND")
    src.write_bytes(b"FORM\x00\x00\x00\x04AIFF")
    with_chunks(src, [(b"ANNO", b"odd"), *ordered])
    assert [name for name, _ in chunks_of(src)][-1] == b"SSND"

    result = written(src, {"artist": "Bicep", "bpm": 124})

    tags = AIFF(result).tags
    assert (str(tags["TIT2"]), str(tags["TPE1"]), str(tags["TBPM"])) == ("Glue", "Bicep", "124")
    assert dict(chunks_of(result))[b"SSND"] == sound


def test_stops_reading_the_audio_when_the_job_is_told_to_stop(tmp_path: Path) -> None:
    src = track(tmp_path, ".mp3")
    stop = threading.Event()
    stop.set()

    with src.open("rb") as file, pytest.raises(Stopped):
        tag_write._audio_of(file, "mp3", stop)
