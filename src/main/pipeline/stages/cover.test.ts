import { createHash } from 'crypto'
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { listStyles, replaceStyles } from '../../db/styles'
import { getTrackById, insertTracks, type NewTrack, type Track } from '../../db/tracks'
import { createCoverStore, type CoverStore } from '../../services/covers'
import type { LookupClients } from '../../services/lookup/chain'
import { createLookupHttp, LookupError } from '../../services/lookup/http'
import type { ITunesClient, ITunesSong } from '../../services/lookup/itunes'
import {
  answering,
  openLimiters,
  USER_AGENT,
  type Answer,
  type Recorded
} from '../../services/lookup/lookup.test-util'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import { DEFAULT_STYLES } from '@shared/settings'
import type { CoverInspectResult } from '@shared/rpc'
import { createLookupCache } from '../lookup-cache'
import {
  coverDetailsSchema,
  createCoverStage,
  createRedrawPlaceholderStage,
  type CoverStageDependencies
} from './cover'
import type { Stage, StageContext } from './stage'

const ARTWORK = 'https://is3-ssl.mzstatic.com/image/thumb/Music/a/600x600bb.jpg'
const RELEASE_MBID = 'f5ec3e4a-36ff-4a36-8dd0-a1c3a54b8a5b'
const CAA = `https://coverartarchive.org/release/${RELEASE_MBID}/front-1200`
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const SONG: ITunesSong = { artist: 'Daft Punk', title: 'Around the World', artwork: ARTWORK }
const NO_VOLUMES: ReadonlySet<string> = new Set()
/** What the stand-in sidecar puts in a placeholder it draws. */
const DRAWN = 'drawn placeholder'

let testDatabase: TestDatabase
let folder: string
let covers: CoverStore
/** What the stand-in sidecar was asked, in order. */
let calls: { method: string; params: Record<string, unknown> }[]
/** What `cover.inspect` answers. */
let held: CoverInspectResult
/** Downloads the stand-in sidecar refuses to make a cover of. */
let refused: Set<string>
let lookups: number

function stemOf(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

/** Stands in for the sidecar: makes a "cover" of a download by copying its name. */
const python: Pick<PythonBridge, 'call'> = {
  call: (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'cover.inspect') return held
    if (method === 'cover.placeholder') {
      if (refused.has('placeholder')) throw new AppError('PYTHON_ERROR', 'refused')
      if (refused.has('slow placeholder')) throw new AppError('TIMEOUT', 'no answer')
      const stem = stemOf(JSON.stringify(params))
      writeFileSync(join(folder, `${stem}.jpg`), DRAWN)
      return { cover: `${stem}.jpg`, thumb: `${stem}.thumb.jpg` }
    }
    if (method !== 'cover.prepare') throw new Error(`unexpected call: ${method}`)
    const source = String(params['source'])
    if (refused.has(source)) throw new AppError('PYTHON_ERROR', 'cover.prepare: refused')
    const stem = source.replace('.download', '')
    writeFileSync(join(folder, `${stem}.jpg`), 'cover')
    writeFileSync(join(folder, `${stem}.thumb.jpg`), 'thumb')
    return { cover: `${stem}.jpg`, thumb: `${stem}.thumb.jpg`, width: 1200, height: 1200 }
  }) as PythonBridge['call']
}

function itunesWith(songs: ITunesSong[] | Error): ITunesClient & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    search: async (artist, title) => {
      asked.push(`${artist}|${title}`)
      if (songs instanceof Error) throw songs
      return songs
    }
  }
}

/** Lookup clients that know the track by its names, at the release the archive knows. */
function lookupClients(releaseId: string | null = RELEASE_MBID): LookupClients {
  return {
    acoustid: { lookup: async () => [] },
    musicbrainz: {
      recording: async () => null,
      search: async () => {
        lookups += 1
        return [
          {
            id: '59d61a60-0a62-4004-b0d5-8c55fa62ddbe',
            title: 'Around the World',
            artist: 'Daft Punk',
            durationS: 227,
            year: 1997,
            album: 'Homework',
            releaseId
          }
        ]
      }
    },
    discogs: { search: async () => null }
  }
}

