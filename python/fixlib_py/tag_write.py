"""Writes the tags of a track as ID3v2.3, the version Rekordbox reads.

Mirrored by `tags.write` and `tags.would_change` in src/shared/rpc.ts.

The file is never changed where it is: the app names a temp file next to it, the
whole file is copied there, the tags are changed in the copy, and the copy is read
back before the call returns. The app puts it in place. File content is untrusted.
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
from typing import Any, BinaryIO

from fixlib_py.files import open_regular_file
from fixlib_py.safe_files import (
    PackedFrame,
    Refused,
    Stopped,
    check_frame_count,
    check_temp_target,
    copy_stream,
    create_made,
    guarded_frames,
    is_packed_frame,
    open_made,
    remove_made,
)
from fixlib_py.server import JobCancelled, cancellable, raise_if_cancelled, rpc
from fixlib_py.tags import MAX_READ_SIZE, _BoundedReader, _clean_text, _first_text, _year

# Tags are written into these; a WAV becomes an AIFF first (convert.py).
_FORMATS = {".mp3": "mp3", ".aif": "aiff", ".aiff": "aiff"}
_TEXT_FRAMES = {"artist": "TPE1", "title": "TIT2", "album": "TALB", "label": "TPUB", "key": "TKEY"}
_FIELDS = {*_TEXT_FRAMES, "year", "bpm", "coverPath"}
# A key as ID3 writes one: `Am`, `F#m`, `Db`.
_KEY = re.compile(r"^[A-G][#b]?m?$")
# A cover the app made is a 600 x 600 JPEG of a few hundred kilobytes.
MAX_COVER_BYTES = 4 * 1024 * 1024
_JPEG = b"\xff\xd8\xff"
# Frames ID3v2.3 does not have and every player and tagger reads in it all the same:
# the names a library is sorted by.
_SORT_FRAMES = ("TSOA", "TSOP", "TSOT")
_MAX_CHUNKS = 10_000
_COPY_CHUNK = 1024 * 1024
# So many frames of audio in a row are audio, and no accident of a cover's bytes.
_AUDIO_FRAMES = 4
# Layer III, by the version bits of a frame header: kbit/s, Hz, and the factor of
# the length of a frame.
_MPEG = {
    3: (
        (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
        (44100, 48000, 32000),
        144,
    ),
    2: ((8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160), (22050, 24000, 16000), 72),
    0: ((8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160), (11025, 12000, 8000), 72),
}


def _check_fields(fields: object) -> dict[str, Any]:
    """The fields to write, or ValueError. A field that is not named is left as it is."""
    if not isinstance(fields, dict) or not fields or not set(fields) <= _FIELDS:
        raise ValueError("fields must name at least one tag, and only tags this app writes")
    for name in _TEXT_FRAMES:
        if name not in fields:
            continue
        value = fields[name]
        # Only text that reads back as it was written: one clean line.
        if not isinstance(value, str) or not value or _clean_text(value) != value:
            raise ValueError(f"{name} must be one clean line of text")
        try:
            # Half a character cannot be written, and is not found out by copying
            # the whole file first.
            value.encode("utf-16")
        except UnicodeEncodeError:
            raise ValueError(f"{name} must be one clean line of text") from None
    if "key" in fields and _KEY.match(fields["key"]) is None:
        raise ValueError("key must be a musical key")
    for name, low, high in (("year", 1000, 9999), ("bpm", 20, 400)):
        value = fields.get(name, low)
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise ValueError(f"{name} is out of range")
    if "coverPath" in fields and (
        not isinstance(fields["coverPath"], str) or not os.path.isabs(fields["coverPath"])
    ):
        raise ValueError("coverPath must be an absolute path")
    return fields


def _format_of(path: str) -> str:
    kind = _FORMATS.get(os.path.splitext(path)[1].lower())
    if kind is None:
        raise Refused("tags are not written into a file of this format")
    return kind


def _chunks(file: BinaryIO, size: int) -> tuple[int, list[tuple[bytes, int, int]]]:
    """Where an AIFF ends, and its chunks as (id, where its data starts, where it ends)."""
    file.seek(0)
    head = file.read(12)
    if head[:4] != b"FORM" or head[8:12] not in (b"AIFF", b"AIFC"):
        raise Refused("the file cannot be read as audio")
    form_end = min(size, 8 + int.from_bytes(head[4:8], "big"))
    chunks: list[tuple[bytes, int, int]] = []
    position = 12
    while position + 8 <= form_end:
        # More chunks than any file has: what stands after them is not looked at,
        # so nothing may be said about the file at all.
        if len(chunks) >= _MAX_CHUNKS:
            raise Refused("the file cannot be read as audio")
        file.seek(position)
        header = file.read(8)
        length = int.from_bytes(header[4:8], "big")
        chunks.append((header[:4], position + 8, position + 8 + length))
        position += 8 + length + (length & 1)
    return form_end, chunks


def _check_work(file: BinaryIO, kind: str) -> None:
    """Refuses a file whose tag would keep the reader busy for minutes. See `check_frame_count`."""
    size = os.fstat(file.fileno()).st_size
    starts = [0]
    if kind == "aiff":
        chunks = _chunks(file, size)[1]
        starts = [start for name, start, _ in chunks if name.strip().upper() == b"ID3"]
    for start in starts:
        file.seek(start)
        check_frame_count(file.read(MAX_READ_SIZE))


def _open(file: BinaryIO, kind: str) -> Any:
    """An open file as mutagen sees it: its tags, or None, and what its audio is.

    Read once, by one reader, and every time through the frame classes that refuse a
    compressed or encrypted frame instead of unpacking it: a second reader that
    finds the tag by another rule could be shown another tag than the one that was
    checked. No single read may ask for more than a tag may hold, and a tag of more
    frames than a tag has is refused before it is read. The file is left at its start.
    """
    from mutagen.aiff import AIFF
    from mutagen.mp3 import MP3

    loader = AIFF if kind == "aiff" else MP3
    source: Any = _BoundedReader(file, os.fstat(file.fileno()).st_size)
    try:
        _check_work(file, kind)
        file.seek(0)
        if kind == "aiff":
            # An AIFF has no ID3v1 tag: the last bytes of its sound are sound.
            return loader(source, known_frames=guarded_frames(), load_v1=False)
        try:
            return loader(source, known_frames=guarded_frames())
        except Exception as error:
            if is_packed_frame(error):
                raise
            # An ID3v1 tag that cannot be read must not keep the file from its tags.
            file.seek(0)
            return loader(source, known_frames=guarded_frames(), load_v1=False)
    except Refused:
        raise
    except Exception as error:
        if is_packed_frame(error):
            raise PackedFrame() from None
        raise Refused("the file cannot be read as audio with tags") from None
    finally:
        file.seek(0)


def _cover_of(tags: Any) -> bytes | None:
    """The picture of a tag that holds exactly one front cover as a JPEG, else None."""
    pictures = tags.getall("APIC")
    if len(pictures) != 1 or pictures[0].type != 3 or pictures[0].mime != "image/jpeg":
        return None
    return bytes(pictures[0].data)


def _held(tags: Any) -> dict[str, Any]:
    """What a tag says in the fields this module writes."""
    if tags is None:
        return {name: None for name in _FIELDS}
    held: dict[str, Any] = {name: _first_text(tags, frame) for name, frame in _TEXT_FRAMES.items()}
    held["year"] = _year(tags)
    tempo = _first_text(tags, "TBPM")
    held["bpm"] = int(tempo) if tempo is not None and tempo.isascii() and tempo.isdigit() else None
    held["coverPath"] = _cover_of(tags)
    return held


def _read_cover(path: str) -> bytes:
    file = open_regular_file(path)
    if file is None:
        raise Refused("the cover is not a regular file")
    with file:
        data = file.read(MAX_COVER_BYTES + 1)
    if len(data) > MAX_COVER_BYTES or data[:3] != _JPEG:
        raise Refused("the cover is not a JPEG of a size a cover may have")
    return data


def _wanted(fields: dict[str, Any]) -> dict[str, Any]:
    """The fields as they are compared with what a tag holds: the cover as its bytes."""
    wanted = dict(fields)
    if "coverPath" in wanted:
        wanted["coverPath"] = _read_cover(wanted["coverPath"])
    return wanted


def _differs(held: dict[str, Any], wanted: dict[str, Any]) -> bool:
    return any(held[name] != value for name, value in wanted.items())


def _apply(tags: Any, wanted: dict[str, Any]) -> None:
    """Changes the named frames of a tag, which is then a real ID3v2.3 tag."""
    from mutagen.id3 import APIC, TBPM, TYER, Frames

    sorting = [frame for name in _SORT_FRAMES for frame in tags.getall(name)]
    tags.update_to_v23()
    for frame in sorting:
        tags.add(frame)
    # A volume adjustment of ID3v2.4 has no place in a v2.3 tag.
    tags.delall("RVA2")
    for name, frame_id in _TEXT_FRAMES.items():
        if name in wanted:
            tags.delall(frame_id)
            # UTF-16: ID3v2.3 knows no UTF-8, and only so do accents stay what they are.
            tags.add(Frames[frame_id](encoding=1, text=[wanted[name]]))
    if "year" in wanted:
        tags.delall("TDRC")
        tags.delall("TYER")
        tags.add(TYER(encoding=1, text=[str(wanted["year"])]))
    if "bpm" in wanted:
        tags.delall("TBPM")
        tags.add(TBPM(encoding=1, text=[str(wanted["bpm"])]))
    if "coverPath" in wanted:
        tags.delall("APIC")
        tags.add(APIC(encoding=0, mime="image/jpeg", type=3, desc="", data=wanted["coverPath"]))


def _digest(file: BinaryIO, start: int, end: int, stop: threading.Event | None) -> str:
    digest = hashlib.sha256()
    file.seek(start)
    left = end - start
    while left > 0:
        _raise_if_stopped(stop)
        chunk = file.read(min(left, _COPY_CHUNK))
        if not chunk:
            raise Refused("the file cannot be read as audio")
        digest.update(chunk)
        left -= len(chunk)
    return digest.hexdigest()


def _frame_of(head: bytes) -> tuple[int, int] | None:
    """The length of the MPEG layer III frame these four bytes begin, and its kind."""
    if len(head) < 4 or head[0] != 0xFF or head[1] & 0xE6 != 0xE2:
        return None
    version = (head[1] >> 3) & 3
    rate = (head[2] >> 2) & 3
    bitrate = head[2] >> 4
    if version not in _MPEG or rate == 3 or bitrate in (0, 15):
        return None
    bitrates, rates, factor = _MPEG[version]
    length = factor * 1000 * bitrates[bitrate - 1] // rates[rate] + ((head[2] >> 1) & 1)
    return length, version << 2 | rate


def _holds_audio(data: bytes) -> bool:
    """True when frames of MPEG audio stand in a row somewhere in the bytes."""
    position = data.find(b"\xff")
    while position != -1:
        at = position
        kind = None
        for _ in range(_AUDIO_FRAMES):
            frame = _frame_of(data[at : at + 4])
            if frame is None or (kind is not None and frame[1] != kind):
                break
            kind = frame[1]
            at += frame[0]
        else:
            return True
        position = data.find(b"\xff", position + 1)
    return False


def _audio_span(file: BinaryIO, kind: str) -> tuple[int, int]:
    """Where the audio of a file starts and ends: what a tag write must leave as it is.

    For an MP3, everything after the ID3v2 tag at its start and before an ID3v1 tag
    at its end. For an AIFF, the data of its one sound chunk. Found by a walk of its
    own, which trusts nothing a tag reader worked out, and raises for a file whose
    audio cannot be found whole. The file is left at its start.
    """
    try:
        size = os.fstat(file.fileno()).st_size
        file.seek(0)
        if kind == "mp3":
            head = file.read(10)
            start = 0
            if len(head) == 10 and head[:3] == b"ID3":
                declared = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
                # How long the tag is, the tag says itself, and a rewrite takes its
                # word for it: one that counts audio as its own would lose that
                # audio. A tag in which audio stands is not rewritten.
                if declared > MAX_READ_SIZE or _holds_audio(file.read(declared)):
                    raise Refused("the tags of the file reach into its audio")
                start = 10 + declared
            file.seek(start)
            # The footer of an ID3v2.4 tag, which a rewritten tag leaves standing.
            if file.read(3) == b"3DI":
                start += 10
            end = size
            if size - start >= 128:
                file.seek(size - 128)
                if file.read(3) == b"TAG":
                    end = size - 128
            if end <= start:
                raise Refused("the file cannot be read as audio")
            return start, end
        form_end, chunks = _chunks(file, size)
        found = [(start, end) for name, start, end in chunks if name == b"SSND"]
        # One sound chunk, whole and inside the file: anything else is not a file
        # whose audio can be told to be untouched.
        if len(found) != 1 or found[0][1] > form_end:
            raise Refused("the file cannot be read as audio")
        return found[0]
    finally:
        file.seek(0)


def _audio_of(file: BinaryIO, kind: str, stop: threading.Event | None = None) -> str:
    """The sha256 of the audio of a file. The file is left at its start."""
    try:
        return _digest(file, *_audio_span(file, kind), stop)
    finally:
        file.seek(0)


def _save(target: BinaryIO, kind: str, wanted: dict[str, Any]) -> None:
    """Changes the tags of the copy, where it is."""
    audio = _open(target, kind)
    try:
        if audio.tags is None:
            # A file without a tag gets one. What only an ID3v1 tag of an MP3 said
            # is in `audio.tags` already: mutagen read it, and it goes into the new tag.
            audio.add_tags()
        _apply(audio.tags, wanted)
        target.seek(0)
        if kind == "aiff":
            audio.save(target, v2_version=3)
        else:
            # No ID3v1 tag stays behind: two tags would be two answers to one question.
            audio.save(target, v1=0, v2_version=3)
    except Exception:
        # In fixed words: what a tagger says of a failure may name the path.
        raise Refused("the tags cannot be written into the file") from None


def _check_written(
    target: BinaryIO,
    kind: str,
    wanted: dict[str, Any],
    audio: str,
    stop: threading.Event | None = None,
) -> None:
    """Raises unless the file holds what was to be written, as ID3v2.3, around the same audio."""
    tags = _open(target, kind).tags
    if tags is None or tags.version[:2] != (2, 3) or _differs(_held(tags), wanted):
        raise Refused("the tags that were written do not read back as they were meant")
    if _audio_of(target, kind, stop) != audio:
        raise Refused("the audio of the file is not what it was")
    if kind == "mp3":
        target.seek(0, os.SEEK_END)
        if target.tell() >= 128:
            target.seek(-128, os.SEEK_END)
            if target.read(3) == b"TAG":
                raise Refused("an ID3v1 tag is still in the file")
        target.seek(0)


def _raise_if_stopped(stop: threading.Event | None) -> None:
    if stop is not None and stop.is_set():
        raise Stopped()


@rpc("tags.would_change")
def would_change(path: str, fields: dict[str, Any]) -> dict[str, bool]:
    """Whether writing these fields would change the file. Reads the file only.

    Asked before a backup is made: a file that says all of it already costs none.
    """
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    wanted = _wanted(_check_fields(fields))
    kind = _format_of(path)
    source = open_regular_file(path)
    if source is None:
        raise Refused("not a regular file")
    with source:
        held = _held(_open(source, kind).tags)
        # A file whose audio cannot be found would be refused by the write, after
        # its backup was made: it is refused here, where nothing was made yet.
        _audio_span(source, kind)
        return {"changed": _differs(held, wanted)}


def write_file(
    src: str,
    dst: str,
    identity: tuple[int, int],
    fields: dict[str, Any],
    stop: threading.Event | None = None,
) -> None:
    """Copy `src` into the file made at `dst` with the named tags changed."""
    wanted = _wanted(fields)
    kind = _format_of(src)
    source = open_regular_file(src)
    if source is None:
        raise Refused("not a regular file")
    with source:
        # Asked of the source first: a file whose tags cannot be carried, or whose
        # audio cannot be found, is refused before anything is copied.
        _open(source, kind)
        audio = _audio_of(source, kind, stop)
        with open_made(dst, identity, "rb+") as target:
            copy_stream(source, target, stop)
            target.flush()
            target.seek(0)
            _save(target, kind, wanted)
            target.flush()
            # Saving may have moved the whole audio, and reading it back takes as
            # long again: a job that was told to stop is not kept waiting for both.
            _raise_if_stopped(stop)
            target.seek(0)
            _check_written(target, kind, wanted, audio, stop)


@rpc("tags.write")
def write_tags(src: str, dst: str, fields: dict[str, Any], job_id: str) -> dict[str, bool]:
    """Write the named tags of one file. Reads `src`, writes `dst`, touches nothing else.

    `dst` is the temp file the app's file rules made a name for, next to `src`; the
    app puts it in place when this returns. A field that is not named stays as it
    is. When the call fails or is stopped, the file it made is removed.
    """
    check_temp_target(src, dst)
    checked = _check_fields(fields)
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        identity = create_made(dst)
        try:
            write_file(src, dst, identity, checked, stop)
            raise_if_cancelled(stop)
        except Stopped:
            remove_made(dst, identity)
            raise JobCancelled() from None
        except BaseException:
            remove_made(dst, identity)
            raise
    return {"written": True}
