// One request to a lookup service: rate limited, identified, bounded in time and
// size, and answered with JSON or a picture, or with a LookupError that says nothing
// a service sent.
import { createRateLimiter, ServiceBusyError, type RateLimiter } from './rate-limiter'

export const LOOKUP_SOURCES = [
  'acoustid',
  'musicbrainz',
  'discogs',
  'itunes',
  'coverartarchive'
] as const
export type LookupSource = (typeof LOOKUP_SOURCES)[number]

/** The services a picture is downloaded from. */
export type ImageSource = 'itunes' | 'coverartarchive' | 'discogs'

// The address of a picture comes from a service's answer, or from where a service
// redirects to: it is fetched only from these hosts, over https.
const IMAGE_HOSTS: Record<ImageSource, RegExp> = {
  itunes: /^is\d{1,2}-ssl\.mzstatic\.com$/,
  // The archive answers a cover by a redirect to the server that holds it.
  coverartarchive:
    /^(?:coverartarchive\.org|archive\.org|[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})?\.archive\.org)$/,
  discogs: /^i\.discogs\.com$/
}

/** True for an address a picture of this service may be downloaded from. */
export function isImageUrl(source: ImageSource, url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return (
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    IMAGE_HOSTS[source].test(parsed.hostname)
  )
}

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
  /**
   * The bytes of a picture, asked without a key. Redirects are followed by hand, a
   * few at most, each only to a host `isImageUrl` accepts for the service.
   */
  image: (source: ImageSource, url: string, options?: LookupRequestOptions) => Promise<Buffer>
}

// What each service allows. AcoustID: 3 a second. MusicBrainz: 1 a second. Discogs:
// 60 a minute for requests with a key. iTunes Search: about 20 a minute. The Cover
// Art Archive names no limit; it is asked as MusicBrainz is.
const LIMITS: Record<LookupSource, { cap: number; intervalMs: number }> = {
  acoustid: { cap: 3, intervalMs: 1000 },
  musicbrainz: { cap: 1, intervalMs: 1000 },
  discogs: { cap: 60, intervalMs: 60_000 },
  itunes: { cap: 20, intervalMs: 60_000 },
  coverartarchive: { cap: 1, intervalMs: 1000 }
}

// A track asks up to four requests in a row, and its stage has 30 s for all of them.
const DEFAULT_TIMEOUT_MS = 6000
const DEFAULT_MAX_BYTES = 1024 * 1024
// A picture: a front image of 1200 px, or a scan somewhat larger. The same limit is
// in fixlib_py/cover.py.
const IMAGE_TIMEOUT_MS = 15_000
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_REDIRECTS = 3
// Pictures come from the servers that hold them, not from the search services: a
// download does not wait behind the searches, and is still kept from a burst.
const IMAGE_LIMIT = { cap: 10, intervalMs: 1000 }
const REDIRECTS = new Set([301, 302, 303, 307, 308])
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
async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
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
  return Buffer.concat(chunks)
}

function limitersFor(now: (() => number) | undefined): Record<LookupSource, RateLimiter> {
  return Object.fromEntries(
    LOOKUP_SOURCES.map((source) => [source, createRateLimiter({ ...LIMITS[source], now })])
  ) as Record<LookupSource, RateLimiter>
}

export function createLookupHttp(
  options: LookupHttpOptions,
  limiters: Record<LookupSource, RateLimiter> = limitersFor(options.now)
): LookupHttp {
  const now = options.now ?? Date.now
  const imageLimiters: Record<ImageSource, RateLimiter> = {
    itunes: createRateLimiter({ ...IMAGE_LIMIT, now: options.now }),
    coverartarchive: createRateLimiter({ ...IMAGE_LIMIT, now: options.now }),
    discogs: createRateLimiter({ ...IMAGE_LIMIT, now: options.now })
  }
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

  /**
   * A 2xx answer of the service, scheduled by its limiter. A busy service is asked
   * once more; anything else that is not 2xx is a LookupError, except what
   * `passes` lets through.
   */
  async function answer(
    source: LookupSource,
    limiter: RateLimiter,
    ask: () => Promise<Response>,
    signal: AbortSignal | undefined,
    passes: (response: Response) => boolean
  ): Promise<Response> {
    // One more try after a service was busy; a pause too long to wait for refuses it.
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await limiter.schedule(ask, signal)
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
      if (!response.ok && !passes(response)) {
        await response.body?.cancel().catch(() => {})
        throw new LookupError(source, 'invalid', response.status)
      }
      return response
    }
  }

  async function body(source: LookupSource, response: Response, limit: number): Promise<Buffer> {
    let bytes: Buffer | null
    try {
      bytes = await readBounded(response, limit)
    } catch {
      throw new LookupError(source, 'unreachable')
    }
    if (bytes === null) throw new LookupError(source, 'invalid', response.status)
    return bytes
  }

  return {
    async json(source, url, init, { signal } = {}) {
      const response = await answer(
        source,
        limiters[source],
        () => send(source, url, init, signal),
        signal,
        () => init.errorsAsJson === true
      )
      const text = (await body(source, response, maxBytes)).toString('utf8')
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new LookupError(source, 'invalid', response.status)
      }
    },

    async image(source, url, { signal } = {}) {
      // One time limit for the whole of it, redirects and body included. It starts
      // with the first request, not while the request waits for its turn.
      const stop = new AbortController()
      const bounded = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      let timer: NodeJS.Timeout | undefined
      const startClock = (): void => {
        timer ??= setTimeout(
          () => stop.abort(new DOMException('The picture took too long', 'TimeoutError')),
          options.timeoutMs ?? IMAGE_TIMEOUT_MS
        )
      }
      try {
        let address = url
        for (let hop = 0; ; hop += 1) {
          if (!isImageUrl(source, address)) throw new LookupError(source, 'invalid')
          const asked = address
          const response = await answer(
            source,
            imageLimiters[source],
            async () => {
              startClock()
              try {
                return await (options.fetch ?? fetch)(asked, {
                  method: 'GET',
                  headers: { Accept: 'image/jpeg, image/png', 'User-Agent': options.userAgent },
                  // Followed by hand below, so every address is checked before it is asked.
                  redirect: 'manual',
                  signal: bounded
                })
              } catch {
                throw new LookupError(source, 'unreachable')
              }
            },
            bounded,
            (response) => REDIRECTS.has(response.status)
          )
          if (REDIRECTS.has(response.status)) {
            await response.body?.cancel().catch(() => {})
            const location = response.headers.get('location')
            if (hop >= MAX_REDIRECTS || location === null || !URL.canParse(location, asked)) {
              throw new LookupError(source, 'invalid', response.status)
            }
            address = new URL(location, asked).href
            continue
          }
          // A picture says what it is; an answer that does not is no picture.
          const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
          if (type !== 'image/jpeg' && type !== 'image/png') {
            await response.body?.cancel().catch(() => {})
            throw new LookupError(source, 'invalid', response.status)
          }
          return await body(source, response, MAX_IMAGE_BYTES)
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
