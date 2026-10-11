"""Reads the basic tags and audio properties of library files with mutagen.

File content is untrusted: a file that cannot be read is reported as unreadable and
never fails the files next to it. Mirrored by `tags.read` in src/shared/rpc.ts.
"""

from __future__ import annotations

import logging
import os
import re
import stat
from typing import Any

import mutagen
from mutagen.aiff import AIFF
from mutagen.mp3 import MP3
from mutagen.wave import WAVE

from fixlib_py.server import rpc

logger = logging.getLogger(__name__)

# One scan batch. The same limit is in src/shared/rpc.ts.
MAX_PATHS = 50
# With this limit the largest possible answer for one batch stays below the 1 MiB
# line limit of the bridge, also when every character is written as an escape.
MAX_TEXT_LENGTH = 300
# A tag is read into memory whole, covers included. Anything larger than this is
# not a tag a DJ tool wrote, and the file is reported as unreadable.
MAX_ID3_SIZE = 16 * 1024 * 1024

# The formats the app handles. Anything else mutagen recognises is not a library track.
_SUPPORTED = (MP3, WAVE, AIFF)
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
        scaled = value * scale
    except OverflowError:
        # A broken header can claim a number too large for a float.
        return None
    # Also false for NaN and infinity.
    return round(scaled) if 0 < scaled < 2**31 else None


def _id3_size(header: bytes) -> int:
    """The size an ID3v2 header claims for its tag, or 0 when there is no such header."""
    if len(header) < 10 or header[:3] != b"ID3" or any(byte & 0x80 for byte in header[6:10]):
        return 0
    return (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9]


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
    # Opened here, not by mutagen: a link is never followed, and something that is
    # not a regular file (a pipe would block forever) is never read.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            return _unreadable(path)
        if _id3_size(file.read(10)) > MAX_ID3_SIZE:
            return _unreadable(path)
        file.seek(0)
        audio = mutagen.File(file)
        if not isinstance(audio, _SUPPORTED):
            return _unreadable(path)

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


def read_file_tags(path: str) -> dict[str, Any]:
    """The tags of one file. Never raises: whatever goes wrong, the file is unreadable."""
    try:
        return _parse(path)
    except Exception as error:
        # A damaged or hostile file can fail anywhere, in mutagen or while its values
        # are read. Only the kind of error is logged: its text can hold the file name.
        logger.warning("tags.read: a file could not be read (%s)", type(error).__name__)
        return _unreadable(path)


@rpc("tags.read")
def read_tags(paths: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Read up to MAX_PATHS files. The result has one entry per path, in input order."""
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_PATHS:
        raise ValueError(f"paths must hold 1 to {MAX_PATHS} entries")
    for path in paths:
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ValueError("every path must be an absolute path")
    return {"files": [read_file_tags(path) for path in paths]}
