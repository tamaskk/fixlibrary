"""The features the energy of a track is computed from, measured with Essentia.

Mirrored by `analysis.energy_features` in src/shared/rpc.ts.

The track is cut into windows of ten seconds and each feature is measured per window.
The result is the 75th percentile over the windows that are not silent, so the drops
decide the value and a long intro, an outro or silence before the track do not.
"""

from __future__ import annotations

import math
import os
from typing import Any

from fixlib_py import server
from fixlib_py.analysis.decode import SAMPLE_RATE, decode_mono
from fixlib_py.server import cancellable, rpc

# Stored with every result: a track is analysed again only when this changes. Change
# it with the algorithm or its settings, together with ENERGY_ANALYZER_VERSION in
# src/shared/rpc.ts.
ANALYZER_VERSION = "essentia-windows10s-p75-1"

WINDOW_SECONDS = 10
PERCENTILE = 75
# A window quieter than this holds no music: digital silence, or the hiss before it.
SILENT_RMS_DB = -60.0
FRAME = 2048
HOP = 1024
# The band of the kick and the bass.
LOW_BAND_HZ = (20.0, 150.0)
# HPSS runs on half the rate: the split needs no high band, and it is the slow part.
HPSS_DOWNSAMPLE = 2
HPSS_FRAME = 1024
HPSS_HOP = 512
# Frames across time for the harmonic part, bins across frequency for the percussive.
HPSS_KERNEL = 17
# Below this a band holds nothing to divide by.
_TINY = 1e-12

FEATURES = (
    "integratedLufs",
    "rmsDb",
    "percussiveRatio",
    "onsetRate",
    "spectralCentroidHz",
    "spectralFlux",
    "lowRatio",
)


def _percussive_power(audio: Any) -> tuple[Any, Any]:
    """The percussive and the whole power of each HPSS frame, at the reduced rate.

    A median filter across time keeps what holds a pitch, one across frequency what
    hits; the percussive share of each bin is then P² / (H² + P²).
    """
    import numpy
    from scipy import ndimage, signal

    reduced = signal.resample_poly(audio, 1, HPSS_DOWNSAMPLE).astype(numpy.float32)
    _f, _t, spectrum = signal.stft(
        reduced,
        nperseg=HPSS_FRAME,
        noverlap=HPSS_FRAME - HPSS_HOP,
        boundary=None,
        padded=False,
    )
    magnitude = numpy.abs(spectrum).astype(numpy.float32)
    del spectrum
    harmonic = ndimage.median_filter(magnitude, size=(1, HPSS_KERNEL))
    percussive = ndimage.median_filter(magnitude, size=(HPSS_KERNEL, 1))
    power = magnitude**2
    harmonic **= 2
    percussive **= 2
    mask = percussive / numpy.maximum(harmonic + percussive, _TINY)
    return (mask * power).sum(axis=0), power.sum(axis=0)


def window_features(audio: Any) -> list[dict[str, float]]:
    """The features of each whole window of ten seconds of mono samples at SAMPLE_RATE
    that is not silent."""
    import essentia.standard as es
    import numpy

    window_length = WINDOW_SECONDS * SAMPLE_RATE
    count = len(audio) // window_length
    percussive, whole = _percussive_power(audio)
    hpss_rate = SAMPLE_RATE / HPSS_DOWNSAMPLE / HPSS_HOP

    windowing = es.Windowing(type="hann")
    spectrum_of = es.Spectrum(size=FRAME)
    centroid_of = es.Centroid(range=SAMPLE_RATE / 2)
    flux_of = es.Flux()
    low_of = es.EnergyBand(
        sampleRate=SAMPLE_RATE,
        startCutoffFrequency=LOW_BAND_HZ[0],
        stopCutoffFrequency=LOW_BAND_HZ[1],
    )
    energy_of = es.Energy()
    rms_of = es.RMS()
    onsets_of = es.OnsetRate()

    windows = []
    for index in range(count):
        part = audio[index * window_length : (index + 1) * window_length]
        rms_db = 20 * math.log10(max(float(rms_of(part)), _TINY))
        if rms_db <= SILENT_RMS_DB:
            continue
        # Both keep what they saw last: a window must not depend on the one before.
        flux_of.reset()
        onsets_of.reset()
        centroids, fluxes = [], []
        low = total = 0.0
        for frame in es.FrameGenerator(part, frameSize=FRAME, hopSize=HOP, startFromZero=True):
            spectrum = spectrum_of(windowing(frame))
            centroids.append(centroid_of(spectrum))
            fluxes.append(flux_of(spectrum))
            low += low_of(spectrum)
            total += energy_of(spectrum)
        _onsets, onset_rate = onsets_of(part)
        first = int(index * WINDOW_SECONDS * hpss_rate)
        last = int((index + 1) * WINDOW_SECONDS * hpss_rate)
        hits = float(percussive[first:last].sum())
        all_power = float(whole[first:last].sum())
        windows.append(
            {
                "rmsDb": rms_db,
                "percussiveRatio": math.sqrt(hits / all_power) if all_power > _TINY else 0.0,
                "onsetRate": float(onset_rate),
                "spectralCentroidHz": float(numpy.mean(centroids)),
                "spectralFlux": float(numpy.mean(fluxes)),
                "lowRatio": low / total if total > _TINY else 0.0,
            }
        )
    return windows


def analyze_samples(audio: Any) -> dict[str, Any]:
    """The energy features of mono samples at SAMPLE_RATE."""
    import essentia
    import essentia.standard as es
    import numpy

    # Essentia reports through its own logger on stderr; only errors are worth a line.
    essentia.log.infoActive = False
    essentia.log.warningActive = False

    if len(audio) < WINDOW_SECONDS * SAMPLE_RATE:
        raise ValueError("the audio is too short to analyse")
    loud = window_features(audio)
    if not loud:
        raise ValueError("the audio is silent")
    features = {
        name: float(numpy.percentile([w[name] for w in loud], PERCENTILE))
        for name in FEATURES
        if name != "integratedLufs"
    }
    # Gated by R128 itself, so silence does not lower it. Mono counts as both channels.
    _momentary, _short, lufs, _range = es.LoudnessEBUR128(sampleRate=SAMPLE_RATE)(
        es.StereoMuxer()(audio, audio)
    )
    features["integratedLufs"] = float(lufs)
    for name, value in features.items():
        if not math.isfinite(value):
            raise ValueError(f"{name} is not a number")
    return {
        "features": {name: round(value, 4) for name, value in features.items()},
        "analyzerVersion": ANALYZER_VERSION,
    }


def analyze_file(path: str) -> dict[str, Any]:
    """Runs in a worker of the process pool: decodes one file and analyses it."""
    return analyze_samples(decode_mono(path))


@rpc("analysis.energy_features")
def energy_features(path: str, job_id: str) -> dict[str, Any]:
    """Measure the energy features of one file. Reads the file and changes nothing."""
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    with cancellable(job_id) as stop:
        return server.run_in_cpu_pool(stop, analyze_file, path)
