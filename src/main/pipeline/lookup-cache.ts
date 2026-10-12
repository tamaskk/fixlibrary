// The answers of the lookup services, kept in the `lookup_cache` table.
import type { AppDatabase } from '../db/connection'
import { getCachedLookup, putCachedLookup } from '../db/lookup-cache'
import type { LookupCache } from '../services/lookup/cache'

/** Keeps answers for good: a query is sent again only when the user asks for it. */
export function createLookupCache(db: AppDatabase): LookupCache {
  return {
    get(source, queryKey, schema) {
      try {
        return getCachedLookup(db, source, queryKey, schema)
      } catch {
        // Kept by another version of the app, or damaged: as good as not kept.
        return undefined
      }
    },
    put(source, queryKey, answer) {
      putCachedLookup(db, source, queryKey, answer)
    }
  }
}
