import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLookupHttp, LookupError, retryAfterMs } from './http'
import { ServiceBusyError } from './rate-limiter'
import { answering, openLimiters, USER_AGENT, type Answer, type Recorded } from './lookup.test-util'

const URL = 'https://musicbrainz.org/ws/2/recording?query=x'

function request(
  answers: Answer[],
  pauses: number[] = []
): { requests: Recorded[]; answer: Promise<unknown> } {
  const { fetch, requests } = answering(answers)
  const http = createLookupHttp({ userAgent: USER_AGENT, fetch }, openLimiters(pauses))
  return { requests, answer: http.json('musicbrainz', URL, { method: 'GET' }) }
}

describe('a request to a lookup service', () => {
  it('returns the JSON of the answer', async () => {
    // Act
    const { answer } = request([{ body: { recordings: [] } }])

    // Assert
    await expect(answer).resolves.toEqual({ recordings: [] })
  })

  it('names the app, and follows no redirect', async () => {
    // Act
    const { answer, requests } = request([{ body: {} }])
    await answer

    // Assert
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('user-agent')).toBe(USER_AGENT)
    expect(requests[0]?.redirect).toBe('error')
  })

  it.each([
    [429, { 'retry-after': '7' }, 7000],
    [429, {}, 60_000],
    [503, { 'retry-after': '0' }, 1000],
    [503, {}, 1000]
  ])(
    'leaves a service that answers %i alone, then asks once more',
    async (status, headers, pause) => {
      // Arrange
      const pauses: number[] = []

      // Act
      const { answer, requests } = request(
        [{ status, body: 'slow down', headers }, { body: { ok: true } }],
        pauses
      )

      // Assert
      await expect(answer).resolves.toEqual({ ok: true })
      expect(requests).toHaveLength(2)
      expect(pauses).toEqual([pause])
    }
  )

  it('gives a service up as busy when it is busy twice', async () => {
    // Act
    const { answer, requests } = request([
      { status: 503, body: '' },
      { status: 503, body: '' }
    ])

    // Assert
    await expect(answer).rejects.toMatchObject({ failure: 'busy', status: 503 })
    expect(requests).toHaveLength(2)
  })

  it.each([
    [401, 'refused'],
    [403, 'refused'],
    [400, 'invalid'],
    [404, 'invalid'],
    [500, 'invalid']
  ])('reports an answer of %i as %s, without asking again', async (status, failure) => {
    // Act
    const { answer, requests } = request([{ status, body: { message: 'no' } }])

    // Assert
    await expect(answer).rejects.toMatchObject({ source: 'musicbrainz', failure, status })
    expect(requests).toHaveLength(1)
  })

  it('reports an answer that is not JSON as invalid', async () => {
    // Act
    const { answer } = request([{ body: '<html>Just a moment...</html>' }])

    // Assert
    await expect(answer).rejects.toMatchObject({ failure: 'invalid' })
  })

  it('reads no more than the longest answer it accepts', async () => {
    // Arrange
    const { fetch } = answering([{ body: JSON.stringify({ text: 'x'.repeat(5000) }) }])
    const http = createLookupHttp({ userAgent: USER_AGENT, fetch, maxBytes: 1000 }, openLimiters())

    // Act
    const answer = http.json('musicbrainz', URL, { method: 'GET' })

    // Assert
    await expect(answer).rejects.toMatchObject({ failure: 'invalid' })
  })

  it('says nothing of what failed when a service cannot be reached', async () => {
    // Arrange
    const cause = new TypeError('fetch failed: https://api.acoustid.org/?client=SECRETKEY123')

    // Act
    const { answer } = request([cause])

    // Assert
    const error = await answer.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LookupError)
    expect((error as LookupError).failure).toBe('unreachable')
    expect((error as LookupError).message).toBe('musicbrainz: unreachable')
    expect(String((error as LookupError).stack)).not.toContain('SECRETKEY123')
  })
})

describe('a request that is not answered in time', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is given up as unreachable', async () => {
    // Arrange
    const never = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    const http = createLookupHttp(
      { userAgent: USER_AGENT, fetch: never, timeoutMs: 2000 },
      openLimiters()
    )

    // Act
    const answer = http.json('musicbrainz', URL, { method: 'GET' })
    const failed = expect(answer).rejects.toMatchObject({ failure: 'unreachable' })
    await vi.advanceTimersByTimeAsync(2500)

    // Assert
    await failed
  })
})

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-12T10:00:00Z')
  const answer = (status: number, header?: string): Response =>
    new Response('', { status, headers: header === undefined ? {} : { 'retry-after': header } })

  it.each([
    ['seconds', answer(429, '30'), 30_000],
    ['a date', answer(429, 'Mon, 12 Oct 2026 10:00:20 GMT'), 20_000],
    ['a date that has passed', answer(429, 'Mon, 12 Oct 2026 09:00:00 GMT'), 1000],
    ['zero', answer(503, '0'), 1000],
    ['nonsense', answer(429, 'soon'), 60_000],
    ['an absurd wait', answer(429, '999999999'), 3_600_000]
  ])('reads %s', (_name, response, expected) => {
    expect(retryAfterMs(response, now)).toBe(expected)
  })
})

