"""Covers: the one a file holds, and the 600 x 600 JPEG the app embeds.

Mirrored by `cover.inspect` and `cover.prepare` in src/shared/rpc.ts.

Every picture the app makes or reads back lives in one folder, which the app names
when it starts the sidecar (`FIXLIB_COVERS_DIR`), under a name built from a hash.
A call names a file of that folder by its name only, so no call can point the
sidecar at another file. Pictures are untrusted: they come from a tag or from an
online service, and are decoded by Pillow only as JPEG or PNG, after their size in
pixels was read from the header.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import secrets
import stat
import warnings
from typing import Any

from fixlib_py.files import NO_LINKS, open_regular_file
from fixlib_py.safe_files import Refused
from fixlib_py.server import rpc

COVERS_DIR_ENV = "FIXLIB_COVERS_DIR"
# What the app embeds: Rekordbox and the players show it sharp, and it stays small.
COVER_SIZE = 600
# A cover a file has already is kept from this size on.
MIN_COVER_SIZE = 300
THUMB_SIZE = 128
# A cover the app made is a 600 x 600 JPEG of a few hundred kilobytes.
MAX_COVER_BYTES = 4 * 1024 * 1024
# What a service may send: a front image of 1200 px, or a scan somewhat larger.
MAX_SOURCE_BYTES = 16 * 1024 * 1024
# A picture is refused by its header before a pixel of it is unpacked: a few
# kilobytes of PNG can claim gigabytes of pixels. A real cover is at most a scan of
# about 3000 px a side; this leaves room for twice that, at some 64 MB unpacked.
MAX_PIXELS = 16_000_000
# A colour profile is a few kilobytes; a larger one is not worth the work of reading.
MAX_PROFILE_BYTES = 1024 * 1024
# Off by more than this, a picture is cut to a square; less is not seen once resized.
_SQUARE_TOLERANCE = 0.02
_FORMATS = ("JPEG", "PNG")
# A picture the user chose may also be a WebP; one from a service may not.
_MANUAL_FORMATS = (*_FORMATS, "WEBP")
# The mark of a cover the app drew (placeholder.py), so a later run looks again.
PLACEHOLDER_COMMENT = b"FixLibrary placeholder"
_HASH = "[0-9a-f]{40}"
_NAMES = {
    "cover": re.compile(rf"^{_HASH}\.jpg$"),
    "thumb": re.compile(rf"^{_HASH}\.thumb\.jpg$"),
    "download": re.compile(rf"^{_HASH}\.download$"),
}


def covers_dir() -> str:
    """The folder of covers the app named, or Refused when there is none."""
    folder = os.environ.get(COVERS_DIR_ENV, "")
    if not os.path.isabs(folder):
        raise Refused("no covers folder was named")
    try:
        mode = os.lstat(folder).st_mode
    except OSError:
        raise Refused("the covers folder is not there") from None
    if not stat.S_ISDIR(mode):
        raise Refused("the covers folder is not a folder")
    return folder


def is_name(name: object, kind: str) -> bool:
    # Whole: `$` would also take a name with a line break after it.
    return isinstance(name, str) and _NAMES[kind].fullmatch(name) is not None


def path_of(name: object, kind: str) -> str:
    """The path of a file of the covers folder, by a name of the given kind."""
    if not is_name(name, kind):
        raise ValueError(f"{kind} must be the name of a {kind} the app made")
    assert isinstance(name, str)
    return os.path.join(covers_dir(), name)


def _read(path: str, limit: int) -> bytes:
    file = open_regular_file(path)
    if file is None:
        raise Refused("the picture is not a regular file")
    with file:
        data = file.read(limit + 1)
    if len(data) > limit:
        raise Refused("the picture is larger than a cover may be")
    return data


class TooLarge(Refused):
    """A picture larger than a cover may be: its size is known from its header."""

    def __init__(self, size: tuple[int, int] | None) -> None:
        super().__init__("the picture is larger than a cover may be")
        self.size = size


# How the formats Pillow is not asked to decode begin: a real picture of the track,
# not damaged bytes.
_OTHER_PICTURES = (b"GIF87a", b"GIF89a", b"BM", b"II*\x00", b"MM\x00*")


def _is_other_picture(data: bytes) -> bool:
    is_webp = data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return is_webp or any(data.startswith(magic) for magic in _OTHER_PICTURES)


def _image(
    data: bytes, least: int | None = None, formats: tuple[str, ...] = _FORMATS
) -> tuple[Any, tuple[int, int]]:
    """The picture in the bytes, decoded, and its size as stored; or Refused.

    With `least`, a JPEG is decoded at the smallest scale at which it still has that
    many pixels a side: a large scan costs a fraction of its memory.
    """
    from PIL import Image

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data), formats=formats)
            width, height = image.size
            if width < 1 or height < 1:
                raise Refused("the picture cannot be read as an image")
            if width * height > MAX_PIXELS:
                raise TooLarge((width, height))
            if least is not None and image.format == "JPEG":
                image.draft("RGB", (least, least))
            image.load()
            return image, (width, height)
    except Refused:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise TooLarge(None) from None
    except Exception:
        # In fixed words: what a decoder says may quote the bytes.
        raise Refused("the picture cannot be read as an image") from None


def read_app_cover(name: object) -> bytes:
    """The bytes of a cover the app made, checked to be one: a 600 x 600 JPEG."""
    data = _read(path_of(name, "cover"), MAX_COVER_BYTES)
    image, _ = _image(data)
    if image.format != "JPEG" or image.size != (COVER_SIZE, COVER_SIZE):
        raise Refused("the cover is not a JPEG the app made")
    return data


def write_new(name: str, kind: str, data: bytes) -> None:
    """Puts the bytes in the covers folder under the name, whole or not at all."""
    final = path_of(name, kind)
    temp = os.path.join(os.path.dirname(final), f".{name}.{secrets.token_hex(4)}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NO_LINKS, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(data)
        os.replace(temp, final)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def jpeg_bytes(image: Any, quality: int, comment: bytes | None = None) -> bytes:
    # Nothing of the source rides along: no EXIF, no colour profile, no comment but
    # the app's own.
    output = io.BytesIO()
    extra = {"comment": comment} if comment is not None else {}
    image.save(output, format="JPEG", quality=quality, optimize=True, **extra)
    return output.getvalue()


def thumbnail_bytes(image: Any) -> bytes:
    from PIL import Image

    small = _rgb(image)
    small.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
    return jpeg_bytes(small, 80)


def _rgb(image: Any) -> Any:
    """The picture as sRGB pixels with no transparency."""
    from PIL import Image, ImageCms, ImageOps

    image = ImageOps.exif_transpose(image) or image
    profile = image.info.get("icc_profile")
    if profile and len(profile) <= MAX_PROFILE_BYTES and image.mode in ("RGB", "RGBA", "CMYK", "L"):
        try:
            converted = ImageCms.profileToProfile(
                image,
                ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                ImageCms.createProfile("sRGB"),
                outputMode="RGB" if image.mode != "RGBA" else "RGBA",
            )
            if converted is not None:
                image = converted
        except Exception:
            # A profile that cannot be read is no reason to go without a cover:
            # the pixels are taken as sRGB, which nearly every picture is.
            pass
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def _square(image: Any) -> Any:
    width, height = image.size
    if abs(width - height) <= _SQUARE_TOLERANCE * max(width, height):
        return image
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def _front_picture(tags: Any) -> Any:
    """The picture a player shows: the front cover, or the first picture there is."""
    pictures = tags.getall("APIC") if tags is not None else []
    for picture in pictures:
        if picture.type == 3:
            return picture
    return pictures[0] if pictures else None


@rpc("cover.inspect")
def inspect_cover(path: str) -> dict[str, Any]:
    """What the cover a file holds is: its size in pixels and a thumbnail. Reads the file only.

    A file without a picture answers `{"cover": None}`. A picture that is not decoded
    answers no thumbnail, and `other` when it is a real picture the app does not
    decode (larger than it decodes, or a GIF, BMP, TIFF or WebP) rather than damaged
    bytes; the size of one that is too large is read from its header.
    """
    # Imported here: the tag writer reads covers through this module.
    from fixlib_py.tag_write import _format_of, _open

    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    kind = _format_of(path)
    source = open_regular_file(path)
    if source is None:
        raise Refused("not a regular file")
    with source:
        picture = _front_picture(_open(source, kind).tags)
    if picture is None:
        return {"cover": None}
    data = bytes(picture.data)
    try:
        image, (width, height) = _image(data, THUMB_SIZE)
    except TooLarge as error:
        # A real cover, larger than the app decodes: as large as any it would make.
        width, height = error.size or (None, None)
        return {
            "cover": {
                "width": width,
                "height": height,
                "thumb": None,
                "placeholder": False,
                "other": True,
            }
        }
    except Refused:
        # A GIF, BMP, TIFF or WebP is a cover of the track the app does not decode;
        # anything else is damaged.
        return {
            "cover": {
                "width": None,
                "height": None,
                "thumb": None,
                "placeholder": False,
                "other": _is_other_picture(data),
            }
        }
    thumb = f"{hashlib.sha1(data).hexdigest()}.thumb.jpg"
    write_new(thumb, "thumb", thumbnail_bytes(image))
    # A cover the app drew where none was found: a later run looks again.
    drawn = image.format == "JPEG" and image.info.get("comment") == PLACEHOLDER_COMMENT
    return {
        "cover": {
            "width": width,
            "height": height,
            "thumb": thumb,
            "placeholder": drawn,
            "other": False,
        }
    }


@rpc("cover.prepare")
def prepare_cover(source: str, manual: bool = False) -> dict[str, Any]:
    """Makes the 600 x 600 JPEG of a downloaded picture, and its thumbnail.

    `source` names a download in the covers folder; the cover gets the same hash.
    A picture is cut to a square around its middle when its sides differ by more
    than 2%, resized with Lanczos, turned into sRGB and saved at quality 90 with
    nothing of the source's metadata. A picture whose shorter side is below 300
    pixels is refused: it would be no better than the cover a file may keep.
    `manual` is for a picture the user chose, which may also be a WebP.
    """
    if not isinstance(manual, bool):
        raise ValueError("manual must be true or false")
    data = _read(path_of(source, "download"), MAX_SOURCE_BYTES)
    image, (width, height) = _image(data, COVER_SIZE, _MANUAL_FORMATS if manual else _FORMATS)
    from PIL import Image

    # Judged by the picture as it is stored: the square is its shorter side.
    if min(width, height) < MIN_COVER_SIZE:
        raise Refused("the picture is too small for a cover")
    square = _square(_rgb(image))
    cover = square.resize((COVER_SIZE, COVER_SIZE), Image.Resampling.LANCZOS)
    stem = source.removesuffix(".download")
    write_new(f"{stem}.jpg", "cover", jpeg_bytes(cover, 90))
    write_new(f"{stem}.thumb.jpg", "thumb", thumbnail_bytes(cover))
    return {
        "cover": f"{stem}.jpg",
        "thumb": f"{stem}.thumb.jpg",
        "width": width,
        "height": height,
    }
