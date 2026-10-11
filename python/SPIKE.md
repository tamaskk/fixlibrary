# Python environment spike (T-002)

Run on 2026-10-11, MacBook Pro 13" M1, 16 GiB RAM, macOS 26.2.

## Result

Essentia and Demucs install together on arm64 from PyPI wheels and run in one environment. No source build is needed, and Demucs runs on MPS.

## Chosen path

- Runtime: python-build-standalone CPython 3.11.17, release `20261009`, `aarch64-apple-darwin`, `install_only`, fetched into `python/runtime/` by `scripts/fetch-python-runtime.sh`. The version is pinned and the archive is checked against the SHA-256 in the release's `SHA256SUMS` before it is unpacked.
- Environment: `uv venv --python runtime/bin/python3`, dependencies from PyPI with `uv add`, locked in `uv.lock`.
- Essentia: the prebuilt `macosx_15_0_arm64` wheel. `scripts/build-essentia.sh` and `python/wheels/` are not needed.
- Demucs: `htdemucs` on MPS with `PYTORCH_ENABLE_MPS_FALLBACK=1`. The run did not fall back to the CPU, neither as a whole nor for single operators (the script counts PyTorch's fallback warnings: 0).

Prerequisites: uv, and `ffmpeg` on the PATH (the spike decodes audio for Demucs through it). To reproduce, from the repository root:

```
./scripts/fetch-python-runtime.sh
cd python
uv venv --python runtime/bin/python3
uv sync --locked
uv run python spike/run_spike.py <track>
```

## Versions

| Package    | Version       |
| ---------- | ------------- |
| CPython    | 3.11.17       |
| uv         | 0.13.0        |
| essentia   | 2.1b6.dev1389 |
| demucs     | 4.1.0         |
| torch      | 2.14.0        |
| torchaudio | 2.11.0        |
| numpy      | 2.4.6         |
| scipy      | 1.17.1        |
| mutagen    | 1.48.1        |
| pyloudnorm | 0.2.0         |
| soundfile  | 0.14.0        |
| pillow     | 12.3.0        |

The wheels set the minimum macOS of the packaged app: Essentia needs macOS 15, torch needs macOS 14.

## Measurements

Synthetic input only: a generated 124 BPM kick with an A minor chord. Real tracks have not been run yet (see "Not done").

| Input             | Length | BPM    | Key     | Essentia | Demucs device | Demucs time | Speed         |
| ----------------- | ------ | ------ | ------- | -------- | ------------- | ----------- | ------------- |
| MP3 320           | 60 s   | 123.65 | A minor | 0.7 s    | mps           | 8.5 s       | 7.1x realtime |
| WAV 16 bit        | 60 s   | 123.65 | A minor | 0.6 s    | mps           | 8.0 s       | 7.5x realtime |
| MP3 320           | 60 s   | 123.65 | A minor | 0.7 s    | cpu           | 21.1 s      | 2.8x realtime |
| MP3 320, 9 minute | 540 s  | 123.63 | A minor | 5.8 s    | mps           | 66.7 s      | 8.1x realtime |

- Demucs time covers `apply_model` only, including the MPS warm-up of a fresh process. Loading the model, decoding the file and moving the model to the device are measured separately and add 0.5 to 1.4 s.
- The 9 minute run was repeated twice more: 66.4 s and 66.5 s.
- Peak memory of the 9 minute run: 2.4 GiB resident (`/usr/bin/time -l`).
- An earlier series on the same day was about twice as slow: 31.7 s (MP3) and 24.4 s (WAV) for 60 s on MPS, 46.6 s on the CPU, and 146.4 s (3.7x realtime) for the 9 minute track. That series ran with torch 2.14.1, an unpinned model load and other work on the machine; which of these caused the difference was not investigated.

Estimate for T-028: at 8.1x realtime a 6 minute track takes about 45 s, so 3000 tracks take about 37 hours of Demucs time on this machine; at the slower 3.7x it is about 80 hours. Both are above the "half a day to a day" in docs/ARCHITECTURE.md §07. Confirm on real tracks before planning T-028.

## Environment size

Measured with `du -sh`.

| Part                          | Size   |
| ----------------------------- | ------ |
| `python/.venv`                | 780 MB |
| of which torch                | 543 MB |
| `python/runtime`              | 76 MB  |
| `htdemucs` model (downloaded) | 80 MB  |

About 0.94 GB unpacked in total, so the Python side fits under the 2 GiB `.dmg` limit of task 42 with room for the app and the binaries.

## Findings for later tasks

- The lock is restricted to arm64 macOS (`tool.uv.environments` in `pyproject.toml`). A universal lock resolved torch 2.2.2, the last release with Intel macOS wheels, next to torchaudio 2.11.0.
- The lock has a cooldown (`exclude-newer`): releases younger than about two weeks are not resolved. Move the date when upgrading on purpose.
- The package uses a flat layout (`python/fixlib_py/`, `module-root = ""`), as docs/ARCHITECTURE.md §03 describes, not the `src/` layout that `uv init --package` creates.
- Model loading (T-028, T-041). Demucs 4.1.0 takes its weights from the Hugging Face Hub (`adefossez/HTDemucs`), which is not in the project's list of online services. `demucs.pretrained.get_model()` must not be used in shipped code:
  - it follows the moving `main` branch without a checksum;
  - the file's metadata names the class that Demucs imports and calls, so a changed file can run code;
  - when the Hub fails, including with `HF_HUB_OFFLINE=1` and an empty cache, it silently downloads a pickle from `dl.fbaipublicfiles.com` instead.

  The spike loads one file at a fixed revision and checks its SHA-256 against the value the Hub publishes before loading it. The sidecar should load the weights from a local path only: bundled, or fetched once with a checksum.

- Demucs 4.1.0 no longer depends on torchaudio; only its training and pitch-shift modules import it. torchaudio stays in the dependency list as the task specifies; dropping it is an option for T-041.
- Audio decoding (T-003, T-013, T-028). Library files are untrusted input, and neither decoder used here is fit for the sidecar:
  - `demucs.audio.AudioFile` finds `ffmpeg` and `ffprobe` through the PATH and passes no protocol whitelist;
  - Essentia's `MonoLoader` decodes with the FFmpeg 2.8 bundled in its wheel, which has network and `concat` protocols compiled in.

  The sidecar should decode with the pinned ffmpeg of T-005 (`-protocol_whitelist file,pipe`) or with soundfile, and hand arrays to Essentia and Demucs.

- Demucs writes decoded audio to the system temp directory, and model caches default to `~/.cache`. The sidecar needs a per-job temp directory and cache locations under the app's data directory.
- The Essentia wheel bundles 43 third-party libraries, mutagen is GPL and lameenc is LGPL. The `.dmg` (T-042) has to carry their notices, and the licence of the `htdemucs` weights has to be settled before they are bundled.
- `KeyExtractor` ran with its default profile. The profile choice for electronic music belongs to T-013.

## Not done

- The test with three real tracks (one MP3, one WAV, one longer than 8 minutes) compared by hand with Rekordbox BPM and key. It needs copies in `tests/fixtures/real/`. Run it at the latest with T-013, which measures BPM and key accuracy on the real test set.
