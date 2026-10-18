"""The waveform of a track for the cue editor (T-030): its peaks, a hundred a second.

Mirrored by `analysis.peaks` in src/shared/rpc.ts. The file is decoded to mono by the
app's own ffmpeg (decode.py) and the highest level of every hundredth of a second is
kept, as a whole number per thousand, in `<track id>.json` of the peaks folder the app
names. The renderer draws the waveform from it without decoding the file itself.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

from fixlib_py.analysis.decode import (
    MAX_DECODE_SECONDS,
    SAMPLE_RATE,
    ToolStopped,
    _samples_of_wav,
    decode_wav,
)
from fixlib_py.analysis.stems import _open_app_dir, envelope_name
from fixlib_py.server import JobCancelled, cancellable, raise_if_cancelled, rpc

PEAKS_DIR_ENV = "FIXLIB_PEAKS_DIR"
PEAKS_PER_SECOND = 100
# The format of the file; the app reads only this one.
PEAKS_VERSION = 1
# Twenty minutes of a long track; what is after it has no waveform.
MAX_SECONDS = MAX_DECODE_SECONDS - 1
# A decode of a whole track by ffmpeg, under the 120 s of the call.
DECODE_TIMEOUT_S = 100
_BLOCK = SAMPLE_RATE // PEAKS_PER_SECOND


def peaks_of(samples: Any) -> list[int]:
    """The highest level of each block of a hundredth of a second, per thousand of full scale."""
    import numpy

    whole = len(samples) // _BLOCK * _BLOCK
    levels = numpy.abs(numpy.asarray(samples[:whole], dtype=numpy.int32)).reshape(-1, _BLOCK)
    peaks = levels.max(axis=1) if whole else numpy.zeros(0, dtype=numpy.int32)
    if whole < len(samples):
        rest = numpy.abs(numpy.asarray(samples[whole:], dtype=numpy.int32)).max()
        peaks = numpy.append(peaks, rest)
    return [int(round(level * 1000 / 32768)) for level in peaks]


def peaks_name(track_id: int) -> str:
    """The name of a track's peaks: its id, nothing a caller can steer."""
    return envelope_name(track_id).removesuffix(".npz") + ".json"


def write_peaks(name: str, content: dict[str, Any], stop: threading.Event) -> int:
    """Writes the peaks into the peaks folder whole or not at all. Returns the size."""
    folder = _open_app_dir(PEAKS_DIR_ENV, "peaks")
    temp = f".{name}.{os.getpid()}.{threading.get_ident()}.fixlib-tmp"
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(temp, flags, 0o600, dir_fd=folder)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                json.dump(content, file, separators=(",", ":"))
                file.flush()
                os.fsync(file.fileno())
            raise_if_cancelled(stop)
            os.replace(temp, name, src_dir_fd=folder, dst_dir_fd=folder)
        except BaseException:
            try:
                os.unlink(temp, dir_fd=folder)
            except OSError:
                pass
            raise
        return os.stat(name, dir_fd=folder, follow_symlinks=False).st_size
    finally:
        os.close(folder)


@rpc("analysis.peaks")
def peaks(
    path: str, track_id: int, job_id: str, file_size_bytes: int | None, file_mtime_ms: int | None
) -> dict[str, Any]:
    """Make the waveform of one file. Reads the file, writes only its peaks file.

    The size and the time of the file as the app knows it go into the peaks file, for
    the app to tell whether it is still the waveform of the file as it is.
    """
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    name = peaks_name(track_id)
    for value in (file_size_bytes, file_mtime_ms):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("the size and the time of the file must be whole numbers")
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        try:
            data = decode_wav(path, 1, MAX_SECONDS, stop=stop, timeout=DECODE_TIMEOUT_S)
        except ToolStopped:
            raise JobCancelled() from None
        import numpy

        raw = _samples_of_wav(data)
        samples = numpy.frombuffer(raw, dtype="<i2", count=len(raw) // 2)
        levels = peaks_of(samples)
        duration = len(samples) / SAMPLE_RATE
        raise_if_cancelled(stop)
        content = {
            "version": PEAKS_VERSION,
            "peaksPerSecond": PEAKS_PER_SECOND,
            "durationSeconds": round(duration, 3),
            "truncated": duration >= MAX_SECONDS - 0.01,
            "fileSizeBytes": file_size_bytes,
            "fileMtimeMs": file_mtime_ms,
            "peaks": levels,
        }
        size = write_peaks(name, content, stop)
    return {"file": name, "count": len(levels), "bytes": size, "durationSeconds": duration}
