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
import threading
import time
from typing import TYPE_CHECKING, BinaryIO

from fixlib_py.files import open_regular_file

if TYPE_CHECKING:
    import numpy

SAMPLE_RATE = 44_100
# Tempo and key do not change with what comes after this, and it bounds what one
# job decodes: 53 MB as it leaves ffmpeg, twice that as floats.
MAX_SECONDS = 10 * 60
# The longest stretch any caller may ask for; each asks for its own (decode_mono for
# MAX_SECONDS, the stems for theirs). Twenty minutes of 16 bit stereo are 212 MB.
MAX_DECODE_SECONDS = 20 * 60 + 1
DECODE_TIMEOUT_S = 60
# The most ffmpeg may ask for in one allocation. Decoding needs a fraction of this;
# a header that claims an absurd sample rate makes the resampler ask for gigabytes.
MAX_FFMPEG_ALLOC = 128 * 1024 * 1024
# What a WAV stream may hold beside its samples.
_HEADER_ROOM = 4096
# Set by the app (services/python-bridge.ts) to the ffmpeg it ships.
FFMPEG_ENV = "FIXLIB_FFMPEG"

# The demuxer is chosen by the file name, never by ffmpeg's guess from the content:
# the content of a file must not decide which code reads it.
_DEMUXERS = {".mp3": "mp3", ".wav": "wav", ".aif": "aiff", ".aiff": "aiff"}
_MAX_LOGGED_ERROR = 300
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]+")


class DecodeError(Exception):
    """The file could not be turned into samples."""


class ToolStopped(Exception):
    """A tool was ended because the job it worked for was told to stop."""


# How often a running tool is looked at: whether its job was stopped, or its time is up.
_POLL_S = 0.2


def run_tool(
    command: list[str],
    *,
    stdin: BinaryIO | None = None,
    data: bytes | None = None,
    timeout: float,
    stop: threading.Event | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run a tool of the app to its end and return what it wrote.

    The tool gets an empty environment and reads either `stdin` or `data`. It is
    killed when its time is up (DecodeError) or when `stop` is set (ToolStopped): a
    job that was told to stop must not leave a process working for it.
    """
    process = subprocess.Popen(
        command,
        stdin=stdin if data is None else subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={},
        cwd="/",
    )
    deadline = time.monotonic() + timeout
    pending = data
    while True:
        try:
            output, errors = process.communicate(input=pending, timeout=_POLL_S)
        except subprocess.TimeoutExpired:
            # The input is on its way already; it is handed over only once.
            pending = None
            stopped = stop is not None and stop.is_set()
            if not stopped and time.monotonic() < deadline:
                continue
            process.kill()
            process.communicate()
            if stopped:
                raise ToolStopped() from None
            raise DecodeError(f"{os.path.basename(command[0])} did not finish in time") from None
        return subprocess.CompletedProcess(command, process.returncode, output, errors)


def demuxer_for(path: str) -> str | None:
    """The demuxer ffmpeg reads a file with, by its name; None for no audio file of the app."""
    return _DEMUXERS.get(os.path.splitext(path)[1].lower())


def tool_path(variable: str) -> str:
    """A tool the app ships, named by the app in the environment.

    Nothing falls back to a tool on the PATH.
    """
    path = os.environ.get(variable, "")
    if not os.path.isabs(path) or not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise DecodeError(f"{variable} does not name a tool of the app")
    return path


def ffmpeg_path() -> str:
    """The ffmpeg of the app."""
    return tool_path(FFMPEG_ENV)


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


def decode_wav(
    path: str,
    channels: int,
    seconds: int,
    stop: threading.Event | None = None,
    timeout: float = DECODE_TIMEOUT_S,
) -> bytes:
    """At most the first `seconds` of a file as a 16 bit WAV stream at SAMPLE_RATE.

    The stream is what ffmpeg writes to a pipe: its header cannot hold its sizes.
    ffmpeg is ended when `stop` is set (ToolStopped).
    """
    if channels not in (1, 2) or not 1 <= seconds <= MAX_DECODE_SECONDS:
        raise ValueError("unsupported decoding request")
    demuxer = demuxer_for(path)
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
        str(channels),
        "-ar",
        str(SAMPLE_RATE),
        "-t",
        str(seconds),
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
        done = run_tool(command, stdin=file, timeout=timeout, stop=stop)
    if done.returncode != 0:
        # What ffmpeg says can quote the file; it goes to the log as one clean line.
        said = _CONTROL_CHARACTERS.sub(" ", done.stderr.decode("utf-8", "replace")).strip()
        raise DecodeError(f"ffmpeg failed ({done.returncode}): {said[:_MAX_LOGGED_ERROR]}")
    if len(done.stdout) > seconds * SAMPLE_RATE * 2 * channels + _HEADER_ROOM:
        raise DecodeError("ffmpeg returned more audio than was asked for")
    return done.stdout


def decode_mono(path: str) -> numpy.ndarray:
    """At most the first MAX_SECONDS of a file as mono float32 samples at SAMPLE_RATE."""
    import numpy

    samples = _samples_of_wav(decode_wav(path, 1, MAX_SECONDS))
    # One copy, as floats, scaled where it is: a long track must not be held three times.
    audio = numpy.frombuffer(samples, dtype="<i2", count=len(samples) // 2).astype(numpy.float32)
    audio /= 32768.0
    return audio
