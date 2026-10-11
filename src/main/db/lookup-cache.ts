import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { AppDatabase } from './connection'
import { lookupCache } from './schema'

export interface LookupCacheOptions {
  /** Entries older than this are treated as missing. Omit to accept any age. */
  maxAgeMs?: number
  now?: Date
}

/** Returns the cached response, validated, or undefined when missing or too old. */
export function getCachedLookup<T>(
  db: AppDatabase,
  source: string,
  queryKey: string,
  schema: z.ZodType<T>,
  options: LookupCacheOptions = {}
): T | undefined {
  const row = db
    .select()
    .from(lookupCache)
    .where(and(eq(lookupCache.source, source), eq(lookupCache.queryKey, queryKey)))
    .get()
  if (row === undefined) return undefined

  const ageMs = (options.now ?? new Date()).getTime() - row.fetchedAt.getTime()
  if (options.maxAgeMs !== undefined && ageMs > options.maxAgeMs) return undefined
  return schema.parse(row.response)
}

export function putCachedLookup(
  db: AppDatabase,
  source: string,
  queryKey: string,
  response: unknown,
  fetchedAt: Date = new Date()
): void {
  db.insert(lookupCache)
    .values({ source, queryKey, response, fetchedAt })
    .onConflictDoUpdate({
      target: [lookupCache.source, lookupCache.queryKey],
      set: { response, fetchedAt }
    })
    .run()
}
