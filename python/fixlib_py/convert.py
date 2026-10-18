"""Turns a WAV file into an AIFF that every Pioneer player can play.

Mirrored by `convert.wav_to_aiff` in src/shared/rpc.ts.

Lossless where the players allow it: the samples keep their rate up to 48 kHz and
their depth up to 24 bit. The file is read with the app's own ffmpeg, as its standard
input, and the result is written to the one path the app names; nothing here chooses
where a file goes. File content, tags included, is untrusted.
"""

from __future__ import annotations

import math
import os
import re
import threading
from typing import Any, BinaryIO

from fixlib_py.analysis.decode import (
    MAX_FFMPEG_ALLOC,
    DecodeError,
    ToolStopped,
    ffmpeg_path,
    run_tool,
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

# The highest rate every Pioneer player takes; a file above it is brought down to it.
MAX_SAMPLE_RATE = 48_000
# More channels than this are no music file of a DJ, and the app's contract ends there.
MAX_CHANNELS = 8
# How far the length of the result may be from the length of the source.
MAX_LENGTH_DIFFERENCE_MS = 10
# Less than the stage's own limit in src/shared/timeouts.ts, so ffmpeg is ended here.
CONVERT_TIMEOUT_S = 110
# The most an `id3 ` chunk may hold. A cover is a few megabytes at most.
MAX_TAG_BYTES = 16 * 1024 * 1024
# What an AIFF may hold beside its samples: its header and the texts ffmpeg carries.
_OUTPUT_ROOM = 1024 * 1024
# The decoder for each kind of samples a WAV holds, and what the result is made of.
# 24 bit is the most every player takes, so 32 bit and floating point become 24 bit.
# The decoder is named to ffmpeg: the content of a file must not choose its own.
_SAMPLES = {
    "PCM_U8": ("pcm_u8", "pcm_s16be"),
    "PCM_16": ("pcm_s16le", "pcm_s16be"),
    "PCM_24": ("pcm_s24le", "pcm_s24be"),
    "PCM_32": ("pcm_s32le", "pcm_s24be"),
    "FLOAT": ("pcm_f32le", "pcm_s24be"),
    "DOUBLE": ("pcm_f64le", "pcm_s24be"),
}
_BIT_DEPTHS = {"PCM_16": 16, "PCM_24": 24}
_MAX_LOGGED_ERROR = 300
_MAX_CHUNKS = 10_000
# As many as the app's contract lets through; a tag has a few dozen frames.
_MAX_LOST_FRAMES = 32
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]+")


# What a caller of this module catches; one kind of refusal for every file the app
# will not work on.
ConvertError = Refused
# Kept under its old name for the tests that ask it directly.
_read_tags = read_id3


def _chunks(file: BinaryIO, byteorder: str) -> Any:
    """The chunks of a RIFF or IFF file after its 12 byte head: id, size, and where the data starts.

    Ends where the file does, or where a size runs past it. Reads no chunk data.
    """
    position = 12
    for _ in range(_MAX_CHUNKS):
        file.seek(position)
        header = file.read(8)
        if len(header) < 8:
            return
        size = int.from_bytes(header[4:8], byteorder)  # type: ignore[arg-type]
        yield header[:4], size, position + 8
        position += 8 + size + (size & 1)
    # More chunks than any audio file has: what comes after them is not looked at,
    # and a file whose tags may be among it is not converted without them.
    raise ConvertError("not a WAV this app converts")


def _container(file: BinaryIO) -> str:
    """`wav` or `aiff`, by what the file says of itself. The file is left at its start.

    Asked before any parser sees the file: libsndfile picks its parser, and its
    codec, by the content. A file named `.wav` reaches it only as plain samples.
    """
    try:
        head = file.read(12)
        if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
            for name, size, start in _chunks(file, "little"):
                if name != b"fmt ":
                    continue
                file.seek(start)
                fmt = file.read(min(size, 40))
                kind = int.from_bytes(fmt[:2], "little")
                # 1 is PCM and 3 is floating point; 0xFFFE says the kind stands
                # further on, in the longer header most 24 bit files have.
                if kind == 0xFFFE and len(fmt) >= 26:
                    kind = int.from_bytes(fmt[24:26], "little")
                if kind in (1, 3):
                    return "wav"
                break
        elif head[:4] == b"FORM" and head[8:12] == b"AIFF":
            return "aiff"
        raise ConvertError("not a WAV this app converts")
    finally:
        file.seek(0)


