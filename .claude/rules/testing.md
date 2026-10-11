---
paths:
  - '**/*.test.{ts,tsx}'
  - '**/*.spec.{ts,tsx}'
  - 'tests/**'
  - 'python/tests/**'
  - 'vitest.config.*'
  - 'playwright.config.*'
---

# Testing

- Unit tests (Vitest) cover logic in `src/main/pipeline/`, `src/main/services/` and `src/shared/`, next to the source as `<name>.test.ts`. Python logic is covered by pytest in `python/tests/`. End-to-end tests (Playwright driving Electron, in `tests/e2e/`) only for the critical flows in docs/PRD.md §05.
- Structure every test as Arrange-Act-Assert, with a blank line between the three parts.
- Default to state-based (Chicago school) tests: real domain objects, assertions on outputs and state. Mock only at the boundaries: the Python bridge, external binaries, the `claude` CLI (a fake script on PATH), HTTP (recorded responses), the clock, randomness.
- File-operation tests run in a temp directory and compare sha256 before and after. They never touch a path outside it.
- Test names state the behaviour: `skips a track that would clip above -1 dBTP`.
- A bug fix starts with a failing test that reproduces the bug.
- No network in unit tests. Audio fixtures are generated (`tests/fixtures/synthetic/`); tests that need `tests/fixtures/real/` skip themselves when it is absent and never run in CI.
- Deterministic tests: fixed time (`vi.useFakeTimers`, `vi.setSystemTime`), seeded data, no order dependence.
- E2E launches the built app with `ELECTRON_RUN_AS_NODE` removed from the environment (see `tests/e2e/app.spec.ts`).
- Commands: `npm run test` (unit), `npm run test:e2e` (build + e2e), `uv run pytest` from `python/` (planned, task 2). A task is not done while tests fail.
