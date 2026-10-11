/**
 * Reads a value at most once per `maxAgeMs` and hands out the last one in between.
 * For something that is asked for many times in a row and is costly or slow to read,
 * where an answer a moment old is as good as a new one.
 */
export function createTimedCache<T>(
  read: () => T,
  maxAgeMs: number,
  now: () => number = Date.now
): () => T {
  let cached: { value: T; at: number } | null = null
  return () => {
    const time = now()
    if (cached === null || time - cached.at >= maxAgeMs) cached = { value: read(), at: time }
    return cached.value
  }
}
