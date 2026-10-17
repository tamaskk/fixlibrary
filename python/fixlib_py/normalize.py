"""Changes the loudness of a file by a gain the app planned, and nothing else.

Mirrored by `normalize.apply` in src/shared/rpc.ts. The plan is made in the app
(src/shared/normalize.ts): only a linear gain, never a limiter or any other dynamic
processing. Three ways to apply it, each into the one temp file the app names:

- `mp3gain`: an MP3 in steps of 1.5 dB, by mp3gain on a copy. Only the gain fields of
  the frames change: the audio is not encoded again, no frame changes its size, and
  `-s s` keeps mp3gain from writing an APEv2 tag.
- `pcm`: the samples of an AIFF or a WAV, multiplied by the exact gain and written back
  at their own depth, with TPDF dither at 16 bit. Every other chunk of the file (tags
  and cover included) stays as it was, byte for byte.
- `reencode`: an MP3 decoded, its volume changed, and encoded again at 320 kbps, with
  the ID3v2 tag of the source carried over, cover included.
"""

from __future__ import annotations

import math
import os
import re
import struct
import threading
from typing import Any, BinaryIO

from fixlib_py.analysis.decode import (
    MAX_FFMPEG_ALLOC,
    DecodeError,
    ToolStopped,
    ffmpeg_path,
    run_tool,
    tool_path,
)
from fixlib_py.files import open_regular_file
from fixlib_py.safe_files import (
    Refused,
    Stopped,
    check_frame_count,
    check_temp_target,
    copy_stream,
    create_made,
    open_made,
    read_id3,
    remove_made,
)
from fixlib_py.server import JobCancelled, cancellable, raise_if_cancelled, rpc

# Set by the app (services/python-bridge.ts) to the mp3gain it ships.
MP3GAIN_ENV = "FIXLIB_MP3GAIN"
STEP_DB = 1.5
# More than any track of a library needs either way; the app's plan stays inside it.
MAX_GAIN_DB = 40.0
MAX_STEPS = int(MAX_GAIN_DB / STEP_DB)
# Less than the stage's own limit in src/shared/timeouts.ts, so a tool is ended here.
APPLY_TIMEOUT_S = 110
# The most an ID3v2 tag may hold. A cover is a few megabytes at most.
MAX_TAG_BYTES = 16 * 1024 * 1024
# Frames done at a time: a few megabytes of samples, whatever the length of the track.
_BLOCK_FRAMES = 65_536
_MAX_CHUNKS = 10_000
# What is read of a COMM or `fmt ` chunk: its fields fit in far less.
_MAX_HEADER_BYTES = 64
# How much larger an MP3 encoded again at 320 kbps may be than its source: one of 32 kbps
# becomes ten times its size. Past this, ffmpeg was not writing what it was asked to.
_MAX_GROWTH = 12
_MAX_LOGGED_ERROR = 300
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]+")
# The same dither for the same file, so that a test, or a second attempt, gets the same bytes.
_DITHER_SEED = 0x5EED


def _check_plan(plan: object) -> dict[str, Any]:
    """The plan as the app sends it, or ValueError."""
    if not isinstance(plan, dict):
        raise ValueError("plan must be an object")
    kind = plan.get("kind")
    if kind == "mp3gain":
        steps = plan.get("steps")
        if not isinstance(steps, int) or isinstance(steps, bool) or not 0 < abs(steps) <= MAX_STEPS:
            raise ValueError("steps must be a whole number of steps other than 0")
        return {"kind": kind, "steps": steps}
    if kind in ("pcm", "reencode"):
        gain = plan.get("gainDb")
        if (
            not isinstance(gain, (int, float))
            or isinstance(gain, bool)
            or not math.isfinite(gain)
            or not 0 < abs(gain) <= MAX_GAIN_DB
        ):
            raise ValueError("gainDb must be a gain other than 0")
        return {"kind": kind, "gainDb": float(gain)}
    raise ValueError("unknown kind of plan")


def _tool_failed(name: str, done: Any) -> Refused:
    # What a tool says can quote the file; it goes to the log as one clean line.
    said = _CONTROL_CHARACTERS.sub(" ", done.stderr.decode("utf-8", "replace")).strip()
    return Refused(f"{name} failed ({done.returncode}): {said[:_MAX_LOGGED_ERROR]}")


