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

## Release key

Updates are trusted only through a release manifest signed with the owner's Ed25519 key. Make the key once, keep the private key outside the repository and back it up, and commit the public key it writes into `src/main/services/release-key.ts`:

```bash
npm run release:key -- keygen ~/.fixlibrary/release-signing-key.pem
npm run release:key -- manifest release/ <app version> <runtime version>
npm run release:key -- sign release/ ~/.fixlibrary/release-signing-key.pem
```

To release, set `version` in `package.json`, merge, and push the tag `v<version>` (a tag `v<version>-<suffix>` makes a prerelease). The workflow tests and builds everything and creates a draft release; then sign and publish it from this machine:

```bash
npm run release:publish -- v<version>
```

It publishes only a draft whose `manifest.json` carries the build attestation of this repository's workflow for that tag, whose tag is on `main`, and whose files are exactly the ones the manifest names, byte for byte (GitHub's digests). A prerelease is published unsigned, so the updater can never install it. If the workflow fails after it created the draft, delete the draft (`gh release delete <tag>`) and re-run the workflow.

On GitHub, keep a tag ruleset on `refs/tags/v*` that lets only the owner create, move or delete these tags, protect `main` (pull requests only, no force push), and turn on immutable releases where available.

A build without the key never updates itself. Replacing the key (`--force`) leaves every installed app unable to trust new releases until it is updated by hand.

## Install

FixLibrary needs an Apple Silicon Mac with macOS 15 or newer. Download the DMG only from the releases of this repository, and compare its checksum with the one the release names:

```bash
shasum -a 256 FixLibrary-*.dmg
```

Drag `FixLibrary.app` into Applications. At the first start the app unpacks its runtime into `~/Library/Application Support/fixlibrary/python/` (well under a minute, 1.1 GB).

The app is signed ad hoc, without an Apple Developer ID, so macOS does not open it the first time when it came from a browser, AirDrop, Mail or Messages. From macOS 15, right-click → Open is not enough:

1. Open FixLibrary once; macOS says it cannot be checked. Click Done.
2. Open System Settings → Privacy & Security, scroll to Security, and click "Open Anyway" next to FixLibrary.
3. Confirm with your password, then click "Open Anyway" again.

This is needed once per downloaded copy. Do not turn Gatekeeper off (`spctl --master-disable`) or strip the quarantine attribute (`xattr -cr`) instead. Updates come through the app (Settings → Rendszer, or the line above the pages): it downloads the new version, checks its signature and checksum, and opens the DMG for you to drag the app across; such a download is not asked about again. yt-dlp updates itself in the background.

## License

AGPL-3.0-only. The audio analysis depends on Essentia, which is AGPL-3.0.

Bundled with the app, each under its own licence:

- ffmpeg (LGPL-2.1, with LAME and mpg123), fpcalc (Chromaprint, LGPL-2.1) and mp3gain (LGPL-2.1): `Contents/Resources/bin/licenses/`.
- CPython (PSF License) and the Python packages of the runtime, among them Essentia (AGPL-3.0), PyTorch and torchaudio (BSD-style), Demucs (MIT), NumPy and SciPy (BSD-3-Clause), yt-dlp (Unlicense) and Pillow (MIT-CMU): their licences are in the `*.dist-info` folders of the unpacked runtime.
- The htdemucs weights of Demucs (MIT, by Meta Platforms), converted to plain tensors by `scripts/convert-demucs-weights.py`.
- The Inter font (SIL Open Font License 1.1): `fixlib_py/assets/fonts/` inside the runtime, `python/fixlib_py/assets/fonts/` in the repository.
