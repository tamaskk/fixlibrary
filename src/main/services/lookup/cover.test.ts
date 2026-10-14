import { describe, expect, it } from 'vitest'
import type { LookupResult } from './chain'
import { findCover, songLikeness, type CoverCandidate, type CoverQuery } from './cover'
import { LookupError } from './http'
import { createITunesClient, type ITunesClient, type ITunesSong } from './itunes'
import { httpOver, memoryCache } from './lookup.test-util'

const RELEASE_MBID = 'f5ec3e4a-36ff-4a36-8dd0-a1c3a54b8a5b'
const ARTWORK = 'https://is3-ssl.mzstatic.com/image/thumb/Music/a/600x600bb.jpg'
const DISCOGS_IMAGE = 'https://i.discogs.com/abc/R-1.jpeg'
const QUERY: CoverQuery = { artist: 'Daft Punk', title: 'Around the World', mix: null }

const MATCHED: LookupResult = {
  confidence: 0.9,
  matched: true,
  acoustId: null,
  musicbrainzRecordingId: null,
  musicbrainzReleaseId: RELEASE_MBID,
  discogsImage: DISCOGS_IMAGE,
  answered: ['musicbrainz', 'discogs'],
  failed: []
}

function itunesWith(songs: ITunesSong[] | Error): { itunes: ITunesClient; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    itunes: {
      search: async (artist, title) => {
        asked.push(`${artist}|${title}`)
        if (songs instanceof Error) throw songs
        return songs
      }
    }
  }
}

async function all(candidates: AsyncIterable<CoverCandidate>): Promise<CoverCandidate[]> {
  const found: CoverCandidate[] = []
  for await (const candidate of candidates) found.push(candidate)
  return found
}

describe('where a cover is looked for', () => {
  it('tries iTunes, then the Cover Art Archive, then Discogs', async () => {
    // Arrange
    const { itunes } = itunesWith([
      { artist: 'Daft Punk', title: 'Around the World', artwork: ARTWORK }
    ])

    // Act
    const search = findCover(QUERY, itunes, async () => MATCHED)

    // Assert
    expect(await all(search.candidates)).toEqual([
      { source: 'itunes', url: ARTWORK },
      {
        source: 'coverartarchive',
        url: `https://coverartarchive.org/release/${RELEASE_MBID}/front-1200`
      },
      { source: 'discogs', url: DISCOGS_IMAGE }
    ])
  })

  it('does not look the track up while iTunes has a cover that is taken', async () => {
    // Arrange
    const { itunes } = itunesWith([
      { artist: 'Daft Punk', title: 'Around the World', artwork: ARTWORK }
    ])
    let lookups = 0
    const search = findCover(QUERY, itunes, async () => {
      lookups += 1
      return MATCHED
    })

    // Act
    for await (const candidate of search.candidates) {
      expect(candidate.source).toBe('itunes')
      break
    }

    // Assert
    expect(lookups).toBe(0)
  })

  it('takes no iTunes song whose artist or title is less than 80% alike', async () => {
    // Arrange
    const { itunes } = itunesWith([
      { artist: 'Daft Punk', title: 'One More Time', artwork: ARTWORK },
      { artist: 'Daft Punks Tribute Band', title: 'Around the World', artwork: ARTWORK },
      { artist: 'Daft Punk', title: 'Around the World', artwork: null }
    ])

    // Act
    const search = findCover(QUERY, itunes, async () => null)

    // Assert
    expect(await all(search.candidates)).toEqual([])
  })

  it('takes nothing from a lookup that is not sure enough', async () => {
    // Arrange
    const { itunes } = itunesWith([])

    // Act
    const search = findCover(QUERY, itunes, async () => ({
      ...MATCHED,
      confidence: 0.69,
      matched: false
    }))

    // Assert
    expect(await all(search.candidates)).toEqual([])
  })

  it('asks iTunes nothing without an artist and a title, and goes on to the lookup', async () => {
    // Arrange
    const { itunes, asked } = itunesWith([])

    // Act
    const search = findCover(
      { artist: null, title: 'Around the World', mix: null },
      itunes,
      async () => ({
        ...MATCHED,
        discogsImage: null
      })
    )

    // Assert
    expect((await all(search.candidates)).map((candidate) => candidate.source)).toEqual([
      'coverartarchive'
    ])
    expect(asked).toEqual([])
  })

  it('notes the sources that could not be asked, and goes on', async () => {
    // Arrange
    const { itunes } = itunesWith(new LookupError('itunes', 'unreachable'))

    // Act
    const search = findCover(QUERY, itunes, async () => ({
      ...MATCHED,
      failed: [{ source: 'discogs', failure: 'busy' }]
    }))
    const found = await all(search.candidates)

    // Assert
    expect(found.map((candidate) => candidate.source)).toEqual(['coverartarchive', 'discogs'])
    expect([...search.failed].sort()).toEqual(['discogs', 'itunes'])
  })
})

