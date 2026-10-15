import { describe, expect, it } from 'vitest'
import { createAcoustIdClient, type AcoustIdClient } from './acoustid'
import { createDiscogsClient, type DiscogsClient } from './discogs'
import { createMusicBrainzClient, type MusicBrainzClient } from './musicbrainz'
import { httpOver, memoryCache, type Answer, type Recorded } from './lookup.test-util'
import { cleanText } from './text'
import { previewValueSchemas } from '@shared/preview'

const ACOUSTID = '9ff43b6a-4f16-427c-93c2-92307ca505e0'
const MBID = '59d61a60-0a62-4004-b0d5-8c55fa62ddbe'
const OTHER_MBID = 'cd2e7c47-16f5-46c6-a37c-a1eb7bf599ff'
const KEY = 'ACOUSTIDKEY123'

// Shaped like the answers of the services; cut down to what the clients read, plus
// a field they do not know.
const ACOUSTID_ANSWER = {
  status: 'ok',
  results: [
    { id: 'not-a-uuid', score: 0.99, recordings: [{ id: MBID }] },
    {
      id: ACOUSTID,
      score: 0.61,
      recordings: [{ id: OTHER_MBID, title: 'Da Funk', artists: [{ id: 'x', name: 'Daft Punk' }] }]
    },
    {
      id: ACOUSTID,
      score: 0.97,
      recordings: [
        {
          id: MBID,
          title: 'Around the World',
          duration: 227,
          artists: [{ name: 'Daft Punk' }],
          releasegroups: [{ title: 'Homework' }]
        },
        { id: 'broken', title: 'Left out' }
      ]
    }
  ]
}

const RECORDING_ANSWER = {
  id: MBID,
  title: 'Around the‮ World',
  length: 226866,
  video: false,
  'first-release-date': '1997-06',
  'artist-credit': [
    { name: 'Daft Punk', joinphrase: ' feat. ', artist: { id: 'x' } },
    { name: 'Somebody', joinphrase: '' }
  ],
  releases: [
    {
      title: 'The Braun MTV Eurochart ’97, Volume 6',
      status: 'Official',
      date: '1997-06',
      'release-group': { 'secondary-types': ['Compilation'] }
    },
    { title: 'Bootleg Mix', status: 'Bootleg', date: '1996' },
    {
      id: 'f5ec3e4a-36ff-4a36-8dd0-a1c3a54b8a5b',
      title: 'Homework',
      status: 'Official',
      date: '1997-01-20',
      'release-group': {}
    },
    { title: 'Homework (reissue)', status: 'Official', date: '2022', 'release-group': {} },
    { status: 'Official' }
  ]
}

