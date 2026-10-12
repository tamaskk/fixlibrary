# Tasks

Derived from docs/PRD.md §05 and the 45-task plan. `T-0NN` is task NN in docs/source/fixlibrary-fejlesztesi-terv.md: read its section there (problem, solution, acceptance criteria, tests, dependencies) before starting. Sizes: S ≤ 1 day, M 2–5 days, L 1+ week; split M and L tasks into day-sized slices when you plan them. Tick a box only when AGENTS.md §07 is met. Feature refs: F# from the PRD; `base` = infrastructure.

## Now

Package 1: foundations.

- [ ] T-005 (base, S) External tools: ffmpeg, fpcalc, mp3gain bundled, yt-dlp as a Python module. Built and tested in development. Open: `checkAll()` in the packaged app, which needs the Python runtime of T-041 and the signing fix of T-042.

## Next

Package 2: pipeline frame.

Package 3: file names and tags. Needs the real test set in `tests/fixtures/real/`.

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
- [x] T-009 (base, L) Pipeline orchestrator and job queue: the `jobs` table, stages, the queue, the orchestrator, `job.cancel`, the sleep blocker, `library:run` and the `pipeline:*` channels, the run panel and the function chooser. Not done: no real stage exists before T-013, so runs use two stand-in stages that only wait and exist in development only (`FIXLIB_DEMO_STAGES=1`); `job.cancel` within 5 s is proven with a stand-in job, not a real Python method; "no file changed after compute" is proven only with stand-in stages; the sleep assertion (`pmset -g assertions`) was not checked by hand; nothing starts the apply phase before T-011; the rate limiters per lookup service come with T-014.
- [x] T-010 (base, M) File operations, backup and undo: `services/file-ops.ts`, `pipeline/batch-files.ts`, the `batch_files` journal, backups in place, copies in the clean library, atomic writes, the free space check, undo and the pruning of older backups. Not done: no real stage writes yet, so all of it is proven with stand-in stages on generated files in temp folders; the "Undo last batch" button and the message with the needed and free GB come with the preview (T-011), until then nothing in the page can apply or undo a batch; copies are checked by size, not by sha256; nothing was tried on the real external drive (exFAT has no clones, so backups there are real copies).
- [x] T-011 (base, L) Batch preview frame: the typed proposal, `pipeline/preview.ts`, `tracks.locked_fields`, the `preview:*` channels, the "Előnézet" page with the virtualized table, in-place editing, exclusion, filters, the "Változások" and "Hibák" tabs, approval with confirmation, discard, "Utolsó batch visszavonása" and the message with the needed and free GB. Not done: no real stage exists, so every acceptance criterion is proven with the development-only stand-in stages on generated files; only the columns of a run exist (cover, normalization, download and duplicate columns and the "Duplikátumok" tab come with tasks 15, 17, 19, 21, 24, 32, 34); a manual edit is written to the track's row and locked, but into the file's tags only once a tag-writing stage exists (T-015); a batch with only manual edits and no file change cannot be undone; rows are shown in the order of the batch, not sorted; scrolling 3000 rows was measured by a test (rows in the page stay under 60, a jump to the end under a second), not judged by eye on the real machine.
- [x] T-013 (F1, M) BPM and key analysis: `shared/keys.ts` and `fixlib_py/keys.py` (the 24 keys by pitch class), `fixlib_py/analysis/` (decoding with the app's ffmpeg, `analysis.bpm_key` with Essentia, the octave correction), the `bpmKey` stage with its result kept in `analyses` per analyzer version, the tempo range in the "Elemzés" card of Settings, and the BPM and key columns of the batch preview with the key editable by hand; tempo and key reach the track's row when the batch is approved. Not done: the two accuracy criteria (BPM within ±1 of Rekordbox for 95% of tracks, key the same for 75%) are not measured, because there is no real test set yet: `python/tests/test_bpm_key_real.py` is written and skips until `tests/fixtures/real/` holds tracks and their exported Rekordbox XML, and with it the three-track comparison left over from T-002; the audio is decoded by the app's ffmpeg and not by Essentia's `MonoLoader` as the plan says (python/SPIKE.md); only the first 10 minutes of a file are analysed; a worker has no deadline of its own, so a file that made Essentia hang would hold it until the app quits; a key has no confidence in the preview until its strength is compared with real tracks; a batch that only analyses writes no file, so it cannot be undone, and the confirmation of its approval still speaks of files that change; at the minimum window the preview table of a run scrolls sideways inside itself (style and energy are out of view); the Library table shows the tempo with one decimal (`124,0`); a file whose audio was replaced under the same name is not analysed again; nothing was run on the real library or on exFAT.
- [x] T-012 (base, M) Claude CLI service: `services/claude-cli.ts` (finding the command, version and login check, one headless call with no tools, MCP servers, settings or skills), `services/claude-prompts/` (the task type and the style decision), `pipeline/claude.ts` (calls of at most 20 items, one retry for an invalid answer, one more ask for a missing id, `CLAUDE_FAILED`), the usage limit (`CLAUDE_LIMIT`, the `claude` resource held for 15 minutes, the message in the run panel), and the Claude block of the "Rendszer" card with the command chosen by hand and the "Teszt" button. Not done: no stage asks Claude yet, so the 45-track and `CLAUDE_FAILED` criteria are proven at the service with a stand-in `claude` executable, and the limit with a stand-in stage; the tasks for mood, playlist prompts and online recommendations come with their features; "found by the packaged app started from the Finder" needs packaging (T-041, T-042), in development it is proven with a process that gets no shell `PATH`; reaching the real usage limit was not tried; no model, budget limit or `--safe-mode` is passed, the default of the login is used; whether the flags keep out the user's `~/.claude/CLAUDE.md` and whether `@path` in a prompt is expanded in this mode was not verified against the real command (the `@` is escaped either way); one real call with five tracks was made through the service during development, the "Teszt" button itself was tried only against the stand-in.