function stageOver(
  answers: Answer[],
  itunes: ITunesClient = itunesWith([SONG]),
  clients: LookupClients = lookupClients()
): { stage: Stage; requests: Recorded[] } {
  const { fetch, requests } = answering(answers)
  const http = createLookupHttp({ userAgent: USER_AGENT, fetch }, openLimiters())
  const dependencies: CoverStageDependencies = {
    db: testDatabase.db,
    python: () => python,
    covers,
    cache: createLookupCache(testDatabase.db),
    clients,
    coverClients: { itunes, images: http }
  }
  return { stage: createCoverStage(dependencies), requests }
}

function context(overrides: Partial<StageContext> = {}): StageContext {
  return {
    signal: new AbortController().signal,
    batchId: 1,
    files: null,
    proposal: {},
    ...overrides
  }
}

function trackWith(changes: Partial<NewTrack> = {}): Track {
  const path = changes.path ?? '/Music/daft punk - around the world.mp3'
  const [id] = insertTracks(testDatabase.db, [
    {
      path,
      originalPath: path,
      format: 'mp3',
      artist: 'Daft Punk',
      title: 'Around the World',
      durationMs: 227_000,
      ...changes
    }
  ]) as [number]
  const track = getTrackById(testDatabase.db, id, NO_VOLUMES)
  if (!track) throw new Error('no track')
  return track
}

