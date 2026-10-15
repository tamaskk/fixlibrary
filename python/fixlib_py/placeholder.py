"""The cover a track gets when no place has one: its artist and title on its style's colour.

Mirrored by `cover.placeholder` in src/shared/rpc.ts.

The text comes from tags and lookups, so it is untrusted: it is drawn, never read as
anything else, and must be one clean line. The font is Inter (SIL Open Font License,
`assets/fonts/LICENSE.txt`), which has every letter of Hungarian.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from fixlib_py.cover import (
    COVER_SIZE,
    PLACEHOLDER_COMMENT,
    is_name,
    jpeg_bytes,
    path_of,
    thumbnail_bytes,
    write_new,
)
from fixlib_py.server import rpc
from fixlib_py.tags import _clean_text

FONT = Path(__file__).parent / "assets" / "fonts" / "InterDisplay-SemiBold.ttf"
# Changes when the drawing changes, so a cover drawn the old way is not taken for a new one.
_VERSION = "placeholder/2"
_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
_MARGIN = 48
_WIDTH = COVER_SIZE - 2 * _MARGIN
_GAP = 24
# Largest and smallest size, and most lines, of each part of the text.
_ARTIST = (40, 22, 2)
_TITLE = (72, 28, 3)
_LINE_SPACING = 1.15
_WHITE = (255, 255, 255)
# Nearly black: pure black on a strong colour looks harder than it needs to.
_DARK = (17, 17, 17)
_ELLIPSIS = "…"
# More than three lines of the smallest size can hold, of the narrowest letters.
_MOST_LETTERS = 160


def _luminance(rgb: tuple[int, int, int]) -> float:
    """The relative luminance of a colour, as WCAG defines it."""

    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(value) for value in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    light, dark = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def text_color(background: tuple[int, int, int]) -> tuple[int, int, int]:
    """White or nearly black, whichever stands out more against the background."""
    return _WHITE if _contrast(_WHITE, background) >= _contrast(_DARK, background) else _DARK


def _rgb_of(color: str) -> tuple[int, int, int]:
    return (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16))


def _font(size: int) -> Any:
    from PIL import ImageFont

    return ImageFont.truetype(str(FONT), size)


# Widths are measured once per character, at one size, and scaled: measuring every
# piece of text again at every size costs seconds for a long title, and more for
# letters the font does not have.
_REFERENCE_SIZE = 100
_advances: dict[str, float] = {}


def _advance(letter: str) -> float:
    width = _advances.get(letter)
    if width is None:
        width = _font(_REFERENCE_SIZE).getlength(letter)
        _advances[letter] = width
    return width


def _length(text: str, size: int) -> float:
    return sum(_advance(letter) for letter in text) * size / _REFERENCE_SIZE


def _split(word: str, size: int) -> list[str]:
    """A word too long for a line, in pieces that fit."""
    pieces: list[str] = []
    piece = ""
    for letter in word:
        if piece and _length(piece + letter, size) > _WIDTH:
            pieces.append(piece)
            piece = letter
        else:
            piece += letter
    return [*pieces, piece] if piece else pieces


def _wrap(text: str, size: int) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split(" "):
        for piece in [word] if _length(word, size) <= _WIDTH else _split(word, size):
            candidate = f"{line} {piece}" if line else piece
            if not line or _length(candidate, size) <= _WIDTH:
                line = candidate
            else:
                lines.append(line)
                line = piece
    return [*lines, line] if line else lines


def _cut(line: str, size: int) -> str:
    """The line with an ellipsis at its end, as much of it as fits."""
    while line and _length(line + _ELLIPSIS, size) > _WIDTH:
        line = line[:-1]
    return line.rstrip() + _ELLIPSIS


def fit(text: str, sizes: tuple[int, int, int]) -> tuple[Any, list[str]]:
    """The font and the lines of the text: as large as it fits in the lines it may have.

    At the smallest size a text that is still too long keeps the lines it may have,
    the last one ending in an ellipsis. No more of a text is looked at than the
    lines could hold at the smallest size.
    """
    largest, smallest, most = sizes
    text = text[:_MOST_LETTERS]
    for size in range(largest, smallest - 1, -4):
        lines = _wrap(text, size)
        if len(lines) <= most:
            return _font(size), lines
    lines = _wrap(text, smallest)
    if len(lines) > most:
        lines = [*lines[: most - 1], _cut(lines[most - 1], smallest)]
    return _font(smallest), lines


def _height(font: Any, lines: list[str]) -> int:
    return round(font.size * _LINE_SPACING) * len(lines)


def _draw(draw: Any, font: Any, lines: list[str], top: int, fill: tuple[int, int, int]) -> None:
    step = round(font.size * _LINE_SPACING)
    for index, line in enumerate(lines):
        width = _length(line, font.size)
        draw.text(((COVER_SIZE - width) / 2, top + index * step), line, font=font, fill=fill)


def draw_placeholder(artist: str | None, title: str | None, color: str) -> Any:
    """The 600 x 600 picture: the artist at the top, the title in the middle."""
    from PIL import Image, ImageDraw

    background = _rgb_of(color)
    image = Image.new("RGB", (COVER_SIZE, COVER_SIZE), background)
    draw = ImageDraw.Draw(image)
    fill = text_color(background)
    below = _MARGIN
    if artist:
        font, lines = fit(artist, _ARTIST)
        _draw(draw, font, lines, _MARGIN, fill)
        below = _MARGIN + _height(font, lines) + _GAP
    if title:
        font, lines = fit(title, _TITLE)
        height = _height(font, lines)
        _draw(draw, font, lines, max((COVER_SIZE - height) // 2, below), fill)
    return image


def _check_text(name: str, value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or _clean_text(value) != value:
        raise ValueError(f"{name} must be one clean line of text")
    return value


@rpc("cover.placeholder")
def make_placeholder(artist: str | None, title: str | None, color: str) -> dict[str, str]:
    """Draws the placeholder cover of a track into the covers folder, and its thumbnail.

    Named by the hash of what it shows, so the same text on the same colour is drawn once.
    """
    artist = _check_text("artist", artist)
    title = _check_text("title", title)
    if not isinstance(color, str) or _COLOR.fullmatch(color) is None:
        raise ValueError("color must be a colour as #rrggbb")
    key = "\n".join([_VERSION, artist or "", title or "", color.lower()])
    stem = hashlib.sha1(key.encode("utf-8")).hexdigest()
    cover, thumb = f"{stem}.jpg", f"{stem}.thumb.jpg"
    if not (is_name(cover, "cover") and is_name(thumb, "thumb")):
        raise ValueError("the names of a placeholder are not of the app's shape")
    if not (Path(path_of(cover, "cover")).is_file() and Path(path_of(thumb, "thumb")).is_file()):
        image = draw_placeholder(artist, title, color)
        write_new(cover, "cover", jpeg_bytes(image, 90, PLACEHOLDER_COMMENT))
        write_new(thumb, "thumb", thumbnail_bytes(image))
    return {"cover": cover, "thumb": thumb}
