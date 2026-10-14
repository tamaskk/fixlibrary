from __future__ import annotations

import io
import os
import shutil
from pathlib import Path

import pytest
from mutagen.id3 import APIC, ID3
from PIL import Image

from fixlib_py import cover
from fixlib_py.safe_files import Refused

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "synthetic"
STEM = "89abcdef0123456789abcdef0123456789abcdef"
RED = (220, 20, 20)
BLUE = (20, 20, 220)


@pytest.fixture
def covers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "covers"
    folder.mkdir()
    monkeypatch.setenv("FIXLIB_COVERS_DIR", str(folder))
    return folder


def encoded(image: Image.Image, image_format: str = "JPEG", **options: object) -> bytes:
    output = io.BytesIO()
    image.save(output, format=image_format, **options)
    return output.getvalue()


def banded(size: tuple[int, int], band: int) -> Image.Image:
    """Blue, with red bands of `band` pixels at the left and right edges."""
    image = Image.new("RGB", size, BLUE)
    image.paste(RED, (0, 0, band, size[1]))
    image.paste(RED, (size[0] - band, 0, size[0], size[1]))
    return image


def downloaded(covers: Path, data: bytes) -> str:
    name = f"{STEM}.download"
    (covers / name).write_bytes(data)
    return name


def opened(path: Path) -> Image.Image:
    image = Image.open(path)
    image.load()
    return image


def near(color: tuple[int, ...], wanted: tuple[int, int, int]) -> bool:
    return all(abs(a - b) <= 40 for a, b in zip(color[:3], wanted, strict=True))


def test_makes_a_600_pixel_jpeg_and_a_thumbnail_of_a_downloaded_picture(covers: Path) -> None:
    source = downloaded(covers, encoded(Image.new("RGB", (1200, 1200), BLUE)))

    result = cover.prepare_cover(source)

    assert result == {
        "cover": f"{STEM}.jpg",
        "thumb": f"{STEM}.thumb.jpg",
        "width": 1200,
        "height": 1200,
    }
    made = opened(covers / f"{STEM}.jpg")
    assert (made.format, made.size, made.mode) == ("JPEG", (600, 600), "RGB")
    thumb = opened(covers / f"{STEM}.thumb.jpg")
    assert (thumb.format, thumb.size) == ("JPEG", (128, 128))


def test_cuts_a_picture_that_is_not_square_to_its_middle(covers: Path) -> None:
    # 1200 x 800: the middle 800 x 800 leaves out both red bands of 150 pixels.
    source = downloaded(covers, encoded(banded((1200, 800), 150), "PNG"))

    cover.prepare_cover(source)

    made = opened(covers / f"{STEM}.jpg")
    assert made.size == (600, 600)
    assert near(made.getpixel((2, 300)), BLUE)
    assert near(made.getpixel((597, 300)), BLUE)


def test_resizes_a_picture_that_is_square_within_two_percent_without_cutting_it(
    covers: Path,
) -> None:
    source = downloaded(covers, encoded(banded((1000, 985), 60), "PNG"))

    cover.prepare_cover(source)

    made = opened(covers / f"{STEM}.jpg")
    assert near(made.getpixel((5, 300)), RED)
    assert near(made.getpixel((594, 300)), RED)


def test_leaves_out_the_metadata_of_the_source_and_fills_transparency_with_white(
    covers: Path,
) -> None:
    image = Image.new("RGBA", (800, 800), (0, 0, 0, 0))
    source = downloaded(covers, encoded(image, "PNG", icc_profile=b"not a profile"))

    cover.prepare_cover(source)

    made = opened(covers / f"{STEM}.jpg")
    assert "exif" not in made.info
    assert "icc_profile" not in made.info
    assert near(made.getpixel((300, 300)), (255, 255, 255))


def test_turns_a_picture_with_a_colour_profile_into_srgb(covers: Path) -> None:
    from PIL import ImageCms

    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    source = downloaded(
        covers, encoded(Image.new("RGB", (700, 700), RED), "JPEG", icc_profile=profile)
    )

    cover.prepare_cover(source)

    made = opened(covers / f"{STEM}.jpg")
    assert near(made.getpixel((300, 300)), RED)
    assert "icc_profile" not in made.info


def test_refuses_a_picture_too_small_to_be_a_better_cover(covers: Path) -> None:
    source = downloaded(covers, encoded(Image.new("RGB", (250, 250), BLUE)))

    with pytest.raises(Refused, match="too small"):
        cover.prepare_cover(source)

    assert not (covers / f"{STEM}.jpg").exists()


@pytest.mark.parametrize(
    "data",
    [
        b"<html>not a picture</html>",
        b"GIF89a" + b"\x00" * 100,
        encoded(Image.new("RGB", (400, 400)), "BMP"),
    ],
)
def test_refuses_what_is_not_a_jpeg_or_png(covers: Path, data: bytes) -> None:
    source = downloaded(covers, data)

    with pytest.raises(Refused, match="cannot be read as an image"):
        cover.prepare_cover(source)