def _info(file: BinaryIO) -> Any:
    """What libsndfile says about an open file. The file is left at its start."""
    import soundfile

    try:
        return soundfile.info(file)
    except Exception:
        raise ConvertError("the file cannot be read as audio") from None
    finally:
        file.seek(0)


def _describe(info: Any) -> dict[str, Any]:
    depth = _BIT_DEPTHS.get(info.subtype)
    if (
        info.format != "AIFF"
        or depth is None
        or info.samplerate > MAX_SAMPLE_RATE
        or not 1 <= info.channels <= MAX_CHANNELS
        or info.frames < 1
    ):
        raise ConvertError("the result is not an AIFF a player can play")
    return {
        "sampleRateHz": info.samplerate,
        "bitDepth": depth,
        "channels": info.channels,
        "durationMs": round(info.frames * 1000 / info.samplerate),
    }


def _id3_chunk(file: BinaryIO) -> bytes | None:
    """The `id3 ` chunk of a WAV as it is, or None. The file is left at its start."""
    try:
        for name, size, start in _chunks(file, "little"):
            if name.lower() != b"id3 ":
                continue
            if size > MAX_TAG_BYTES:
                raise ConvertError("the tags of the file are larger than a tag may be")
            file.seek(start)
            data = file.read(size)
            if len(data) != size:
                raise ConvertError("the tags of the file cannot be read")
            return data
        return None
    finally:
        file.seek(0)


# What ID3v2.3 says in other frames than ID3v2.4, which is no loss.
_TRANSLATED = {"TDRC", "TDOR", "TIPL", "TMCL"}
# Frames ID3v2.3 does not have and every player and tagger reads in it all the same:
# the names a library is sorted by.
_SORT_FRAMES = ("TSOA", "TSOP", "TSOT")
_FRAME_ID = re.compile(r"^[A-Z0-9]{3,4}$")


def _copy_tags(frames: Any, target: BinaryIO) -> list[str]:
    """Carries the frames of a WAV's `id3 ` chunk, cover included, into the AIFF.

    ffmpeg brings the RIFF INFO texts with it; what a tagger wrote as ID3 into the
    WAV is the fuller set, so its frames take the place of those. Written as real
    ID3v2.3, the version Rekordbox reads: a year is `TYER` there, not `TDRC`.
    Returns the ids of the frames that could not be carried, for the app to say.
    """
    from mutagen.aiff import AIFF

    # A frame mutagen does not know is kept by it as bytes, and written by no one.
    lost = [raw[:4].decode("ascii", "replace") for raw in frames.unknown_frames]
    if len(frames) == 0:
        return [name for name in lost if _FRAME_ID.match(name)]
    audio = AIFF(target)
    if audio.tags is None:
        audio.add_tags()
    before = set()
    for frame in frames.values():
        audio.tags.add(frame)
        before.add(frame.FrameID)
    sorting = [frame for name in _SORT_FRAMES for frame in audio.tags.getall(name)]
    audio.tags.update_to_v23()
    for frame in sorting:
        audio.tags.add(frame)
    # A volume adjustment of ID3v2.4 has no place in a v2.3 tag, and no player of
    # the app's reads it.
    audio.tags.delall("RVA2")
    after = {frame.FrameID for frame in audio.tags.values()}
    lost += sorted(before - after - _TRANSLATED)
    target.seek(0)
    audio.save(target, v2_version=3)
    return [name for name in lost if _FRAME_ID.match(name)][:_MAX_LOST_FRAMES]


