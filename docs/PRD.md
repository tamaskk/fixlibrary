# PRD: FixLibrary

Status: Draft · Last updated: 2026-10-11

Full product spec (Hungarian): `docs/source/fixlibrary-dokumentacio.md`. Task-level plan: `docs/source/fixlibrary-fejlesztesi-terv.md`. Where this file and the sources disagree, ask.

## 01 Product overview

| Field        | Value                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product name | FixLibrary                                                                                                                                                                                                           |
| Tagline      | Clean a DJ library and hand it to Rekordbox                                                                                                                                                                          |
| Description  | A Mac desktop app that renames, tags, sorts, analyses, cues and normalizes a DJ's music files, then writes a Rekordbox XML the DJ imports. Every change is shown in a batch preview and applied only after approval. |
| Stage        | Idea                                                                                                                                                                                                                 |
| Platform     | Desktop (macOS, Apple Silicon arm64 only)                                                                                                                                                                            |

## 02 Problem

Today, a DJ with about 3000 tracks has to fix file names, tags, covers, folders, cue points and loudness by hand, track by track, inside Rekordbox and Finder, because downloads arrive with junk names, missing metadata and uneven volume. This costs weeks of manual work, and a library that is still inconsistent on a CDJ at a gig.

## 03 Goal

Help one DJ turn a messy 2700–3000 track library into a consistently named, tagged, sorted, cued and level-matched Rekordbox collection in days of mostly unattended processing, without hand-editing each track.

## 04 Target users

Primary user:

- Who: the owner, a working DJ with a 2700–3000 track library (90–95% MP3, the rest WAV) on an external drive, using Rekordbox 7 and Pioneer CDJ / XDJ / DDJ hardware.
- Trigger: preparing a set and finding duplicate, misnamed, cover-less tracks with no usable cue points.
- Today they use: Rekordbox, Finder renaming, manual tag editing.
- They will switch because: one pipeline does all nine jobs with a preview and undo, and the result lands in Rekordbox.

Secondary users: none.

Not for:

- Other DJs or the public. Single user, unsigned build, no onboarding, no support.
- Windows, Linux or Intel Mac users.
- Users of Serato, Traktor or Engine DJ.

## 05 Core features

| #   | Feature                       | What the user can do                                             | Done when                                                                                                                                                                                                                                          |
| --- | ----------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | File name and tag fixing      | Run lookup and analysis, review a batch preview, approve         | Approved tracks are named `Artist feat. X - Title (Mix) [8A Am - 124 - E7].mp3` with ID3v2.3 artist, title, album, label, year, BPM and key; matches under 70% confidence are flagged; WAV becomes AIFF; duplicates are listed, never auto-deleted |
| F2  | Cover art                     | Let the app find covers, or drop an image on a track             | Every track has an embedded 600×600 JPEG; existing covers of 300×300 or larger are untouched; a styled placeholder is generated when no source matches                                                                                             |
| F3  | Style folders                 | Review the proposed primary style per track                      | Each track sits in its style folder, the genre tag holds the primary style, uncertain tracks are in `Unsorted`, and the XML has matching playlist folders                                                                                          |
| F4  | Energy level                  | Rate 20–30 calibration tracks, then review values                | Every track has a 1–10 energy value relative to its style, in the comment tag and the file name                                                                                                                                                    |
| F5  | Hot cues                      | Run cue detection after Rekordbox analysis, adjust on a waveform | Each track has up to 8 fixed-meaning hot cues (A Start … H Drop 3) snapped to the Rekordbox beatgrid; a missing section leaves its slot empty                                                                                                      |
| F6  | Playlists and recommendations | Create a playlist, add tracks, accept suggestions                | The app shows 10 local and 10 verified online suggestions fitted to the whole playlist; playlists appear in a `Playlists` folder in the XML                                                                                                        |
| F7  | Playlist generator            | Type a prompt or set parameters and an energy curve              | The generated list obeys the hard rules (Camelot-compatible neighbours, at most ±3 BPM steps) and follows the curve within 1.5 energy on average; any track can be swapped                                                                         |
| F8  | Download                      | Paste URLs or search YouTube / SoundCloud                        | The track downloads as MP3 320 into `Inbox`, runs through F1–F4 and F9 automatically, and moves to its style folder after preview approval                                                                                                         |
| F9  | Loudness normalization        | Pick a target, A/B listen, approve                               | Tracks reach the target (default −11 LUFS) without a limiter and never exceed −1.0 dBTP; tracks that would clip are skipped and flagged                                                                                                            |

