// One request to a lookup service: rate limited, identified, bounded in time and
// size, and answered with JSON or with a LookupError that says nothing a service sent.
import { createRateLimiter, ServiceBusyError, type RateLimiter } from './rate-limiter'

export const LOOKUP_SOURCES = ['acoustid', 'musicbrainz', 'discogs'] as const
export type LookupSource = (typeof LOOKUP_SOURCES)[number]

/**
 * - `unreachable`: no answer (offline, DNS, timeout);
 * - `busy`: the service asked to be left alone (429, 503), or is paused for that;
 * - `refused`: the key was not accepted;
 * - `invalid`: an answer the app cannot use.
 */
export type LookupFailure = 'unreachable' | 'busy' | 'refused' | 'invalid'

/**
 * Why a service gave no answer. The message is the app's own text: it never holds a
 * URL, a header or anything the service sent, so it can be logged as it is.
 */
export class LookupError extends Error {
  constructor(
    readonly source: LookupSource,
    readonly failure: LookupFailure,
    readonly status?: number
  ) {
    super(`${source}: ${failure}${status === undefined ? '' : ` (${status})`}`)
  }
}

export interface LookupHttpOptions {
  /** Identifies the app to the services, as their terms ask. */
  userAgent: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** The longest answer that is read. */
  maxBytes?: number
  now?: () => number
}

export interface LookupRequestOptions {
  signal?: AbortSignal
}

export interface LookupHttp {
  /** The parsed JSON of a 2xx answer. Everything else is a LookupError. */
  json: (
    source: LookupSource,
    url: string,
    init: {
      method: 'GET' | 'POST'
      headers?: Record<string, string>
      body?: URLSearchParams
      /**
       * For a service that says what is wrong in the JSON of an error answer: such an
       * answer is returned like any other. Busy and refused answers are not.
       */
      errorsAsJson?: boolean
    },
    options?: LookupRequestOptions
  ) => Promise<unknown>
}

// What each service allows. AcoustID: 3 a second. MusicBrainz: 1 a second. Discogs:
// 60 a minute for requests with a key.
const LIMITS: Record<LookupSource, { cap: number; intervalMs: number }> = {
  acoustid: { cap: 3, intervalMs: 1000 },
  musicbrainz: { cap: 1, intervalMs: 1000 },
  discogs: { cap: 60, intervalMs: 60_000 }
}

// A track asks up to four requests in a row, and its stage has 30 s for all of them.
const DEFAULT_TIMEOUT_MS = 6000
const DEFAULT_MAX_BYTES = 1024 * 1024
// A busy service that names no time, or a time of zero: MusicBrainz sheds load with
// `Retry-After: 0`.
const SHORTEST_PAUSE_MS = 1000
const PAUSE_WITHOUT_HEADER_MS: Record<number, number> = { 429: 60_000, 503: SHORTEST_PAUSE_MS }
const LONGEST_PAUSE_MS = 60 * 60 * 1000

/** How long a service asks to be left alone, from its `Retry-After` header. */
export function retryAfterMs(response: Response, now: number): number {
  const header = response.headers.get('retry-after')?.trim() ?? ''
  let wanted = PAUSE_WITHOUT_HEADER_MS[response.status] ?? SHORTEST_PAUSE_MS
  if (/^\d{1,9}$/.test(header)) wanted = Number(header) * 1000
  else if (header !== '' && !Number.isNaN(Date.parse(header))) wanted = Date.parse(header) - now
  return Math.min(Math.max(wanted, SHORTEST_PAUSE_MS), LONGEST_PAUSE_MS)
}

/** Reads a body of at most `maxBytes`; null when it is longer. */
async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createLookupHttp(
  options: LookupHttpOptions,
  limiters: Record<LookupSource, RateLimiter> = {
    acoustid: createRateLimiter({ ...LIMITS.acoustid, now: options.now }),
    musicbrainz: createRateLimiter({ ...LIMITS.musicbrainz, now: options.now }),
    discogs: createRateLimiter({ ...LIMITS.discogs, now: options.now })
  }
): LookupHttp {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  async function send(
    source: LookupSource,
    url: string,
    init: Parameters<LookupHttp['json']>[2],
    signal: AbortSignal | undefined
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      return await (options.fetch ?? fetch)(url, {
        method: init.method,
        body: init.body,
        headers: { Accept: 'application/json', ...init.headers, 'User-Agent': options.userAgent },
        // A redirect would send a key on to wherever it points.
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
    } catch {
      // Offline, DNS failure, timeout, a redirect: nothing was learned. What the
      // error says is not passed on; it can name the address that was asked.
      throw new LookupError(source, 'unreachable')
    }
  }

  return {
    async json(source, url, init, { signal } = {}) {
      const limiter = limiters[source]
      // One more try after a service was busy; a pause too long to wait for refuses it.
      for (let attempt = 0; ; attempt += 1) {
        let response: Response
        try {
          response = await limiter.schedule(() => send(source, url, init, signal), signal)
        } catch (error) {
          if (error instanceof LookupError) throw error
          if (error instanceof ServiceBusyError) throw new LookupError(source, 'busy')
          throw new LookupError(source, 'unreachable')
        }
        if (response.status === 429 || response.status === 503) {
          await response.body?.cancel().catch(() => {})
          limiter.pauseFor(retryAfterMs(response, now()))
          if (attempt === 0) continue
          throw new LookupError(source, 'busy', response.status)
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => {})
          throw new LookupError(source, 'refused', response.status)
        }
        if (!response.ok && !init.errorsAsJson) {
          await response.body?.cancel().catch(() => {})
          throw new LookupError(source, 'invalid', response.status)
        }
        let text: string | null
        try {
          text = await readBounded(response, maxBytes)
        } catch {
          throw new LookupError(source, 'unreachable')
        }
        if (text === null) throw new LookupError(source, 'invalid', response.status)
        try {
          return JSON.parse(text) as unknown
        } catch {
          throw new LookupError(source, 'invalid', response.status)
        }
      }
    }
  }
}
