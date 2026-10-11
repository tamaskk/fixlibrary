# Design System: FixLibrary

Values marked (assumed — confirm) are defaults chosen during bootstrap and listed in PRD §08.

## 01 Brand identity

- Personality: precise, dark, focused (assumed — confirm)
- Tone in UI copy: plain Hungarian, short sentences, informal "te" form, no exclamation marks. DJ terms stay in English (track, playlist, cue, drop, BPM, key).
- Feel: dense and calm, like DJ software. Data first: tables and waveforms, no decoration.
- UI language(s) and locale: hu-HU only. Dates `2026. 10. 11.`, decimal comma (`−11,0 LUFS`), 24-hour time. No currency.
- Reference: Rekordbox 7 (dark, table driven), Linear (density, restraint).

## 02 Color palette

Use tokens in components. Never raw hex values.

| Token                 | Value   | Use                                                 |
| --------------------- | ------- | --------------------------------------------------- |
| --color-bg            | #0B0B0D | Window background                                   |
| --color-surface       | #16161A | Cards, panels, inputs, table header                 |
| --color-surface-hover | #1F1F25 | Hovered and selected rows                           |
| --color-border        | #2A2A31 | Dividers, input borders                             |
| --color-text          | #F2F2F3 | Body text                                           |
| --color-text-muted    | #9A9AA3 | Secondary text, captions                            |
| --color-primary       | #2563EB | Primary button background, focus ring, selection    |
| --color-primary-hover | #3B82F6 | Hover on primary                                    |
| --color-primary-text  | #60A5FA | Links and active text on dark backgrounds           |
| --color-success       | #22C55E | Done states, confirmations                          |
| --color-warning       | #F59E0B | Non-blocking warnings (low confidence, low bitrate) |
| --color-danger        | #DC2626 | Destructive button background, error borders        |
| --color-danger-text   | #F87171 | Error messages on dark backgrounds                  |

Hot cue defaults (editable in Settings; these are the first-run values, assumed — confirm):

| Token         | Value   | Slot               |
| ------------- | ------- | ------------------ |
| --color-cue-a | #22C55E | A Start (green)    |
| --color-cue-b | #22D3EE | B Bassline (aqua)  |
| --color-cue-c | #A855F7 | C Vocal (purple)   |
| --color-cue-d | #EF4444 | D Drop 1 (red)     |
| --color-cue-e | #3B82F6 | E Breakdown (blue) |
| --color-cue-f | #F97316 | F Drop 2 (orange)  |
| --color-cue-g | #EAB308 | G Outro (yellow)   |
| --color-cue-h | #EC4899 | H Drop 3 (pink)    |

Rules:

- One primary color. Accent colors are for state, not decoration. Cue colors appear only on cues. Colors the user picks as data (a style's color) are free and may coincide with a cue color; they are always shown with their hex value.
- Text on any background passes WCAG AA (4.5:1 for body text). Use `--color-primary-text` and `--color-danger-text` for colored text; `--color-primary` and `--color-danger` are backgrounds for white text.
- Dark only in v1. There is no light theme and no `.dark` class; never hard-code a color so a second value set can be added later.
- State is never shown by color alone: pair it with an icon or a label.

## 03 Typography

System fonts, because the app is Mac only and works offline (assumed — confirm).
Sans: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`. Mono: `ui-monospace, "SF Mono", Menlo, monospace`.

| Role  | Font | Size | Weight | Line height                     |
| ----- | ---- | ---- | ------ | ------------------------------- |
| H1    | Sans | 24px | 600    | 1.25                            |
| H2    | Sans | 18px | 600    | 1.3                             |
| H3    | Sans | 15px | 600    | 1.35                            |
| Body  | Sans | 14px | 400    | 1.5                             |
| Small | Sans | 13px | 400    | 1.45                            |
| Label | Sans | 11px | 500    | 1.4, uppercase, 0.04em tracking |
| Data  | Mono | 13px | 400    | 1.45                            |

Rules:

- Numbers in tables (BPM, key, energy, LUFS, time) use the Data role with tabular figures so columns align.
- Headings use tight letter spacing: H1 -0.02em, H2 -0.01em.
- Prose line length stays under 70 characters. Table cells truncate with an ellipsis and show the full value in a tooltip.
- No display sizes: this is a tool, not a landing page.

## 04 Spacing

Base unit: 4px. Only use values from this scale.

| Token    | Value | Typical use                                 |
| -------- | ----- | ------------------------------------------- |
| space-1  | 4px   | Icon gaps                                   |
| space-2  | 8px   | Inside small components, table cell padding |
| space-3  | 12px  | Input padding                               |
| space-4  | 16px  | Default gap between elements                |
| space-6  | 24px  | Card and page padding                       |
| space-8  | 32px  | Between groups                              |
| space-12 | 48px  | Between sections                            |

Layout:

- Fixed left sidebar 220px for page navigation; content fills the rest of the window.
- Table rows are 36px high. Tables fill the available height and scroll inside themselves.
- Page padding space-6. Settings-style forms have a max width of 720px.

## 05 Border radius and shadows

| Token       | Value  | Use                         |
| ----------- | ------ | --------------------------- |
| radius-sm   | 6px    | Inputs, tags, small buttons |
| radius-md   | 8px    | Buttons, dropdowns          |
| radius-lg   | 12px   | Cards, modals               |
| radius-full | 9999px | Pills, energy badges        |

Shadows: one level only, for elevated surfaces (dropdowns, modals).
`0 8px 24px rgba(0, 0, 0, 0.5)`. Flat cards get a border, not a shadow.

## 06 Components

Reuse before creating. Check `src/renderer/components/ui/` first.
If a variant is not listed here, ask before adding it.

Buttons

| Variant   | Background  | Text  | Border | Use                                                        |
| --------- | ----------- | ----- | ------ | ---------------------------------------------------------- |
| Primary   | primary     | white | none   | One per screen, the main action ("Jóváhagyás", "Futtatás") |
| Secondary | surface     | text  | border | Supporting actions                                         |
| Ghost     | transparent | text  | none   | Toolbars, row actions                                      |
| Danger    | danger      | white | none   | Destructive actions, always confirm                        |

- Height 32px, padding 0 12px, radius-md, Small 500.
- States: hover (primary-hover, or surface-hover for secondary and ghost), active (darken 8%), focus (2px primary ring with a 2px bg offset), disabled (50% opacity, no pointer).
- Loading: spinner replaces the label, width stays fixed. The label stays in place for assistive technology.

Inputs

- Height 32px, radius-sm, surface background, border color-border, focus ring primary.
- Label above the field, 11px Label role, always visible. Placeholder is a hint, never the label.
- Error: border danger, message below in danger-text at 13px.
- In a table whose column header already shows the label, the field's own label may be visually hidden (`labelHidden`). It stays in place for assistive technology and names the row ("3. stílus neve"), so rows can be told apart.
- A field that saves when it loses focus also saves on Enter.

Selects

- The native `<select>`, styled like an input: height 32px, radius-sm (it is a form field; radius-md is for custom dropdown panels), surface background, label above. Focus ring and disabled state as for inputs.

Switches

- Track 32×16px, radius-full. Off: surface-hover with a text-muted border, so the control is visible on a surface. On: primary. Thumb 12px in text color.
- The label sits next to the switch, and the whole row (at least 32px high) is the click target. An optional description under the label says what both states mean.
- States: hover (border text when off, primary-hover when on), focus (2px primary ring with a 2px offset), disabled (50% opacity).
- In a table whose column header shows the label, the switch label may be visually hidden, as for inputs.
- For a setting that takes effect at once. A choice between more than two values is a select.

Color inputs

- The system color picker behind a 32px swatch (radius-sm, border; border text-muted on hover), with the hex value next to it in lower case in the Data role, so the choice is never shown by color alone.
- The value is committed when the picker is left, not for every step while choosing.

Icon buttons

- A button that holds only an icon is 32×32px (`size="icon"`), usually Ghost, and always has an `aria-label` that names the row it acts on.

Navigation

- The left sidebar lists the pages as rows of 32px: icon plus label, Small 500, text-muted.
- Current page: surface-hover background, text color and a straight 2px primary left edge, marked with `aria-current="page"`. Focus ring as for buttons.

Status lines

- A state shown as an icon and words together in the Small role: success (check), danger-text (cross), warning (triangle), text-muted (dash). `success` and `warning` may be used as text on bg and surface; both pass AA there.
- A status that appears after an action sits in a `role="status"` element, so it is announced. The element is in the page before the status is, and empty until then: a live region that appears already filled is often not announced.
- The component is `ui/status-line.tsx`.

Settings pages

- One card per section, space-6 between cards (they are parts of one form, not separate sections of a page). The title is an `h2` in the H3 role, with an optional description of at most two lines in Small, text-muted. A longer explanation goes next to what it explains, as a Small caption.
- Saving: a control saves at once (switch, select, color once the picker is left) or when its field is left or Enter is pressed (text, number). The outcome appears in the card header, to the right of the title: the status line "Elmentve" for four seconds, or the error until the next attempt. The slot takes no extra room, so nothing moves when it appears.
- There is no page-wide save button. The page has no Primary button, with two exceptions that never show together: the save button of a list that is edited as a whole (the styles) while it has unsaved changes, next to the warning status "Nem mentett változások", and the retry button of the page's error state.
- Leaving the page with unsaved changes asks for confirmation in a modal. Deleting something the user would have to find again (an API key) asks for confirmation too.
- Folder field: a read-only box (bg background, border, 32px) that can take the focus and is named by its label. It shows the path in the Data role: the parent path truncates, the folder name with its slash never does. While the box has the focus the whole path is spelled out under it; it is also in the tooltip. "(alapérték)" follows a path that is the default. The folder is chosen with a Secondary button; a Ghost button of fixed width removes the choice, and keeps its place when there is nothing to remove, so rows align.
- A table of fields uses `role="table"` rows with a header row in the Label role. Column widths are multiples of space-8.
- Text inside a native `<option>` cannot take the Data role; numbers there use the hu-HU format only.

Tables

- Virtualized for anything that can exceed 100 rows. Sticky header on surface.
- Selected row: surface-hover background with a 2px primary left edge.
- Changed values in a batch preview: old value struck through in text-muted, new value in text.
- Row status uses an icon plus a tooltip: done (success), missing (text-muted), error (danger-text).
- Columns: fixed columns are multiples of 32px wide and the text columns share the rest. Each fixed column is wide enough for its header with the sort arrow (a header never truncates). The columns shown fit the window without sideways scrolling; the least needed column (the file format of a track) is left out while the table is narrower than 896px, so the text columns keep their room at the minimum window, and stays whenever the table is sorted by it. A table narrower than its columns scrolls sideways inside itself. The state of a row is its first column, so it never scrolls out of sight. Numbers are right-aligned in the Data role; an empty value is an en dash in text-muted.
- Sorting: a column header that sorts is a button in the Label role. The sorted column is in text color with an up or down arrow and `aria-sort`; a third click removes the sorting. Rows without a value in the sorted column come last in both directions.
- Selection: click selects a row, Shift + click the range from the last clicked row, Cmd + click adds or removes one row. With the table focused: arrows, Page Up, Page Down, Home and End move and select, Shift extends, Cmd + A selects every row shown, Escape clears. The row the keys move from has a 1px border outline while the table has the focus. A search or filter that hides a selected row takes it out of the selection. A row that cannot be processed (offline, file missing) is in text-muted.
- A row is surface on hover. A table has a 1px border and radius-lg, and never shrinks below 192px in height. A secondary column (the file format) is in the Small role and text-muted.
- The column template of a table is a constant in its component, in whole pixels; it is the one place where sizes are not Tailwind classes, because the virtualizer positions the rows itself.
- A table is a `role="grid"` that takes the focus as a whole (2px primary ring), with `aria-rowcount` for all rows, not only the ones in the page.
- Above the table: search and filters as labelled fields in one row, with the number of rows on the right (`shown / all` when a filter hides some). Below it, the selection bar: the number of selected rows on the left; on the right the choice of what to run, as a labelled select, and the actions, Secondary before Primary. With nothing to choose from, the select and the actions are disabled and the select says so. The answer to an action appears as a status line under the bar.
- When a search or a filter leaves no row, the table gives way to an empty state with a Secondary "Szűrők törlése" button.

Cards

- Surface background, radius-lg, padding space-6, 1px color-border. No shadow.

Modals

- Max width 480px, radius-lg, overlay rgba(0, 0, 0, 0.6).
- Close on overlay click and on Escape, except while an apply phase is running.
- Buttons sit at the bottom right: the one that cancels on the left, the one that confirms on the right. The confirming button is Danger when it deletes or discards. Focus starts on the cancelling button.

Progress

- Pipeline runs show a percent bar, counts per stage, elapsed time and an estimate. A library scan, which takes seconds to a few minutes, shows its phase, counts and percent only. Never an indeterminate spinner for work longer than 3 seconds.
- The bar (`ui/progress-bar.tsx`) is 4px high, radius-full, surface-hover with a primary fill, and is always named for assistive technology. The percent and the counts stand next to it in the Data role.
- Work with no known end (finding the files of a scan) shows a rising count instead of a bar.
- Run panel: a card with padding space-4 at the top of the page, only while a run is active. A heading in the H3 role says the phase and whether it runs or is paused; "Szünet" or "Folytatás" (Secondary) and "Megszakítás" (Danger, with a confirmation) sit to its right. Under the bar, in one wrapping row: finished and all steps with the percent, the elapsed time as a clock, the time left in words ("kb. 12 perc"), and the number of errors as a danger status line. Under that, the steps per function in text-muted. The elapsed time does not run while the run is paused.
- While the run panel is shown, the note about the last scan is hidden, and the run buttons of the selection bar are disabled. When the run has ended, a status line says how in the place of the panel.

Empty states

- One line saying what belongs here, plus one primary action. Never a blank panel.

## 07 Icons

- Set: Lucide. One set only.
- Sizes: 16px inline with text and in buttons, 20px standalone.
- Stroke width 1.75.
- An icon is never the only label on an action. Add text or an aria-label.

## 08 Window sizes

Desktop only. There are no mobile breakpoints.

| Name    | Window width | Notes                                                           |
| ------- | ------------ | --------------------------------------------------------------- |
| min     | 1024px       | Minimum window size is 1024×640. Every screen works here first. |
| default | 1280px       | Default window size 1280×800                                    |
| wide    | 1600px+      | Tables gain columns; side panels may sit next to the table      |

Rules:

- No horizontal scrolling of the page. Wide tables scroll horizontally inside themselves.
- Click targets are at least 28px high.
- Everything reachable by mouse is reachable by keyboard; batch preview shortcuts are arrows, Space, Enter.

## 09 Motion

- Duration: 150ms for micro interactions, 250ms for panels and modals. No page transitions.
- Easing: ease-out when entering, ease-in when leaving.
- Respect prefers-reduced-motion: disable non-essential animation.
- Progress bars update at most 4 times per second.

## 10 Implementation

- Tokens live in `src/renderer/styles/globals.css` as CSS variables with the exact names above, exposed to Tailwind through `@theme` (Tailwind v4). This file and globals.css change in the same commit.
- Primitives live in `src/renderer/components/ui/` (shadcn/ui restyled with these tokens).
- Class names are joined with `cn` from `src/renderer/lib/cn.ts`, never with the bare `cn` package (ESLint refuses it). The package reads an unknown `text-…` class as a text color and drops it when a real color follows; the project's own knows the font sizes of §03. A font size added to globals.css is added to that file too, and a test compares the two.
- Layout widths are tokens too: `--container-sidebar` (220px), `--container-form` (720px), `--container-modal` (480px).
- Cue colors in the UI come from Settings at runtime; the `--color-cue-*` tokens are only the defaults.
- Anything not defined here: ask before inventing it.
