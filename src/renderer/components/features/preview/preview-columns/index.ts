import { ERROR_COLUMNS } from './errors'
import { COVER_COLUMN, CUES_COLUMN, FOLDER_COLUMN, RUN_COLUMNS } from './run'
import type { PreviewColumn } from './types'

export type { PreviewColumn, PreviewColumnContext, PreviewEditor } from './types'
export { ERROR_COLUMNS }

// One set per kind of batch. The tasks that add a kind (downloads, duplicates,
// loudness) add their columns here; the table itself stays the same.
const COLUMNS_BY_BATCH_TYPE: Readonly<Record<string, readonly PreviewColumn[]>> = {
  run: RUN_COLUMNS
}

/**
 * The columns of the "Változások" tab for a kind of batch. A batch that sorts files
 * into style folders shows the folder after the file name; one that places hot cues
 * shows them, and one that looked for covers shows those, before the source of its values.
 */
export function columnsFor(
  batchType: string,
  options: { covers?: boolean; folders?: boolean; cues?: boolean } = {}
): readonly PreviewColumn[] {
  // The type is a stored string: only a set of its own is looked up, never what
  // every object has.
  let columns = Object.hasOwn(COLUMNS_BY_BATCH_TYPE, batchType)
    ? (COLUMNS_BY_BATCH_TYPE[batchType] ?? RUN_COLUMNS)
    : RUN_COLUMNS
  // The folder a file goes into, right after its name.
  if (options.folders) {
    const name = columns.findIndex((column) => column.id === 'fileName')
    columns = [...columns.slice(0, name + 1), FOLDER_COLUMN, ...columns.slice(name + 1)]
  }
  // The cues and the cover, in that order, before the source of the values.
  const before = [options.cues ? CUES_COLUMN : null, options.covers ? COVER_COLUMN : null].filter(
    (column): column is PreviewColumn => column !== null
  )
  if (before.length === 0) return columns
  const source = columns.findIndex((column) => column.id === 'source')
  const at = source === -1 ? columns.length : source
  return [...columns.slice(0, at), ...before, ...columns.slice(at)]
}