def _apply_mp3gain(
    source: BinaryIO, dst: str, identity: tuple[int, int], steps: int, stop: threading.Event
) -> None:
    """A copy of the MP3 at `dst`, its gain changed by mp3gain in place."""
    mp3gain = tool_path(MP3GAIN_ENV)
    with open_made(dst, identity, "rb+") as copy:
        copy_stream(source, copy, stop)
    size = os.fstat(source.fileno()).st_size
    # An empty standard input: mp3gain must never read the sidecar's own.
    done = run_tool(
        # `-T`: in the file itself. By default mp3gain writes a file of its own next to it
        # and renames that, which would put an unknown name into a library folder.
        [mp3gain, "-T", "-g", str(steps), "-s", "s", "-q", dst],
        data=b"",
        timeout=APPLY_TIMEOUT_S,
        stop=stop,
    )
    if done.returncode != 0:
        raise _tool_failed("mp3gain", done)
    with open_made(dst, identity, "rb") as written:
        # The gain fields only: a file of another size was written in another way.
        if os.fstat(written.fileno()).st_size != size:
            raise Refused("mp3gain changed more than the gain of the file")


def _chunks(file: BinaryIO, size: int, byteorder: str) -> list[tuple[bytes, int, int]]:
    """The chunks after the 12 byte head of a RIFF or IFF file: id, size, start of data."""
    found = []
    offset = 12
    while offset + 8 <= size and len(found) < _MAX_CHUNKS:
        file.seek(offset)
        head = file.read(8)
        if len(head) < 8:
            break
        length = int.from_bytes(head[4:], byteorder)
        found.append((head[:4], length, offset + 8))
        offset += 8 + length + (length & 1)
    return found


def _pcm_layout(file: BinaryIO) -> tuple[int, int, int, str]:
    """Where the samples of an AIFF or a WAV are, how many bytes, their depth and byte order."""
    size = os.fstat(file.fileno()).st_size
    file.seek(0)
    head = file.read(12)
    if head[:4] == b"FORM" and head[8:12] in (b"AIFF", b"AIFC"):
        chunks = _chunks(file, size, "big")
        common = next((chunk for chunk in chunks if chunk[0] == b"COMM"), None)
        sound = next((chunk for chunk in chunks if chunk[0] == b"SSND"), None)
        if common is None or sound is None or common[1] < 18:
            raise Refused("not an AIFF this app normalizes")
        file.seek(common[2])
        # The header is a few dozen bytes, whatever size the chunk claims.
        data = file.read(min(common[1], _MAX_HEADER_BYTES))
        if len(data) < 18:
            raise Refused("not an AIFF this app normalizes")
        channels, frames, depth = struct.unpack(">hIh", data[:8])
        if head[8:12] == b"AIFC" and (len(data) < 22 or data[18:22] not in (b"NONE", b"twos")):
            raise Refused("not an AIFF this app normalizes")
        file.seek(sound[2])
        offset = int.from_bytes(file.read(4), "big")
        start = sound[2] + 8 + offset
        length = channels * frames * depth // 8
        # The samples the header promises, all of them in the file.
        if channels < 1 or length == 0 or start + length > min(sound[2] + sound[1], size):
            raise Refused("not an AIFF this app normalizes")
        return start, length, depth, "big"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        chunks = _chunks(file, size, "little")
        form = next((chunk for chunk in chunks if chunk[0] == b"fmt "), None)
        sound = next((chunk for chunk in chunks if chunk[0] == b"data"), None)
        if form is None or sound is None or form[1] < 16:
            raise Refused("not a WAV this app normalizes")
        file.seek(form[2])
        data = file.read(min(form[1], _MAX_HEADER_BYTES))
        if len(data) < 16:
            raise Refused("not a WAV this app normalizes")
        tag, channels, _rate, _bytes, align, depth = struct.unpack("<HHIIHH", data[:16])
        # Plain PCM, or the longer header that most 24 bit files have, around PCM.
        extensible = tag == 0xFFFE and len(data) >= 26 and data[24:26] == b"\x01\x00"
        if (tag != 1 and not extensible) or channels < 1 or align != channels * depth // 8:
            raise Refused("not a WAV this app normalizes")
        length = min(sound[1], size - sound[2]) // align * align
        if length <= 0:
            raise Refused("not a WAV this app normalizes")
        return sound[2], length, depth, "little"
    raise Refused("not an AIFF or a WAV")


