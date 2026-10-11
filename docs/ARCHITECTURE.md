# Architecture: FixLibrary

Sections 01–05 describe the target structure. Only the scaffold exists today: `src/main/index.ts`, `src/main/ipc/app.ts`, `src/preload/`, `src/renderer/` (one page) and `src/shared/ipc.ts`. Everything else is marked by task number in `docs/TASKS.md` and detailed in `docs/source/fixlibrary-fejlesztesi-terv.md`.

## 01 System overview

```
Renderer (React, sandboxed)
    |  window.api  (typed IPC, src/shared/ipc.ts)
    v
Preload (contextBridge only)
    |
    v
Main process (Electron, Node)
    |
    +--->  SQLite (better-sqlite3 + Drizzle)        app state, cache, jobs
    +--->  Python sidecar (JSON-RPC over stdio)     all audio analysis and file audio work
    +--->  Bundled binaries (yt-dlp, ffmpeg, fpcalc, mp3gain)
    +--->  claude CLI (`claude -p`, headless)       style, mood, prompt parsing
    +--->  Online lookups (AcoustID, MusicBrainz, Discogs, Beatport, iTunes, Cover Art Archive)
    +--->  Library files on the external drive
    +--->  Rekordbox XML (written and read; Rekordbox itself is driven by the user)
```

- The user only ever interacts with the renderer.
- The renderer has no Node access. It never touches files, the database, the network or a process. Everything goes through `window.api`.
- Python is called only by the main process, through one bridge.
- The app never talks to Rekordbox directly: it writes an XML the user imports and reads an XML the user exports.

## 02 Tech stack

| Layer                 | Choice                                                                                       | Why this, not the obvious alternative                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shell                 | Electron, electron-vite, electron-builder                                                    | Tauri is smaller, but the Python sidecar, native SQLite and Playwright's Electron driver are proven on Electron |
| Frontend              | React 19, TypeScript strict                                                                  | —                                                                                                               |
| Styling               | Tailwind v4, tokens from DESIGN_SYSTEM.md                                                    | —                                                                                                               |
| UI primitives         | shadcn/ui restyled with the tokens                                                           | Hand-built primitives would cost days for tables, dialogs and selects                                           |
| Client state          | Zustand                                                                                      | Redux is ceremony for a single-window, single-user app                                                          |
| Database              | SQLite via better-sqlite3                                                                    | A server database needs a running service; this is a local single-user app and one file is enough               |
| Queries               | Drizzle ORM + drizzle-kit migrations                                                         | Prisma ships a query engine binary that complicates packaging                                                   |
| Validation            | Zod                                                                                          | —                                                                                                               |
| Audio                 | Python 3.11 sidecar: Essentia, Demucs (PyTorch, MPS), mutagen, pyloudnorm, soundfile, Pillow | Essentia and Demucs have no usable Node equivalent                                                              |
| Python tooling        | uv, python-build-standalone                                                                  | A plain venv cannot be relocated into an app bundle                                                             |
| AI                    | Local `claude -p` CLI                                                                        | An API SDK needs a paid key; the user's Claude subscription is already on the machine                           |
| Auth, payments, email | none                                                                                         | Single user, local app                                                                                          |
| Distribution          | Ad-hoc signed arm64 `.dmg` on GitHub Releases                                                | No Apple Developer account; own use only                                                                        |
| Testing               | Vitest, Playwright (`_electron`), pytest                                                     | —                                                                                                               |
| Quality               | ESLint, Prettier (+ tailwind plugin), `tsc --noEmit`; ruff for Python                        | —                                                                                                               |

Do not add a dependency that overlaps with a row in this table without asking.

## 03 Project structure

