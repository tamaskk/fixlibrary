import { asc } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { cues } from './schema'

export type Cue = typeof cues.$inferSelect

/** Every hot cue of every track, by track and slot. */
export function listAllCues(db: AppDatabase): Cue[] {
  return db.select().from(cues).orderBy(asc(cues.trackId), asc(cues.slot)).all()
}
