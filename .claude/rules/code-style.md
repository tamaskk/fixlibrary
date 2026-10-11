# Code style

- TypeScript strict. No `any` (use `unknown` and narrow). No `@ts-ignore` or `@ts-expect-error` without a comment explaining why.
- File names: React component and page files PascalCase (`BatchPreviewTable.tsx`); everything else kebab-case (`python-bridge.ts`), including `components/ui` primitives and hooks (`useThing` in `use-thing.ts`).
- Named exports only, except config files whose tool requires a default export (`electron.vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`).
- Imports: `@/` for `src/renderer`, `@shared/` for `src/shared`. No `../../../` chains. Main-process code uses relative imports within `src/main`.
- One function, one job. Name it by what it does (`writeRekordboxXml`, not `handleXml2`).
- Never swallow errors. Catch only where you can handle them or add context; log unexpected errors once. Per-track failures become a `TrackError`, they do not abort the batch.
- Node, Electron main APIs, the file system, child processes and the database are main-process only. Renderer code reaches them through `window.api`.
- Comments explain why, not what. No commented-out code. No TODO without a task id (`T-0NN`).
- Formatting belongs to Prettier; a hook formats every file you edit. Do not hand-format.