def convert_file(
    src: str, dst: str, identity: tuple[int, int], stop: threading.Event | None = None
) -> dict[str, Any]:
    """Write `src` as an AIFF into the file made at `dst`, and describe the result."""
    source = open_regular_file(src)
    if source is None:
        raise ConvertError("not a regular file")
    with source:
        container = _container(source)
        info = _info(source)
        if container == "aiff":
            # A run that was stopped after the content was written and before that
            # was recorded: the work is done, and doing it again is a plain copy.
            described = _describe(info)
            with open_made(dst, identity, "rb+") as copy:
                try:
                    copy_stream(source, copy, stop)
                except Stopped:
                    raise ToolStopped() from None
            return {**described, "converted": False, "tagsLost": []}
        samples = _SAMPLES.get(info.subtype)
        # `WAVEX` is the same file with a longer header, which most 24 bit files have.
        if info.format not in ("WAV", "WAVEX") or samples is None:
            raise ConvertError("not a WAV this app converts")
        if not 1 <= info.channels <= MAX_CHANNELS or info.frames < 1:
            raise ConvertError("not a WAV this app converts")
        decoder, codec = samples
        depth = 16 if codec == "pcm_s16be" else 24
        rate = min(info.samplerate, MAX_SAMPLE_RATE)
        # Looked at before anything is written: a file whose tags cannot be carried
        # is refused whole, not converted without them.
        tag = _id3_chunk(source)
        if tag is not None:
            # A tag of a million empty frames would keep the reader busy for minutes.
            check_frame_count(tag)
        tagged = None if tag is None else read_id3(tag)
        frames = math.ceil(info.frames * rate / info.samplerate) + rate
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
            # The demuxer and the decoder are named, never guessed from the content.
            "-f",
            "wav",
            "-c:a",
            decoder,
            "-i",
            "pipe:0",
            # The first audio stream only.
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            codec,
            "-ar",
            str(rate),
            # The RIFF INFO texts of the source, as ID3v2.3; no line naming the tool.
            "-write_id3v2",
            "1",
            "-id3v2_version",
            "3",
            "-bitexact",
            # No more than the samples the header promises can take up.
            "-fs",
            str(frames * info.channels * depth // 8 + _OUTPUT_ROOM),
            # Into the file that was made for it, which is empty.
            "-y",
            "-f",
            "aiff",
            dst,
        ]
        # The descriptor itself goes to ffmpeg, so it is the descriptor that must
        # stand at the start, not only the reader around it.
        source.seek(0)
        os.lseek(source.fileno(), 0, os.SEEK_SET)
        try:
            done = run_tool(command, stdin=source, timeout=CONVERT_TIMEOUT_S, stop=stop)
        except DecodeError as error:
            raise ConvertError(str(error)) from None
        if done.returncode != 0:
            # What ffmpeg says can quote the file; it goes to the log as one clean line.
            said = _CONTROL_CHARACTERS.sub(" ", done.stderr.decode("utf-8", "replace")).strip()
            raise ConvertError(f"ffmpeg failed ({done.returncode}): {said[:_MAX_LOGGED_ERROR]}")

    lost: list[str] = []
    if tagged is not None:
        with open_made(dst, identity, "rb+") as target:
            lost = _copy_tags(tagged, target)
    with open_made(dst, identity, "rb") as result:
        described = _describe(_info(result))
    source_ms = info.frames * 1000 / info.samplerate
    if (
        described["sampleRateHz"] != rate
        or described["bitDepth"] != depth
        or described["channels"] != info.channels
        or abs(described["durationMs"] - source_ms) > MAX_LENGTH_DIFFERENCE_MS
    ):
        raise ConvertError("the result does not match its source")
    return {**described, "converted": True, "tagsLost": lost}


@rpc("convert.wav_to_aiff")
def wav_to_aiff(src: str, dst: str, job_id: str) -> dict[str, Any]:
    """Convert one WAV. Reads `src`, writes `dst`, and touches nothing else.

    `dst` is the temp file the app's file rules made a name for, next to `src`; the
    app puts it in place when this returns. It is made here, and must not be there
    before. When the call fails or is stopped, the file it made is removed.
    """
    check_temp_target(src, dst)
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        identity = create_made(dst)
        try:
            result = convert_file(src, dst, identity, stop)
            raise_if_cancelled(stop)
        except ToolStopped:
            remove_made(dst, identity)
            raise JobCancelled() from None
        except BaseException:
            remove_made(dst, identity)
            raise
    return result
