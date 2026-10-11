import type * as React from 'react'
import { cn } from '@/lib/cn'
import type { PreviewCell, PreviewValue } from '@shared/preview'
import { defaultFormat, EMPTY } from './diff-text'

type DiffValueProps = {
  cell: PreviewCell
  /** Turns a value into what is shown; the default shows it as it is. */
  format?: (value: PreviewValue) => string | null
  /** For numbers: the Data role, so that columns align. */
  data?: boolean
}

/**
 * A value of a batch preview. A changed one shows the old value struck through in
 * text-muted and the new one in text (DESIGN_SYSTEM §06); the two are marked up as a
 * deletion and an insertion, so the change does not rest on the styling alone.
 */
export function DiffValue({
  cell,
  format = defaultFormat,
  data = false
}: DiffValueProps): React.JSX.Element {
  const before = format(cell.before)
  const after = format(cell.after)
  const role = data ? 'font-mono text-data tabular-nums' : undefined
  if (!cell.changed) {
    return after === null ? (
      <span className="text-text-muted">{EMPTY}</span>
    ) : (
      <span className={cn('truncate', role)}>{after}</span>
    )
  }
  return (
    <span className={cn('flex min-w-0 gap-2', role)}>
      {/* A value that was not there before has nothing to strike through. */}
      {before !== null && (
        // The old value gives way first: the new one is what will be written.
        <del className="min-w-0 shrink-4 truncate text-text-muted line-through">{before}</del>
      )}
      <ins className="min-w-0 truncate no-underline">{after ?? EMPTY}</ins>
    </span>
  )
}
