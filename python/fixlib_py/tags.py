"""Reads the basic tags and audio properties of library files with mutagen.

File content is untrusted: a file that cannot be read is reported as unreadable and
never fails the files next to it. Mirrored by `tags.read` in src/shared/rpc.ts.
"""

from __future__ import annotations

import logging
import os
import re
from collections import Counter
from typing import Any, BinaryIO

from mutagen.aiff import AIFF
from mutagen.mp3 import MP3
from mutagen.wave import WAVE

from fixlib_py.files import open_regular_file
from fixlib_py.server import rpc

logger = logging.getLogger(__name__)

# One scan batch. The same limit is in src/shared/rpc.ts.
MAX_PATHS = 50
# With this limit the largest possible answer for one batch stays below the 1 MiB
# line limit of the bridge, also when every character is written as an escape.
MAX_TEXT_LENGTH = 300
# The most a parser may read in one go. A tag is read into memory whole, covers
# included, and so is a WAV or AIFF chunk; a file that asks for more than this was
# not written by a DJ tool, and is reported as unreadable.
MAX_READ_SIZE = 16 * 1024 * 1024

# The parser is chosen by the file name, never by trying every format mutagen knows:
# the content of a file must not decide which code reads it.
_PARSERS: dict[str, type[MP3] | type[WAVE] | type[AIFF]] = {
    ".mp3": MP3,
    ".wav": WAVE,
    ".aif": AIFF,
    ".aiff": AIFF,
}
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# Invisible characters that change the reading direction, so text cannot be made to
# look like something else. Joiners stay: emoji and some scripts need them.
_DIRECTION_MARKS = re.compile("[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_WHITESPACE = re.compile(r"\s+")
_YEAR = re.compile(r"^\s*(\d{4})")


def _clean_text(value: object) -> str | None:
    """One line of tag text, or None when nothing usable is left."""
    visible = _DIRECTION_MARKS.sub("", _CONTROL_CHARACTERS.sub(" ", str(value)))
    text = _WHITESPACE.sub(" ", visible).strip()
    return text[:MAX_TEXT_LENGTH] or None


def _first_text(tags: Any, frame_id: str) -> str | None:
    for frame in tags.getall(frame_id):
        for value in getattr(frame, "text", []):
            text = _clean_text(value)
            if text is not None:
                return text
    return None


def _year(tags: Any) -> int | None:
    # mutagen presents the ID3v2.3 year (TYER) as TDRC as well.
    text = _first_text(tags, "TDRC")
    match = _YEAR.match(text) if text else None
    year = int(match.group(1)) if match else 0
    return year if 1000 <= year <= 9999 else None


def _positive_int(value: object, scale: float = 1.0) -> int | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        rounded = round(value * scale)
    except (OverflowError, ValueError):
        # A broken header can claim a number too large for a float, or none at all.
        return None
    # Checked after rounding: a few samples of audio must not become a duration of 0.
    return rounded if 0 < rounded < 2**31 else None


class _BoundedReader:
    """A file as mutagen sees it, on which no single read may exceed MAX_READ_SIZE."""

    def __init__(self, file: BinaryIO, size: int) -> None:
        self._file = file
        self._size = size

    def read(self, size: int | None = -1) -> bytes:
        wanted = self._size - self._file.tell() if size is None or size < 0 else size
        if wanted > MAX_READ_SIZE:
            raise ValueError("the file asks for more than may be read at once")
        return self._file.read(wanted)

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return self._file.seek(offset, whence)

    def tell(self) -> int:
        return self._file.tell()


def _unreadable(path: str) -> dict[str, Any]:
    return {
        "path": path,
        "readable": False,
        "durationMs": None,
        "bitrateKbps": None,
        "sampleRateHz": None,
        "artist": None,
        "title": None,
        "album": None,
        "label": None,
        "year": None,
        "hasCover": False,
    }


def _parse(path: str) -> dict[str, Any]:
    parser = _PARSERS.get(os.path.splitext(path)[1].lower())
    if parser is None:
        return _unreadable(path)
    # Opened here, not by mutagen: a link is never followed, and something that is
    # not a regular file is never read.
    file = open_regular_file(path)
    if file is None:
        return _unreadable(path)
    with file:
        audio = parser(_BoundedReader(file, os.fstat(file.fileno()).st_size))

        result = _unreadable(path)
        result["readable"] = True
        result["durationMs"] = _positive_int(getattr(audio.info, "length", None), 1000)
        result["bitrateKbps"] = _positive_int(getattr(audio.info, "bitrate", None), 0.001)
        result["sampleRateHz"] = _positive_int(getattr(audio.info, "sample_rate", None))
        tags = audio.tags
        if tags is not None:
            result["artist"] = _first_text(tags, "TPE1")
            result["title"] = _first_text(tags, "TIT2")
            result["album"] = _first_text(tags, "TALB")
            result["label"] = _first_text(tags, "TPUB")
            result["year"] = _year(tags)
            result["hasCover"] = len(tags.getall("APIC")) > 0
        return result


def read_file_tags(path: str, failures: Counter[str] | None = None) -> dict[str, Any]:
    """The tags of one file. Never raises: whatever goes wrong, the file is unreadable.

    The kind of each failure is counted in `failures`, for the caller to log once.
    """
    try:
        return _parse(path)
    except Exception as error:
        # A damaged or hostile file can fail anywhere, in mutagen or while its values
        # are read.
        if failures is not None:
            failures[type(error).__name__] += 1
        return _unreadable(path)


@rpc("tags.read")
def read_tags(paths: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Read up to MAX_PATHS files. The result has one entry per path, in input order."""
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_PATHS:
        raise ValueError(f"paths must hold 1 to {MAX_PATHS} entries")
    for path in paths:
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ValueError("every path must be an absolute path")
    failures: Counter[str] = Counter()
    files = [read_file_tags(path, failures) for path in paths]
    if failures:
        # One line per call, and only the kinds of error: the text of an error can
        # hold a file name, and a folder of broken files must not fill the log.
        kinds = ", ".join(f"{count} {name}" for name, count in sorted(failures.items()))
        logger.warning(
            "tags.read: %d of %d files could not be read (%s)",
            sum(failures.values()),
            len(paths),
            kinds,
        )
    return {"files": files}