describe('the AcoustID client', () => {
  function client(
    answers: Answer[],
    withKey = true
  ): { requests: Recorded[]; cache: ReturnType<typeof memoryCache>; acoustid: AcoustIdClient } {
    const { http, requests } = httpOver(answers)
    const cache = memoryCache()
    const apiKey = (): string | undefined => (withKey ? KEY : undefined)
    return { requests, cache, acoustid: createAcoustIdClient({ http, cache, apiKey }) }
  }

  it('returns the matches of a fingerprint, best first, with their recordings', async () => {
    // Arrange
    const { acoustid } = client([{ body: ACOUSTID_ANSWER }])

    // Act
    const matches = await acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    expect(matches).toEqual([
      {
        acoustId: ACOUSTID,
        score: 0.97,
        recordings: [{ id: MBID, title: 'Around the World', artist: 'Daft Punk', durationS: 227 }]
      },
      {
        acoustId: ACOUSTID,
        score: 0.61,
        recordings: [{ id: OTHER_MBID, title: 'Da Funk', artist: 'Daft Punk', durationS: null }]
      }
    ])
  })

  it('sends the key in the body of the request, never in its address', async () => {
    // Arrange
    const { acoustid, requests } = client([{ body: ACOUSTID_ANSWER }])

    // Act
    await acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    const [request] = requests
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('https://api.acoustid.org/v2/lookup')
    expect(request?.url).not.toContain(KEY)
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
      client: KEY,
      format: 'json',
      meta: 'recordings',
      duration: '227',
      fingerprint: 'AQAAfingerprint'
    })
  })

  it('asks nothing without a key', async () => {
    // Arrange
    const { acoustid, requests } = client([], false)

    // Act
    const matches = await acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    expect(matches).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('asks once: the second lookup of a fingerprint is answered from what was kept', async () => {
    // Arrange
    const { acoustid, requests, cache } = client([{ body: ACOUSTID_ANSWER }])
    const first = await acoustid.lookup('AQAAfingerprint', 227)

    // Act
    const second = await acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    expect(second).toEqual(first)
    expect(requests).toHaveLength(1)
    // The key of the kept answer names neither the API key nor the whole fingerprint.
    expect([...cache.entries.keys()].join()).not.toContain(KEY)
    expect([...cache.entries.keys()].join()).not.toContain('AQAAfingerprint')
  })

  it('keeps "no match" as an answer too', async () => {
    // Arrange
    const { acoustid, requests } = client([{ body: { status: 'ok', results: [] } }])
    await acoustid.lookup('AQAAunknown', 100)

    // Act
    const again = await acoustid.lookup('AQAAunknown', 100)

    // Assert
    expect(again).toEqual([])
    expect(requests).toHaveLength(1)
  })

  it('asks again when told to refresh', async () => {
    // Arrange
    const { acoustid, requests } = client([
      { body: { status: 'ok', results: [] } },
      { body: ACOUSTID_ANSWER }
    ])
    await acoustid.lookup('AQAAfingerprint', 227)

    // Act
    const refreshed = await acoustid.lookup('AQAAfingerprint', 227, { refresh: true })

    // Assert
    expect(refreshed).toHaveLength(2)
    expect(requests).toHaveLength(2)
  })

  it('keeps nothing of a request that failed, and asks again the next time', async () => {
    // Arrange
    const { acoustid, requests } = client([
      { status: 500, body: 'oops' },
      { body: { status: 'ok', results: [] } }
    ])
    const failed = await acoustid.lookup('AQAAfingerprint', 227).catch((error: unknown) => error)

    // Act
    const again = await acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    expect(failed).toMatchObject({ source: 'acoustid', failure: 'invalid' })
    expect(again).toEqual([])
    expect(requests).toHaveLength(2)
  })

  it('reports a key that AcoustID refuses with a 400', async () => {
    // Arrange
    const { acoustid } = client([
      { status: 400, body: { status: 'error', error: { code: 4, message: 'invalid API key' } } }
    ])

    // Act
    const lookup = acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    await expect(lookup).rejects.toMatchObject({ source: 'acoustid', failure: 'refused' })
  })

  it.each([
    ['a key that is not known', { status: 'error', error: { code: 4, message: 'bad' } }, 'refused'],
    ['another error', { status: 'error', error: { code: 3 } }, 'invalid'],
    ['an answer of another shape', { results: 'none' }, 'invalid']
  ])('reports %s', async (_name, body, failure) => {
    // Arrange
    const { acoustid } = client([{ body }])

    // Act
    const lookup = acoustid.lookup('AQAAfingerprint', 227)

    // Assert
    await expect(lookup).rejects.toMatchObject({ source: 'acoustid', failure })
  })
})

