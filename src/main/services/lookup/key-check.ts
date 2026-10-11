// One small request per service to learn whether an API key is accepted.
// The full lookup clients arrive with T-014.

export type KeyCheckResult = 'valid' | 'invalid' | 'unreachable'

export interface KeyCheckOptions {
  /** Identifies the app to the service, as their terms ask. */
  userAgent: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const ACOUSTID_LOOKUP_URL = 'https://api.acoustid.org/v2/lookup'
const DISCOGS_SEARCH_URL = 'https://api.discogs.com/database/search?q=test&per_page=1'
// AcoustID error codes: the fingerprint was not understood (the key was accepted),
// and the client key is not known.
const ACOUSTID_INVALID_FINGERPRINT_CODE = 3
const ACOUSTID_INVALID_KEY_CODE = 4

async function request(
  url: string,
  init: RequestInit,
  options: KeyCheckOptions
): Promise<Response | null> {
  try {
    return await (options.fetch ?? fetch)(url, {
      ...init,
      headers: { ...init.headers, 'User-Agent': options.userAgent },
      // A redirect would send the key on to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
  } catch {
    // Offline, DNS failure, timeout: nothing was learned about the key.
    return null
  }
}

/**
 * Sends a lookup with a deliberately meaningless fingerprint. A known key gets an
 * answer about the fingerprint; an unknown key is rejected before that.
 */
export async function checkAcoustIdKey(
  key: string,
  options: KeyCheckOptions
): Promise<KeyCheckResult> {
  // In the body, not the URL, so the key cannot end up in a proxy or server log line.
  const body = new URLSearchParams({
    client: key,
    duration: '1',
    fingerprint: 'AQAAAA',
    format: 'json'
  })
  const response = await request(ACOUSTID_LOOKUP_URL, { method: 'POST', body }, options)
  if (response === null) return 'unreachable'

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return 'unreachable'
  }
  if (typeof payload !== 'object' || payload === null) return 'unreachable'
  const status = 'status' in payload ? payload.status : undefined
  const errorCode =
    'error' in payload ? (payload.error as { code?: unknown } | null)?.code : undefined

  if (errorCode === ACOUSTID_INVALID_KEY_CODE) return 'invalid'
  if (errorCode === ACOUSTID_INVALID_FINGERPRINT_CODE) return 'valid'
  if (response.status === 200 && status === 'ok') return 'valid'
  // Rate limiting, a block, a server error: the key was not judged.
  return 'unreachable'
}

/** Runs the smallest authenticated search. Discogs answers 401 to a wrong key or secret. */
export async function checkDiscogsKey(
  key: string,
  secret: string,
  options: KeyCheckOptions
): Promise<KeyCheckResult> {
  const response = await request(
    DISCOGS_SEARCH_URL,
    { method: 'GET', headers: { Authorization: `Discogs key=${key}, secret=${secret}` } },
    options
  )
  if (response === null) return 'unreachable'
  if (response.status === 200) return 'valid'
  if (response.status === 401) return 'invalid'
  // Rate limited, blocked (Discogs also answers 403 to a user agent it dislikes)
  // or a server error: the key was not judged.
  return 'unreachable'
}
