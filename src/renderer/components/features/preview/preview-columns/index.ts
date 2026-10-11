import { ERROR_COLUMNS } from './errors'
import { RUN_COLUMNS } from './run'
import type { PreviewColumn } from './types'

export type { PreviewColumn, PreviewColumnContext, PreviewEditor } from './types'
export { ERROR_COLUMNS }

// One set per kind of batch. The tasks that add a kind (downloads, duplicates,
// loudness) add their columns here; the table itself stays the same.
const COLUMNS_BY_BATCH_TYPE: Readonly<Record<string, readonly PreviewColumn[]>> = {
  run: RUN_COLUMNS
}

/** The columns of the "Változások" tab for a kind of batch. */
export function columnsFor(batchType: string): readonly PreviewColumn[] {
  // The type is a stored string: only a set of its own is looked up, never what
  // every object has.
  return Object.hasOwn(COLUMNS_BY_BATCH_TYPE, batchType)
    ? (COLUMNS_BY_BATCH_TYPE[batchType] ?? RUN_COLUMNS)
    : RUN_COLUMNS
}
