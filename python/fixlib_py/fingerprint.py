"""The acoustic fingerprint of a track, for looking it up at AcoustID.

Mirrored by `fingerprint.compute` in src/shared/rpc.ts.
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Any

from fixlib_py.analysis.decode import DecodeError, ToolStopped, decode_wav, run_tool, tool_path
from fixlib_py.server import JobCancelled, cancellable, raise_if_cancelled, rpc
from fixlib_py.tags import read_file_tags

# Set by the app (services/python-bridge.ts) to the fpcalc it ships.
FPCALC_ENV = "FIXLIB_FPCALC"
# What AcoustID fingerprints are made of: the first two minutes.
FINGERPRINT_SECONDS = 120
FPCALC_TIMEOUT_S = 30
# The same limit as in src/shared/rpc.ts. Two minutes give about 2500 characters.
MAX_FINGERPRINT_LENGTH = 8192

_FINGERPRINT = re.compile(r"^[A-Za-z0-9_-]+$")


def fingerprint_of_wav(wav: bytes, stop: threading.Event | None = None) -> str:
    """The fingerprint fpcalc makes of a WAV stream.

    fpcalc never sees a library file. Its own FFmpeg can open network addresses and
    takes whatever a header claims, so the file is decoded by the app's ffmpeg first
    (`decode_wav`), and fpcalc is handed plain samples on its standard input.
    """
    command = [
        tool_path(FPCALC_ENV),
        "-json",
        "-length",
        str(FINGERPRINT_SECONDS),
        "-format",
        "wav",
        "-",
    ]
    done = run_tool(command, data=wav, timeout=FPCALC_TIMEOUT_S, stop=stop)
    if done.returncode != 0:
        # Too little audio for a fingerprint ends here as well.
        raise DecodeError(f"fpcalc failed ({done.returncode})")
    try:
        fingerprint = json.loads(done.stdout)["fingerprint"]
    except (ValueError, KeyError, TypeError):
        raise DecodeError("fpcalc returned no fingerprint") from None
    if (
        not isinstance(fingerprint, str)
        or not 1 <= len(fingerprint) <= MAX_FINGERPRINT_LENGTH
        or _FINGERPRINT.match(fingerprint) is None
    ):
        raise DecodeError("fpcalc returned no fingerprint")
    return fingerprint


@rpc("fingerprint.compute")
def compute(path: str, job_id: str) -> dict[str, Any]:
    """Fingerprint one file. Reads the file and changes nothing.

    `duration` is the length of the whole track in seconds, which AcoustID asks for
    next to the fingerprint of its first two minutes.
    """
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        duration_ms = read_file_tags(path)["durationMs"]
        if duration_ms is None:
            raise DecodeError("the length of the file cannot be read")
        try:
            # Both tools are ended as soon as the job is told to stop.
            wav = decode_wav(path, 2, FINGERPRINT_SECONDS, stop)
            fingerprint = fingerprint_of_wav(wav, stop)
        except ToolStopped:
            raise JobCancelled() from None
        raise_if_cancelled(stop)
    return {"fingerprint": fingerprint, "duration": max(1, round(duration_ms / 1000))}