const picture: Answer = { body: PICTURE, headers: { 'content-type': 'image/jpeg' } }

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  // As the app has them from its first start.
  replaceStyles(testDatabase.db, DEFAULT_STYLES)
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-covers-')))
  covers = createCoverStore(folder)
  calls = []
  held = { cover: null }
  refused = new Set()
  lookups = 0
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the cover stage', () => {
  it('finds a cover on iTunes for a track that has none, without looking the track up', async () => {
    // Arrange
    const { stage, requests } = stageOver([picture])

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    const stem = stemOf(ARTWORK)
    expect(result?.proposal?.fields).toEqual({
      cover: { value: `${stem}.jpg`, source: 'itunes' }
    })
    expect(coverDetailsSchema.parse(result?.proposal?.['cover'])).toEqual({
      thumb: `${stem}.thumb.jpg`,
      before: null
    })
    expect(requests.map((request) => request.url)).toEqual([ARTWORK])
    expect(calls.map((call) => call.method)).toEqual(['cover.inspect', 'cover.prepare'])
    // The download is gone once the cover is made of it.
    expect(readdirSync(folder).sort()).toEqual([`${stem}.jpg`, `${stem}.thumb.jpg`])
    expect(lookups).toBe(0)
  })

  it.each([
    [300, 300],
    [1200, 1000]
  ])('keeps a cover of %i × %i, and asks nothing online', async (width, height) => {
    // Arrange
    held = { cover: { width, height, thumb: null, placeholder: false, other: false } }
    const itunes = itunesWith([SONG])
    const { stage, requests } = stageOver([], itunes)

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result).toBeUndefined()
    expect(requests).toEqual([])
    expect(itunes.asked).toEqual([])
  })

  it.each([
    { width: 299, height: 600, thumb: null, placeholder: false, other: false },
    { width: null, height: null, thumb: null, placeholder: false, other: false }
  ])('replaces a cover that is smaller than 300 × 300 or cannot be read', async (before) => {
    // Arrange
    held = { cover: before }
    const { stage } = stageOver([picture])

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal?.fields?.cover?.source).toBe('itunes')
    expect(coverDetailsSchema.parse(result?.proposal?.['cover']).before).toEqual(before)
  })

  it('looks for the track by the names the batch proposes for it', async () => {
    // Arrange
    const itunes = itunesWith([SONG])
    const { stage } = stageOver([picture], itunes)

    // Act
    await stage.run(
      context({
        proposal: {
          fields: {
            artist: { value: 'Daft Punk', source: 'musicbrainz', confidence: 0.9 },
            title: { value: 'Around the World', source: 'musicbrainz', confidence: 0.9 }
          }
        }
      }),
      trackWith({ artist: 'daft punk ', title: 'around the world (official)' })
    )

    // Assert
    expect(itunes.asked).toEqual(['Daft Punk|Around the World'])
  })

  it('goes on to the Cover Art Archive when the sidecar makes no cover of the iTunes picture', async () => {
    // Arrange
    refused.add(`${stemOf(ARTWORK)}.download`)
    const { stage, requests } = stageOver([
      picture,
      { status: 307, body: '', headers: { location: 'https://archive.org/download/x/a.jpg' } },
      picture
    ])

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal?.fields?.cover).toEqual({
      value: `${stemOf(CAA)}.jpg`,
      source: 'coverartarchive'
    })
    expect(requests.map((request) => new URL(request.url).hostname)).toEqual([
      'is3-ssl.mzstatic.com',
      'coverartarchive.org',
      'archive.org'
    ])
    expect(readdirSync(folder).some((name) => name.endsWith('.download'))).toBe(false)
  })

  it('downloads a picture once: a second run takes the cover it made', async () => {
    // Arrange
    const { stage, requests } = stageOver([picture])
    await stage.run(context(), trackWith())

    // Act
    const again = await stage.run(context(), trackWith({ path: '/Music/other.mp3' }))

    // Assert
    expect(again?.proposal?.fields?.cover?.value).toBe(`${stemOf(ARTWORK)}.jpg`)
    expect(requests).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'cover.prepare')).toHaveLength(1)
  })

  it('downloads the picture of tracks of one release that run together once, and gives it to both', async () => {
    // Arrange
    const { stage, requests } = stageOver([picture, picture])

    // Act
    const [first, second] = await Promise.all([
      stage.run(context(), trackWith()),
      stage.run(context(), trackWith({ path: '/Music/other.mp3' }))
    ])

    // Assert
    const cover = { value: `${stemOf(ARTWORK)}.jpg`, source: 'itunes' }
    expect([first?.proposal?.fields?.cover, second?.proposal?.fields?.cover]).toEqual([
      cover,
      cover
    ])
    expect(requests).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'cover.prepare')).toHaveLength(1)
  })

  it('takes a picture a server will not give for one that is not there, not for a failure', async () => {
    // Arrange: the CDN refuses the iTunes picture; the archive has the cover.
    const { stage } = stageOver([
      { status: 403, body: 'Forbidden' },
      { status: 307, body: '', headers: { location: 'https://archive.org/download/x/a.jpg' } },
      picture
    ])

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal?.fields?.cover?.source).toBe('coverartarchive')
  })

  it('draws a placeholder on the colour of Unsorted when no place has a cover, and says so', async () => {
    // Arrange: iTunes has none, and the archive has no front cover of the release.
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith({ mix: 'Radio Edit' }))

    // Assert
    const spec = { artist: 'Daft Punk', title: 'Around the World (Radio Edit)', color: '#9a9aa3' }
    expect(calls.find((call) => call.method === 'cover.placeholder')?.params).toEqual(spec)
    expect(result?.proposal?.fields?.cover?.source).toBe('placeholder')
    expect(result?.proposal?.warnings).toEqual(['NO_COVER'])
    expect(coverDetailsSchema.parse(result?.proposal?.['cover']).placeholder).toEqual(spec)
  })

  it('draws the placeholder on the colour of the style the batch gives the track', async () => {
    // Arrange
    const tech = listStyles(testDatabase.db).find((style) => style.name === 'Tech House')
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    await stage.run(
      context({ proposal: { fields: { styleId: { value: tech?.id ?? 0, source: 'manual' } } } }),
      trackWith()
    )

    // Assert
    const params = calls.find((call) => call.method === 'cover.placeholder')?.params
    expect(params?.['color']).toBe(tech?.color)
  })

  it("keeps a small cover of the track's own when no place has a better one", async () => {
    // Arrange
    held = { cover: { width: 200, height: 200, thumb: null, placeholder: false, other: false } }
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal).toEqual({ warnings: ['NO_COVER'], cover: null })
    expect(calls.map((call) => call.method)).not.toContain('cover.placeholder')
  })

  it.each([
    { width: null, height: null },
    { width: 6000, height: 6000 }
  ])('keeps a real cover the app does not decode when no place has another (%o)', async (size) => {
    // Arrange
    held = { cover: { ...size, thumb: null, placeholder: false, other: true } }
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    if (size.width === null) {
      expect(result?.proposal).toEqual({ warnings: ['NO_COVER'], cover: null })
    } else {
      // Larger than any cover the app makes: nothing is asked for.
      expect(result).toBeUndefined()
    }
    expect(calls.map((call) => call.method)).not.toContain('cover.placeholder')
  })

  it('proposes nothing when the file holds the very placeholder it would get', async () => {
    // Arrange
    held = {
      cover: {
        width: 600,
        height: 600,
        thumb: `${stemOf(DRAWN)}.thumb.jpg`,
        placeholder: true,
        other: false
      }
    }
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal).toEqual({ warnings: ['NO_COVER'], cover: null })
  })

  it('draws a placeholder in the place of a cover that cannot be read', async () => {
    // Arrange
    held = { cover: { width: null, height: null, thumb: null, placeholder: false, other: false } }
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal?.fields?.cover?.source).toBe('placeholder')
  })

  it('looks again for a real cover for a track that holds a placeholder the app drew', async () => {
    // Arrange
    held = { cover: { width: 600, height: 600, thumb: null, placeholder: true, other: false } }
    const { stage } = stageOver([picture])

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal?.fields?.cover?.source).toBe('itunes')
  })

  it('warns and changes nothing when the placeholder cannot be drawn either', async () => {
    // Arrange
    refused.add('placeholder')
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal).toEqual({ warnings: ['NO_COVER'], cover: null })
    expect(readdirSync(folder)).toEqual([])
  })

  it('goes without a placeholder that takes too long to draw', async () => {
    // Arrange
    refused.add('slow placeholder')
    const { stage } = stageOver([{ status: 404, body: 'Not Found' }], itunesWith([]))

    // Act
    const result = await stage.run(context(), trackWith())

    // Assert
    expect(result?.proposal).toEqual({ warnings: ['NO_COVER'], cover: null })
  })

  it('looks for nothing for a track whose cover the user chose', async () => {
    // Arrange
    const itunes = itunesWith([SONG])
    const { stage } = stageOver([], itunes)

    // Act
    const result = await stage.run(context(), trackWith({ lockedFields: ['cover'] }))

    // Assert
    expect(result).toBeUndefined()
    expect(calls).toEqual([])
    expect(itunes.asked).toEqual([])
  })

  it('fails the track when a service could not be asked and nothing was found', async () => {
    // Arrange
    const { stage } = stageOver(
      [],
      itunesWith(new LookupError('itunes', 'busy')),
      lookupClients(null)
    )

    // Act
    const result = stage.run(context(), trackWith())

    // Assert
    await expect(result).rejects.toMatchObject({ code: 'LOOKUP_FAILED' })
  })

  it('looks at no WAV and no copy that was set aside', async () => {
    // Arrange
    const { stage } = stageOver([])

    // Act
    const wav = await stage.run(context(), trackWith({ path: '/Music/a.wav', format: 'wav' }))
    const setAside = await stage.run(context(), trackWith({ path: '/Music/_Duplicates/a.mp3' }))

    // Assert
    expect([wav, setAside]).toEqual([undefined, undefined])
    expect(calls).toEqual([])
  })

  it('fails the track when the sidecar is not running', async () => {
    // Arrange
    const stage = createCoverStage({
      db: testDatabase.db,
      python: () => null,
      covers,
      cache: createLookupCache(testDatabase.db),
      clients: lookupClients(),
      coverClients: {
        itunes: itunesWith([]),
        images: createLookupHttp({ userAgent: USER_AGENT, fetch: answering([]).fetch })
      }
    })

    // Act
    const result = stage.run(context(), trackWith())

    // Assert
    await expect(result).rejects.toMatchObject({ code: 'PYTHON_CRASHED' })
  })
})

describe('the stage that draws a placeholder again', () => {
  const SPEC = { artist: 'Daft Punk', title: 'Around the World', color: '#9a9aa3' }
  const PROPOSAL = {
    fields: {
      cover: { value: `${stemOf('old')}.jpg`, source: 'placeholder' as const },
      title: { value: 'One More Time', source: 'manual' as const }
    },
    cover: { thumb: `${stemOf('old')}.thumb.jpg`, before: null, placeholder: SPEC }
  }

  it('keeps the placeholder the preview showed when it cannot be drawn again', async () => {
    // Arrange
    refused.add('placeholder')
    const stage = createRedrawPlaceholderStage({ db: testDatabase.db, python: () => python })

    // Act
    const result = await stage.run(context({ proposal: PROPOSAL }), trackWith())

    // Assert
    expect(result).toBeUndefined()
  })

  it('fails the track when the sidecar is not running and the placeholder must change', async () => {
    // Arrange
    const stage = createRedrawPlaceholderStage({ db: testDatabase.db, python: () => null })

    // Act
    const result = stage.run(context({ proposal: PROPOSAL }), trackWith())

    // Assert
    await expect(result).rejects.toMatchObject({ code: 'PYTHON_CRASHED' })
  })
})
