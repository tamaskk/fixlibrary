from __future__ import annotations

import json
import os
import shutil
import struct
import wave
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


def test_a_header_with_an_absurd_sample_rate_does_not_fail_the_batch(tmp_path: Path) -> None:
    # An 80-bit float near its maximum: the bitrate mutagen derives from it is too
    # large to be converted, which used to raise out of the whole call.
    comm = struct.pack(">hLh", 1, 1, 16) + b"\x7f\xfe" + b"\xff" * 8
    body = b"AIFF" + b"COMM" + struct.pack(">L", len(comm)) + comm
    broken = tmp_path / "huge-rate.aiff"
    broken.write_bytes(b"FORM" + struct.pack(">L", len(body)) + body)
    good = copy_fixture("sine.mp3", tmp_path)

    result = tags.read_tags([str(broken), str(good)])

    assert result["files"][1]["readable"] is True
    assert result["files"][0]["bitrateKbps"] is None


def test_a_file_whose_tag_claims_to_be_huge_is_not_parsed(tmp_path: Path) -> None:
    path = tmp_path / "bomb.mp3"
    # 0x08 0x00 0x00 0x00 as a synchsafe size is 16 MiB, one byte over the limit with 0x01.
    path.write_bytes(b"ID3\x03\x00\x00\x08\x00\x00\x01" + (FIXTURES / "sine.mp3").read_bytes())

    result = tags.read_file_tags(str(path))

    assert result["readable"] is False


def test_an_mp3_with_padding_before_its_first_frame_is_still_an_mp3(tmp_path: Path) -> None:
    # Content alone does not say MP3 here; the file name does.
    path = tmp_path / "padded.mp3"
    path.write_bytes(b"\x00" * 4096 + (FIXTURES / "sine.mp3").read_bytes())

    result = tags.read_file_tags(str(path))

    assert result["readable"] is True
    assert result["sampleRateHz"] == 44100


def test_the_parser_is_chosen_by_the_file_name_not_by_the_content(tmp_path: Path) -> None:
    wav_named_mp3 = copy_fixture("sine.wav", tmp_path, "really-a-wav.mp3")

    result = tags.read_file_tags(str(wav_named_mp3))

    assert result["readable"] is False


def test_a_sound_of_a_few_samples_has_no_duration_instead_of_zero(tmp_path: Path) -> None:
    path = tmp_path / "click.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(b"\x00\x00" * 10)

    result = tags.read_file_tags(str(path))

    assert result["readable"] is True
    assert result["durationMs"] is None


@pytest.mark.parametrize("chunk", [b"id3 ", b"fmt "])
def test_a_wav_chunk_that_claims_to_be_huge_is_not_read(tmp_path: Path, chunk: bytes) -> None:
    # The chunk says 200 MB; the file does not hold them, but a reader that trusted
    # the number would ask for them.
    fmt = struct.pack("<4sLHHLLHH", b"fmt ", 16, 1, 1, 44100, 88200, 2, 16)
    huge = chunk + struct.pack("<L", 200 * 1024 * 1024) + b"ID3\x03\x00\x00\x5f\x7f\x7f\x7f"
    body = b"WAVE" + (fmt if chunk != b"fmt " else b"") + huge
    path = tmp_path / "huge-chunk.wav"
    path.write_bytes(b"RIFF" + struct.pack("<L", len(body)) + body)

    result = tags.read_file_tags(str(path))

    assert result["readable"] is False


def test_a_file_reached_through_a_linked_folder_is_not_read(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    copy_fixture("sine.mp3", real)
    (tmp_path / "linked").symlink_to(real, target_is_directory=True)

    result = tags.read_file_tags(str(tmp_path / "linked" / "sine.mp3"))

    assert result["readable"] is False


def test_unreadable_files_are_logged_as_one_line_without_their_names(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    paths = [str(tmp_path / f"secret-name-{index}.mp3") for index in range(3)]

    with caplog.at_level("WARNING"):
        tags.read_tags(paths)

    assert len(caplog.records) == 1
    assert "3 of 3" in caplog.text
    assert "secret-name" not in caplog.text


def test_a_link_and_a_pipe_are_not_read(tmp_path: Path) -> None:
    target = copy_fixture("sine.mp3", tmp_path)
    link = tmp_path / "link.mp3"
    link.symlink_to(target)
    pipe = tmp_path / "pipe.mp3"
    os.mkfifo(pipe)

    result = tags.read_tags([str(link), str(pipe)])

    assert [entry["readable"] for entry in result["files"]] == [False, False]


def test_characters_that_reverse_the_reading_direction_are_removed(tmp_path: Path) -> None:
    path = copy_fixture("sine.mp3", tmp_path)
    id3 = ID3()
    id3.add(TIT2(encoding=3, text=["Track\u202egnp.exe\u2066"]))
    id3.save(path, v2_version=3)

    result = tags.read_file_tags(str(path))

    assert result["title"] == "Trackgnp.exe"


def test_the_largest_possible_answer_fits_one_line_of_the_bridge() -> None:
    # Every character written as two \\uXXXX escapes, the longest a path can be on macOS.
    entry = tags._unreadable("\U0001f3b5" * 256)
    for key in ("artist", "title", "album", "label"):
        entry[key] = "\U0001f3b5" * tags.MAX_TEXT_LENGTH

    line = server._encode({"jsonrpc": "2.0", "id": 1, "result": {"files": [entry] * 50}})

    assert len(line) < 1024 * 1024


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
