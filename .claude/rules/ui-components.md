---
paths:
  - 'src/renderer/**/*.tsx'
  - 'src/renderer/styles/**'
---

# UI components

- Before creating or changing UI, read docs/DESIGN_SYSTEM.md if you have not in this session.
- Tokens only: colors, spacing, radius and typography from DESIGN_SYSTEM.md. No raw hex, no arbitrary values like `p-[13px]`.
- Reuse the `src/renderer/components/ui` primitives first. A new primitive needs approval and a DESIGN_SYSTEM.md §06 entry in the same change. `npx shadcn@latest add <name>` output must be restyled to the tokens before use.
- Every data-driven view has loading, empty and error states.
- Desktop only: works at the 1024×640 minimum window, no horizontal page scroll; wide tables scroll inside themselves. Lists that can exceed 100 rows are virtualized.
- Accessibility: semantic HTML, visible labels, `aria-label` on icon-only buttons, visible focus ring, AA contrast, full keyboard access. State is never shown by color alone.
- Pages are thin: they read stores and call `window.api`. No business rules, no direct `ipcRenderer`, no Node APIs.
- State: Zustand stores in `src/renderer/stores/`, one per domain. The main process is the authority; no optimistic updates.
- UI copy is Hungarian and follows the tone rules in DESIGN_SYSTEM.md §01. Numbers use the Data role and the hu-HU format.