describe('how alike an iTunes song is to the track', () => {
  it('knows the track by its title with the mix in brackets, as iTunes names it', () => {
    // Act
    const likeness = songLikeness(
      { artist: 'Bicep', title: 'Glue', mix: 'Extended Mix' },
      { artist: 'Bicep', title: 'Glue (Extended Mix)', artwork: ARTWORK }
    )

    // Assert
    expect(likeness).toBe(1)
  })

  it('is the lesser of artist and title', () => {
    // Act
    const likeness = songLikeness(QUERY, {
      artist: 'Daft Punk',
      title: 'Harder Better Faster Stronger',
      artwork: ARTWORK
    })

    // Assert
    expect(likeness).toBeLessThan(0.5)
  })
})

describe('the iTunes client', () => {
  it('asks for five songs and gives their covers at 600 px', async () => {
    // Arrange
    const { http, requests } = httpOver([
      {
        body: {
          resultCount: 3,
          results: [
            {
              artistName: 'Daft Punk',
              trackName: 'Around the World',
              artworkUrl100: 'https://is3-ssl.mzstatic.com/image/thumb/Music/a/100x100bb.jpg'
            },
            {
              artistName: 'Daft Punk',
              trackName: 'Around the World (Radio Edit)',
              artworkUrl100: 'https://example.com/image/100x100bb.jpg'
            },
            { trackName: 'no artist' }
          ]
        }
      }
    ])
    const itunes = createITunesClient({ http, cache: memoryCache() })

    // Act
    const songs = await itunes.search('Daft Punk', 'Around the World')

    // Assert
    expect(songs).toEqual([
      { artist: 'Daft Punk', title: 'Around the World', artwork: ARTWORK },
      { artist: 'Daft Punk', title: 'Around the World (Radio Edit)', artwork: null }
    ])
    const asked = new URL(requests[0]?.url ?? '')
    expect(`${asked.origin}${asked.pathname}`).toBe('https://itunes.apple.com/search')
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      term: 'Daft Punk Around the World',
      entity: 'song',
      limit: '5'
    })
  })

  it('asks once for the same artist and title', async () => {
    // Arrange
    const { http, requests } = httpOver([{ body: { results: [] } }])
    const itunes = createITunesClient({ http, cache: memoryCache() })
    await itunes.search('Daft Punk', 'Around the World')

    // Act
    await itunes.search('Daft Punk', 'Around the World')

    // Assert
    expect(requests).toHaveLength(1)
  })

  it('reports an answer it cannot read', async () => {
    // Arrange
    const { http } = httpOver([{ body: { results: 'none' } }])
    const itunes = createITunesClient({ http, cache: memoryCache() })

    // Act
    const songs = itunes.search('Daft Punk', 'Around the World')

    // Assert
    await expect(songs).rejects.toEqual(new LookupError('itunes', 'invalid'))
  })
})
