import { describe, expect, it } from 'vitest'
import { checkAcoustIdKey, checkDiscogsKey } from './key-check'

interface Recorded {
  url: string
  method: string
  body: string
  headers: Headers
}

/** A fetch that answers with a canned response and records what was asked. */
function respondWith(status: number, body: string): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = []
  const stub = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      headers: new Headers(init?.headers)
    })
    return new Response(body, { status })
  }) as typeof fetch
  return { fetch: stub, requests }
}

const failing = (async () => {
  throw new TypeError('fetch failed')
}) as typeof fetch

const userAgent = 'FixLibrary/0.0.1 (+https://github.com/tamaskk/fixlibrary)'

describe('checkAcoustIdKey', () => {
  it('reports an unknown key as invalid', async () => {
    // Arrange
    const { fetch } = respondWith(
      400,
      '{"status":"error","error":{"code":4,"message":"invalid API key"}}'
    )

    // Act
    const result = await checkAcoustIdKey('wrong', { userAgent, fetch })

    // Assert
    expect(result).toBe('invalid')
  })

  it('reports a key as valid when the service only objects to the test fingerprint', async () => {
    // Arrange
    const { fetch } = respondWith(
      400,
      '{"status":"error","error":{"code":3,"message":"invalid fingerprint"}}'
    )

    // Act
    const result = await checkAcoustIdKey('good', { userAgent, fetch })

    // Assert
    expect(result).toBe('valid')
  })

  it('reports a key as valid on a normal answer', async () => {
    // Arrange
    const { fetch } = respondWith(200, '{"status":"ok","results":[]}')

    // Act
    const result = await checkAcoustIdKey('good', { userAgent, fetch })

    // Assert
    expect(result).toBe('valid')
  })

  it('sends the key in the request body, with the app user agent, never in the URL', async () => {
    // Arrange
    const { fetch, requests } = respondWith(200, '{"status":"ok","results":[]}')

    // Act
    await checkAcoustIdKey('my-secret-key', { userAgent, fetch })

    // Assert
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url).not.toContain('my-secret-key')
    expect(requests[0]?.body).toContain('client=my-secret-key')
    expect(requests[0]?.headers.get('User-Agent')).toBe(userAgent)
  })

  it.each([
    ['the network fails', failing],
    ['the service has a server error', respondWith(503, 'Service Unavailable').fetch],
    ['the answer is not JSON', respondWith(200, '<html>').fetch],
    [
      'the request was rate limited',
      respondWith(429, '{"status":"error","error":{"code":14,"message":"rate limit exceeded"}}')
        .fetch
    ],
    ['the answer is JSON of an unknown shape', respondWith(200, '[]').fetch],
    ['an error comes without a known code', respondWith(403, '{"status":"error"}').fetch]
  ])('does not judge the key when %s', async (_name, fetch) => {
    // Act
    const result = await checkAcoustIdKey('any', { userAgent, fetch })

    // Assert
    expect(result).toBe('unreachable')
  })
})

describe('redirects', () => {
  it('are refused, so a key is never sent on to another address', async () => {
    // Arrange
    const redirectModes: (RequestRedirect | undefined)[] = []
    const recording = (async (_url: unknown, init?: RequestInit) => {
      redirectModes.push(init?.redirect)
      return new Response('{"status":"ok"}', { status: 200 })
    }) as typeof fetch

    // Act
    await checkAcoustIdKey('key', { userAgent, fetch: recording })
    await checkDiscogsKey('key', 'secret', { userAgent, fetch: recording })

    // Assert
    expect(redirectModes).toEqual(['error', 'error'])
  })
})

describe('checkDiscogsKey', () => {
  it.each([
    [200, 'valid'],
    [401, 'invalid'],
    [403, 'unreachable'],
    [429, 'unreachable'],
    [500, 'unreachable']
  ] as const)('maps HTTP %i to %s', async (status, expected) => {
    // Arrange
    const { fetch } = respondWith(status, '{}')

    // Act
    const result = await checkDiscogsKey('key', 'secret', { userAgent, fetch })

    // Assert
    expect(result).toBe(expected)
  })

  it('sends the key and secret in the Authorization header, never in the URL', async () => {
    // Arrange
    const { fetch, requests } = respondWith(200, '{}')

    // Act
    await checkDiscogsKey('my-key', 'my-secret', { userAgent, fetch })

    // Assert
    expect(requests[0]?.url).not.toMatch(/my-key|my-secret/)
    expect(requests[0]?.headers.get('Authorization')).toBe('Discogs key=my-key, secret=my-secret')
    expect(requests[0]?.headers.get('User-Agent')).toBe(userAgent)
  })

  it('does not judge the key when the network fails', async () => {
    // Act
    const result = await checkDiscogsKey('key', 'secret', { userAgent, fetch: failing })

    // Assert
    expect(result).toBe('unreachable')
  })
})
