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
    +--->  External tools (ffmpeg, fpcalc, mp3gain bundled; yt-dlp as a Python module)
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
      pipeline/          business logic: orchestrator, queue, stages/, scanner, naming, style, cues, playlists
      services/          side-effect adapters: python-bridge, file-ops (the only code that changes library files), claude-cli, binaries, keychain, logger, rekordbox-xml, lookup/
      db/                connection.ts, schema.ts, migrations/, one query module per table group (tracks.ts, settings.ts, …)
    preload/             contextBridge exposure of window.api. No logic.
    renderer/            React app (index.html, main.tsx, App.tsx)
      pages/             one file per screen. Thin: reads stores, calls window.api.
      components/
        ui/              primitives: Button, Input, Card (see DESIGN_SYSTEM.md)
        features/        feature-level components
      stores/            Zustand stores, UI state and cached server state
      styles/globals.css design tokens
      lib/               pure renderer helpers
    shared/              types and pure functions used by main, preload and renderer: ipc.ts, rpc.ts, errors.ts, library.ts, pipeline.ts, keys.ts
  python/
    fixlib_py/           sidecar package: server.py, logging_setup.py, analysis/, tags.py, convert.py, normalize.py
    tests/               pytest
    spike/               T-002 environment spike script; results in python/SPIKE.md
    runtime/             python-build-standalone CPython (gitignored)
    pyproject.toml, uv.lock   locked for arm64 macOS only
  resources/bin/         ffmpeg, fpcalc, mp3gain and their licences, from scripts/fetch-binaries.sh (gitignored)
  scripts/               fetch-python-runtime.sh, fetch-binaries.sh, make-synthetic-fixtures.py, build-python.sh, build-dmg.sh
  tests/
    e2e/                 Playwright tests against the built app
    fixtures/synthetic/  generated audio (committed; scripts/make-synthetic-fixtures.py)
    fixtures/real/       real music (gitignored, never committed)
