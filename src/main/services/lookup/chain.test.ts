import { describe, expect, it } from 'vitest'
import type { AcoustIdMatch } from './acoustid'
import { lookupTrack, type LookupClients, type LookupInput } from './chain'
import type { DiscogsRelease } from './discogs'
import { LookupError } from './http'
import type { MusicBrainzRecording } from './musicbrainz'

const ACOUSTID = '9ff43b6a-4f16-427c-93c2-92307ca505e0'
const MBID = '59d61a60-0a62-4004-b0d5-8c55fa62ddbe'
const OTHER_MBID = 'cd2e7c47-16f5-46c6-a37c-a1eb7bf599ff'

const RECORDING: MusicBrainzRecording = {
  id: MBID,
  title: 'Around the World',
  artist: 'Daft Punk',
  durationS: 227,
  year: 1997,
  album: 'Homework'
}
const MATCH: AcoustIdMatch = {
  acoustId: ACOUSTID,
  score: 0.95,
  recordings: [{ id: MBID, title: 'Around the World', artist: 'Daft Punk', durationS: 227 }]
}
const RELEASE: DiscogsRelease = {
  title: 'Daft Punk - Around The World',
  year: 1996,
  label: 'Virgin'
}

const TAGGED: LookupInput = {
  fingerprint: { fingerprint: 'AQAAfp', duration: 227 },
  durationS: 227,
  artist: 'Daft Punk',
  title: 'Around the World',
  fileName: 'x.mp3'
}

interface Answers {
  acoustid?: AcoustIdMatch[] | null | Error
  recording?: MusicBrainzRecording | null | Error
  search?: MusicBrainzRecording[] | Error
  discogs?: DiscogsRelease[] | null | Error
}

function clientsWith(answers: Answers): { clients: LookupClients; asked: string[] } {
  const asked: string[] = []
  const give = async <T>(what: string, answer: T | Error): Promise<T> => {
    asked.push(what)
    if (answer instanceof Error) throw answer
    return answer
  }
  return {
    asked,
    clients: {
      acoustid: {
        lookup: () => give('acoustid', answers.acoustid === undefined ? [] : answers.acoustid)
      },
      musicbrainz: {
        recording: (id) => give(`recording:${id}`, answers.recording ?? null),
        search: (artist, title) => give(`search:${artist}|${title}`, answers.search ?? [])
      },
      discogs: {
        search: (artist, title) =>
          give(`discogs:${artist}|${title}`, answers.discogs === undefined ? [] : answers.discogs)
      }
    }
  }
}

