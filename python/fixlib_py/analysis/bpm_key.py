"""Tempo and key of a track, measured from its audio with Essentia.

Mirrored by `analysis.bpm_key` in src/shared/rpc.ts.
"""

from __future__ import annotations

import math
import os
from concurrent.futures import ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from threading import Event
from typing import Any

from fixlib_py import server
from fixlib_py.analysis.decode import SAMPLE_RATE, decode_mono
from fixlib_py.keys import SCALES, key_of
from fixlib_py.server import cancellable, raise_if_cancelled, rpc

# Stored with every result: a track is analysed again only when this changes. Change
# it with the algorithm or its settings, together with BPM_KEY_ANALYZER_VERSION in
# src/shared/rpc.ts.
ANALYZER_VERSION = "essentia-2.1b6-multifeature-edma-1"

# The same limits as in src/shared/settings.ts. The range must hold a whole octave,
# or a tempo could be doubled out of its top and halved out of its bottom forever.
BPM_MIN_LIMITS = (40, 150)
BPM_MAX_LIMITS = (80, 300)

# Shorter than this there is no tempo to speak of.
MIN_SECONDS = 5
# How often a waiting call looks whether it was told to stop.
_POLL_S = 0.2


def check_bpm_range(bpm_min: object, bpm_max: object) -> tuple[float, float]:
    """The range as two numbers, or ValueError when it is not one the app allows."""
    for value in (bpm_min, bpm_max):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("the tempo range must be two numbers")
        if not math.isfinite(value):
            raise ValueError("the tempo range must be two numbers")
    low, high = float(bpm_min), float(bpm_max)  # type: ignore[arg-type]
    if not BPM_MIN_LIMITS[0] <= low <= BPM_MIN_LIMITS[1]:
        raise ValueError("the lower end of the tempo range is out of bounds")
    if not BPM_MAX_LIMITS[0] <= high <= BPM_MAX_LIMITS[1]:
        raise ValueError("the upper end of the tempo range is out of bounds")
    if high < 2 * low:
        raise ValueError("the tempo range must hold a whole octave")
    return low, high


def fold_bpm(bpm: float, bpm_min: float, bpm_max: float) -> float:
    """Moves a tempo into the range by octaves: doubled below it, halved above it.

    Tempo detection often lands on half or double the tempo a DJ counts, so a house
    track measured at 62 is 124, and a drum and bass track at 174 stays what it is.
    """
    low, high = check_bpm_range(bpm_min, bpm_max)
    if not math.isfinite(bpm) or bpm <= 0:
        raise ValueError("no tempo was found")
    while bpm < low:
        bpm *= 2
    while bpm > high:
        bpm /= 2
    return bpm


def analyze_samples(audio: Any, bpm_min: float, bpm_max: float) -> dict[str, Any]:
    """Tempo and key of mono samples at SAMPLE_RATE."""
    import essentia
    import essentia.standard as es

    # Essentia reports through its own logger on stderr; only errors are worth a line.
    essentia.log.infoActive = False
    essentia.log.warningActive = False

    if len(audio) < MIN_SECONDS * SAMPLE_RATE:
        raise ValueError("the audio is too short to analyse")
    raw_bpm, _beats, confidence, _estimates, _intervals = es.RhythmExtractor2013(
        method="multifeature"
    )(audio)
    # The profile Essentia tuned on electronic dance music.
    tonic, scale, strength = es.KeyExtractor(profileType="edma", sampleRate=SAMPLE_RATE)(audio)

    key = key_of(tonic, scale) if scale in SCALES else None
    if key is None:
        raise ValueError("no key was found")
    result = {
        "bpm": round(fold_bpm(float(raw_bpm), bpm_min, bpm_max), 2),
        "rawBpm": round(float(raw_bpm), 2),
        "bpmConfidence": round(float(confidence), 3),
        "keyName": str(tonic),
        "scale": str(scale),
        "keyStrength": round(float(strength), 3),
        "camelot": key.camelot,
        "musical": key.musical,
        "analyzerVersion": ANALYZER_VERSION,
    }
    for name in ("bpm", "rawBpm", "bpmConfidence", "keyStrength"):
        if not math.isfinite(result[name]):
            raise ValueError(f"{name} is not a number")
    return result


def analyze_file(path: str, bpm_min: float, bpm_max: float) -> dict[str, Any]:
    """Runs in a worker of the process pool: decodes one file and analyses it."""
    return analyze_samples(decode_mono(path), bpm_min, bpm_max)


def _run_in(pool: ProcessPoolExecutor, stop: Event, *arguments: Any) -> dict[str, Any]:
    """Analyses one file in a worker of `pool`, and stops waiting when told to stop.

    Essentia cannot be interrupted. A job that is told to stop answers at once and
    leaves its worker to finish the track; it only reads.
    """
    future = pool.submit(analyze_file, *arguments)
    while not wait([future], timeout=_POLL_S).done:
        if stop.is_set():
            future.cancel()
        raise_if_cancelled(stop)
    return future.result()


@rpc("analysis.bpm_key")
def bpm_key(path: str, job_id: str, bpm_min: float, bpm_max: float) -> dict[str, Any]:
    """Measure the tempo and key of one file. Reads the file and changes nothing."""
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    low, high = check_bpm_range(bpm_min, bpm_max)
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        pool = server.cpu_pool()
        try:
            return _run_in(pool, stop, path, low, high)
        except BrokenProcessPool:
            server.discard_cpu_pool(pool)
        # A worker that dies takes every job of its pool with it, and nothing says
        # which file did it. So each of them is tried once more in a pool of its own:
        # the file that kills its worker fails alone, and the others get their result.
        raise_if_cancelled(stop)
        alone = server.new_worker_pool(1)
        try:
            return _run_in(alone, stop, path, low, high)
        finally:
            alone.shutdown(wait=False, cancel_futures=True)
