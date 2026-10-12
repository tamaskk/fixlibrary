import type * as React from 'react'
import type { EditablePreviewField, PreviewRow } from '@shared/preview'

/** What a cell may need beyond its row. */
export interface PreviewColumnContext {
  styleNames: ReadonlyMap<number, string>
  /** True from the width on at which the table shows its wide-only columns. */
  wide: boolean
}

/** How a cell is edited in place. */
export type PreviewEditor = 'text' | 'style' | 'energy' | 'key'

/**
 * One column of a batch preview. The table knows nothing about what a column shows:
 * each kind of batch brings its own set, and later tasks add theirs here.
 */
export interface PreviewColumn {
  id: string
  header: string
  /** The grid track of the column, in whole pixels or `minmax(…px, …fr)`. */
  track: string
  /** The least room the column takes, for the width below which the table scrolls. */
  minWidth: number
  numeric?: true
  /** Sets a left-aligned column off from right-aligned numbers before it. */
  indent?: true
  /** Left out while the table is too narrow for it. */
  wideOnly?: true
  /** Set for a column whose cells the user can change in place. */
  edit?: { field: EditablePreviewField; editor: PreviewEditor }
  render: (row: PreviewRow, context: PreviewColumnContext) => React.ReactNode
  /** The whole content as text, for the tooltip of a cell that is cut short. */
  text: (row: PreviewRow, context: PreviewColumnContext) => string | null
}