describe('the download of a picture', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const CAA = 'https://coverartarchive.org/release/0b5c3b0f-1b6c-4a8a-9f7e-2a7cbe2a2a2a/front-1200'

  function download(
    source: 'itunes' | 'coverartarchive' | 'discogs',
    url: string,
    answers: Answer[]
  ): { requests: Recorded[]; bytes: Promise<Buffer> } {
    const { fetch, requests } = answering(answers)
    const http = createLookupHttp({ userAgent: USER_AGENT, fetch }, openLimiters())
    return { requests, bytes: http.image(source, url) }
  }

  it('returns the bytes, asked as a picture, by the app, without a key', async () => {
    // Act
    const { bytes, requests } = download(
      'itunes',
      'https://is3-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg',
      [{ body: JPEG, headers: { 'content-type': 'image/jpeg' } }]
    )

    // Assert
    expect([...(await bytes)]).toEqual([...JPEG])
    expect(requests[0]?.headers.get('user-agent')).toBe(USER_AGENT)
    expect(requests[0]?.headers.get('accept')).toBe('image/jpeg, image/png')
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    expect(requests[0]?.redirect).toBe('manual')
  })

  it('follows the redirects of the Cover Art Archive to the server that holds the picture', async () => {
    // Act
    const { bytes, requests } = download('coverartarchive', CAA, [
      { status: 307, body: '', headers: { location: 'https://archive.org/download/mbid-x/a.jpg' } },
      {
        status: 302,
        body: '',
        headers: { location: 'https://ia800500.us.archive.org/12/items/mbid-x/a.jpg' }
      },
      { body: JPEG, headers: { 'content-type': 'image/jpeg' } }
    ])

    // Assert
    expect((await bytes).length).toBe(JPEG.length)
    expect(requests.map((request) => new globalThis.URL(request.url).hostname)).toEqual([
      'coverartarchive.org',
      'archive.org',
      'ia800500.us.archive.org'
    ])
  })

  it.each([
    'https://archive.org.example.com/a.jpg',
    'http://archive.org/a.jpg',
    'https://archive.org:8443/a.jpg',
    'https://user@archive.org/a.jpg',
    'file:///etc/passwd'
  ])('asks nothing of a redirect to %s', async (location) => {
    // Act
    const { bytes, requests } = download('coverartarchive', CAA, [
      { status: 302, body: '', headers: { location } },
      { body: JPEG }
    ])

    // Assert
    await expect(bytes).rejects.toEqual(new LookupError('coverartarchive', 'invalid'))
    expect(requests).toHaveLength(1)
  })

  it('gives up after three redirects', async () => {
    // Arrange
    const hop = { status: 302, body: '', headers: { location: 'https://archive.org/again' } }

    // Act
    const { bytes, requests } = download('coverartarchive', CAA, [hop, hop, hop, hop, hop])

    // Assert
    await expect(bytes).rejects.toBeInstanceOf(LookupError)
    expect(requests).toHaveLength(4)
  })

  it.each([
    ['itunes', 'https://is3-ssl.mzstatic.com.example.com/a.jpg'],
    ['itunes', 'https://itunes.apple.com/a.jpg'],
    ['discogs', 'https://api.discogs.com/images/a.jpg'],
    ['discogs', 'http://i.discogs.com/a.jpg']
  ] as const)('asks nothing of %s at %s', async (source, url) => {
    // Act
    const { bytes, requests } = download(source, url, [{ body: JPEG }])

    // Assert
    await expect(bytes).rejects.toEqual(new LookupError(source, 'invalid'))
    expect(requests).toHaveLength(0)
  })

  it('refuses an answer that says it is not a picture', async () => {
    // Act
    const { bytes } = download('discogs', 'https://i.discogs.com/a.jpg', [
      { body: '<html></html>', headers: { 'content-type': 'text/html' } }
    ])

    // Assert
    await expect(bytes).rejects.toEqual(new LookupError('discogs', 'invalid', 200))
  })

  it('refuses an answer that does not say what it is', async () => {
    // Act
    const { bytes } = download('discogs', 'https://i.discogs.com/a.jpg', [{ body: JPEG }])

    // Assert
    await expect(bytes).rejects.toEqual(new LookupError('discogs', 'invalid', 200))
  })

  it('does not wait behind the searches of its service', async () => {
    // Arrange: the iTunes search is held back; its pictures are not.
    const { fetch } = answering([{ body: JPEG, headers: { 'content-type': 'image/jpeg' } }])
    const limiters = {
      ...openLimiters(),
      itunes: {
        schedule: () => Promise.reject(new ServiceBusyError()),
        pauseFor: () => {}
      }
    }
    const http = createLookupHttp({ userAgent: USER_AGENT, fetch }, limiters)

    // Act
    const bytes = http.image('itunes', 'https://is3-ssl.mzstatic.com/a/600x600bb.jpg')

    // Assert
    expect((await bytes).length).toBe(JPEG.length)
  })

  it('reads no more than the largest picture it accepts', async () => {
    // Act
    const { bytes } = download('discogs', 'https://i.discogs.com/a.jpg', [
      { body: new Uint8Array(16 * 1024 * 1024 + 1), headers: { 'content-type': 'image/jpeg' } }
    ])

    // Assert
    await expect(bytes).rejects.toEqual(new LookupError('discogs', 'invalid', 200))
  })

  it('reports a missing picture as invalid', async () => {
    // Act
    const { bytes } = download('coverartarchive', CAA, [{ status: 404, body: 'Not Found' }])

    // Assert
    await expect(bytes).rejects.toEqual(new LookupError('coverartarchive', 'invalid', 404))
  })
})
