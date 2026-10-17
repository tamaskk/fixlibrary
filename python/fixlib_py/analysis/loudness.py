"""Measures the loudness of a file by EBU R128 with the app's own ffmpeg.

Mirrored by `analysis.loudness` in src/shared/rpc.ts.

The file goes to ffmpeg as its standard input, read by the demuxer its name calls
for, as in decode.py. The `ebur128` filter prints its summary to the log, and only
that summary is read: the integrated loudness, the loudness range and the true peak.
"""

from __future__ import annotations

import math
import os
import re
import threading
from typing import Any

from fixlib_py.analysis.decode import (
    MAX_FFMPEG_ALLOC,
    ToolStopped,
    demuxer_for,
    ffmpeg_path,
    run_tool,
)
from fixlib_py.files import open_regular_file
from fixlib_py.server import JobCancelled, cancellable, raise_if_cancelled, rpc

# Less than the stage's own limit in src/shared/timeouts.ts, so ffmpeg is ended here.
MEASURE_TIMEOUT_S = 110
# What ffmpeg reports for audio that has nothing above the absolute gate of R128:
# silence, or less of a signal than any track has.
SILENT_LUFS = -70.0
# The log of a whole run, the stream lines and the summary. Far more is something else.
_MAX_LOG_BYTES = 1024 * 1024

_NUMBER = r"(-?(?:\d+(?:\.\d+)?|inf)|nan)"
_INTEGRATED = re.compile(rf"^\s*I:\s+{_NUMBER} LUFS\s*$", re.MULTILINE)
_RANGE = re.compile(rf"^\s*LRA:\s+{_NUMBER} LU\s*$", re.MULTILINE)
_TRUE_PEAK = re.compile(rf"^\s*True peak:\s*\n\s*Peak:\s+{_NUMBER} dBFS\s*$", re.MULTILINE)


class LoudnessError(Exception):
    """ffmpeg's log has no summary the app can read."""


def parse_summary(log: str) -> dict[str, float]:
    """The integrated loudness, the range and the true peak of an `ebur128` summary.

    Only what follows the last `Summary:` counts: a frame line above it is no summary.
    The values are as ffmpeg prints them; one that is not finite stays so, for the
    caller to judge.
    """
    at = log.rfind("Summary:")
    if at == -1:
        raise LoudnessError("ffmpeg printed no loudness summary")
    summary = log[at:]
    found = {}
    for name, pattern in (
        ("integratedLufs", _INTEGRATED),
        ("lra", _RANGE),
        ("truePeakDbtp", _TRUE_PEAK),
    ):
        match = pattern.search(summary)
        if match is None:
            raise LoudnessError(f"the loudness summary has no {name}")
        found[name] = float(match.group(1))
    return found


def judge(values: dict[str, float]) -> dict[str, Any]:
    """The answer for a summary: the values, or why the file has none."""
    integrated = values["integratedLufs"]
    peak = values["truePeakDbtp"]
    if not math.isfinite(peak) or not math.isfinite(integrated) or integrated <= SILENT_LUFS:
        return {"status": "unreadable", "reason": "silent"}
    lra = values["lra"]
    return {
        "status": "measured",
        "integratedLufs": integrated,
        "truePeakDbtp": peak,
        "lra": lra if math.isfinite(lra) and lra >= 0 else 0.0,
    }


def measure_file(path: str, stop: threading.Event | None = None) -> dict[str, Any]:
    """Measures one file. A file ffmpeg cannot decode, or a silent one, is unreadable."""
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    demuxer = demuxer_for(path)
    if demuxer is None:
        return {"status": "unreadable", "reason": "format"}
    command = [
        ffmpeg_path(),
        "-nostdin",
        "-max_alloc",
        str(MAX_FFMPEG_ALLOC),
        "-hide_banner",
        "-nostats",
        # The summary is printed at this level; the frames are kept out of it below.
        "-loglevel",
        "info",
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
        "-af",
        "ebur128=peak=true:framelog=quiet",
        "-f",
        "null",
        "-",
    ]
    file = open_regular_file(path)
    if file is None:
        return {"status": "unreadable", "reason": "file"}
    with file:
        done = run_tool(command, stdin=file, timeout=MEASURE_TIMEOUT_S, stop=stop)
    if done.returncode != 0:
        return {"status": "unreadable", "reason": "decode"}
    log = done.stderr[-_MAX_LOG_BYTES:].decode("utf-8", "replace")
    return judge(parse_summary(log))


@rpc("analysis.loudness")
def loudness(path: str, job_id: str) -> dict[str, Any]:
    """Measure the loudness of one file. Reads the file and changes nothing."""
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        try:
            result = measure_file(path, stop)
        except ToolStopped:
            raise JobCancelled() from None
        raise_if_cancelled(stop)
    return result
