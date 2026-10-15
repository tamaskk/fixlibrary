// Which new styles a batch creates when it is applied (T-021), worked out the same way
// for the folder and the genre the preview shows (T-022) and for the commit that
// creates them: the first five its rows name, and only as many as the list has room for.
import type { AppDatabase } from '../db/connection'
import { getBatch, listAllBatchItems, type BatchItem } from '../db/batches'
import { listStyles } from '../db/styles'
import { readProposal } from '@shared/preview'
import { MAX_STYLES, newStylesTaken, styleKey } from '@shared/settings'
import { styleDetailsOf } from './stages/style'

/** The new style a row names: only while its first style is still the classification's. */
export function newStyleOf(after: unknown): string | null {
  const field = readProposal(after).fields?.styleId
  return field?.source === 'claude' && field.value === null
    ? (styleDetailsOf(after)?.newPrimary ?? null)
    : null
}

// The rows of a batch that is being applied no longer change, and the batch may hold
// thousands: what they name is read once.
const appliedNames = new WeakMap<AppDatabase, { batchId: number; names: string[] }>()

/**
 * The new styles the rows that are written name, in the order of the batch. Before
 * the approval, the rows the user left in and no stage failed for; from then on,
 * the approved ones, which a failure while writing does not change.
 */
function namesOfBatch(db: AppDatabase, batchId: number): string[] {
  const status = getBatch(db, batchId)?.status
  const written =
    status === 'preview' || status === 'computing'
      ? (item: BatchItem) => !item.excluded && item.error === null
      : (item: BatchItem) => item.approved
  const fixed = status !== 'preview' && status !== 'computing'
  const kept = appliedNames.get(db)
  if (fixed && kept?.batchId === batchId) return kept.names
  const names = listAllBatchItems(db, batchId).flatMap((item) => {
    const name = written(item) ? newStyleOf(item.after) : null
    return name ? [name] : []
  })
  if (fixed) appliedNames.set(db, { batchId, names })
  return names
}

/**
 * Tells, of the new styles a batch names, which it creates: one of the first five
 * that the list has already (it is the list's), or that the list has room for, in the
 * order of the batch. A style it creates is then on the list, so asking again while
 * the batch is written gives the same answer.
 */
export function createsStyle(db: AppDatabase, batchId: number): (name: string) => boolean {
  const stored = new Set(listStyles(db).map((style) => styleKey(style.name)))
  const taken = newStylesTaken(namesOfBatch(db, batchId)).map(styleKey)
  const room = Math.max(0, MAX_STYLES - stored.size)
  const created = new Set([
    ...taken.filter((key) => stored.has(key)),
    ...taken.filter((key) => !stored.has(key)).slice(0, room)
  ])
  return (name) => created.has(styleKey(name))
}

/** The names of the new styles a batch creates, as its rows name them. */
export function createdNames(db: AppDatabase, batchId: number): string[] {
  const creates = createsStyle(db, batchId)
  return newStylesTaken(namesOfBatch(db, batchId)).filter(creates)
}