Key user flow:

1. The user points the app at the library folder; the app scans it.
2. They press "Teljes futtatás"; the app computes F1–F4 and F9 and shows one batch preview.
3. They fix flagged rows and approve; the app writes files and the Rekordbox XML.
4. They import the XML into Rekordbox, let it analyse, and export XML back.
5. The app places hot cues on the Rekordbox grid and writes a second XML to import.

## 06 Success metrics

Measured on the roughly 50-track real test set and the full library.

| Metric                                  | Target                        | Measured by                                      |
| --------------------------------------- | ----------------------------- | ------------------------------------------------ |
| BPM within ±1 of Rekordbox              | ≥ 95% of tracks               | pytest on the real test set against exported XML |
| Key matches Rekordbox                   | ≥ 75% of tracks               | same                                             |
| Primary style matches `styles.csv`      | ≥ 85% of tracks               | test set evaluation                              |
| Hot cues within one bar of `cues.csv`   | ≥ 80% of cues                 | test set evaluation                              |
| First scan of 3000 files                | ≤ 5 minutes                   | manual timing on the external drive              |
| Missing files in Rekordbox after import | 0                             | Rekordbox "Display All Missing Files"            |
| Live test checklist                     | 100% pass on CDJ, XDJ and DDJ | `tests/LIVE_TEST.md`                             |

## 07 Out of scope

- Reading or writing Rekordbox `master.db`. XML only.
- Windows, Linux, Intel Mac builds; Apple notarization or App Store distribution.
- Memory cues, loops, per-section energy curves.
- A limiter or any dynamic processing in normalization.
- Downloading whole playlists; Bandcamp as a download source.
- Automatic deletion of duplicates.
- Accounts, sync, multi-user or cloud features; any UI language other than Hungarian.
- Bundling Claude: the app uses the locally installed, logged-in Claude CLI.

## 08 Open questions

- (assumed — confirm) Typography uses the macOS system fonts instead of bundled Inter / JetBrains Mono.
- (assumed — confirm) Palette, default hot cue hex values and the three-word personality in DESIGN_SYSTEM.md.
- (assumed — confirm) Python code is linted and formatted with ruff.
- (assumed — confirm) React component and page files are PascalCase; all other files kebab-case.
- The spec lists Bandcamp as a download source, the plan excludes it. The plan is followed here.
- Beatport is not a lookup source: its search page refuses the app's own User-Agent with a bot check (found in T-014). The mix name and genre it was meant to add, and the cross-check of an online tempo and key, have no source until an official Beatport API key is asked for. Worth doing?
- Does the 8-cue scheme need per-style variants later, or stay identical for every style?

## 09 Glossary

| Term               | Meaning                                                             | Not to be confused with                      |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------------- |
| Library            | The user's music folder on the external drive                       | Collection (Rekordbox's own database)        |
| Batch              | One run of one or more functions over a set of tracks               | Job (one stage for one track)                |
| Compute phase      | Analysis and lookup that produces proposals; touches no file        | Apply phase                                  |
| Apply phase        | File writes, run only after the batch preview is approved           | Compute phase                                |
| Batch preview      | The table of proposed changes the user edits and approves           | Rekordbox import preview                     |
| In-place mode      | Files are modified where they are, after a backup                   | Clean library mode                           |
| Clean library mode | Work happens on copies in a new folder; originals never change      | In-place mode                                |
| Style              | The app's primary category that decides a track's folder            | Genre (raw value from an online source)      |
| Energy             | 1–10 value relative to the track's own style                        | Loudness (LUFS)                              |
| Hot cue            | One of 8 fixed-meaning slots A–H                                    | Memory cue (not supported)                   |
| Camelot            | Key notation such as `8A`                                           | Musical key (`Am`)                           |
| Inbox              | Folder where downloads and manually added files wait for processing | Unsorted (style folder for uncertain tracks) |
| Sidecar            | The long-running Python process that does all audio work            | Main process (Electron)                      |