```
/
  AGENTS.md              agent instructions (read first)
  docs/                  PRD, design system, this file, security, tasks, source specs
  src/
    main/                Electron main process
      index.ts           app lifecycle and window creation only
      ipc/               one file per domain; registers handlers, validates input, calls a pipeline or service
      pipeline/          business logic: orchestrator, queue, stages/, naming, style, cues, playlists
      services/          side-effect adapters: python-bridge, file-ops, claude-cli, binaries, keychain, logger, rekordbox-xml, lookup/
      db/                schema.ts, migrations/, query functions
    preload/             contextBridge exposure of window.api. No logic.
    renderer/            React app (index.html, main.tsx, App.tsx)
      pages/             one file per screen. Thin: reads stores, calls window.api.
      components/
        ui/              primitives: Button, Input, Card (see DESIGN_SYSTEM.md)
        features/        feature-level components
      stores/            Zustand stores, UI state and cached server state
      styles/globals.css design tokens
      lib/               pure renderer helpers
    shared/              types and pure functions used by main, preload and renderer: ipc.ts, rpc.ts, errors.ts, keys.ts
  python/
    fixlib_py/           sidecar package: server.py, log.py, analysis/, tags.py, convert.py, normalize.py
    tests/               pytest
    spike/               T-002 environment spike script; results in python/SPIKE.md
    runtime/             python-build-standalone CPython (gitignored)
    pyproject.toml, uv.lock   locked for arm64 macOS only
  resources/bin/         downloaded binaries (gitignored)
  scripts/               fetch-python-runtime.sh, fetch-binaries.sh, build-python.sh, build-dmg.sh
  tests/
    e2e/                 Playwright tests against the built app
    fixtures/synthetic/  generated audio (committed)
    fixtures/real/       real music (gitignored, never committed)
```

SQLite: `src/main/db/` holds one connection (WAL mode) opened at startup, the Drizzle schema and the query functions. The file lives at `app.getPath('userData')/fixlibrary.db`. Applied migrations are never edited; every schema change is a new migration.

Where new code belongs:

- A new screen: `src/renderer/pages/<Name>.tsx`. Thin. Calls `window.api`.
- A new renderer-to-main call: add the channel and types to `src/shared/ipc.ts`, expose it in `src/preload/index.ts`, register the handler in `src/main/ipc/<domain>.ts`.
- New business logic: `src/main/pipeline/<domain>.ts`, as pure as possible.
- A new pipeline stage: `src/main/pipeline/stages/<stage>.ts` implementing the `Stage` interface.
- Anything that touches a file, process, network or the database: `src/main/services/` or `src/main/db/`, imported by a pipeline module, never by `ipc/` handlers directly for writes.
- New audio work: an `@rpc` method in `python/fixlib_py/`, with its types added to `src/shared/rpc.ts`.
- A new UI primitive: `src/renderer/components/ui/`, added to DESIGN_SYSTEM.md in the same commit.

## 04 Data flow

Request path for every user action:

1. Component calls `window.api.<domain>.<method>(…)`.
2. The IPC handler in `src/main/ipc/` validates the payload with Zod.
3. A pipeline function applies the rule, calling services, the database and the Python bridge.
4. A typed result returns. Long work reports through `pipeline:progress` events instead.
5. The renderer store updates from the response or event, not from a guess.

Every batch has two phases:

- **Compute**: analysis, lookup, proposals. Results go to `batch_items` and the analysis cache. No library file is modified.
- **Apply**: runs only after the user approves the batch preview. All file changes go through `services/file-ops.ts`: backup or copy first, write to a temp file in the same folder, then rename.

State:

- Durable state lives in SQLite. Jobs, batches and the full-run state machine are resumable after a restart.
- Renderer state is UI state plus a cache of what main returned. Main is always the authority.
- Optimistic updates: none in v1.

Python sidecar:

- One long-running process, started by `services/python-bridge.ts` when the app is ready and stopped on quit (`shutdown`, then SIGKILL after 3 s). It speaks JSON-RPC 2.0, one JSON document per line: requests on stdin, responses and `progress` notifications on stdout.
- The sidecar gets a fixed set of environment variables, not the app's environment, so secrets cannot reach it.
- Every line from the sidecar is validated against `src/shared/rpc.ts`; anything else is logged and dropped.
- When the sidecar dies, calls already sent are rejected with `PYTHON_CRASHED` and it restarts after 1 s, 2 s, then 4 s, at most 5 times in a row. Calls made during a restart wait for the new process.
- In development the interpreter is `python/.venv/bin/python`. The packaged app does not start the sidecar until task 41 defines its runtime path.

Errors:

- A failing track never stops a batch: it is recorded as `TrackError { trackId, stage, code, message }` and listed on the "Hibák" tab.
- Every stage has a timeout from `src/shared/timeouts.ts`.
- Logs go to `~/Library/Logs/FixLibrary/`. The UI shows a plain Hungarian message, never a stack trace or raw tool output.

## 05 Boundaries

Dependencies flow one way: renderer -> (IPC) -> main/ipc -> main/pipeline -> main/services and main/db. `shared` is imported by all and imports nothing from them.

Allowed:

- Pages import components, stores and `@shared` types.
- `ipc/` imports `pipeline/`; `pipeline/` imports `services/` and `db/`.
- `preload/` imports `electron` and `@shared` only.

