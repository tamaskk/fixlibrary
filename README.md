# FixLibrary

Mac desktop app (Apple Silicon) that cleans up a DJ music library and hands the result to Rekordbox through Rekordbox XML.

`docs/` and `AGENTS.md` are the source of truth for what is built, how it looks and how the code is organised. Read them before changing anything.

## Setup

Requires Node 22 (`nvm use`) and macOS on arm64.

```bash
npm install
cp .env.example .env.local   # fill in the lookup API keys for development
npm run dev
```

## Scripts

| Script                            | What it does                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`                     | Start the app with hot reload                                                     |
| `npm run build`                   | Type check and build into `out/`                                                  |
| `npm run build:mac`               | Build the full and the lite arm64 `.dmg` into `release/` (`scripts/build-dmg.sh`) |
| `npm run lint`                    | ESLint                                                                            |
| `npm run typecheck`               | `tsc --noEmit` for main, preload and renderer                                     |
| `npm run format` / `format:check` | Prettier                                                                          |
| `npm run test` / `test:watch`     | Vitest unit tests                                                                 |
| `npm run test:e2e`                | Build, then Playwright against the Electron app                                   |

## Build

`npm run build:mac` builds two disk images into `release/` and prints their SHA-256:

- `FixLibrary-<version>-arm64.dmg`: the app with its Python runtime (Essentia, Demucs and the analysis code). Use it for the first install, and whenever the runtime version changed.
- `FixLibrary-<version>-arm64-lite.dmg`: the app without the runtime archive. Only for an update that keeps the runtime version; on a first install it cannot start its analyses.

## Install

Download the DMG only from the releases of this repository, and compare its checksum with the one the release names:

```bash
shasum -a 256 FixLibrary-*.dmg
```

Drag `FixLibrary.app` into Applications. At the first start the app unpacks its runtime into `~/Library/Application Support/fixlibrary/python/` (well under a minute, 1.1 GB).

The app is signed ad hoc, without an Apple Developer ID, so macOS does not open it the first time when it came from a browser, AirDrop, Mail or Messages. From macOS 15, right-click → Open is not enough:

1. Open FixLibrary once; macOS says it cannot be checked. Click Done.
2. Open System Settings → Privacy & Security, scroll to Security, and click "Open Anyway" next to FixLibrary.
3. Confirm with your password, then click "Open Anyway" again.

This is needed once per downloaded copy. Do not turn Gatekeeper off (`spctl --master-disable`) or strip the quarantine attribute (`xattr -cr`) instead. Until the in-app updater exists (T-043), an update is a new download that asks the same way.

## License

AGPL-3.0-only. The audio analysis depends on Essentia, which is AGPL-3.0.

Bundled with the app, each under its own licence:

- ffmpeg (LGPL-2.1, with LAME and mpg123), fpcalc (Chromaprint, LGPL-2.1) and mp3gain (LGPL-2.1): `Contents/Resources/bin/licenses/`.
- CPython (PSF License) and the Python packages of the runtime, among them Essentia (AGPL-3.0), PyTorch and torchaudio (BSD-style), Demucs (MIT), NumPy and SciPy (BSD-3-Clause), yt-dlp (Unlicense) and Pillow (MIT-CMU): their licences are in the `*.dist-info` folders of the unpacked runtime.
- The htdemucs weights of Demucs (MIT, by Meta Platforms), converted to plain tensors by `scripts/convert-demucs-weights.py`.
- The Inter font (SIL Open Font License 1.1): `fixlib_py/assets/fonts/` inside the runtime, `python/fixlib_py/assets/fonts/` in the repository.
