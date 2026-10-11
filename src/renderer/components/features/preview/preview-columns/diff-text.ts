import type { PreviewCell, PreviewValue } from '@shared/preview'

/** Shown in the place of a value that is not there. */
export const EMPTY = '–'

/** What a cell says as plain text: the value, or the old one and the new one. */
export function diffText(
  cell: PreviewCell,
  format: (value: PreviewValue) => string | null = defaultFormat
): string | null {
  const after = format(cell.after)
  if (!cell.changed) return after
  return `${format(cell.before) ?? EMPTY} → ${after ?? EMPTY}`
}

export function defaultFormat(value: PreviewValue): string | null {
  return value === null ? null : String(value)
}
