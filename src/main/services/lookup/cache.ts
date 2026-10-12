// What the lookup clients keep of an answer, so that a request is made once.
import type { z } from 'zod'
import type { LookupRequestOptions } from './http'

/** Kept answers by source and query. The database behind it belongs to the caller. */
export interface LookupCache {
  /** The kept answer, or undefined when there is none or it cannot be read. */
  get: <T>(source: string, queryKey: string, schema: z.ZodType<T>) => T | undefined
  put: (source: string, queryKey: string, answer: unknown) => void
}

export interface LookupOptions extends LookupRequestOptions {
  /** Ask the service again, whatever is kept. */
  refresh?: boolean
}

/**
 * The kept answer to a query, or the answer of `ask`, which is then kept. Only an
 * answer is kept: a request that failed is made again the next time.
 */
export async function cachedAnswer<T>(
  cache: LookupCache,
  source: string,
  queryKey: string,
  schema: z.ZodType<T>,
  options: LookupOptions,
  ask: () => Promise<T>
): Promise<T> {
  if (!options.refresh) {
    const kept = cache.get(source, queryKey, schema)
    if (kept !== undefined) return kept
  }
  const answer = await ask()
  cache.put(source, queryKey, answer)
  return answer
}
