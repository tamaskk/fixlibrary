// The hot cues of a track (T-029): what a batch proposes for them, and how an approved
// proposal becomes the track's cues in the fixed scheme of the Settings.
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { replaceTrackCues } from '../db/cues'
import type { Settings } from '@shared/settings'

/** A lock of one slot, set when the user places that cue by hand (T-030): `cue:4`. */
export function cueLockOf(slot: number): string {
  return `cue:${slot}`
}

/** The entry the cues stage keeps next to its proposal. */
export const cuesEntrySchema = z.object({
  /** The cues found, each on a beat of Rekordbox's grid. */
  slots: z
    .array(
      z.object({
        slot: z.number().int().min(1).max(8),
        positionMs: z.number().int().nonnegative()
      })
    )
    .max(8),
  /** The cues the track had when the batch ran, by their letters, for the preview. */
  before: z.string().nullable()
})

export type CuesEntry = z.output<typeof cuesEntrySchema>

/** The cues entry an item of a batch holds, or null when the batch placed none. */
export function cuesEntryOf(after: unknown): CuesEntry | null {
  const record = z.record(z.string(), z.unknown()).safeParse(after)
  const parsed = cuesEntrySchema.safeParse(record.data?.['cues'])
  return parsed.success ? parsed.data : null
}

/**
 * Writes the approved cues of a track: each slot named and colored as the Settings
 * name and color it, the slots the cues leave out emptied, and the slots the user
 * placed by hand kept as they are. Run inside the transaction of the approval.
 */
export function writeTrackCues(
  db: AppDatabase,
  trackId: number,
  entry: CuesEntry,
  hotCues: Settings['hotCues'],
  lockedFields: readonly string[]
): void {
  const kept = [1, 2, 3, 4, 5, 6, 7, 8].filter((slot) => lockedFields.includes(cueLockOf(slot)))
  replaceTrackCues(
    db,
    trackId,
    entry.slots.flatMap(({ slot, positionMs }) => {
      const scheme = hotCues[slot - 1]
      return scheme ? [{ slot, positionMs, name: scheme.name, color: scheme.color }] : []
    }),
    kept
  )
}