```

SQLite: `src/main/db/` holds one connection (WAL mode, foreign keys on) opened at startup, the Drizzle schema and the query functions. The file lives at `app.getPath('userData')/fixlibrary.db`. Applied migrations are never edited; every schema change is a new migration.

- Startup opens the database and runs the pending migrations before IPC, the sidecar and the window. If the database cannot be opened or migrated, or was written by a newer version of the app, the app shows an error and quits. Only one instance of the app runs at a time.
- Migrations run with foreign keys off (a table rebuild would otherwise cascade into the child tables), followed by a foreign key check; the keys are on for everything else.
- Rows that undo depends on never disappear as a side effect (the same holds for `batch_files`): a batch with backups cannot be deleted, a track that a batch refers to cannot be deleted, and deleting a track only clears the link on its backup rows. The one delete of batches is `deleteDiscardedBatches`, run when a new run starts: it removes batches that were cancelled before anything was written (never applied, no backup, no apply job ever started), with their items and jobs. A batch that got as far as writing is never deleted by it.
- Track paths are stored normalized and NFC-composed, and the volume name is always derived from the path.
- Settings keys that start with `secret.` are reserved for encrypted values (task 6); `setSetting` refuses them.
- Migrations are generated with `npx drizzle-kit generate --name <what_changed>` and committed. The packaged app reads them from `Resources/migrations` (`extraResources`).
- Query functions take the database as their first argument, so tests run them against a temporary file built by the real migrations (`src/main/db/database.test-util.ts`).
- JSON columns are typed `unknown` in the schema and validated with Zod by the query function that reads them.
- A track stores the name of its volume (`/Volumes/<name>`), or null on the startup disk. Queries return `offline: true` for a track whose volume is not in the set of mounted volumes (`services/volumes.ts`, which counts mount points only, not leftover folders); an offline track must not be processed.
- End-to-end tests start the app with `--user-data-dir` pointing at a temp folder, so they never touch the developer's database.

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

External tools:

| Tool    | Version    | How it gets here                                                                 | Licence                    |
| ------- | ---------- | -------------------------------------------------------------------------------- | -------------------------- |
| ffmpeg  | 9.0.2      | built from the ffmpeg.org source by the script, with LAME 4.0 linked in          | LGPL 2.1 or later          |
| mp3gain | 1.6.2      | built from source by the script, with libmpg123 1.33.7 linked in                 | LGPL 2.1 or later          |
| fpcalc  | 1.6.1      | official Chromaprint `macos-arm64` release binary                                | MIT, with LGPL FFmpeg code |
| yt-dlp  | 2026.08.19 | Python package in the sidecar environment (`python/uv.lock`), run as `-m yt_dlp` | Unlicense                  |

- `scripts/fetch-binaries.sh` installs ffmpeg, mp3gain and fpcalc into `resources/bin/`, with their licence texts and a `NOTICE.txt`. Every download is checked against a pinned SHA-256 before it is used. The source pins equal the hashes Homebrew publishes for the same URLs; the fpcalc pins are the digests GitHub publishes. Every tool must contain an arm64 slice and may link only against system libraries. The build ignores Homebrew and the caller's compiler settings, so it needs only the Xcode Command Line Tools.
- ffmpeg is deliberately small: audio only, the formats the app converts between, `file` and `pipe` as the only protocols. It is not the `ffmpeg-static` build the plan named: that binary is compiled with `--enable-nonfree` and may not be redistributed. A new format or filter means a new configure flag in the script.
- The script records the SHA-256 of every installed file. `./scripts/fetch-binaries.sh --verify` checks them, and `build:mac` and `build:unpack` run it first, so packaging stops if a tool is missing or was changed.
- yt-dlp is not a bundled binary. The official single-file build unpacks itself on every start (20 s per call on an M1, against 0.1 s as a module), and electron-builder cannot sign the folder build. As a Python package it is pinned and hash-checked by `uv.lock` like every other dependency. Task 43 therefore updates a Python package, not a file in `userData`.
- `services/binaries.ts` is the only place that knows how to start the tools: `resources/bin/` in development, `Resources/bin/` in the packaged app, and the sidecar's interpreter with `-I -m yt_dlp` for yt-dlp. Nothing falls back to a tool on the PATH. `checkAll()` runs each tool with its version switch, an empty environment and a neutral working directory, and returns a version or a reason code, never raw output.
- Not verified in the packaged app: it has no Python runtime before task 41, so yt-dlp is reported as missing there, and the packaged app itself does not start yet because of its signing settings (task 42).
- Rules for the code that will call the tools with untrusted input:
  - ffmpeg: `-nostdin`, an absolute input path, the input format forced with `-f` from the app's own check of the file, and an app-generated output name. Tag text never goes into a filter string.
  - yt-dlp: the URL is validated in the main process and passed after `--`; always `--ignore-config`, `--no-playlist` and an explicit `--ffmpeg-location`; never `--exec`, `--cookies-from-browser` or `-U`.
  - mp3gain: always `-s s`, absolute paths, and only files the app has identified as MP3.
  - All of them: an argument array, an explicit minimal environment, a timeout.

Settings and secrets:

- `src/shared/settings.ts` holds the schemas and the defaults. Settings are stored as five groups, one row each; a group that was never changed has no row, and a folder that was never chosen is null. `pipeline/settings.ts` resolves the value in use (backup folder next to the library, Rekordbox folders under `~/Documents/FixLibrary`, worker count one less than the CPU cores and never more than the cores). A library that is a whole drive or a home folder has no folder next to it that the app could create, so it has no default backup folder: the user has to choose one.
- The renderer changes settings with a typed, validated patch. There is no generic "set key to value" call, an unknown key is refused, and the merged result is validated again before it is written.
- Folders are never accepted from the renderer: `settings:pickFolder` opens the dialog in the main process, which also words the dialog, and stores what the user picked as the file system names it (links resolved). The library, its clean copy and its backup folder may not contain one another; this is decided by what the folders are on disk, not by how their paths are spelled. A folder that does not exist yet is resolved as far as it exists and compared by spelling from there on. The rule is checked when a folder is chosen; the tasks that write files check their targets again when they run.
- API keys are encrypted with Electron `safeStorage` (a key in the macOS Keychain) and stored under the reserved `secret.` keys of the settings table. Without the Keychain a key is not stored at all. A key's value never goes to the renderer, only where it comes from: stored, the development env file, unreadable, or missing.
- In development `.env.local` is a fallback for keys that are not stored. Only the three key variables are kept, in an object and never in `process.env`, so child processes cannot inherit them. The packaged app does not read the file.
- The app is ad-hoc signed, so the Keychain item belongs to one build. After an update a stored key may not decrypt; the Settings page then shows it as unreadable and asks for it again.
- A key test is a real request with the owner's key: one at a time per service, and no second request to a service within five seconds, whatever is saved or deleted in between (a test that comes too soon is answered without a request). It never follows a redirect. Only a clear answer counts; anything else is reported as "not checked". A result belongs to the keys it was run with: once a key changes, a test that ran or is still running with the old one is not reported for the new one.
- A stored key is encrypted together with its name, so a ciphertext copied to the row of another key is not accepted there.
- Names of styles and hot cues are stored composed (NFC) with single spaces. Control, invisible, private-use and unassigned characters are refused, which also rules out emoji sequences that need a joiner.
- A style that a track uses cannot be deleted; `Unsorted` always exists and keeps its name.

IPC handlers:

- Every handler is registered through `handleIpc` (`src/main/ipc/handle.ts`). It runs the handler only for the app's own page (the main frame, at the renderer's URL) and only with arguments that fit a Zod schema. Anything else is rejected with a fixed message and logged by channel name. A handler that throws is logged in the main process, and the renderer gets a fixed message, never the error text. In development every page of the dev server's origin counts as the app's page.
- The main process tells the renderer something unasked only on the channels of `IPC_EVENTS` in `src/shared/ipc.ts`. The preload exposes each as a subscribe function that hands the page the payload alone and returns the function that unsubscribes. Progress goes out at most four times a second (`ipc/progress.ts`).
- Calls that can fail in an expected way return `Result<T>` from `src/shared/errors.ts` (`{ ok, value }` or `{ ok: false, code }`), because an error thrown across IPC loses its code. The renderer maps the code to Hungarian text.
- The window's top-level document cannot navigate away from the app's page, and no webview can be attached. A frame inside the page gets no preload and is refused by the handlers.

Library scan:

- `pipeline/scanner.ts` walks the library folder and keeps the `tracks` table in step with it. It only reads: no library file is changed, moved or deleted by a scan. It runs when the app starts (if a library folder is chosen) and from the Library page; one scan runs at a time, and a second request joins the one that is running. `library:followScan` gives the page the result of a running scan without ever starting one.
- The walk takes `.mp3`, `.wav`, `.aif` and `.aiff` files in any letter case. It skips every entry whose name starts with a dot (hidden files, `._*` AppleDouble files, `.Trashes`, `.Spotlight-V100`, `.fseventsd`), never follows a link, and leaves out the backup and clean library folders.
- A track stores the size and modification time of its file as last scanned. A file with both unchanged is not read again. New and changed files go to the sidecar's `tags.read` in batches of 50 (`TAG_BATCH_SIZE`), which returns duration, bitrate, sample rate, the basic tags and whether a cover is embedded. A file that cannot be read is listed without tags, with `stageStatus.scan` set to `failed`.
- A file that is gone is marked `fileMissing`; its row stays, because batches and backups may refer to it. Nothing is marked missing when a folder could not be read, or when the library is not reachable at the end of the scan.
- Before it starts, and again before it marks anything missing, the scan checks that the folder is there and, for a path under `/Volumes`, that the volume is mounted: an unclean eject can leave an empty folder behind. A drive that goes away ends the scan with `LIBRARY_UNAVAILABLE`; what was stored until then stays.
- The home folder, anything above it and `/Volumes` itself cannot be the library (`LIBRARY_ROOT_UNSUITABLE`). This and the rule that the library folders may not contain one another are checked when a folder is chosen and again by every scan.
- A file that could not be read (`stageStatus.scan` is `failed`) is tried again by every scan, whether it changed or not; if it is still unreadable, the scan counts it as unchanged. A file whose read ran out of time is `skipped` instead and is not tried again until its size or modification time changes, because trying it costs minutes.
- When a whole batch fails, its files are read one by one, so one file the sidecar cannot cope with is recorded as unreadable instead of stopping every scan at the same place. After a single file fails, the sidecar is asked whether it is alive (`ping`): if it answers, the file was the cause; if not, the scan ends with the sidecar's error.
- Every entry of a `tags.read` answer is validated on its own (`fileTagsSchema`). An entry that does not fit makes that one file unreadable; an answer about other files than were asked for ends the scan.
- The sidecar chooses the parser by the file's extension, never by its content, and opens the file itself: nothing reached through a link in any part of the path (`O_NOFOLLOW_ANY`), regular files only. No single read may exceed 16 MB, which bounds a tag, a cover and a WAV or AIFF chunk alike. Tag text is cut to one line of 300 characters without direction marks; with that limit the largest answer for a batch fits the 1 MiB line limit of the bridge.
- Not covered: a compressed ID3 frame inside the read limit can inflate to much more memory, and a tag of very many tiny frames can take minutes to parse. Such a file is read once, runs into the batch timeout and is then `skipped`, but its sidecar thread works on until it is done. Parsing in a process that can be stopped would close both.
- A scan that could not look at part of the library (a folder it may not read, an entry that vanished, a library that had tracks and shows no file at all) reports `complete: false` and marks nothing missing. `missing` in the result is the total of this library's tracks without a file, not only the ones this scan noticed.
- Known limit: a file renamed only in letter case is a new track to the scan, and the old row is marked missing.
- A path is stored composed (NFC), but a file is always opened by the name the disk gave during the walk.
- The scanner reads the file system itself instead of going through a service: it only lists and stats, and `services/file-ops.ts` stays the only code that changes a library file.

Library page:

- `library:list` returns one page (at most 500) of `LibraryTrack` rows in path order: what the table shows of a track and nothing more. The page loads all of them into `stores/library-store.ts`; search, filters and sorting are pure functions in `renderer/lib/library-view.ts` and run in the renderer, which is fast enough for the 3000 tracks the app is built for and makes range selection and "select all" trivial. The table itself is virtualized (`@tanstack/react-virtual`).
- The selection (`renderer/lib/selection.ts`) lives in the store as a set of track ids. A search or filter that hides a selected row takes it out of the selection, so a run never processes a track the user cannot see selected; sorting keeps the selection. Tracks that are gone leave it when the rows are loaded again after a scan.
- `library:run` takes track ids, or the whole library, and nothing else. `pipeline/library.ts` decides which of them a run may process: a track that is offline, whose file the last scan did not find, or that is not in the library is left out and counted. A track whose tags could not be read is not left out: its audio may still be fine. File and folder names are sent to the page as one clean line, for display only; the page never sends a name or a path back. The mounted volumes are looked up at most once a second for these calls, so one load of the table sees one state; the scanner always asks afresh. Until the orchestrator exists (T-009) the handler only answers with those tracks; nothing is processed.

Pipeline runs:

- A stage (`pipeline/stages/stage.ts`) is one step for one track: a name, a phase (`compute` or `apply`), the resource it needs, the stages it depends on, a timeout and `run`. `pipeline/stages/index.ts` lists the stages and checks at startup that they can be ordered: no circle, no unknown or duplicate name, no compute stage that waits for an apply stage. No stage exists before T-013.
- A run is a batch: one `batch_items` row per track, holding the track as it was (`before`) and what the stages propose (`after`), and one `jobs` row per track and stage. Asking for a stage adds the stages it depends on. Only a track that is in the library, online and has its file becomes part of a batch; this is decided when the run starts, whatever the caller checked.
- `pipeline/orchestrator.ts` runs the jobs. A job starts when the stages it depends on are done for the same track, and when its resource has room (`pipeline/queue.ts`): `cpu` is the worker count of the settings, read again whenever a job could start; `gpu` 1, `claude` 1, `io` 2, `network` 4.
- A job goes through `pipeline/run-stage.ts`, so a failure or a timeout becomes a `TrackError` on the job and on the item of the batch (the first error of a track stays). The jobs that wait for a failed one are skipped; the other tracks go on.
- Two phases. Compute ends with the batch in `preview`: nothing was written, and the apply jobs stay queued. `applyBatch` starts them, only for the items the user approved and did not take out, and ends with the batch `applied`. Only one batch waits for approval: starting a new run cancels an older one, and deletes it together with every other batch that was given up unwritten, so the rows of runs that came to nothing do not pile up.
- One batch is computed or applied at a time; a second start is answered with `RUN_ACTIVE`.
- Pause: no new job starts and the running ones finish; the pause and its reason are stored on the batch. If the drive of a track is not mounted when its job would start, the run pauses itself (`offline`) instead of failing every track that is left.
- Cancel ends the batch at once: in one transaction the batch becomes `cancelled` and every job that is not over becomes `skipped`, the running ones included. They get their abort signal, and whatever they still return is thrown away. A cancelled batch is never taken up again. A stage that writes files must therefore stop on its signal: a write that finishes after the cancel is not recorded on the job.
- Restart: quitting tells the running jobs to stop and puts them back in line. At the next start the batch that was being computed or applied is taken up again: `done` jobs are not run again. A batch the user paused stays paused; one that had paused for a missing drive goes on, and pauses again if the drive is still away. After a crash the jobs that were running go back in line too, but the start counts: a job that was running in three crashes is recorded as failed, so a file that makes the app crash cannot do so forever.
- The apply phase never writes a track that a stage failed for, approved or not.
- What listens to a run (progress, the sleep blocker) cannot stop it by failing, and may act on the run from inside a report: the last report of a run goes out after the run is over.
- A run is started from the Library page with `library:run`: track ids, or the whole library, and the names of the functions to run. Only the names of stages marked `selectable` are accepted; the stages they depend on are added by the orchestrator. At most one run is started in two seconds, and pause and resume are acted on at most four times a second, so a page cannot fill the disk or the log by calling in a loop. `pipeline:state` tells the page which functions exist and which run is active; `pipeline:pause`, `pipeline:resume` and `pipeline:cancel` take no argument and act on the one active run.
- `pipeline:progress` events go to the page at most four times a second. A report that says something new about the run itself (paused, went on, ended, another batch or phase) is never held back, and the newest report that was held back still goes out when its time has come: a run may stand still for minutes, and the page must not show old numbers all that time. A report carries the time the run has worked (pauses do not count) and how many tracks failed.
- While a run works, `services/power.ts` holds off sleep with Electron's `powerSaveBlocker` (`prevent-app-suspension`); a paused run with nothing running lets the Mac sleep.
- At startup the app scans the library first and then takes up a run that was interrupted, so both do not read the drive at once. Until then the run is not shown, and a new run is refused. The limits of the resources are read from the settings at most once a second. Quitting calls `shutdown` on the orchestrator before the sidecar is stopped and the database is closed.
- Long work in the sidecar runs inside `cancellable(job_id)` and checks its stop event between steps. The bridge takes a job id and an abort signal with a call: on abort the call is rejected at once and `job.cancel` is sent. A job has five seconds to stop. A cancel that reaches the sidecar before its job has registered is remembered, and the job is stopped as it starts. Every attempt of a job gets its own id, made in the main process, of at most 64 characters. No method uses this before T-013.
- No real stage exists before T-013. In development, `FIXLIB_DEMO_STAGES=1` adds two stages that only wait (`pipeline/stages/demo.ts`), so a run can be tried and tested end to end; `FIXLIB_DEMO_STAGE_MS` sets how long they take. The packaged app ignores both.
- Progress is reported as counts per stage and an estimate of the time left: per stage, how long its last 50 jobs took, times the jobs left, over how many run at once. There is no estimate while a stage with jobs left has not finished one.

File changes, backup and undo:

- `services/file-ops.ts` is the only code that copies, renames, overwrites or deletes a file of the library. It knows nothing about batches. Every write goes through a temp file next to its target (`.<name>.<8 hex>.fixlib-tmp`, a new name per write), which is synced to disk and renamed into place only when it is complete; a write that fails or is told to stop leaves the target byte-identical and removes the temp file. A file gets a new name through `link` and `unlink`, which fail if the name is taken: a move or a copy never replaces another file, also when two of them race for one name. Only `restore` and `replace` write over an existing file. It refuses a path that is not absolute and plain (no `..`), and every path whose nearest existing folder is not inside the library, the clean library or the backup folder, decided by what the folders are on disk and not by spelling. Links are resolved first, so a path through a link that points out of those folders is refused; a source that is itself a link is refused too. It never deletes a folder that holds anything, and never one of the three folders.
- `pipeline/batch-files.ts` holds the rules. An apply stage gets `context.files`, bound to its one track: `workingPath`, `move` and `replaceContent`. A compute stage gets `null`, so it has no way to change a file. The stages of one track take turns at its file, and every new name is picked and taken under one lock, so two tracks that want one name get two names. `move` accepts only names a library file may have (`unusableNameReason`: an audio extension, no leading dot, no control characters, composed Unicode) and renames nothing once its stage was told to stop.
- In place: before the first change of a track, the original is copied to `<backup folder>/<batch id>/<track id>.<ext>` and recorded in `backups`. The copy is a clone where the file system makes one and a plain copy elsewhere (`COPYFILE_FICLONE`, with `COPYFILE_EXCL` so that nothing already at the temp name is written through). A file that is in the place of the backup without a record is left alone, and the backup is made beside it under the next free name. Every copy is checked by size. A track is backed up once per batch, as it was before the batch; if that backup is gone when the track is taken up again, the track is changed no further.
- Clean library: the first change copies the track to the same relative place under the clean library folder, and all work happens on the copy. The track's `path` then names the copy and `originalPath` the untouched original; the scanner knows such an original and does not take it for a new track. A copy that an earlier batch made is backed up like an original before a later batch changes it.
- `batch_files` is a journal of the files a batch creates (copies, and files under a new name). A row is written before its file is, so undo and the next run know about a file even if the app stopped between the two; a row whose file was not created after all is removed again. After a crash, a file that is not where its track says is found again through the journal.
- A taken name gets ` (2)`, ` (3)`, …; the stage is told, and reports `NAME_COLLISION` for the preview.
- Before the apply phase starts, `checkSpace` adds up what still has to be copied, per volume, and `applyBatch` answers `NOT_ENOUGH_SPACE` if that plus 64 MB does not fit. The whole size is always counted, also where a clone would take no room.
- Undo (`undoLast`) acts on the newest batch that changed files and has not been undone, also one that was cancelled halfway. It plans and checks everything before the first file changes: every record of the batch is readable, every backup exists and lies in the backup folder, every place a file goes back to lies in the library or the clean library. If a check fails, undo changes nothing. Then it puts each backup back in one step per file, deletes the file the batch left under a new name (only the track's current file, and only if the journal names it; a file that only got another letter case is renamed back), restores the tracks whose files it touched from `batch_items.before`, marks the batch `undone`, deletes the backups it has put back, and cancels a batch that waits for approval, since its proposals were made for other files. A track without a backup is only ever the copy a clean library batch made: its copy is deleted if the original is still there, and kept with its track if not. In place, a touched track without a backup record makes undo refuse the whole batch. An undo that stopped halfway and is asked for again knows the files it has already put back (the track's file is gone, and the file at the old name is as big as the backup). Undo never writes over a file that is not the track's own: if the old name is taken, the original goes back under the next free name. The path of a restored track is where its file really went, not what the record says. It is refused while a batch is computed or applied, and it can be asked for again if it stopped halfway.
- Once a batch that wrote files is applied, the backup files and records of every earlier batch are deleted: only the last batch can be undone, and a library's worth of backups must not pile up. A batch that wrote nothing deletes nothing, so the last batch that did write stays undoable. Only a file inside the backup folder is deleted as a backup, whatever a record says. An apply or undo that is asked for while backups are being deleted, or while a stage of a cancelled batch is still finishing a copy or a rename, waits for that to end.
- A scan and a change of files never run together: the scanner starts no scan while a batch is applied or undone (`RUN_ACTIVE`), and `applyBatch` and `undoLast` are refused during a scan and until the startup work is over.
- The backup folder in use cannot change while a backup exists (`BACKUPS_IN_USE`), also not by moving the library when the folder is the default one next to it: undo reads the backups from there.
- At startup the app deletes the `.fixlib-tmp` files that interrupted writes left in the three folders, before it scans. The cleanup follows no link and stays on the volume of the folder.
- Nothing calls `applyBatch` or `undoLast` from the page yet; the approval and the "Undo last batch" button come with T-011.

Python sidecar:

- One long-running process, started by `services/python-bridge.ts` when the app is ready and stopped on quit (`shutdown`, then SIGKILL after 3 s). It speaks JSON-RPC 2.0, one JSON document per line: requests on stdin, responses and `progress` notifications on stdout.
- The sidecar gets a fixed set of environment variables, not the app's environment, so secrets cannot reach it.
- Every line from the sidecar is validated against `src/shared/rpc.ts`; anything else is logged and dropped. A line longer than 1 MiB counts as a crash.
- The sidecar keeps the real stdin and stdout for the protocol only: its own prints and its child processes get stderr and an empty stdin.
- When the sidecar dies, calls already sent are rejected with `PYTHON_CRASHED` and it restarts after 1 s, 2 s, then 4 s, at most 5 times in a row; 10 s of uptime ends the row. Calls made during a restart wait for the new process.
- In development the interpreter is `python/.venv/bin/python`. The packaged app does not start the sidecar until task 41 defines its runtime path.

Errors:

- A failing track never stops a batch: it is recorded as `TrackError { trackId, stage, code, message }` and listed on the "Hibák" tab. `pipeline/run-stage.ts` is the one place that turns a failure into a `TrackError`: it runs one stage for one track, never throws, and aborts the work when its time is up (`TIMEOUT`). The orchestrator (task 9) stores the error in `batch_items.error`; the preview (task 11) lists it.
- Every stage has a timeout from `src/shared/timeouts.ts`, the only place where the limits are set.
- The message of a `TrackError` is always fixed text of the app, chosen by the error's code (`TRACK_ERROR_MESSAGES`). The text of the error itself, what the sidecar reported and what a tool printed go to the log only, each cut down to one clean line. An error the app did not raise itself is recorded as `UNEXPECTED`.
- Work that is abandoned on a timeout is told to stop through an abort signal. Its late result is ignored, but what it still does is not undone, so work that writes a file must stop on abort and never rename a temp file into place afterwards.
- Everything in the main process logs through `services/logger.ts`, into `main.log` in the app's log folder (`~/Library/Logs/FixLibrary/`; Electron spells the folder `fixlibrary`, which is the same folder on a case-insensitive disk). The file rotates at 10 MB and five files are kept. The sidecar writes its own `python.log` there with the same limits, and the bridge copies the sidecar's stderr lines into `main.log` with a `[python]` prefix, so both sides can be read in order. That copy is limited to 200 lines in ten seconds (what is held back is counted in one line), so a tool's progress output cannot push the app's own history out of the log. Both files are readable by the user only. If the log folder cannot be used, the app logs to the console and starts anyway.
- An uncaught exception in the main process is logged, the user is told in a dialog, and the app restarts (or stops, if it has run for less than 30 seconds, so a crash at startup cannot loop). The app never runs on in an unknown state while it may be writing library files. An unhandled promise rejection is only logged.
- `services/logger.ts` and the pure helpers in `src/shared` may be imported from every layer of the main process, including `db/`. Only `logger.ts` imports `electron-log`, and only its `/node` entry: the main entry registers IPC handlers outside `ipc/handle.ts`. ESLint enforces this.
- The UI shows a plain Hungarian message, never a stack trace or raw tool output.

## 05 Boundaries

Dependencies flow one way: renderer -> (IPC) -> main/ipc -> main/pipeline -> main/services and main/db. `shared` is imported by all and imports nothing from them.

Allowed:

- Pages import components, stores and `@shared` types.
- `ipc/` imports `pipeline/`; `pipeline/` imports `services/` and `db/`.
- `preload/` imports `electron` and `@shared` only.

Never:

- The renderer imports from `src/main`, uses Node APIs, or receives `ipcRenderer` itself.
- `services/` or `db/` import from `pipeline/`, `ipc/` or the renderer.
- Anything but `services/python-bridge.ts` spawns or talks to the Python sidecar. The one other use of the interpreter is `services/binaries.ts`, which runs yt-dlp as a module in its own short-lived process.
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

| Name                    | Used by                                | Main process only |
| ----------------------- | -------------------------------------- | ----------------- |
| ACOUSTID_API_KEY        | `src/main/services/lookup/`            | yes               |
| DISCOGS_CONSUMER_KEY    | `src/main/services/lookup/`            | yes               |
| DISCOGS_CONSUMER_SECRET | `src/main/services/lookup/`            | yes               |
| FIXLIB_DEMO_STAGES      | `src/main/index.ts` (development only) | yes               |
| FIXLIB_DEMO_STAGE_MS    | `src/main/index.ts` (development only) | yes               |

The packaged app ignores `.env` files.