Never:

- The renderer imports from `src/main`, uses Node APIs, or receives `ipcRenderer` itself.
- `services/` or `db/` import from `pipeline/`, `ipc/` or the renderer.
- Anything but `services/python-bridge.ts` spawns or talks to the Python process.
- Anything but `services/file-ops.ts` renames, moves, overwrites or deletes a library file.
- A command line built by string concatenation. External tools are spawned with an argument array, never through a shell.
- A secret in the renderer, in a log, or in plain text in the database.

## 06 Decisions that look wrong but are intentional

The agent must not "fix" these.

- Rekordbox is reached only through XML. `master.db` is never read or written, even though that would remove the manual import and export steps.
- Tags are written as ID3v2.3, not 2.4. Rekordbox and Pioneer players read 2.3 reliably.
- WAV files are converted to AIFF, and anything above 48 kHz is resampled to 48 kHz, so tags, covers and CDJ playback work.
- Normalization has no limiter. A track that cannot reach the target without exceeding −1.0 dBTP is skipped and flagged, not processed harder.
- Lossless MP3 gain runs `mp3gain` with `-s s` so no APEv2 tag is written.
- BPM and key come from our own analysis. Online values are only a cross-check.
- Claude is called through the `claude -p` CLI with tools and MCP disabled, from an empty working directory. No API SDK, and not `--bare` (it would bypass the subscription login).
- Demucs runs in its own single process, outside the CPU process pool, so the model loads once.
- Only the last batch can be undone; applying a new batch deletes the previous batch's backups.
- The preload is sandboxed and exposes hand-written functions. `@electron-toolkit/preload` was removed on purpose: it cannot be required in a sandbox.
- The renderer lives directly in `src/renderer/`, not electron-vite's default `src/renderer/src/`.
- React component and page files are PascalCase (`BatchPreviewTable.tsx`); everything else, including shadcn primitives, is kebab-case.
- `src/shared/keys.ts` and `rpc.ts` are mirrored by hand in Python (`keys.py`, method signatures). There is no code generation; both sides are kept in sync by hand in the same commit.
- The app is ad-hoc signed and not notarized. Do not add a signing or notarization step.
- Duplicates are detected and shown, never deleted automatically.

## 07 Scalability and future considerations

- Expected scale for v1: one user, one library of about 3000 tracks (25–35 GB) on an external drive, one machine (MacBook Pro M1). Build for this, not for 100x.
- Known limits: one Demucs job at a time, so the first full run takes half a day to a day (the T-002 spike projects 37 to 80 hours of Demucs time from synthetic input, see `python/SPIKE.md`; confirm on real tracks in T-028); one Claude call at a time in batches of 20; the Claude subscription limit can pause a run; exFAT drives make backups real copies; the full `.dmg` must stay under 2 GiB (GitHub Releases file limit).
- Planned next: nothing beyond the 45 tasks.
- Not planned: other platforms, other DJ software, multi-user, cloud sync, a plugin system. Do not add abstractions for these.

## 08 When the agent must stop and ask

If a task needs any of the following, stop, name the conflict, and propose the smallest change that avoids it:

- Crossing a boundary in section 05
- Changing a decision in section 06
- Adding a table, a dependency, a bundled binary, or an online service
- Changing how files are backed up, written, moved or deleted
- Changing how secrets are stored, or how the `claude` CLI is invoked
- Running anything against the real music library or `tests/fixtures/real/`

## 09 Environments and configuration

| Environment | How it runs                      | Built from                                  | Data                                                                                                        |
| ----------- | -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Development | `npm run dev`                    | working tree                                | dev database in Electron `userData`; synthetic fixtures, or a copy of real tracks in `tests/fixtures/real/` |
| Packaged    | `FixLibrary.app` from the `.dmg` | `v*` tag via the release workflow (task 44) | real library on the external drive                                                                          |

There is no server, preview or staging environment.

Environment variables (names only; values live in `.env.local` for development and in the app's Settings, encrypted via the macOS Keychain, when packaged):

| Name                    | Used by                     | Main process only |
| ----------------------- | --------------------------- | ----------------- |
| ACOUSTID_API_KEY        | `src/main/services/lookup/` | yes               |
| DISCOGS_CONSUMER_KEY    | `src/main/services/lookup/` | yes               |
| DISCOGS_CONSUMER_SECRET | `src/main/services/lookup/` | yes               |

The packaged app ignores `.env` files.
