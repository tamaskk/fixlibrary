from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from mutagen.aiff import AIFF
from mutagen.id3 import APIC, ID3, TALB, TDRC, TIT2, TPE1, TPUB
from mutagen.wave import WAVE

from fixlib_py import server, tags

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "synthetic"


def copy_fixture(name: str, folder: Path, target_name: str | None = None) -> Path:
    target = folder / (target_name or name)
    shutil.copyfile(FIXTURES / name, target)
    return target


def test_reads_tags_and_audio_properties_of_an_mp3(tmp_path: Path) -> None:
    path = copy_fixture("sine.mp3", tmp_path, "Tűz.mp3")
    id3 = ID3()
    id3.add(TPE1(encoding=3, text=["Előadó feat. Másik"]))
    id3.add(TIT2(encoding=3, text=["Tűz (Extended Mix)"]))
    id3.add(TALB(encoding=3, text=["Album"]))
    id3.add(TPUB(encoding=3, text=["Kiadó"]))
    id3.add(TDRC(encoding=3, text=["2024-05-01"]))
    id3.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="", data=b"\xff\xd8\xff"))
    id3.save(path, v2_version=3)

    result = tags.read_file_tags(str(path))

    assert result == {
        "path": str(path),
        "readable": True,
        "durationMs": pytest.approx(200, abs=60),
        "bitrateKbps": 320,
        "sampleRateHz": 44100,
        "artist": "Előadó feat. Másik",
        "title": "Tűz (Extended Mix)",
        "album": "Album",
        "label": "Kiadó",
        "year": 2024,
        "hasCover": True,
    }


@pytest.mark.parametrize(("name", "file_type"), [("sine.wav", WAVE), ("sine.aiff", AIFF)])
def test_reads_tags_of_wav_and_aiff(tmp_path: Path, name: str, file_type: type) -> None:
    path = copy_fixture(name, tmp_path)
    audio = file_type(path)
    audio.add_tags()
    audio.tags.add(TPE1(encoding=3, text=["Artist"]))
    audio.tags.add(TIT2(encoding=3, text=["Title"]))
    audio.save()

    result = tags.read_file_tags(str(path))

    assert result["readable"] is True
    assert result["durationMs"] == 200
    assert result["sampleRateHz"] == 44100
    assert (result["artist"], result["title"]) == ("Artist", "Title")
    assert result["hasCover"] is False


def test_an_untagged_file_is_readable_with_empty_tags(tmp_path: Path) -> None:
    path = copy_fixture("sine.mp3", tmp_path)

    result = tags.read_file_tags(str(path))

    assert result["readable"] is True
    assert result["bitrateKbps"] == 320
    assert [result[key] for key in ("artist", "title", "album", "label", "year")] == [None] * 5


def test_tag_text_becomes_one_clean_line_of_limited_length(tmp_path: Path) -> None:
    path = copy_fixture("sine.mp3", tmp_path)
    id3 = ID3()
    id3.add(TPE1(encoding=3, text=["  Line one\r\nline\ttwo\x00\x1b "]))
    id3.add(TIT2(encoding=3, text=["x" * 2000]))
    id3.add(TALB(encoding=3, text=[" \n "]))
    id3.add(TDRC(encoding=3, text=["0000"]))
    id3.save(path, v2_version=3)

    result = tags.read_file_tags(str(path))

    assert result["artist"] == "Line one line two"
    assert len(result["title"]) == tags.MAX_TEXT_LENGTH
    assert result["album"] is None
    assert result["year"] is None


def test_a_broken_or_missing_file_does_not_fail_the_batch(tmp_path: Path) -> None:
    good = copy_fixture("sine.mp3", tmp_path)
    broken = tmp_path / "broken.mp3"
    broken.write_bytes(b"this is not audio" * 100)
    text = tmp_path / "notes.wav"
    text.write_text("RIFF but not really")
    missing = tmp_path / "missing.mp3"

    result = tags.read_tags([str(broken), str(good), str(missing), str(text)])

    assert [entry["path"] for entry in result["files"]] == [
        str(broken),
        str(good),
        str(missing),
        str(text),
    ]
    assert [entry["readable"] for entry in result["files"]] == [False, True, False, False]


def test_a_file_of_another_audio_format_is_not_a_track(tmp_path: Path) -> None:
    flac = tmp_path / "track.flac"
    flac.write_bytes(b"fLaC" + b"\x00" * 64)

    result = tags.read_file_tags(str(flac))

    assert result["readable"] is False


@pytest.mark.parametrize(
    "paths",
    [[], ["relative/path.mp3"], [1], "not-a-list", ["/a.mp3"] * (tags.MAX_PATHS + 1)],
)
def test_tags_read_refuses_invalid_params(paths: object) -> None:
    request = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tags.read", "params": {"paths": paths}}
    )

    response = json.loads(server.dispatch(request) or "{}")

    assert response["error"]["code"] == server.INTERNAL_ERROR


def test_tags_read_answers_over_the_protocol(tmp_path: Path) -> None:
    path = copy_fixture("sine.wav", tmp_path)
    request = json.dumps(
        {"jsonrpc": "2.0", "id": 5, "method": "tags.read", "params": {"paths": [str(path)]}}
    )

    response = json.loads(server.dispatch(request) or "{}")

    assert response["id"] == 5
    assert response["result"]["files"][0]["readable"] is True
