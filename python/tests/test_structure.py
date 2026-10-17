from __future__ import annotations

from pathlib import Path

import numpy
import pytest

from fixlib_py.analysis import stems, structure

BPM = 128.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
WINDOW = 0.1

# Per phrase of 8 bars: drums, bass, other, vocals. Intro, the bass comes in, a build
# with the vocals, Drop 1, the breakdown, Drop 2 and its second half, the outro.
SECTIONS = [
    (0.2, 0.0, 0.1, 0.0),
    (0.3, 0.3, 0.1, 0.0),
    (0.1, 0.0, 0.4, 0.4),
    (1.0, 1.0, 0.3, 0.3),
    (0.1, 0.0, 0.4, 0.4),
    (1.0, 1.0, 0.3, 0.3),
    (1.0, 1.0, 0.3, 0.3),
    (0.5, 0.0, 0.0, 0.0),
]


def envelopes_of(
    sections: list[tuple[float, float, float, float]], vocal_from_bar: int = 17
) -> numpy.ndarray:
    """Envelopes in 100 ms windows: each phrase at its levels; the vocals start at a bar."""
    seconds = len(sections) * 8 * BAR
    frames = int(round(seconds / WINDOW))
    envelopes = numpy.zeros((4, frames))
    for frame in range(frames):
        time = frame * WINDOW
        bar = int(time // BAR)
        levels = list(sections[min(bar // 8, len(sections) - 1)])
        if bar < vocal_from_bar:
            levels[3] = 0.0
        envelopes[:, frame] = levels
    return envelopes


def grid(battito: int = 1) -> list[dict[str, object]]:
    return [{"inizio": 0.0, "bpm": BPM, "metro": "4/4", "battito": battito}]


def place(envelopes: numpy.ndarray, markers: list[dict[str, object]] | None = None) -> dict:
    duration = envelopes.shape[1] * WINDOW
    times, places = structure.beats_of(structure.markers_of(markers or grid()), duration)
    return structure.place_cues(times, places, envelopes, WINDOW, duration)


def test_finds_the_parts_of_a_house_track_on_the_bars_and_phrases_of_the_grid() -> None:
    placed = place(envelopes_of(SECTIONS))

    bar = lambda index: pytest.approx(index * BAR)  # noqa: E731
    assert placed["cues"] == {
        "start": bar(0),
        "bass": bar(8),
        # The vocals start a bar after a phrase start: the cue goes to the phrase.
        "vocal": bar(16),
        "drop1": bar(24),
        "breakdown": bar(32),
        "drop2": bar(40),
        "outro": bar(56),
        "drop3": None,
    }
    assert placed["review"] is False
    assert placed["instrumental"] is False


def test_puts_every_cue_on_a_beat_of_the_grid() -> None:
    markers = [
        {"inizio": 0.12, "bpm": BPM, "metro": "4/4", "battito": 1},
        {"inizio": 60.12, "bpm": 127.5, "metro": "4/4", "battito": 1},
    ]
    duration = 120.0
    times, _places = structure.beats_of(structure.markers_of(markers), duration)

    placed = place(envelopes_of(SECTIONS), markers)

    for time in placed["cues"].values():
        if time is not None:
            assert min(abs(time - beat) for beat in times) < 1e-9


def test_leaves_the_vocal_empty_on_an_instrumental_track() -> None:
    instrumental = [(d, b, o, 0.0) for d, b, o, _v in SECTIONS]

    placed = place(envelopes_of(instrumental))

    assert placed["instrumental"] is True
    assert placed["cues"]["vocal"] is None


def test_counts_the_bars_from_the_downbeat_rekordbox_marked() -> None:
    # The first beat of the grid is the third of its bar: bars start two beats later.
    times, places = structure.beats_of(structure.markers_of(grid(battito=3)), 10.0)

    assert places[:6] == [3, 4, 1, 2, 3, 4]
    assert times[2] == pytest.approx(2 * BEAT)


def test_takes_each_marker_from_its_own_time_without_a_doubled_beat() -> None:
    markers = [
        {"inizio": 0.0, "bpm": 120.0, "metro": "4/4", "battito": 1},
        {"inizio": 2.0, "bpm": 60.0, "metro": "4/4", "battito": 1},
    ]

    times, places = structure.beats_of(structure.markers_of(markers), 5.0)

    assert times == pytest.approx([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0])
    assert places == [1, 2, 3, 4, 1, 2, 3]


@pytest.mark.parametrize(
    ("cues", "emptied"),
    [
        ({"start": 10.0, "bass": 5.0}, ["bass"]),
        ({"start": 10.0, "vocal": 9.0}, ["vocal"]),
        ({"drop1": 60.0, "breakdown": 50.0, "drop2": 90.0}, ["breakdown"]),
        ({"drop1": 60.0, "breakdown": 95.0, "drop2": 90.0}, ["breakdown"]),
        ({"drop1": 60.0, "drop2": 90.0, "outro": 80.0}, ["outro"]),
    ],
)
def test_empties_a_slot_that_breaks_the_order_and_asks_for_a_review(
    cues: dict[str, float], emptied: list[str]
) -> None:
    full = dict.fromkeys(structure.SLOTS) | cues

    review = structure.check_order(full)

    assert review is True
    assert [slot for slot in cues if full[slot] is None] == emptied


@pytest.mark.parametrize(
    "grid_value",
    [
        [],
        "nope",
        [{"inizio": -1, "bpm": 120, "battito": 1}],
        [{"inizio": 0, "bpm": 0, "battito": 1}],
        [{"inizio": 0, "bpm": 120, "battito": 0}],
        [{"inizio": 0, "bpm": True, "battito": 1}],
    ],
)
def test_refuses_a_grid_that_is_not_one(grid_value: object) -> None:
    with pytest.raises(ValueError):
        structure.markers_of(grid_value)


def test_reads_the_envelopes_of_the_track_from_the_stems_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "stems"
    folder.mkdir()
    monkeypatch.setenv(stems.STEMS_DIR_ENV, str(folder))
    stems.write_envelopes("9.npz", envelopes_of(SECTIONS).astype(numpy.float16))

    result = structure.structure(9, grid(), 120.0)

    assert result["analyzerVersion"] == structure.ANALYZER_VERSION
    assert [cue["slot"] for cue in result["cues"]] == [1, 2, 3, 4, 5, 6, 7]
    assert result["cues"][3]["timeSec"] == pytest.approx(24 * BAR)
    with pytest.raises(ValueError):
        structure.structure(10, grid(), 120.0)
