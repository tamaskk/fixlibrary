"""Tempo and key against Rekordbox, on the real test set.

Runs only where `tests/fixtures/real/` holds copies of real tracks and the XML that
Rekordbox exported for them (File > Export Collection in xml format); it is skipped
everywhere else, CI included. Put the tracks anywhere under that folder and the XML
next to them. A track is matched to its XML entry by its file name.

    cd python && uv run pytest tests/test_bpm_key_real.py -s
"""

from __future__ import annotations

import os
import unicodedata
import xml.etree.ElementTree as ElementTree
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest

from fixlib_py import keys
from fixlib_py.analysis import bpm_key, decode

ROOT = Path(__file__).resolve().parents[2]
REAL = ROOT / "tests" / "fixtures" / "real"
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"
AUDIO_SUFFIXES = {".mp3", ".wav", ".aif", ".aiff"}

# The targets of docs/PRD.md §06.
BPM_TOLERANCE = 1.0
BPM_TARGET = 0.95
KEY_TARGET = 0.75
# The default range of the settings.
BPM_RANGE = (85, 175)

pytestmark = pytest.mark.skipif(
    not REAL.is_dir() or not FFMPEG.is_file(),
    reason="needs tests/fixtures/real/ and resources/bin/ffmpeg",
)


@dataclass(frozen=True)
class Compared:
    """One track: what Rekordbox says, and what the analysis found or why it failed."""

    name: str
    rekordbox_bpm: float | None
    rekordbox_key: keys.Key | None
    bpm: float | None
    key: keys.Key | None
    error: str | None


def _name_key(name: str) -> str:
    # Rekordbox and the disk may spell one name in two Unicode forms.
    return unicodedata.normalize("NFC", name).casefold()


def _rekordbox_tracks() -> dict[str, tuple[float | None, keys.Key | None]]:
    """Tempo and key per file name, from every XML in the folder."""
    tracks: dict[str, tuple[float | None, keys.Key | None]] = {}
    # The developer's own export, read by a test that never runs in the app: the
    # standard parser will do. It loads no external entity.
    for xml_path in sorted(REAL.rglob("*.xml")):
        for track in ElementTree.parse(xml_path).getroot().iter("TRACK"):
            location = track.get("Location")
            if not location:
                continue
            name = os.path.basename(unquote(urlparse(location).path))
            try:
                bpm = float(track.get("AverageBpm", ""))
            except ValueError:
                bpm = None
            tracks[_name_key(name)] = (
                bpm if bpm and bpm > 0 else None,
                keys.parse_key(track.get("Tonality", "")),
            )
    return tracks


def _analyse(path: str) -> tuple[float | None, str | None, str | None]:
    """Runs in a pool worker. Returns the tempo, the Camelot code, and the error."""
    os.environ[decode.FFMPEG_ENV] = str(FFMPEG)
    try:
        result = bpm_key.analyze_file(path, *BPM_RANGE)
    except Exception as error:
        return None, None, f"{type(error).__name__}: {error}"
    return result["bpm"], result["camelot"], None


@pytest.fixture(scope="module")
def compared() -> list[Compared]:
    pytest.importorskip("essentia")
    rekordbox = _rekordbox_tracks()
    if not rekordbox:
        pytest.skip("no Rekordbox XML with tracks in tests/fixtures/real/")
    files = sorted(
        path
        for path in REAL.rglob("*")
        if path.suffix.lower() in AUDIO_SUFFIXES
        and not path.name.startswith(".")
        and _name_key(path.name) in rekordbox
    )
    if not files:
        pytest.skip("no track in tests/fixtures/real/ is named in the Rekordbox XML")
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as pool:
        analysed = list(pool.map(_analyse, [str(path) for path in files]))
    results = []
    for path, (bpm, camelot, error) in zip(files, analysed, strict=True):
        rekordbox_bpm, rekordbox_key = rekordbox[_name_key(path.name)]
        key = keys.key_of_camelot(camelot) if camelot else None
        results.append(Compared(path.name, rekordbox_bpm, rekordbox_key, bpm, key, error))
    return results


def _report(capsys: pytest.CaptureFixture[str], title: str, lines: list[str]) -> None:
    # Printed whether the test passes or not: the list is what the test is run for.
    with capsys.disabled():
        print(f"\n{title}")
        for line in lines:
            print(f"  {line}")


def test_tempo_is_within_one_bpm_of_rekordbox_for_95_percent(
    compared: list[Compared], capsys: pytest.CaptureFixture[str]
) -> None:
    measured = [track for track in compared if track.rekordbox_bpm is not None]
    assert measured, "no track has a tempo in the Rekordbox XML"

    off = [
        track
        for track in measured
        if track.bpm is None or abs(track.bpm - track.rekordbox_bpm) > BPM_TOLERANCE  # type: ignore[operator]
    ]
    rate = 1 - len(off) / len(measured)

    _report(
        capsys,
        f"Tempo: {len(measured) - len(off)} of {len(measured)} within "
        f"{BPM_TOLERANCE:g} BPM of Rekordbox ({rate:.0%}, target {BPM_TARGET:.0%})",
        [
            f"{track.name}: Rekordbox {track.rekordbox_bpm:.2f}, "
            + (f"analysis {track.bpm:.2f}" if track.bpm is not None else f"failed ({track.error})")
            for track in off
        ],
    )
    assert rate >= BPM_TARGET


def test_key_matches_rekordbox_for_75_percent(
    compared: list[Compared], capsys: pytest.CaptureFixture[str]
) -> None:
    measured = [track for track in compared if track.rekordbox_key is not None]
    assert measured, "no track has a key in the Rekordbox XML"

    off = [track for track in measured if track.key != track.rekordbox_key]
    rate = 1 - len(off) / len(measured)

    def named(key: keys.Key | None) -> str:
        return f"{key.camelot} {key.musical}" if key else "none"

    _report(
        capsys,
        f"Key: {len(measured) - len(off)} of {len(measured)} as in Rekordbox "
        f"({rate:.0%}, target {KEY_TARGET:.0%})",
        [
            f"{track.name}: Rekordbox {named(track.rekordbox_key)}, "
            + (f"analysis {named(track.key)}" if track.error is None else f"failed ({track.error})")
            for track in off
        ],
    )
    assert rate >= KEY_TARGET
