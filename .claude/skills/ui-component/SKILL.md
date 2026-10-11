---
name: ui-component
description: Build or change a React UI component the project's way - design tokens from docs/DESIGN_SYSTEM.md, reuse of the ui primitives, all states, desktop window sizes, keyboard access, Hungarian copy. Use when creating or modifying renderer components or pages.
paths:
  - 'src/renderer/components/**'
  - 'src/renderer/pages/**'
---

# UI component workflow

1. Read docs/DESIGN_SYSTEM.md if you have not in this session. List the primitives in `src/renderer/components/ui`.
2. Reuse, then compose, then create. A new primitive only if nothing fits: ask first, and add it to DESIGN_SYSTEM.md §06 in the same change. If you add one with `npx shadcn@latest add`, restyle it to the tokens.
3. Tokens only (no raw hex, no off-scale spacing). Typography roles from §03; numbers use the Data role.
4. States: default, hover, focus-visible, active, disabled, loading. Data views: loading, empty, error.
5. Desktop: works at 1024×640; tables scroll inside themselves and are virtualized above 100 rows.
6. Accessibility: semantic elements, labels, `aria-label` for icon-only buttons, visible focus ring, AA contrast, keyboard access, no color-only state.
7. Data comes from a Zustand store or `window.api`; a new call is declared in `src/shared/ipc.ts` first. No Node APIs in the renderer.
8. Copy in Hungarian, tone from §01.
9. Verify: `npm run typecheck`; for a critical flow add or extend a Playwright test; if `/verify` is available, look at the window at 1024×640 and 1280×800.
