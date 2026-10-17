"""Where the parts of a track are, and its eight hot cues (T-029).

From the stem envelopes of T-028 and the beatgrid Rekordbox analysed (T-026): the
beats of the grid, the bars from its downbeats, phrases of eight bars from the first
bar; the energy of each stem per beat, bar and phrase; and the rules of
structure_params.py for the fixed scheme A Start, B Bassline, C Vocal, D Drop 1,
E Breakdown, F Drop 2, G Outro, H Drop 3. Every cue is a beat of the grid. A slot
whose part is not found stays empty; one that would break the order is emptied, and
the track is marked for review.

Mirrored by `analysis.structure` in src/shared/rpc.ts.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any

from fixlib_py.analysis import structure_params as params
from fixlib_py.analysis.stems import STEMS, STEMS_DIR_ENV, _open_app_dir, envelope_name
from fixlib_py.server import rpc

# Stored with every result. Change it with the rules or their thresholds, together
# with STRUCTURE_ANALYZER_VERSION in src/shared/rpc.ts.
ANALYZER_VERSION = "structure-house-1"

SLOTS = ("start", "bass", "vocal", "drop1", "breakdown", "drop2", "outro", "drop3")
# The most markers a grid of Rekordbox holds that is worth reading: one per beat of
# twenty minutes at 200 BPM.
MAX_MARKERS = 4000
MAX_BEATS = 20 * 60 * 4


@dataclass(frozen=True)
class Marker:
    inizio: float
    bpm: float
    battito: int
    beats_per_bar: int


def markers_of(grid: object) -> list[Marker]:
    """The markers of a grid as the app sends them, checked and in time order."""
    if not isinstance(grid, list) or not 1 <= len(grid) <= MAX_MARKERS:
        raise ValueError("the grid must hold 1 to 4000 markers")
    markers = []
    for item in grid:
        if not isinstance(item, dict):
            raise ValueError("a marker must be an object")
        inizio, bpm, battito, metro = (
            item.get("inizio"),
            item.get("bpm"),
            item.get("battito"),
            item.get("metro"),
        )
        numbers = (inizio, bpm)
        if any(isinstance(n, bool) or not isinstance(n, (int, float)) for n in numbers):
            raise ValueError("a marker's time and tempo must be numbers")
        if not (math.isfinite(inizio) and inizio >= 0 and math.isfinite(bpm) and 0 < bpm < 1000):
            raise ValueError("a marker's time or tempo is out of bounds")
        if isinstance(battito, bool) or not isinstance(battito, int) or not 1 <= battito <= 16:
            raise ValueError("a marker's beat must be 1 to 16")
        beats_per_bar = 4
        if isinstance(metro, str) and "/" in metro:
            head = metro.split("/", 1)[0]
            if head.isdigit() and 1 <= int(head) <= 16:
                beats_per_bar = int(head)
        markers.append(Marker(float(inizio), float(bpm), battito, beats_per_bar))
    markers.sort(key=lambda marker: marker.inizio)
    return markers


def beats_of(markers: list[Marker], duration: float) -> tuple[list[float], list[int]]:
    """The beats of the grid up to the end of the track, and the place of each in its
    bar (1 is the downbeat), counted on from each marker's `Battito`."""
    times: list[float] = []
    places: list[int] = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].inizio if index + 1 < len(markers) else duration
        period = 60.0 / marker.bpm
        count = 0
        while True:
            time = marker.inizio + count * period
            # The next marker takes over a hair before its own time: no doubled beat.
            if time >= end - 1e-6 or len(times) >= MAX_BEATS:
                break
            times.append(time)
            places.append((marker.battito - 1 + count) % marker.beats_per_bar + 1)
            count += 1
    return times, places


@dataclass
class Levels:
    """The energy of each stem, of their sum and of the pulse (drums + bass), per bar."""

    stems: dict[str, list[float]]
    total: list[float]
    pulse: list[float]


