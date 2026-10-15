# AGENTS.md

Instructions for any AI coding agent working in this project
(Claude Code, Cursor, Codex, Copilot). Read this whole file before doing anything.

## 01 Purpose

FixLibrary is a Mac desktop app (Electron + Python sidecar) that cleans a DJ music library and hands the result to Rekordbox.
Your job is to extend it without breaking what exists, in the style already
established. When in doubt, match what is there.

## 02 Before you start

Do these in order, every session:

1. Read docs/PRD.md for what we are building and what is out of scope.
2. Before any UI work, read docs/DESIGN_SYSTEM.md. Use its tokens.
3. Before any structural, data, pipeline, IPC or Python work, read docs/ARCHITECTURE.md for where code lives and what may touch what.
4. Check `src/renderer/components/ui/` before creating a new component.
5. Look at docs/TASKS.md before proposing new work. The full description of each task is in docs/source/fixlibrary-fejlesztesi-terv.md under the same number.
6. Restate the task in one or two sentences and list the files you expect
   to touch. Wait for a go-ahead if that list is longer than five files.

## 03 General rules

- Follow the design system. If a value is not in DESIGN_SYSTEM.md, ask. Do not invent it.
- Keep responsibilities where ARCHITECTURE.md puts them. No business logic in pages, components or IPC handlers.
- Reuse before creating. Search the codebase for an existing helper or component first.
- Small, focused changes. One task, one branch, one clear diff.
- Do not add dependencies, tables, environment variables, bundled binaries, or online services without asking.
- Do not delete or rewrite working code the task does not require.
- Never "improve" anything listed under intentional decisions in ARCHITECTURE.md.
- Leave the project runnable after every change.
- Never modify, move or delete a music file outside `tests/fixtures/synthetic/` or a temp directory while developing. The real library and `tests/fixtures/real/` are read-only to you.
- No library file changes without an approved batch preview. Compute proposes, apply writes.
- UI text is Hungarian. Code, comments, commits and docs are English.

## 04 Code guidelines

- TypeScript strict. No `any`. No `@ts-ignore` without a comment saying why.
- Functional components, hooks, named exports (config files that the tool requires to default-export are the only exception).
- Validate every external input (IPC payloads, RPC results, CLI output, API responses, XML) with a schema before it reaches pipeline logic.
- Every renderer-to-main call is declared in `src/shared/ipc.ts`. The renderer never gets `ipcRenderer` or Node APIs.
- Spawn external tools with an argument array. Never build a shell command from strings.
- Name things by what they do: `writeRekordboxXml`, not `handleXml2`.
- Comments explain why, not what. Delete commented-out code.
- Every data-driven view handles loading, empty, and error states.
- UI copy follows the tone rules in DESIGN_SYSTEM.md: plain, short, no exclamation marks.
- Tests cover business logic in `src/main/pipeline`, `src/shared` and `python/fixlib_py`. UI tests only for critical flows.
- Python: type hints on public functions; nothing but the RPC writer prints to stdout.
- Formatting is the formatter's job. Run it. Do not argue with it.

## 05 Security and best practices

- Secrets live in `.env.local` (development) or encrypted via the macOS Keychain (packaged app), and are read in the main process only.
  Never log them, never send them to the renderer, never store them in plain text in the database.
- The window keeps `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and the CSP in `index.html`. Do not loosen them.
- Treat file names, tags, downloaded metadata, XML and CLI output as untrusted input: validate, and never interpolate into a command, a path outside the library, or HTML.
- Verify the SHA-256 of anything downloaded and executed (binaries, runtimes, updates).
- Respect the rate limits of the lookup services. Send an identifying User-Agent.
- No change to backup, undo, delete, secret storage or the `claude` CLI flags without explicit approval.
- If docs/SECURITY.md exists, read it before changing IPC, file operations, downloads, updates, secrets or deletion. Where it is stricter than this section, it wins.

## 06 Useful commands

Node 22 is required (`nvm use`).

```
npm install            install dependencies
npm run dev            start the app with hot reload
npm run build          type check and build (must pass before a PR)
npm run build:mac      build the arm64 .dmg into release/
npm run lint           lint
npm run typecheck      type check main, preload and renderer
npm run test           unit tests (Vitest)
npm run test:e2e       build, then end-to-end tests (Playwright + Electron)
npm run format         format the codebase
npm run format:check   check formatting without writing
npx drizzle-kit generate --name <what_changed>   new migration after a schema change
./scripts/fetch-binaries.sh   build ffmpeg and mp3gain, download fpcalc, into resources/bin/ (about 2 minutes)
./scripts/fetch-demucs-weights.sh   download and convert the htdemucs weights into resources/models/ (stem analysis)

uv run pytest          Python tests, from python/
uv run ruff check .    Python lint, from python/
uv run ruff format .   Python format, from python/
```

If a command fails, report the exact output. Do not work around it silently.
In an IDE terminal `ELECTRON_RUN_AS_NODE=1` may be set; unset it before starting Electron by hand.

## 07 Definition of done

A task is done when all of these are true:

- The change does what the task asked, and nothing else.
- Build, lint, typecheck, and tests pass locally (and pytest, if Python changed).
- The task's acceptance criteria in docs/source/fixlibrary-fejlesztesi-terv.md are met, or the unmet ones are named.
- New UI matches DESIGN_SYSTEM.md and works at the 1024×640 minimum window.
- Docs are updated if a structure, a decision, or a component changed; docs/TASKS.md reflects the new status.
- The summary says what changed, what was not done, and what the user should check.

## 08 When to stop and ask

Stop and ask instead of guessing when:

- The task conflicts with the PRD, the design system, or an architectural boundary.
- Two reasonable readings of the task lead to different work.
- The change needs a new dependency, table, secret, binary, or service.
- Something is broken that the task did not mention.
- A step would touch real music files or the user's Rekordbox data.

Ask with the specific question, the options you see, and your recommendation.

## 09 Git workflow

- Never commit to main directly. Branches: feat/<slug>, fix/<issue>-<slug>, chore/<slug>, docs/<slug>.
- Conventional Commits: `type(scope): summary` (feat, fix, refactor, test, docs, chore, perf).
- One logical change per commit. Never commit secrets, .env files, build output or audio files; the one exception is the generated tones in `tests/fixtures/synthetic/` (`scripts/make-synthetic-fixtures.py`).
- Do not push, force-push, rebase shared branches, or merge pull requests unless the user asks.
- Pull request description: what changed, why, how it was verified, screenshots for UI.
