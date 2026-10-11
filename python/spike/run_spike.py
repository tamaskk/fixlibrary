"""T-002 spike: prove Essentia and Demucs work together on Apple Silicon.

Usage: uv run python spike/run_spike.py <track>

The track is only read. Demucs writes decoded audio to the system temp directory, and
the model is cached under ~/.cache/huggingface. Results are recorded by hand in
python/SPIKE.md.
"""

from __future__ import annotations

import os

# Must be set before torch is imported: operators missing on MPS then run on the CPU.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import argparse
import hashlib
import sys
import time
import traceback
import warnings
from importlib.metadata import version
from pathlib import Path

import essentia
import essentia.standard as es
import torch
from demucs.apply import BagOfModels, apply_model
from demucs.audio import AudioFile
from demucs.hf import load_safetensors_model
from huggingface_hub import hf_hub_download

ANALYSIS_SAMPLE_RATE = 44100

# htdemucs, pinned. demucs.pretrained.get_model() follows the moving main branch and
# instantiates whatever class the file's metadata names, so the file is treated as
# executable: one fixed revision, checked against the SHA-256 the Hub publishes for it.
MODEL_REPO = "adefossez/HTDemucs"
MODEL_REVISION = "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003"
MODEL_FILE = "955717e8.safetensors"
MODEL_SHA256 = "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd"


def analyse_bpm_and_key(track: Path) -> tuple[float, float, str, str, float]:
    """Return BPM, BPM confidence, key, scale and key strength."""
    audio = es.MonoLoader(filename=str(track), sampleRate=ANALYSIS_SAMPLE_RATE)()
    bpm, _beats, bpm_confidence, _estimates, _intervals = es.RhythmExtractor2013(
        method="multifeature"
    )(audio)
    key, scale, key_strength = es.KeyExtractor()(audio)
    return bpm, bpm_confidence, key, scale, key_strength


def load_pinned_model() -> BagOfModels:
    """Fetch the pinned htdemucs weights, verify their SHA-256, then load them."""
    model_path = Path(
        hf_hub_download(MODEL_REPO, MODEL_FILE, revision=MODEL_REVISION, token=False)
    )
    digest = hashlib.sha256()
    with model_path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_SHA256:
        raise RuntimeError(f"SHA-256 mismatch for {MODEL_FILE}: {digest.hexdigest()}")
    model = BagOfModels([load_safetensors_model(model_path)])
    model.eval()
    return model


def separate_stems(track: Path, device: str) -> tuple[float, float, float, int, list[str]]:
    """Run Demucs once.

    Return load seconds, separation seconds, track seconds, the number of operators
    that fell back from MPS to the CPU, and the stem names.
    """
    load_started = time.perf_counter()
    model = load_pinned_model()
    mix = AudioFile(track).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    model.to(device)
    load_seconds = time.perf_counter() - load_started
    track_seconds = mix.shape[-1] / model.samplerate

    # Same input scaling as the demucs CLI.
    reference = mix.mean(0)
    spread = reference.std()
    if spread == 0:
        raise ValueError("the track is silent, there is nothing to separate")
    mix = (mix - reference.mean()) / spread

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        separation_started = time.perf_counter()
        with torch.no_grad():
            stems = apply_model(model, mix[None], device=device, split=True, progress=False)
        if device == "mps":
            torch.mps.synchronize()
        separation_seconds = time.perf_counter() - separation_started
    cpu_fallbacks = sum("fall back to run on the CPU" in str(w.message) for w in caught)

    if not torch.isfinite(stems).all():
        raise RuntimeError(f"Demucs produced non-finite samples on {device}")
    return load_seconds, separation_seconds, track_seconds, cpu_fallbacks, list(model.sources)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("track", type=Path)
    parser.add_argument(
        "--device",
        choices=["auto", "mps", "cpu"],
        default="auto",
        help="Demucs device; auto tries MPS and falls back to CPU on an error",
    )
    args = parser.parse_args()

    if not args.track.is_file():
        print(f"error: not a file: {args.track}", file=sys.stderr)
        return 2
    # Absolute, so ffmpeg cannot read a leading "-" as an option or "name:" as a protocol.
    track: Path = args.track.resolve(strict=True)

    print(f"track:            {track.name}")
    print(
        f"versions:         essentia {essentia.__version__}, torch {torch.__version__}, "
        f"demucs {version('demucs')}"
    )

    analysis_started = time.perf_counter()
    bpm, bpm_confidence, key, scale, key_strength = analyse_bpm_and_key(track)
    analysis_seconds = time.perf_counter() - analysis_started
    print(f"bpm:              {bpm:.2f} (confidence {bpm_confidence:.2f})")
    print(f"key:              {key} {scale} (strength {key_strength:.2f})")
    print(f"essentia time:    {analysis_seconds:.1f} s")

    mps_available = torch.backends.mps.is_available()
    print(f"mps available:    {mps_available}")

    if args.device == "auto":
        devices = ["mps", "cpu"] if mps_available else ["cpu"]
    else:
        devices = [args.device]

    for device in devices:
        try:
            load_seconds, separation_seconds, track_seconds, cpu_fallbacks, sources = (
                separate_stems(track, device)
            )
        except Exception as error:  # the spike reports any MPS failure, then tries the CPU
            print(f"demucs on {device}:   FAILED: {type(error).__name__}: {error}")
            traceback.print_exc(file=sys.stderr)
            continue
        print(f"demucs device:    {device}")
        if device == "mps":
            print(f"cpu fallbacks:    {cpu_fallbacks} operator(s)")
        print(f"demucs stems:     {', '.join(sources)}")
        print(f"track length:     {track_seconds:.1f} s")
        print(f"demucs load:      {load_seconds:.1f} s")
        print(
            f"demucs time:      {separation_seconds:.1f} s "
            f"({track_seconds / separation_seconds:.1f}x realtime)"
        )
        return 0

    print("error: Demucs failed on every device", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