def _scaled(raw: bytes, depth: int, byteorder: str, factor: float, rng: Any) -> bytes:
    """Samples multiplied by `factor`, rounded back to their depth."""
    import numpy

    if depth == 16:
        samples = numpy.frombuffer(raw, dtype=">i2" if byteorder == "big" else "<i2")
        values = samples.astype(numpy.float64) * factor
        # TPDF: the sum of two uniform values of one step each, before the rounding. Not
        # on digital silence, which is to stay silent, not become a noise floor.
        noise = rng.random(values.size) - rng.random(values.size)
        values += numpy.where(samples == 0, 0.0, noise)
        limit = 32767
        out = numpy.clip(numpy.rint(values), -limit - 1, limit).astype(
            ">i2" if byteorder == "big" else "<i2"
        )
        return out.tobytes()
    triples = numpy.frombuffer(raw, dtype=numpy.uint8).reshape(-1, 3).astype(numpy.int32)
    if byteorder == "big":
        joined = (triples[:, 0] << 16) | (triples[:, 1] << 8) | triples[:, 2]
    else:
        joined = (triples[:, 2] << 16) | (triples[:, 1] << 8) | triples[:, 0]
    joined = numpy.where(joined >= 1 << 23, joined - (1 << 24), joined)
    limit = (1 << 23) - 1
    values = numpy.clip(numpy.rint(joined.astype(numpy.float64) * factor), -limit - 1, limit)
    packed = values.astype(numpy.int64) & 0xFFFFFF
    out = numpy.empty((packed.size, 3), dtype=numpy.uint8)
    order = (0, 1, 2) if byteorder == "big" else (2, 1, 0)
    for column, shift in zip(order, (16, 8, 0), strict=True):
        out[:, column] = (packed >> shift) & 0xFF
    return out.tobytes()


