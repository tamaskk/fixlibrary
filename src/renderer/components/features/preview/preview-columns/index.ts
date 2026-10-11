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
  return COLUMNS_BY_BATCH_TYPE[batchType] ?? RUN_COLUMNS
}
