import type { AppDatabase } from './connection'
import { energyCalibration, tracks } from './schema'

/** What the energy calibration needs of a track. */
export interface CalibrationTrack {
  id: number
  path: string
  artist: string | null
  title: string | null
  primaryStyleId: number | null
  fileSizeBytes: number | null
  fileMtimeMs: number | null
}

/** Every track of the library, as the calibration reads it. */
export function listCalibrationTracks(db: AppDatabase): CalibrationTrack[] {
  return db
    .select({
      id: tracks.id,
      path: tracks.path,
      artist: tracks.artist,
      title: tracks.title,
      primaryStyleId: tracks.primaryStyleId,
      fileSizeBytes: tracks.fileSizeBytes,
      fileMtimeMs: tracks.fileMtimeMs
    })
    .from(tracks)
    .all()
}

/** The user's ratings, by track. */
export function listEnergyRatings(db: AppDatabase): Map<number, number> {
  const rows = db
    .select({ trackId: energyCalibration.trackId, rating: energyCalibration.rating })
    .from(energyCalibration)
    .all()
  return new Map(rows.map((row) => [row.trackId, row.rating]))
}

/** Keeps one rating; a later one of the same track replaces it. */
export function saveEnergyRating(db: AppDatabase, trackId: number, rating: number): void {
  const ratedAt = new Date()
  db.insert(energyCalibration)
    .values({ trackId, rating, ratedAt })
    .onConflictDoUpdate({ target: energyCalibration.trackId, set: { rating, ratedAt } })
    .run()
}
