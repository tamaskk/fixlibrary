from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from PIL import Image

from fixlib_py import placeholder

FONT_SHA256 = "0310d7a325896129730c6c8cf9a6e0f81ee258bedf77b1ff059b2a7b75f74e02"
LONG_TITLE = (
    "Ilyenek voltunk, amikor még semmi sem számított, csak a zene és az éjszaka "
    "(Extended Remastered Club Mix by Somebody With A Very Long Name Indeed)"
)


@pytest.fixture
def covers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "covers"
    folder.mkdir()
    monkeypatch.setenv("FIXLIB_COVERS_DIR", str(folder))
    return folder


def opened(path: Path) -> Image.Image:
    image = Image.open(path)
    image.load()
    return image


def colors_in(image: Image.Image) -> set[tuple[int, int, int]]:
    return {color for _, color in image.convert("RGB").getcolors(600 * 600) or []}


def near(color: tuple[int, ...], wanted: tuple[int, int, int], within: int = 24) -> bool:
    return all(abs(a - b) <= within for a, b in zip(color[:3], wanted, strict=True))


def test_the_font_is_the_inter_the_app_ships() -> None:
    digest = hashlib.sha256(placeholder.FONT.read_bytes()).hexdigest()

    assert digest == FONT_SHA256
    assert (placeholder.FONT.parent / "LICENSE.txt").is_file()


@pytest.mark.parametrize(
    ("color", "text"),
    [("#F5F5F5", (17, 17, 17)), ("#111111", (255, 255, 255)), ("#9a9aa3", (17, 17, 17))],
)
def test_draws_a_600_pixel_cover_of_the_colour_with_the_text_that_stands_out_most(
    covers: Path, color: str, text: tuple[int, int, int]
) -> None:
    made = placeholder.make_placeholder("Ákos", "Ilyenek voltunk", color)

    image = opened(covers / made["cover"])
    background = placeholder._rgb_of(color)
    assert (image.format, image.size) == ("JPEG", (600, 600))
    assert near(image.getpixel((4, 4)), background)
    assert near(image.getpixel((595, 595)), background)
    # The text is drawn in the colour the contrast asks for.
    assert any(near(pixel, text, 40) for pixel in colors_in(image))
    assert placeholder.text_color(background) == text
    thumb = opened(covers / made["thumb"])
    assert (thumb.format, thumb.size) == ("JPEG", (128, 128))


def test_draws_the_artist_above_the_title(covers: Path) -> None:
    made = placeholder.make_placeholder("Ákos", "Őszi ütés", "#111111")

    image = opened(covers / made["cover"]).convert("L")

    def has_text(top: int, bottom: int) -> bool:
        return any(
            image.getpixel((x, y)) > 128 for y in range(top, bottom) for x in range(0, 600, 2)
        )

    assert has_text(48, 110)
    assert has_text(260, 340)
    assert not has_text(150, 240)


def test_fits_a_very_long_title_into_three_lines() -> None:
    font, lines = placeholder.fit(LONG_TITLE, (72, 28, 3))

    assert 1 <= len(lines) <= 3
    assert all(font.getlength(line) <= 600 - 2 * 48 for line in lines)
    assert lines[-1].endswith("…")


def test_breaks_a_word_too_long_for_a_line() -> None:
    font, lines = placeholder.fit("A" * 80, (72, 28, 3))

    assert all(font.getlength(line) <= 600 - 2 * 48 for line in lines)


def test_shrinks_a_title_before_it_breaks_it() -> None:
    short_font, short = placeholder.fit("Glue", (72, 28, 3))
    long_font, long = placeholder.fit("Ilyenek voltunk (Extended Mix)", (72, 28, 3))

    assert (short_font.size, len(short)) == (72, 1)
    assert long_font.size <= 72
    assert len(long) <= 3


def test_draws_the_same_cover_once_and_names_another_text_otherwise(covers: Path) -> None:
    first = placeholder.make_placeholder("Bicep", "Glue", "#3b82f6")
    written = (covers / first["cover"]).stat().st_mtime_ns

    again = placeholder.make_placeholder("Bicep", "Glue", "#3B82F6")
    other = placeholder.make_placeholder("Bicep", "Apricots", "#3b82f6")

    assert again == first
    assert (covers / first["cover"]).stat().st_mtime_ns == written
    assert other["cover"] != first["cover"]


def test_draws_a_cover_with_no_artist_or_no_title(covers: Path) -> None:
    made = placeholder.make_placeholder(None, None, "#22c55e")

    assert opened(covers / made["cover"]).size == (600, 600)


@pytest.mark.parametrize(
    ("artist", "title", "color"),
    [
        ("Ákos", "two\nlines", "#111111"),
        ("", "Glue", "#111111"),
        ("Ákos", "Glue", "red"),
        ("Ákos", "Glue", "#11111"),
        ("Ákos", 7, "#111111"),
    ],
)
def test_refuses_text_and_colours_it_cannot_draw_as_they_are(
    covers: Path, artist: object, title: object, color: object
) -> None:
    with pytest.raises(ValueError):
        placeholder.make_placeholder(artist, title, color)  # type: ignore[arg-type]

    assert list(covers.iterdir()) == []


@pytest.mark.parametrize("letter", ["日", "ア", "W"])
def test_draws_the_longest_text_a_tag_may_hold_in_well_under_a_second(
    covers: Path, letter: str
) -> None:
    import time

    started = time.perf_counter()
    placeholder.draw_placeholder(letter * 300, letter * 300, "#111111")

    assert time.perf_counter() - started < 1.5


def test_marks_its_cover_so_a_later_run_knows_it_was_drawn(covers: Path) -> None:
    made = placeholder.make_placeholder("Bicep", "Glue", "#3b82f6")

    image = opened(covers / made["cover"])

    assert image.info.get("comment") == b"FixLibrary placeholder"
