"""Files the sidecar writes, and tags it reads in order to write them again.

Both are places where untrusted content could make the sidecar do more than it was
asked: write through a link, or unpack a few kilobytes into gigabytes. The rules for
both are here, once, for every function that writes a file.
"""

from __future__ import annotations

import io
import os
import threading
from typing import Any, BinaryIO

from fixlib_py.files import NO_LINKS

# The app writes through a temp file of this ending (services/file-ops.ts) and names
# it to the sidecar. A path of any other shape is not a place the sidecar writes to.
TEMP_SUFFIX = ".fixlib-tmp"
_COPY_CHUNK = 1024 * 1024
# No tag a tagger wrote has more than a few hundred frames. mutagen cuts the tag
# anew for every frame it reads, so a tag made of a million empty ones would keep
# it busy for minutes.
MAX_FRAMES = 5000


class Refused(Exception):
    """A file the app will not work on, or a result that is not what it must be."""


class Stopped(Exception):
    """The job the work was for was told to stop."""


def check_temp_target(src: str, dst: str) -> None:
    """Raises ValueError unless `dst` is a temp file of the app next to `src`."""
    for path in (src, dst):
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ValueError("src and dst must be absolute paths")
    name = os.path.basename(dst)
    if not name.startswith(".") or not name.endswith(TEMP_SUFFIX):
        raise ValueError("dst must be a temp file of the app")
    if os.path.dirname(dst) != os.path.dirname(src):
        raise ValueError("dst must be a temp file of the app, next to src")


def copy_stream(source: BinaryIO, target: BinaryIO, stop: threading.Event | None = None) -> None:
    """Copies a file in pieces, and gives up between two of them when told to stop."""
    for chunk in iter(lambda: source.read(_COPY_CHUNK), b""):
        if stop is not None and stop.is_set():
            raise Stopped()
        target.write(chunk)


def create_made(path: str) -> tuple[int, int]:
    """Makes the file the result goes to, and returns what it is known by.

    Made here and made new: nothing that stands at the path, a link least of all,
    is ever written through. Whatever is done to the path afterwards is done only
    while it still is this very file.
    """
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NO_LINKS, 0o644)
    except FileExistsError:
        raise ValueError("dst must not exist") from None
    try:
        made = os.fstat(descriptor)
        return (made.st_dev, made.st_ino)
    finally:
        os.close(descriptor)


def open_made(path: str, identity: tuple[int, int], mode: str) -> BinaryIO:
    """Opens the file `create_made` made, and nothing that was put in its place since."""
    flags = os.O_RDONLY if mode == "rb" else os.O_RDWR
    try:
        descriptor = os.open(path, flags | NO_LINKS)
    except OSError:
        # A link, or nothing, where the file was made: said in fixed words, because
        # what the system says of it names the path.
        raise Refused("the file that was written is not the one that was made") from None
    try:
        found = os.fstat(descriptor)
        if (found.st_dev, found.st_ino) != identity:
            raise Refused("the file that was written is not the one that was made")
        return os.fdopen(descriptor, mode)
    except BaseException:
        os.close(descriptor)
        raise


def remove_made(path: str, identity: tuple[int, int]) -> None:
    """Removes the file `create_made` made, if it is still the one at the path."""
    try:
        found = os.lstat(path)
        if (found.st_dev, found.st_ino) == identity:
            os.remove(path)
    except OSError:
        pass


class _PackedFrame(Exception):
    """A frame that would be unpacked: compressed, or encrypted."""


class _Guarded:
    """Stands where mutagen looks a frame class up, and refuses a packed frame.

    mutagen unpacks a compressed frame as it reads it: a few hundred kilobytes can
    stand for hundreds of megabytes, in memory and then in the file that is
    written. Whether a frame is packed is asked here, of the very flags mutagen
    reads and at the moment it reads them, so that no second reading of the tag can
    come to another answer than the one that counts.
    """

    def __init__(self, frame: Any) -> None:
        self._frame = frame

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        # mutagen also makes frames of these itself, for what an ID3v1 tag says.
        return self._frame(*args, **kwargs)

    def _fromData(self, header: Any, flags: int, data: bytes) -> Any:  # noqa: N802
        from mutagen.id3 import Frame

        if header.version >= header._V24:
            packed = flags & (Frame.FLAG24_COMPRESS | Frame.FLAG24_ENCRYPT)
        elif header.version >= header._V23:
            packed = flags & (Frame.FLAG23_COMPRESS | Frame.FLAG23_ENCRYPT)
        else:
            packed = 0
        if packed:
            raise _PackedFrame()
        return self._frame._fromData(header, flags, data)


