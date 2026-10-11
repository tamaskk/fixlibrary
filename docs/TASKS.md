# Tasks

Derived from docs/PRD.md §05 and the 45-task plan. `T-0NN` is task NN in docs/source/fixlibrary-fejlesztesi-terv.md: read its section there (problem, solution, acceptance criteria, tests, dependencies) before starting. Sizes: S ≤ 1 day, M 2–5 days, L 1+ week; split M and L tasks into day-sized slices when you plan them. Tick a box only when AGENTS.md §07 is met. Feature refs: F# from the PRD; `base` = infrastructure.

## Now

Package 1: foundations.

- [ ] T-005 (base, S) External tools: ffmpeg, fpcalc, mp3gain bundled, yt-dlp as a Python module. Built and tested in development. Open: `checkAll()` in the packaged app, which needs the Python runtime of T-041 and the signing fix of T-042.

## Next

Package 2: pipeline frame.

- [ ] T-009 (base, L) Pipeline orchestrator and job queue. Done: the `jobs` table, the stage interface, the queue and the orchestrator (`pipeline/orchestrator.ts`), tested with stand-in stages. Open, in two more pull requests: `job.cancel` in the sidecar, the sleep blocker, the IPC and progress events, taking a run up at startup, `library:run`; then the run panel, the function chooser and the end-to-end test.
- [ ] T-010 (base, M) File operations, backup and undo
- [ ] T-011 (base, L) Batch preview frame
- [ ] T-012 (base, M) Claude CLI service

Package 3: file names and tags. Needs the real test set in `tests/fixtures/real/`.

- [ ] T-013 (F1, M) BPM and key analysis
- [ ] T-014 (F1, L) Fingerprint and online metadata lookup
- [ ] T-015 (F1, M) Name cleaning and file name format
- [ ] T-016 (F1, S) Tag writing (ID3v2.3)
- [ ] T-017 (F1, M) Duplicate detection
- [ ] T-018 (F1, S) WAV to AIFF conversion

Package 4: style and cover. Needs `styles.csv`.

- [ ] T-021 (F3, M) Style classification
- [ ] T-022 (F3, S) Folder organisation and genre / comment tags
- [ ] T-019 (F2, M) Cover lookup and embedding
- [ ] T-020 (F2, S) Placeholder cover and manual replace

Package 5: Rekordbox integration.

- [ ] T-025 (F5, M) Rekordbox XML writer
- [ ] T-026 (F5, S) Rekordbox XML reader
- [ ] T-027 (F5, M) Rekordbox wizard and missing-file cleanup

Package 6: hot cues. Needs `cues.csv`.

- [ ] T-028 (F5, L) Demucs stem separation
- [ ] T-029 (F5, L) Structure detection and cue placement
- [ ] T-030 (F5, L) Waveform cue editor

Package 7: energy.

- [ ] T-023 (F4, M) Energy features
- [ ] T-024 (F4, M) Calibration and the 1–10 scale

Package 8: normalization.

- [ ] T-031 (F9, S) Loudness measurement
- [ ] T-032 (F9, M) Normalization, lossless and exact modes
- [ ] T-033 (F9, M) A/B player and measured values

Package 9: download.

- [ ] T-034 (F8, M) Downloader
- [ ] T-035 (F8, S) Inbox processing

Package 10: playlists.

- [ ] T-036 (F6, M) Similarity engine
- [ ] T-037 (F6, M) Playlist management and local recommendations
- [ ] T-038 (F6, M) Online recommendations
- [ ] T-039 (F7, L) Playlist generator

Package 11: full pipeline.

- [ ] T-040 (base, S) One-button full run

Package 12: packaging.

- [ ] T-041 (base, M) Python runtime packaging
- [ ] T-042 (base, S) DMG build
- [ ] T-043 (base, M) Semi-automatic updates
- [ ] T-044 (base, S) Release workflow

Package 13: live test.

- [ ] T-045 (base, M) Test set run, Rekordbox check and Pioneer USB test

## Later (after v1)

Nothing planned. See docs/PRD.md §07 before proposing anything.

## Done

- [x] T-001 (base, M) Project skeleton: electron-vite, sandboxed typed IPC, Tailwind v4, design tokens, UI primitives, Vitest, Playwright. Not done: the GitHub remote `tamaskk/fixlibrary` is not created yet.
- [x] T-002 (base, S) Python environment spike on M1: Essentia + Demucs via uv and python-build-standalone. Result in `python/SPIKE.md`. Not done: the run on three real tracks compared with Rekordbox BPM and key; do it with T-013 at the latest.
- [x] T-003 (base, M) Python sidecar and bridge: JSON-RPC over stdio, crash recovery. The bridge starts in development only; the packaged Python path comes with T-041.
- [x] T-004 (base, M) Database schema: better-sqlite3 + Drizzle, migrations. The Library table shows the offline state since T-008.
- [x] T-006 (base, M) Settings page and Keychain-backed secrets. Not done: the "Teszt" button was not tried with real keys; the Claude CLI row of the Rendszer section comes with T-012; the packaged-app half of the `.env.local` rule is covered by a unit test only.
- [x] T-007 (base, S) Logging and the skip-and-list error framework. Not done here: a batch that runs past a broken MP3 and lists it on the "Hibák" tab needs the orchestrator (T-009) and the preview (T-011); the stage runner they will use is in place and tested.
- [x] T-008 (base, M) Library scan and track selection: `pipeline/scanner.ts`, `tags.read`, scan at startup, the virtualized track table with search, filters, sorting and selection, `library:list` and `library:run`. Not done: `library:run` only answers with the tracks a run would process, and the function chooser is missing, both until T-009; the cover column shows the cover state, thumbnails come with the cover task (F2); one state icon per row, the icons per function come with the stages; the 5 minute / 30 second scan limits, the unplugged drive and scrolling 3000 real rows were not measured on the real external drive.