def _apply_pcm(
    source: BinaryIO, dst: str, identity: tuple[int, int], gain_db: float, stop: threading.Event
) -> None:
    """A copy of the AIFF or WAV at `dst`, its samples, and only they, multiplied by the gain."""
    import numpy

    start, length, depth, byteorder = _pcm_layout(source)
    if depth not in (16, 24):
        raise Refused("only 16 and 24 bit files are normalized")
    factor = 10.0 ** (gain_db / 20.0)
    rng = numpy.random.default_rng(_DITHER_SEED)
    source.seek(0)
    with open_made(dst, identity, "rb+") as copy:
        copy_stream(source, copy, stop)
        block = _BLOCK_FRAMES * depth // 8 * 2
        done = 0
        while done < length:
            if stop.is_set():
                raise Stopped()
            part = min(block, length - done)
            part -= part % (depth // 8)
            if part == 0:
                break
            copy.seek(start + done)
            raw = copy.read(part)
            copy.seek(start + done)
            copy.write(_scaled(raw, depth, byteorder, factor, rng))
            done += part


def _id3_of(source: BinaryIO) -> Any:
    """The ID3v2 tag at the start of an MP3, read, or None. The file is left at its start.

    A file with an ID3v1 tag only is refused: it would lose its tags, since the tag is
    carried as ID3v2.3 and ffmpeg is told to write none of its own.
    """
    try:
        head = source.read(10)
        if len(head) < 10 or head[:3] != b"ID3":
            size = os.fstat(source.fileno()).st_size
            if size >= 128:
                source.seek(size - 128)
                if source.read(3) == b"TAG":
                    raise Refused("the file has an ID3v1 tag only")
            return None
        size = 0
        for byte in head[6:10]:
            if byte & 0x80:
                raise Refused("the tags of the file cannot be read")
            size = (size << 7) | byte
        # A footer is ten bytes more.
        total = 10 + size + (10 if head[5] & 0x10 else 0)
        if total > MAX_TAG_BYTES:
            raise Refused("the tags of the file are larger than a tag may be")
        source.seek(0)
        tag = source.read(total)
        if len(tag) != total:
            raise Refused("the tags of the file cannot be read")
        # A tag of a million empty frames would keep the reader busy for minutes.
        check_frame_count(tag)
        return read_id3(tag)
    finally:
        source.seek(0)


def _apply_reencode(
    source: BinaryIO, dst: str, identity: tuple[int, int], gain_db: float, stop: threading.Event
) -> None:
    """The MP3 encoded again at `dst` at 320 kbps, its volume changed, its tag carried over."""
    # Read before anything is written: a file whose tag cannot be carried is refused whole.
    tag = _id3_of(source)
    limit = os.fstat(source.fileno()).st_size * _MAX_GROWTH + 1024 * 1024
    command = [
        ffmpeg_path(),
        "-nostdin",
        "-max_alloc",
        str(MAX_FFMPEG_ALLOC),
        "-hide_banner",
        "-loglevel",
        "fatal",
        "-protocol_whitelist",
        "pipe",
        "-f",
        "mp3",
        "-i",
        "pipe:0",
        # The first audio stream only; the cover comes back with the tag below.
        "-map",
        "0:a:0",
        "-vn",
        # A linear gain and nothing more.
        "-af",
        f"volume={gain_db:.4f}dB",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "320k",
        "-map_metadata",
        "-1",
        # The tag is the source's own, written below; ffmpeg writes none.
        "-id3v2_version",
        "0",
        "-write_id3v1",
        "0",
        "-bitexact",
        # No more than this may take up the drive; a file cut there is refused below.
        "-fs",
        str(limit),
        # Into the file that was made for it, which is empty.
        "-y",
        "-f",
        "mp3",
        dst,
    ]
    os.lseek(source.fileno(), 0, os.SEEK_SET)
    done = run_tool(command, stdin=source, timeout=APPLY_TIMEOUT_S, stop=stop)
    if done.returncode != 0:
        raise _tool_failed("ffmpeg", done)
    with open_made(dst, identity, "rb") as written:
        if os.fstat(written.fileno()).st_size >= limit:
            raise Refused("the file encoded again is larger than it can be")
    if tag is None or len(tag) == 0:
        return
    tag.update_to_v23()
    with open_made(dst, identity, "rb+") as target:
        tag.save(target, v2_version=3)


_APPLY = {"mp3gain": _apply_mp3gain, "pcm": _apply_pcm, "reencode": _apply_reencode}
_EXTENSIONS = {"mp3gain": (".mp3",), "reencode": (".mp3",), "pcm": (".aif", ".aiff", ".wav")}


def apply_plan(
    src: str, dst: str, identity: tuple[int, int], plan: dict[str, Any], stop: threading.Event
) -> None:
    """Writes `src` with the planned gain into the file made at `dst`."""
    kind = plan["kind"]
    if os.path.splitext(src)[1].lower() not in _EXTENSIONS[kind]:
        raise Refused("the plan is not one for a file of this format")
    source = open_regular_file(src)
    if source is None:
        raise Refused("not a regular file")
    with source:
        amount = plan["steps"] if kind == "mp3gain" else plan["gainDb"]
        try:
            _APPLY[kind](source, dst, identity, amount, stop)
        except DecodeError as error:
            raise Refused(str(error)) from None


@rpc("normalize.apply")
def apply(src: str, dst: str, plan: dict[str, Any], job_id: str) -> dict[str, bool]:
    """Change the loudness of one file. Reads `src`, writes `dst`, touches nothing else.

    `dst` is the temp file the app's file rules made a name for, next to `src`; the
    app puts it in place when this returns. It is made here, and must not be there
    before. When the call fails or is stopped, the file it made is removed.
    """
    check_temp_target(src, dst)
    checked = _check_plan(plan)
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        identity = create_made(dst)
        try:
            apply_plan(src, dst, identity, checked, stop)
            raise_if_cancelled(stop)
        except (Stopped, ToolStopped):
            remove_made(dst, identity)
            raise JobCancelled() from None
        except BaseException:
            remove_made(dst, identity)
            raise
    return {"written": True}
