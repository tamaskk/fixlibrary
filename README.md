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

## Install

`npm run build:mac` builds two disk images into `release/`:

- `FixLibrary-<version>-arm64.dmg`: the app with its Python runtime (Essentia, Demucs and the analysis code). Use it for the first install.
- `FixLibrary-<version>-arm64-lite.dmg`: the app without the runtime archive, for an update that keeps the runtime version.

Drag `FixLibrary.app` into Applications. At the first start the app unpacks its runtime into `~/Library/Application Support/fixlibrary/python/` (about a minute, 1.1 GB).

The app is signed ad hoc, without an Apple Developer ID, so macOS does not open it the first time when it was downloaded with a browser. From macOS 15, right-click → Open is not enough:

1. Open FixLibrary once; macOS says it cannot be checked. Click Done.
2. Open System Settings → Privacy & Security, scroll to Security, and click "Open Anyway" next to FixLibrary.
3. Confirm with your password, then click "Open Anyway" again.

This is needed once. Updates are downloaded by the app itself and do not ask again.

## License

AGPL-3.0-only. The audio analysis depends on Essentia, which is AGPL-3.0.

Bundled with the app, each under its own licence:

- ffmpeg (LGPL-2.1, with LAME and mpg123), fpcalc (Chromaprint, LGPL-2.1) and mp3gain (LGPL-2.1): `Contents/Resources/bin/licenses/`.
- CPython (PSF License) and the Python packages of the runtime, among them Essentia (AGPL-3.0), PyTorch and torchaudio (BSD-style), Demucs (MIT), NumPy and SciPy (BSD-3-Clause), yt-dlp (Unlicense) and Pillow (MIT-CMU): their licences are in the `*.dist-info` folders of the unpacked runtime.
- The htdemucs weights of Demucs (MIT, by Meta Platforms), converted to plain tensors by `scripts/convert-demucs-weights.py`.
- The Inter font (SIL Open Font License 1.1): `python/fixlib_py/assets/fonts/`.
