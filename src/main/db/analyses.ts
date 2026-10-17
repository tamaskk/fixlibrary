import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { AppDatabase } from './connection'
import { analyses, type ANALYSIS_TYPES } from './schema'

export type AnalysisType = (typeof ANALYSIS_TYPES)[number]

export interface StoredAnalysis<T> {
  result: T
  analyzerVersion: string
}

/** Stores one result per track and type; a newer result replaces the older one. */
export function saveAnalysis(
  db: AppDatabase,
  analysis: { trackId: number; type: AnalysisType; result: unknown; analyzerVersion: string }
): void {
  const createdAt = new Date()
  db.insert(analyses)
    .values({ ...analysis, createdAt })
    .onConflictDoUpdate({
      target: [analyses.trackId, analyses.type],
      set: { result: analysis.result, analyzerVersion: analysis.analyzerVersion, createdAt }
    })
    .run()
}

/** Reads a result and validates it. Throws if the stored JSON does not fit the schema. */
export function getAnalysis<T>(
  db: AppDatabase,
  trackId: number,
  type: AnalysisType,
  schema: z.ZodType<T>
): StoredAnalysis<T> | undefined {
  const row = db
    .select()
    .from(analyses)
    .where(and(eq(analyses.trackId, trackId), eq(analyses.type, type)))
    .get()
  return row && { result: schema.parse(row.result), analyzerVersion: row.analyzerVersion }
}

/** Removes a track's result of this type, if it has one. */
export function deleteAnalysis(db: AppDatabase, trackId: number, type: AnalysisType): void {
  db.delete(analyses)
    .where(and(eq(analyses.trackId, trackId), eq(analyses.type, type)))
    .run()
}

/** Every stored result of one type, by track; as stored, for the caller to check. */
export function listAnalysesOfType(
  db: AppDatabase,
  type: AnalysisType
): Map<number, StoredAnalysis<unknown>> {
  const rows = db
    .select({
      trackId: analyses.trackId,
      result: analyses.result,
      analyzerVersion: analyses.analyzerVersion
    })
    .from(analyses)
    .where(eq(analyses.type, type))
    .all()
  return new Map(
    rows.map((row) => [row.trackId, { result: row.result, analyzerVersion: row.analyzerVersion }])
  )
}
