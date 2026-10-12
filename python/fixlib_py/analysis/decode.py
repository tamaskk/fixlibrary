"""Decodes a library file to mono samples with the app's own ffmpeg.

File content is untrusted. Essentia's own loader is not used: the FFmpeg inside its
wheel is old and has network protocols compiled in. The ffmpeg the app ships knows
`file` and `pipe` only, and here it is given the file as its standard input, so it
opens nothing by name.
"""

from __future__ import annotations

import os
import re
import subprocess
from typing import TYPE_CHECKING

from fixlib_py.files import open_regular_file

if TYPE_CHECKING:
    import numpy

SAMPLE_RATE = 44_100
# Tempo and key do not change with what comes after this, and it bounds what one
# job decodes: 53 MB as it leaves ffmpeg, twice that as floats.
MAX_SECONDS = 10 * 60
DECODE_TIMEOUT_S = 60
# The most ffmpeg may ask for in one allocation. Decoding needs a fraction of this;
# a header that claims an absurd sample rate makes the resampler ask for gigabytes.
MAX_FFMPEG_ALLOC = 128 * 1024 * 1024
# What ffmpeg can return for MAX_SECONDS, with room for the header.
_MAX_OUTPUT = MAX_SECONDS * SAMPLE_RATE * 2 + 4096
# Set by the app (services/python-bridge.ts) to the ffmpeg it ships.
FFMPEG_ENV = "FIXLIB_FFMPEG"

# The demuxer is chosen by the file name, never by ffmpeg's guess from the content:
# the content of a file must not decide which code reads it.
_DEMUXERS = {".mp3": "mp3", ".wav": "wav", ".aif": "aiff", ".aiff": "aiff"}
_MAX_LOGGED_ERROR = 300
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]+")


class DecodeError(Exception):
    """The file could not be turned into samples."""


def ffmpeg_path() -> str:
    """The ffmpeg of the app. Nothing falls back to a tool on the PATH."""
    path = os.environ.get(FFMPEG_ENV, "")
    if not os.path.isabs(path) or not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise DecodeError(f"{FFMPEG_ENV} does not name the app's ffmpeg")
    return path


def _samples_of_wav(data: bytes) -> memoryview:
    """The sample data of a WAV stream written to a pipe, without copying it.

    Such a stream cannot go back to fill in its sizes, so the data chunk runs to the end.
    """
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise DecodeError("ffmpeg returned no audio")
    offset = 12
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        if data[offset : offset + 4] == b"data":
            return memoryview(data)[offset + 8 :]
        offset += 8 + size + (size & 1)
    raise DecodeError("ffmpeg returned no audio")


def decode_mono(path: str) -> numpy.ndarray:
    """At most the first MAX_SECONDS of a file as mono float32 samples at SAMPLE_RATE."""
    import numpy

    demuxer = _DEMUXERS.get(os.path.splitext(path)[1].lower())
    if demuxer is None:
        raise DecodeError("not one of the app's audio formats")
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
        demuxer,
        "-i",
        "pipe:0",
        # The first audio stream only: an embedded cover is a video stream to ffmpeg.
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-t",
        str(MAX_SECONDS),
        "-map_metadata",
        "-1",
        "-bitexact",
        "-c:a",
        "pcm_s16le",
        # The ffmpeg of the app has no raw output format; WAV is the plainest it has.
        "-f",
        "wav",
        "pipe:1",
    ]
    file = open_regular_file(path)
    if file is None:
        raise DecodeError("not a regular file")
    with file:
        try:
            done = subprocess.run(
                command,
                stdin=file,
                capture_output=True,
                env={},
                cwd="/",
                timeout=DECODE_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise DecodeError("ffmpeg did not finish in time") from None
    if done.returncode != 0:
        # What ffmpeg says can quote the file; it goes to the log as one clean line.
        said = _CONTROL_CHARACTERS.sub(" ", done.stderr.decode("utf-8", "replace")).strip()
        raise DecodeError(f"ffmpeg failed ({done.returncode}): {said[:_MAX_LOGGED_ERROR]}")
    if len(done.stdout) > _MAX_OUTPUT:
        raise DecodeError("ffmpeg returned more audio than was asked for")
    samples = _samples_of_wav(done.stdout)
    # One copy, as floats, scaled where it is: a long track must not be held three times.
    audio = numpy.frombuffer(samples, dtype="<i2", count=len(samples) // 2).astype(numpy.float32)
    audio /= 32768.0
    return audio
