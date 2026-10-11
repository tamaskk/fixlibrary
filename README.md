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

| Script                            | What it does                                    |
| --------------------------------- | ----------------------------------------------- |
| `npm run dev`                     | Start the app with hot reload                   |
| `npm run build`                   | Type check and build into `out/`                |
| `npm run build:mac`               | Build the arm64 `.dmg` into `release/`          |
| `npm run lint`                    | ESLint                                          |
| `npm run typecheck`               | `tsc --noEmit` for main, preload and renderer   |
| `npm run format` / `format:check` | Prettier                                        |
| `npm run test` / `test:watch`     | Vitest unit tests                               |
| `npm run test:e2e`                | Build, then Playwright against the Electron app |

## License

AGPL-3.0-only. The audio analysis depends on Essentia, which is AGPL-3.0.
