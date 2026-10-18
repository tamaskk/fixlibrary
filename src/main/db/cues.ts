import { and, asc, eq, notInArray } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { cues } from './schema'

export type Cue = typeof cues.$inferSelect

/** Every hot cue of every track, by track and slot. */
export function listAllCues(db: AppDatabase): Cue[] {
  return db.select().from(cues).orderBy(asc(cues.trackId), asc(cues.slot)).all()
}

/** The hot cues of one track, by slot. */
export function listTrackCues(db: AppDatabase, trackId: number): Cue[] {
  return db.select().from(cues).where(eq(cues.trackId, trackId)).orderBy(asc(cues.slot)).all()
}

export interface NewCue {
  slot: number
  positionMs: number
  name: string
  color: string
}

/**
 * Puts these cues in the place of the track's own, slot by slot: every slot that is
 * not kept is cleared first, so a slot the new cues leave out ends up empty. The
 * kept slots are not touched. Run inside a transaction.
 */
export function replaceTrackCues(
  db: AppDatabase,
  trackId: number,
  next: readonly NewCue[],
  keptSlots: readonly number[]
): void {
  const cleared = and(
    eq(cues.trackId, trackId),
    keptSlots.length > 0 ? notInArray(cues.slot, [...keptSlots]) : undefined
  )
  db.delete(cues).where(cleared).run()
  const written = next.filter((cue) => !keptSlots.includes(cue.slot))
  if (written.length > 0) {
    db.insert(cues)
      .values(written.map((cue) => ({ ...cue, trackId })))
      .run()
  }
}

/** Puts this cue in one slot of a track, or empties the slot with null. */
export function setTrackCue(
  db: AppDatabase,
  trackId: number,
  slot: number,
  cue: Omit<NewCue, 'slot'> | null
): void {
  db.delete(cues)
    .where(and(eq(cues.trackId, trackId), eq(cues.slot, slot)))
    .run()
  if (cue)
    db.insert(cues)
      .values({ ...cue, slot, trackId })
      .run()
}