def guarded_frames() -> dict[str, Any]:
    """The frame classes to hand to every mutagen reader of an untrusted tag.

    mutagen looks a frame up here by its id; each entry refuses a compressed or an
    encrypted frame at the moment mutagen would unpack it. Passed to whatever loads
    a tag (`ID3`, `MP3`, `AIFF`), so that the tag is read once, by one reader.
    """
    from mutagen.id3 import Frames, Frames_2_2

    return {name: _Guarded(frame) for name, frame in {**Frames, **Frames_2_2}.items()}


class PackedFrame(Refused):
    """A tag holds a compressed or an encrypted frame."""

    def __init__(self) -> None:
        super().__init__("the tags of the file hold a compressed or encrypted frame")


def is_packed_frame(error: BaseException) -> bool:
    """True for the error a guarded reader raises for a packed frame."""
    return isinstance(error, _PackedFrame)


def read_id3(tag: bytes | BinaryIO) -> Any:
    """The frames of an `id3 ` chunk, read once, by the reader that also writes them.

    No tagger a DJ uses writes compressed or encrypted frames, so a file that has
    one is refused, and is told so; as is a chunk that is no ID3 tag.
    """
    from mutagen.id3 import ID3

    known = guarded_frames()
    try:
        source = io.BytesIO(tag) if isinstance(tag, bytes) else tag
        # The ID3v2 tag only: an old ID3v1 tag at the end of a file is never carried on.
        return ID3(source, known_frames=known, load_v1=False)
    except _PackedFrame:
        raise PackedFrame() from None
    except Exception:
        raise Refused("the tags of the file cannot be read") from None


def _syncsafe(four: bytes) -> int:
    """A number as ID3 writes a size: seven bits to a byte."""
    return (four[0] & 127) << 21 | (four[1] & 127) << 14 | (four[2] & 127) << 7 | (four[3] & 127)


def _frames_in(body: bytes, start: int, header: int, syncsafe: bool) -> int:
    """How many frame headers stand in a row from `start`, counted up to the limit."""
    name = 3 if header == 6 else 4
    count = 0
    position = start
    while position + header <= len(body) and count <= MAX_FRAMES:
        head = body[position : position + header]
        if not head[:name].strip(b"\x00"):
            break
        size = head[name : 2 * name]
        length = _syncsafe(size) if syncsafe else int.from_bytes(size, "big")
        position += header + length
        count += 1
    return count


def check_frame_count(tag: bytes) -> None:
    """Raises Refused for an ID3v2 tag that would take a reader minutes to walk.

    `tag` starts at its `ID3` header. This is a limit on work and decides nothing
    else about the tag: which frames it holds stays mutagen's to say. So it does not
    try to read the tag as mutagen will; it counts by every rule mutagen could read
    it by (each version's frame header, sizes of either kind, with and without the
    unsynchronisation taken out and an extended header skipped) and takes the most.
    """
    if len(tag) < 10 or tag[:3] != b"ID3":
        return
    whole = tag[10 : 10 + _syncsafe(tag[6:10])]
    for body in (whole, whole.replace(b"\xff\x00", b"\xff")):
        starts = {0}
        if len(body) >= 4:
            starts |= {4 + int.from_bytes(body[:4], "big"), _syncsafe(body[:4])}
        for start in starts:
            for header, syncsafe in ((10, False), (10, True), (6, False)):
                if _frames_in(body, start, header, syncsafe) > MAX_FRAMES:
                    raise Refused("the tags of the file hold more frames than a tag has")