describe('text from a service', () => {
  it.each([
    ['half a character', 'A\ud800B', 'AB'],
    ['a private-use character', 'A\ue000B', 'AB'],
    ['a letter that shows as nothing', 'A\u115f\u2800B', 'AB'],
    ['a line break and a direction mark', 'A\n\u202eB', 'A B'],
    ['a decomposed accent', 'Rej\u0301', 'Rej\u0301'.normalize('NFC')]
  ])('is cleaned of %s', (_name, sent, kept) => {
    expect(cleanText(sent)).toBe(kept)
  })

  it('is cut to 300 characters, and is nothing when nothing is left', () => {
    expect(Array.from(cleanText('x'.repeat(5000)) ?? '')).toHaveLength(300)
    expect(cleanText('\ud800\u2800')).toBeNull()
    expect(cleanText(undefined)).toBeNull()
  })

  it('that was cleaned is text the preview accepts', () => {
    const cleaned = cleanText('Bad\ud800 \ue000Title\u202e')

    expect(previewValueSchemas.title.safeParse(cleaned)).toMatchObject({
      success: true,
      data: 'Bad Title'
    })
  })
})

describe('the MusicBrainz client', () => {
  function client(answers: Answer[]): { requests: Recorded[]; musicbrainz: MusicBrainzClient } {
    const { http, requests } = httpOver(answers)
    return { requests, musicbrainz: createMusicBrainzClient({ http, cache: memoryCache() }) }
  }

  it('names a recording: artists joined, text cleaned, the own album before a sampler', async () => {
    // Arrange
    const { musicbrainz, requests } = client([{ body: RECORDING_ANSWER }])

    // Act
    const recording = await musicbrainz.recording(MBID)

    // Assert
    expect(recording).toEqual({
      id: MBID,
      title: 'Around the World',
      artist: 'Daft Punk feat. Somebody',
      durationS: 226.866,
      year: 1997,
      album: 'Homework',
      releaseId: 'f5ec3e4a-36ff-4a36-8dd0-a1c3a54b8a5b'
    })
    expect(requests[0]?.url).toBe(
      `https://musicbrainz.org/ws/2/recording/${MBID}?inc=artist-credits+releases+release-groups&fmt=json`
    )
  })

  it('asks nothing for an id that is none', async () => {
    // Arrange
    const { musicbrainz, requests } = client([])

    // Act
    const recording = await musicbrainz.recording('../../release/1')

    // Assert
    expect(recording).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('keeps "no such recording" as an answer', async () => {
    // Arrange
    const { musicbrainz, requests } = client([{ status: 404, body: { error: 'Not Found' } }])
    const first = await musicbrainz.recording(MBID)

    // Act
    const second = await musicbrainz.recording(MBID)

    // Assert
    expect([first, second]).toEqual([null, null])
    expect(requests).toHaveLength(1)
  })

  it('reports a recording it cannot read', async () => {
    // Arrange
    const { musicbrainz } = client([{ body: { id: MBID, title: '', 'artist-credit': [] } }])

    // Act
    const recording = musicbrainz.recording(MBID)

    // Assert
    await expect(recording).rejects.toMatchObject({ source: 'musicbrainz', failure: 'invalid' })
  })

  it('searches by title and artist as phrases, and leaves out what it cannot read', async () => {
    // Arrange
    const { musicbrainz, requests } = client([
      {
        body: {
          count: 2,
          recordings: [{ ...RECORDING_ANSWER, score: 100 }, { id: 'broken' }, 'nonsense']
        }
      }
    ])

    // Act
    const found = await musicbrainz.search('AC/DC "live"', 'Back\\in Black')

    // Assert
    expect(found.map((recording) => recording.id)).toEqual([MBID])
    const url = new URL(requests[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe('https://musicbrainz.org/ws/2/recording')
    expect(url.searchParams.get('query')).toBe(
      'recording:"Back\\\\in Black" AND artist:"AC/DC \\"live\\""'
    )
    expect(url.searchParams.get('limit')).toBe('5')
  })

  it('searches by title alone when no artist is known, and asks the same search once', async () => {
    // Arrange
    const { musicbrainz, requests } = client([{ body: { recordings: [] } }])
    await musicbrainz.search(null, 'Around the World')

    // Act
    const again = await musicbrainz.search(null, 'AROUND THE WORLD')

    // Assert
    expect(again).toEqual([])
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]?.url ?? '').searchParams.get('query')).toBe(
      'recording:"Around the World"'
    )
  })
})

describe('the Discogs client', () => {
  const credentials = { key: 'DISCOGSKEY123', secret: 'DISCOGSSECRET456' }

  function client(
    answers: Answer[],
    withKeys = true
  ): { requests: Recorded[]; discogs: DiscogsClient } {
    const { http, requests } = httpOver(answers)
    const discogs = createDiscogsClient({
      http,
      cache: memoryCache(),
      credentials: () => (withKeys ? credentials : undefined)
    })
    return { requests, discogs }
  }

  it('returns the releases of a search with their label, year, genres and picture', async () => {
    // Arrange
    const image = 'https://i.discogs.com/x/rs:fit/g:sm/q:90/h:600/w:600/R-1.jpeg'
    const { discogs } = client([
      {
        body: {
          pagination: { items: 4 },
          results: [
            {
              id: 1,
              title: 'Daft Punk - Around The World',
              year: '1997',
              label: ['Virgin', 'EMI'],
              genre: ['Electronic', 'Electronic'],
              style: ['House', 'Disco', 'x'.repeat(61)],
              cover_image: image
            },
            {
              id: 2,
              title: 'Daft Punk - Homework',
              label: [],
              cover_image: 'https://st.discogs.com/images/spacer.gif'
            },
            {
              id: 4,
              title: 'Daft Punk - Da Funk',
              cover_image: 'https://i.discogs.com.example.com/a.jpg'
            },
            { id: 3, year: '1997' }
          ]
        }
      }
    ])

    // Act
    const releases = await discogs.search('Daft Punk', 'Around the World')

    // Assert
    expect(releases).toEqual([
      {
        title: 'Daft Punk - Around The World',
        year: 1997,
        label: 'Virgin',
        genres: ['Electronic'],
        styles: ['House', 'Disco'],
        image
      },
      {
        title: 'Daft Punk - Homework',
        year: null,
        label: null,
        genres: [],
        styles: [],
        image: null
      },
      { title: 'Daft Punk - Da Funk', year: null, label: null, genres: [], styles: [], image: null }
    ])
  })

  it('sends the keys in a header, never in the address', async () => {
    // Arrange
    const { discogs, requests } = client([{ body: { results: [] } }])

    // Act
    await discogs.search('Daft Punk', 'Around the World')

    // Assert
    const [request] = requests
    expect(request?.headers.get('authorization')).toBe(
      'Discogs key=DISCOGSKEY123, secret=DISCOGSSECRET456'
    )
    expect(request?.url).toBe(
      'https://api.discogs.com/database/search?q=Daft+Punk+Around+the+World&type=release&per_page=5'
    )
  })

  it('asks nothing without both keys', async () => {
    // Arrange
    const { discogs, requests } = client([], false)

    // Act
    const releases = await discogs.search('Daft Punk', 'Around the World')

    // Assert
    expect(releases).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('reports keys that are not accepted', async () => {
    // Arrange
    const { discogs } = client([{ status: 401, body: { message: 'Invalid consumer.' } }])

    // Act
    const search = discogs.search('Daft Punk', 'Around the World')

    // Assert
    await expect(search).rejects.toMatchObject({ source: 'discogs', failure: 'refused' })
  })
})

describe('a lookup that may only take what is kept', () => {
  it('asks no service, and counts what is not kept as a service that could not be asked', async () => {
    // Arrange
    const { http, requests } = httpOver([{ body: { recordings: [] } }])
    const cache = memoryCache()
    const musicbrainz = createMusicBrainzClient({ http, cache })
    await musicbrainz.search('Daft Punk', 'Around the World')

    // Act
    const kept = await musicbrainz.search('Daft Punk', 'Around the World', { keptOnly: true })
    const notKept = musicbrainz.search('Daft Punk', 'Da Funk', { keptOnly: true })

    // Assert
    expect(kept).toEqual([])
    await expect(notKept).rejects.toMatchObject({ source: 'musicbrainz', failure: 'unreachable' })
    expect(requests).toHaveLength(1)
  })
})