def beat_levels(envelopes: Any, window: float, times: list[float], duration: float) -> Any:
    """The mean of each stem's envelope over each beat: (4, beats)."""
    import numpy

    frames = envelopes.shape[1]
    ends = times[1:] + [duration]
    levels = numpy.zeros((envelopes.shape[0], len(times)), dtype=numpy.float64)
    for index, (start, end) in enumerate(zip(times, ends, strict=True)):
        first = min(frames - 1, max(0, int(start / window)))
        last = min(frames, max(first + 1, int(math.ceil(end / window))))
        levels[:, index] = envelopes[:, first:last].mean(axis=1)
    return levels


def group_levels(beats: Any, starts: list[int], length: int) -> Levels:
    """The mean of beat levels over groups of beats that start at these beat indexes."""
    stems: dict[str, list[float]] = {name: [] for name in STEMS}
    ends = starts[1:] + [length]
    for start, end in zip(starts, ends, strict=True):
        for row, name in enumerate(STEMS):
            stems[name].append(float(beats[row, start:end].mean()))
    total = [sum(stems[name][i] for name in STEMS) for i in range(len(starts))]
    pulse = [stems["drums"][i] + stems["bass"][i] for i in range(len(starts))]
    return Levels(stems, total, pulse)


def percentile(values: list[float], share: float) -> float:
    import numpy

    return float(numpy.percentile(values, share * 100)) if values else 0.0


def place_cues(
    times: list[float], places: list[int], envelopes: Any, window: float, duration: float
) -> dict[str, Any]:
    """The eight cues of a track by the rules, as beat times, or None where empty."""
    bar_beats = [index for index, place in enumerate(places) if place == 1]
    empty: dict[str, Any] = {"cues": dict.fromkeys(SLOTS), "review": False, "instrumental": False}
    if len(bar_beats) < 2:
        return empty
    beats = beat_levels(envelopes, window, times, duration)
    bars = group_levels(beats, bar_beats, len(times))
    phrase_bars = list(range(0, len(bar_beats), params.PHRASE_BARS))
    phrases = group_levels(beats, [bar_beats[i] for i in phrase_bars], len(times))
    bar_time = [times[i] for i in bar_beats]
    cues: dict[str, float | None] = dict.fromkeys(SLOTS)

    # A Start.
    loudest = max(bars.total)
    start_bar = next(
        (i for i, level in enumerate(bars.total) if level > params.START_SHARE * loudest), None
    )
    if start_bar is not None:
        cues["start"] = bar_time[start_bar]

    def snapped(bar: int) -> float:
        """A bar moved to the nearest phrase start within SNAP_BARS, else kept."""
        nearest = min(phrase_bars, key=lambda phrase: abs(phrase - bar))
        return bar_time[nearest if abs(nearest - bar) <= params.SNAP_BARS else bar]

    # B Bassline.
    bass = bars.stems["bass"]
    bass_level = params.BASS_SHARE * percentile(bass, 0.9)
    for i in range(len(bass) - params.BASS_BARS + 1):
        if all(level > bass_level for level in bass[i : i + params.BASS_BARS]):
            cues["bass"] = snapped(i)
            break

    # C Vocal, unless the track is instrumental.
    vocals = bars.stems["vocals"]
    instrumental = percentile(vocals, 0.9) < params.INSTRUMENTAL_SHARE * percentile(bars.total, 0.9)
    if not instrumental:
        vocal_level = params.VOCAL_SHARE * percentile(vocals, 0.9)
        first_vocal = next((i for i, level in enumerate(vocals) if level > vocal_level), None)
        if first_vocal is not None:
            cues["vocal"] = snapped(first_vocal)

    # D, F, H Drops.
    top = max(phrases.pulse)
    drops = [
        j
        for j in range(1, len(phrases.pulse))
        if phrases.pulse[j] >= params.DROP_SHARE * top
        and phrases.pulse[j - 1] <= params.BEFORE_DROP_SHARE * top
    ][: params.MAX_DROPS]
    for slot, phrase in zip(("drop1", "drop2", "drop3"), drops, strict=False):
        cues[slot] = bar_time[phrase_bars[phrase]]

    # E Breakdown.
    if drops:
        first_drop = drops[0]
        floor = params.BREAKDOWN_SHARE * phrases.pulse[first_drop]
        breakdown = next(
            (j for j in range(first_drop + 1, len(phrases.pulse)) if phrases.pulse[j] < floor),
            None,
        )
        if breakdown is not None:
            cues["breakdown"] = bar_time[phrase_bars[breakdown]]

    # G Outro.
    if drops:
        quiet_vocals = params.OUTRO_SHARE * percentile(vocals, 0.9)
        quiet_other = params.OUTRO_SHARE * percentile(bars.stems["other"], 0.9)
        last_drop_bar = phrase_bars[drops[-1]]
        outro = None
        for phrase in phrase_bars:
            if phrase <= last_drop_bar:
                continue
            rest = range(phrase, len(bar_beats))
            if all(vocals[i] < quiet_vocals and bars.stems["other"][i] < quiet_other for i in rest):
                outro = phrase
                break
        if outro is None:
            last_bar = len(bar_beats) - 1
            outro = max(0, last_bar - params.OUTRO_FALLBACK_BARS)
        cues["outro"] = bar_time[outro]

    review = check_order(cues)
    return {"cues": cues, "review": review, "instrumental": instrumental}


