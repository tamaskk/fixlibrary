# Tasks

Derived from docs/PRD.md §05 and the 45-task plan. `T-0NN` is task NN in docs/source/fixlibrary-fejlesztesi-terv.md: read its section there (problem, solution, acceptance criteria, tests, dependencies) before starting. Sizes: S ≤ 1 day, M 2–5 days, L 1+ week; split M and L tasks into day-sized slices when you plan them. Tick a box only when AGENTS.md §07 is met. Feature refs: F# from the PRD; `base` = infrastructure.

## Now

Package 1: foundations.

- [ ] T-002 (base, S) Python environment spike on M1: Essentia + Demucs via uv and python-build-standalone
- [ ] T-003 (base, M) Python sidecar and bridge: JSON-RPC over stdio, crash recovery
- [ ] T-004 (base, M) Database schema: better-sqlite3 + Drizzle, migrations
- [ ] T-005 (base, S) External binaries: yt-dlp, ffmpeg, fpcalc, mp3gain
- [ ] T-006 (base, M) Settings page and Keychain-backed secrets
- [ ] T-007 (base, S) Logging and the skip-and-list error framework

## Next

Package 2: pipeline frame.

- [ ] T-008 (base, M) Library scan and track selection
- [ ] T-009 (base, L) Pipeline orchestrator and job queue
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
