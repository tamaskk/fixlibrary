"""Generates the committed audio fixtures in tests/fixtures/synthetic.

A 0.2 s sine tone as WAV, AIFF and MP3 320, without tags; tests copy a file and tag
the copy. Needs resources/bin/ffmpeg (scripts/fetch-binaries.sh). Run from the
repository root: python3 scripts/make-synthetic-fixtures.py
"""

from __future__ import annotations

import math
import struct
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "tests" / "fixtures" / "synthetic"
FFMPEG = ROOT / "resources" / "bin" / "ffmpeg"

SAMPLE_RATE = 44_100
DURATION_S = 0.2
FREQUENCY_HZ = 440.0
AMPLITUDE = 0.3


def write_wav(path: Path) -> None:
    frames = bytearray()
    for index in range(int(SAMPLE_RATE * DURATION_S)):
        value = AMPLITUDE * math.sin(2 * math.pi * FREQUENCY_HZ * index / SAMPLE_RATE)
        frames += struct.pack("<h", round(value * 32767))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(bytes(frames))


def convert(source: Path, target: Path, codec: list[str]) -> None:
    # -bitexact and no metadata, so a rerun produces the same bytes.
    subprocess.run(
        [str(FFMPEG), "-nostdin", "-y", "-loglevel", "error", "-f", "wav", "-i", str(source)]
        + codec
        + ["-map_metadata", "-1", "-bitexact", str(target)],
        check=True,
    )


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    wav = TARGET / "sine.wav"
    write_wav(wav)
    convert(wav, TARGET / "sine.aiff", ["-c:a", "pcm_s16be", "-f", "aiff"])
    convert(wav, TARGET / "sine.mp3", ["-c:a", "libmp3lame", "-b:a", "320k", "-f", "mp3"])


if __name__ == "__main__":
    main()