def check_order(cues: dict[str, float | None]) -> bool:
    """Empties the slots that break A < B, A ≤ C, Drop 1 < Breakdown < Drop 2 < Drop 3,
    Outro after the last drop. True when any was emptied."""
    emptied = False

    def drop(slot: str) -> None:
        nonlocal emptied
        cues[slot] = None
        emptied = True

    start = cues["start"]
    if start is not None:
        if cues["bass"] is not None and cues["bass"] <= start:
            drop("bass")
        if cues["vocal"] is not None and cues["vocal"] < start:
            drop("vocal")
    breakdown = cues["breakdown"]
    if breakdown is not None:
        after_d = cues["drop1"] is not None and breakdown > cues["drop1"]
        before_f = cues["drop2"] is None or breakdown < cues["drop2"]
        if not (after_d and before_f):
            drop("breakdown")
    last_drop = max(
        (cues[s] for s in ("drop1", "drop2", "drop3") if cues[s] is not None), default=None
    )
    if cues["outro"] is not None and last_drop is not None and cues["outro"] <= last_drop:
        drop("outro")
    return emptied


def read_envelopes(track_id: int) -> tuple[Any, float]:
    """A track's envelopes from the stems folder, by its id: (4, frames), and the window."""
    import numpy

    folder = _open_app_dir(STEMS_DIR_ENV, "stems")
    try:
        descriptor = os.open(envelope_name(track_id), os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)
    except OSError:
        raise ValueError("the track has no stems") from None
    finally:
        os.close(folder)
    with os.fdopen(descriptor, "rb") as file, numpy.load(file, allow_pickle=False) as stored:
        if [str(name) for name in stored["stems"]] != list(STEMS):
            raise ValueError("the stems are not the ones this app keeps")
        envelopes = stored["envelopes"].astype(numpy.float64)
        window = float(stored["window_seconds"])
    if envelopes.ndim != 2 or envelopes.shape[0] != len(STEMS) or envelopes.shape[1] < 1:
        raise ValueError("the stems are not envelopes")
    if not numpy.all(numpy.isfinite(envelopes)) or not 0 < window <= 1:
        raise ValueError("the stems are not envelopes")
    return envelopes, window


@rpc("analysis.structure")
def structure(track_id: int, grid: object, duration_seconds: float) -> dict[str, Any]:
    """The eight hot cues of a track, from its stems and Rekordbox's grid. Reads only."""
    if (
        isinstance(duration_seconds, bool)
        or not isinstance(duration_seconds, (int, float))
        or not math.isfinite(duration_seconds)
        or not 0 < duration_seconds <= 2 * 60 * 60
    ):
        raise ValueError("the duration is out of bounds")
    markers = markers_of(grid)
    envelopes, window = read_envelopes(track_id)
    # What the envelopes cover: a track longer than its stems is read as far as they go.
    duration = min(float(duration_seconds), envelopes.shape[1] * window)
    times, places = beats_of(markers, duration)
    placed = place_cues(times, places, envelopes, window, duration)
    return {
        "cues": [
            {"slot": index + 1, "timeSec": time}
            for index, time in enumerate(placed["cues"][slot] for slot in SLOTS)
            if time is not None
        ],
        "review": bool(placed["review"]),
        "instrumental": bool(placed["instrumental"]),
        "analyzerVersion": ANALYZER_VERSION,
    }
