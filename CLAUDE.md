@AGENTS.md

<!--
Maintainer notes (block comments are stripped from Claude's context):
- AGENTS.md is the tool-agnostic rulebook. Only Claude Code-specific guidance lives here.
- Keep this file under 120 lines. Procedures go to .claude/skills, file-type rules to .claude/rules with `paths`.
-->

# Claude Code guide: FixLibrary

## Snapshot

- FixLibrary: Mac desktop app that cleans a DJ music library and hands the result to Rekordbox. Stage: idea, scaffold only.
- Stack: Electron (electron-vite) · React 19 · TypeScript strict · Tailwind v4 · Zustand · SQLite/Drizzle · Python sidecar (Essentia, Demucs) · GitHub Releases.
- The truth lives in docs/: PRD (what and why), DESIGN_SYSTEM (how it looks), ARCHITECTURE (where code goes), SECURITY, TASKS. Read them as AGENTS.md §02 says; do not restate them here.
- Task detail lives in docs/source/fixlibrary-fejlesztesi-terv.md (Hungarian, about 2000 lines): read only the section of the task you are working on, by its number.

## Commands

`npm run dev` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run test:e2e` · `npm run build`

Node 22 is required; if `node --version` is older, run `nvm use` first.

## Harness map: use these instead of improvising

| When                                            | Use                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| After a feature, before a PR                    | `/review-changes` (project rules + subagents)                    |
| Hunting correctness bugs in a diff              | bundled `/code-review`; security pass: `/security-review`        |
| Fixing a bug or an issue                        | `/fix-issue <number or description>`                             |
| Building a task from docs/TASKS.md              | the `new-feature` skill: `/new-feature T-004`                    |
| Cutting a release                               | `/release <version>`, only when I ask                            |
| Independent review                              | subagents `code-reviewer`, `security-auditor`, `design-reviewer` |
| Broad code search                               | built-in `Explore` subagent (keeps your context clean)           |
| UI work                                         | the `ui-component` skill loads for renderer files                |
| Library docs (Electron, Drizzle, electron-vite) | the `context7` MCP server                                        |
| Proving a change works in the running app       | bundled `/verify` (after `/run-skill-generator` ran once)        |

## Working agreements (Claude Code)

- Plan first (plan mode or a written plan) when a task touches more than 5 files or anything in docs/ARCHITECTURE.md §08.
- Track multi-step work in the task list, one item in progress at a time.
- Verify before saying done: `npm run typecheck` and the relevant tests. Say what you ran.
- Hooks in .claude/hooks enforce safety. If one blocks you, do not work around it: say what you wanted to run and why.
- Only change .claude/**, .mcp.json or CLAUDE.md when the task is about the harness itself.
- A convention I correct twice belongs in AGENTS.md or .claude/rules, not only in auto memory: propose the edit.

## Gotchas

- IDE terminals export `ELECTRON_RUN_AS_NODE=1`; Electron then starts as plain Node and `npm run dev` shows no window. Run it as `env -u ELECTRON_RUN_AS_NODE npm run dev`. The e2e test already strips the variable.
- The preload is sandboxed: it can import `electron` and `@shared/*` only. Any other runtime import breaks the window silently.
- A `.d.ts` next to a same-named `.ts` is ignored by TypeScript (`src/preload/index.d.ts` is only seen through tsconfig.web.json).
- The renderer root is `src/renderer/`, not `src/renderer/src/`. Aliases: `@/` → `src/renderer`, `@shared/` → `src/shared`.
