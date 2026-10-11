# Security: FixLibrary

Read before changing IPC, file operations, downloads, updates, external process calls, secrets or deletion. Where this file is stricter than AGENTS.md §05, this file wins.

## 01 What we protect

| Data            | Examples                                           | Sensitivity                           | Where stored                                                                                                | Retention                                                                       |
| --------------- | -------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Music library   | MP3, AIFF, WAV files on the external drive         | Irreplaceable to the user             | The library folder; backups in `FixLibrary Backups`                                                         | Originals are never deleted by the app; backups until the next batch is applied |
| Lookup API keys | AcoustID key, Discogs consumer key and secret      | Secret                                | Encrypted with Electron `safeStorage` (macOS Keychain) in the `settings` table; `.env.local` in development | Until the user removes them in Settings                                         |
| App database    | Track metadata, analysis cache, batches, playlists | Low                                   | `~/Library/Application Support/FixLibrary/fixlibrary.db`                                                    | Until the user deletes it                                                       |
| Rekordbox data  | Exported and generated XML                         | Low, but drives the user's collection | Fixed folders set in Settings                                                                               | Overwritten on each export                                                      |
| Logs            | Stage errors, tool output                          | Low; must contain no secrets          | `~/Library/Logs/FixLibrary/`                                                                                | 5 files of 10 MB, rotated                                                       |

There are no accounts and no personal data of other people.

## 02 Trust boundaries

- Renderer → main: untrusted. Every IPC payload is validated with Zod in the handler in `src/main/ipc/`.
- Python sidecar → main: validate RPC results against the types in `src/shared/rpc.ts`. A crash or malformed line never takes the app down.
- Online services (AcoustID, MusicBrainz, Discogs, Beatport, iTunes, Cover Art Archive, GitHub API): untrusted input. Validate before use; never render as HTML.
- `claude` CLI output: untrusted. Validate with the JSON schema and the Zod schema; values are data, never commands or paths.
- Files in the library: untrusted. File names and tags may contain any character; tag text and XML are escaped on write. Tag text read by a scan is cut to one line of at most 500 characters in the sidecar, and the main process refuses anything longer. A scan never follows a link out of the library.
- Downloaded executables and archives (yt-dlp, Python runtime, app updates): untrusted until their SHA-256 matches the published value.

## 03 Authentication and authorization

- There is no login and no session. The only principal is the local macOS user.
- The renderer has no privileges of its own: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a CSP of `default-src 'self'`.
- The preload exposes named functions only. It never exposes `ipcRenderer`, a generic `invoke(channel, …)`, or a function that takes a file path to execute or a command to run.
- An event from the main process reaches the page through a subscribe function of the preload that passes on the payload only; the page never gets the event object or a way to listen on a channel of its choice.
- Navigation and new windows are denied; only `http(s)` links are handed to the OS browser. The window stays on the app's own page (`will-navigate`, `will-redirect` and webviews are blocked), so a dropped file or a changed `location` cannot load another document into the window that holds `window.api`.
- Every IPC handler checks that the call comes from the main frame of the app's own page, and validates its arguments, before it runs.
- Custom protocols (such as the planned `fixlib-audio`) serve only files that belong to a track in the database, resolved by track id, never by a path from the renderer.

## 04 Secrets

- Stored in: `.env.local` during development (gitignored), and encrypted via `safeStorage` in the packaged app. Never in git, never in the renderer, never in logs, never in plain text in the database, never in the `.dmg`.
- The packaged app ignores `.env` files.
- CI and the release workflow need no API keys. Do not add one.
- Rotation: the user regenerates the key at AcoustID or Discogs and re-enters it in Settings.
- What the encryption covers: the database file at rest. A copy or backup of the file, another macOS user, or a process that can only read files does not get the keys. What it does not cover: code running as the same user. The app is ad-hoc signed and not notarized, so such code can start the app's own binary and ask the Keychain itself. The encryption gives confidentiality only: it does not detect a changed ciphertext, which is why each key is encrypted together with its name.
- The Settings page can save, replace, delete and test a key, but never read one back. The "Teszt" request sends the key in the request body (AcoustID) or the `Authorization` header (Discogs), never in a URL, to a fixed host, without following redirects. No second request goes to a service within five seconds, and saving or deleting a key does not reset that.
- `.env.local` is read into memory in development only and is never copied into `process.env`.

## 05 Input, output, injection

- External tools (`yt-dlp`, `ffmpeg`, `fpcalc`, `mp3gain`, `claude`, `python`) are started with `spawn(binary, argsArray)`. No `shell: true`, no `exec` with an interpolated string. A user-controlled value that could start with `-` is preceded by `--` or passed as an option value.
- Paths: every write target is resolved and checked to be inside the library root, the clean library folder, the backup folder, the Inbox, or Electron `userData`. Reject `..` segments and absolute paths from the renderer.
- File names built from metadata replace characters the file system forbids (`/`, `:`) and are length limited.
- Library files change only in the apply phase, through `src/main/services/file-ops.ts`: backup or copy first, write to a temp file in the same folder, rename on success.
- SQL goes through Drizzle with bound parameters. No string-built SQL.
- XML is produced by a serializer that escapes values, never by string templates.
- No `dangerouslySetInnerHTML`. No remote scripts, fonts or styles in the renderer.
- Downloads: single items only (`--no-playlist`), into the Inbox, at most 2 at a time.
- Rate limits: obey each lookup service's published limit and send an identifying User-Agent.

## 06 Dependencies

- New dependency, bundled binary or online service → ask first.
- Bundled binaries are built or fetched at pinned versions by `scripts/fetch-binaries.sh` and checked for the arm64 architecture. Packaging refuses to run if `resources/bin` is missing, incomplete or changed since the script installed it.
- ffmpeg is built without network protocols; yt-dlp is a pinned Python package in the sidecar environment, not a separate download.
- Self-updating components (yt-dlp, Python runtime, app) are installed only after a SHA-256 check against the release manifest or checksum file.
- Essentia is AGPL-3.0; the repository stays AGPL-3.0.

## 07 Incident basics

- Contact: the repository owner (tamaskk).
- A leaked secret: rotate first, then clean the history.
- Looking for what happened: `main.log` and `python.log` in the log folder, which the Settings page opens ("Logmappa megnyitása"). They hold stage errors and tool output, never a key. That rests on rules, not on a filter: a key is sent in a request body or header and never in a URL; code that talks to a service catches its own errors and raises one with fixed text; a request, response or config object is never passed to the logger (an object is written out in full, an `Error` only as its stack). The first lookup client (task 14) adds masking of the stored key values as a second line of defence.
- A bad batch on real files: stop, use "Undo last batch", and do not apply another batch (it would delete the backups) until the cause is understood.