def test_refuses_a_picture_by_its_claimed_size_before_it_is_unpacked(covers: Path) -> None:
    # A few kilobytes that claim 100 million pixels.
    source = downloaded(covers, encoded(Image.new("1", (10_000, 10_000)), "PNG"))

    with pytest.raises(Refused, match="larger than a cover may be"):
        cover.prepare_cover(source)


@pytest.mark.parametrize(
    "name",
    [
        f"{STEM}.jpg",
        "../x.download",
        f"/tmp/{STEM}.download",
        f"{STEM.upper()}.download",
        f"{STEM}.download\n",
        7,
    ],
)
def test_reads_only_a_download_named_as_the_app_names_one(covers: Path, name: object) -> None:
    with pytest.raises(ValueError, match="download must be the name"):
        cover.prepare_cover(name)  # type: ignore[arg-type]


def test_reads_no_download_through_a_link(covers: Path, tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere.png"
    elsewhere.write_bytes(encoded(Image.new("RGB", (600, 600))))
    os.symlink(elsewhere, covers / f"{STEM}.download")

    with pytest.raises(OSError):
        cover.prepare_cover(f"{STEM}.download")


def test_refuses_to_work_without_a_covers_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FIXLIB_COVERS_DIR", str(tmp_path / "missing"))

    with pytest.raises(Refused, match="not there"):
        cover.prepare_cover(f"{STEM}.download")


def tagged(tmp_path: Path, *pictures: APIC) -> Path:
    path = tmp_path / "track.mp3"
    shutil.copyfile(FIXTURES / "sine.mp3", path)
    tags = ID3()
    for picture in pictures:
        tags.add(picture)
    tags.save(path)
    return path


def test_says_a_file_without_a_picture_has_no_cover(covers: Path, tmp_path: Path) -> None:
    path = tagged(tmp_path)

    assert cover.inspect_cover(str(path)) == {"cover": None}


def test_gives_the_size_and_a_thumbnail_of_the_front_cover(covers: Path, tmp_path: Path) -> None:
    back = encoded(Image.new("RGB", (100, 100)))
    front = encoded(Image.new("RGB", (500, 400), RED), "PNG")
    path = tagged(
        tmp_path,
        APIC(encoding=3, mime="image/jpeg", type=4, desc="back", data=back),
        APIC(encoding=3, mime="image/png", type=3, desc="front", data=front),
    )
    before = path.read_bytes()

    result = cover.inspect_cover(str(path))

    assert result["cover"]["width"] == 500
    assert result["cover"]["height"] == 400
    thumb = opened(covers / result["cover"]["thumb"])
    assert thumb.format == "JPEG"
    assert max(thumb.size) == 128
    assert path.read_bytes() == before


def test_takes_the_first_picture_when_none_is_a_front_cover(covers: Path, tmp_path: Path) -> None:
    other = encoded(Image.new("RGB", (200, 200)))
    path = tagged(tmp_path, APIC(encoding=3, mime="image/jpeg", type=0, desc="", data=other))

    result = cover.inspect_cover(str(path))

    assert (result["cover"]["width"], result["cover"]["height"]) == (200, 200)


def test_gives_no_size_for_a_picture_that_cannot_be_decoded(covers: Path, tmp_path: Path) -> None:
    path = tagged(
        tmp_path, APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=b"\xff\xd8\xffjunk")
    )

    result = cover.inspect_cover(str(path))

    assert result == {"cover": {"width": None, "height": None, "thumb": None}}
    assert list(covers.iterdir()) == []


def test_a_downloaded_picture_ends_up_in_the_file_as_a_600_pixel_front_cover(
    covers: Path, tmp_path: Path
) -> None:
    from fixlib_py import server, tag_write

    src = tagged(
        tmp_path,
        APIC(
            encoding=3,
            mime="image/png",
            type=3,
            desc="",
            data=encoded(Image.new("RGB", (120, 120)), "PNG"),
        ),
    )
    made = cover.prepare_cover(downloaded(covers, encoded(banded((1400, 1000), 100))))
    dst = src.with_name(f".{src.name}.0a1b2c3d.fixlib-tmp")

    tag_write.write_tags(str(src), str(dst), {"cover": made["cover"]}, "job-cover")
    server._jobs.clear()
    result = dst.rename(tmp_path / "written.mp3")
    held = cover.inspect_cover(str(result))

    assert (held["cover"]["width"], held["cover"]["height"]) == (600, 600)
    pictures = ID3(result).getall("APIC")
    assert [(picture.type, picture.mime) for picture in pictures] == [(3, "image/jpeg")]
    assert bytes(pictures[0].data) == (covers / made["cover"]).read_bytes()