describe('lookupTrack', () => {
  it('asks AcoustID, then MusicBrainz about its best match, then Discogs', async () => {
    // Arrange
    const { clients, asked } = clientsWith({
      acoustid: [MATCH],
      recording: RECORDING,
      discogs: [RELEASE]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(asked).toEqual(['acoustid', `recording:${MBID}`, 'discogs:Daft Punk|Around the World'])
    expect(result).toEqual({
      // 0.6 × 0.95 + 0.3 × 1 + 0.1 × 1
      confidence: expect.closeTo(0.97, 5),
      matched: true,
      artist: { value: 'Daft Punk', source: 'musicbrainz' },
      title: { value: 'Around the World', source: 'musicbrainz' },
      album: { value: 'Homework', source: 'musicbrainz' },
      year: { value: 1997, source: 'musicbrainz' },
      label: { value: 'Virgin', source: 'discogs' },
      acoustId: ACOUSTID,
      musicbrainzRecordingId: MBID,
      answered: ['acoustid', 'musicbrainz', 'discogs'],
      failed: []
    })
  })

  it('asks MusicBrainz about the recording that is named most like the track', async () => {
    // Arrange
    const match: AcoustIdMatch = {
      ...MATCH,
      recordings: [
        { id: OTHER_MBID, title: 'Da Funk', artist: 'Daft Punk', durationS: 330 },
        ...MATCH.recordings
      ]
    }
    const { clients, asked } = clientsWith({ acoustid: [match], recording: RECORDING })

    // Act
    await lookupTrack(TAGGED, clients)

    // Assert
    expect(asked[1]).toBe(`recording:${MBID}`)
  })

  it('searches MusicBrainz by text when the fingerprint has no match', async () => {
    // Arrange
    const { clients, asked } = clientsWith({
      acoustid: [],
      search: [{ ...RECORDING, id: OTHER_MBID, title: 'Around the World (Live)' }, RECORDING]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(asked.slice(0, 2)).toEqual(['acoustid', 'search:Daft Punk|Around the World'])
    // 0.75 × 1 + 0.25 × 1: the better of the two that were found.
    expect(result).toMatchObject({
      matched: true,
      confidence: 1,
      musicbrainzRecordingId: MBID,
      acoustId: null
    })
  })

  it('searches by text as well when the match by fingerprint is not sure enough', async () => {
    // Arrange: a good fingerprint, but a recording without a length and tags that
    // differ from its name, which keeps the first candidate below 70%.
    const { clients, asked } = clientsWith({
      acoustid: [{ ...MATCH, score: 0.8 }],
      recording: { ...RECORDING, id: OTHER_MBID, title: 'Rollin and Scratchin', durationS: null },
      search: [RECORDING]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(asked.slice(0, 3)).toEqual([
      'acoustid',
      `recording:${MBID}`,
      'search:Daft Punk|Around the World'
    ])
    expect(result).toMatchObject({ matched: true, musicbrainzRecordingId: MBID, acoustId: null })
  })

  it('keeps the match by fingerprint when the text search finds nothing surer', async () => {
    // Arrange
    const { clients } = clientsWith({
      acoustid: [{ ...MATCH, score: 0.5 }],
      recording: RECORDING,
      search: [{ ...RECORDING, id: OTHER_MBID, title: 'Something Else', durationS: 90 }]
    })

    // Act
    const result = await lookupTrack({ ...TAGGED, durationS: null }, clients)

    // Assert: 0.6 × 0.5 + 0.3 × 1 + 0.1 × 0
    expect(result.confidence).toBeCloseTo(0.6)
    expect(result.matched).toBe(false)
  })

  it('asks about the best match that names a recording', async () => {
    // Arrange
    const { clients, asked } = clientsWith({
      acoustid: [{ acoustId: ACOUSTID, score: 0.99, recordings: [] }, MATCH],
      recording: RECORDING
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(asked[1]).toBe(`recording:${MBID}`)
    expect(result.matched).toBe(true)
  })

  it('stops, instead of going on to the next source, when it was given up', async () => {
    // Arrange
    const controller = new AbortController()
    controller.abort()
    const { clients, asked } = clientsWith({ acoustid: new LookupError('acoustid', 'unreachable') })

    // Act
    const lookup = lookupTrack(TAGGED, clients, { signal: controller.signal })

    // Assert
    await expect(lookup).rejects.toBeInstanceOf(LookupError)
    expect(asked).toEqual(['acoustid'])
  })

  it('goes straight to the text search without a fingerprint, by the file name if need be', async () => {
    // Arrange
    const { clients, asked } = clientsWith({ search: [RECORDING] })
    const untagged: LookupInput = {
      fingerprint: null,
      durationS: 227,
      artist: null,
      title: null,
      fileName: 'Daft Punk - Around the World.mp3'
    }

    // Act
    const result = await lookupTrack(untagged, clients)

    // Assert
    expect(asked[0]).toBe('search:Daft Punk|Around the World')
    expect(result.matched).toBe(true)
  })

  it('takes nothing from a candidate below 70%: the tags stay', async () => {
    // Arrange
    const { clients } = clientsWith({
      acoustid: [],
      search: [{ ...RECORDING, title: 'Something Else Entirely', artist: 'Nobody', durationS: 90 }]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(result.matched).toBe(false)
    expect(result.confidence).toBeLessThan(0.7)
    expect(result).not.toHaveProperty('artist')
    expect(result).not.toHaveProperty('title')
    expect(result.musicbrainzRecordingId).toBeNull()
  })

  it('finds nothing for a track nobody knows', async () => {
    // Arrange
    const { clients } = clientsWith({ acoustid: [], search: [], discogs: [] })
    const invented: LookupInput = { ...TAGGED, artist: 'Xq Zzyzx', title: 'Nonexistent Tune 9000' }

    // Act
    const result = await lookupTrack(invented, clients)

    // Assert
    expect(result).toMatchObject({ matched: false, confidence: 0, failed: [] })
  })

  it('takes a good fingerprint match even when the tags of the file are junk', async () => {
    // Arrange
    const { clients } = clientsWith({ acoustid: [{ ...MATCH, score: 0.99 }], recording: RECORDING })
    const junk: LookupInput = { ...TAGGED, artist: null, title: null, fileName: 'around world.mp3' }

    // Act
    const result = await lookupTrack(junk, clients)

    // Assert
    expect(result.matched).toBe(true)
    expect(result.title).toEqual({ value: 'Around the World', source: 'musicbrainz' })
  })

  it('takes the year from Discogs only when MusicBrainz has none', async () => {
    // Arrange
    const { clients } = clientsWith({
      acoustid: [MATCH],
      recording: { ...RECORDING, year: null },
      discogs: [RELEASE]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(result.year).toEqual({ value: 1996, source: 'discogs' })
  })

  it('takes no label from a Discogs release that is another release', async () => {
    // Arrange
    const { clients } = clientsWith({
      acoustid: [MATCH],
      recording: RECORDING,
      discogs: [{ title: 'Various - Summer Hits 97', year: 1997, label: 'Sampler Records' }]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(result.matched).toBe(true)
    expect(result).not.toHaveProperty('label')
  })

  it('takes artist and title from Discogs when nothing else names the track', async () => {
    // Arrange
    const { clients } = clientsWith({
      acoustid: [],
      search: [],
      discogs: [{ title: 'Daft Punk (2) - Around The World', year: 1997, label: 'Virgin' }]
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(result).toMatchObject({
      matched: true,
      // 0.75 × 1: Discogs knows no length of a track.
      confidence: 0.75,
      artist: { value: 'Daft Punk', source: 'discogs' },
      title: { value: 'Around The World', source: 'discogs' },
      label: { value: 'Virgin', source: 'discogs' },
      year: { value: 1997, source: 'discogs' },
      musicbrainzRecordingId: null
    })
  })

  it('goes on with the other sources when one cannot be asked', async () => {
    // Arrange
    const { clients, asked } = clientsWith({
      acoustid: new LookupError('acoustid', 'busy', 429),
      search: [RECORDING],
      discogs: new LookupError('discogs', 'unreachable')
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(asked).toEqual([
      'acoustid',
      'search:Daft Punk|Around the World',
      'discogs:Daft Punk|Around the World'
    ])
    expect(result).toMatchObject({
      matched: true,
      answered: ['musicbrainz'],
      failed: [
        { source: 'acoustid', failure: 'busy' },
        { source: 'discogs', failure: 'unreachable' }
      ]
    })
  })

  it('leaves out a source that has no key, without counting it as failed', async () => {
    // Arrange
    const { clients } = clientsWith({ acoustid: null, search: [RECORDING], discogs: null })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(result).toMatchObject({ matched: true, answered: ['musicbrainz'], failed: [] })
  })

  it('reports that no source could be asked', async () => {
    // Arrange
    const { clients } = clientsWith({
      acoustid: new LookupError('acoustid', 'unreachable'),
      search: new LookupError('musicbrainz', 'unreachable'),
      discogs: new LookupError('discogs', 'unreachable')
    })

    // Act
    const result = await lookupTrack(TAGGED, clients)

    // Assert
    expect(result).toMatchObject({ matched: false, answered: [] })
    expect(result.failed.map((entry) => entry.source)).toEqual([
      'acoustid',
      'musicbrainz',
      'discogs'
    ])
  })

  it('does not swallow an error that is no failure of a service', async () => {
    // Arrange
    const { clients } = clientsWith({ acoustid: new TypeError('a bug') })

    // Act
    const lookup = lookupTrack(TAGGED, clients)

    // Assert
    await expect(lookup).rejects.toThrow('a bug')
  })
})
