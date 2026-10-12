import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { getTrackById, insertTracks, type Track } from '../../db/tracks'
import { logger } from '../../services/logger'
import { createAcoustIdClient } from '../../services/lookup/acoustid'
import type { LookupClients } from '../../services/lookup/chain'
import { createDiscogsClient } from '../../services/lookup/discogs'
import { createLookupHttp } from '../../services/lookup/http'
import { createMusicBrainzClient } from '../../services/lookup/musicbrainz'
import {
  answering,
  openLimiters,
  USER_AGENT,
  type Answer,
  type Recorded
} from '../../services/lookup/lookup.test-util'
import type { LookupCache } from '../../services/lookup/cache'
import { createPythonBridge, type PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import { readProposal } from '@shared/preview'
import { createLookupCache } from '../lookup-cache'
import { writeHouseLoop } from './audio.test-util'
import { createFingerprintStage, keptFingerprint } from './fingerprint'
import { createLookupStage, identifiersSchema } from './lookup'
import type { Stage, StageContext } from './stage'

const ACOUSTID = '9ff43b6a-4f16-427c-93c2-92307ca505e0'
const MBID = '59d61a60-0a62-4004-b0d5-8c55fa62ddbe'
const KEYS = {
  acoustid: 'ACOUSTIDKEY123',
  discogsKey: 'DISCOGSKEY123',
  discogsSecret: 'DISCOGSSECRET456'
}
const FINGERPRINT = { fingerprint: 'AQAAfingerprint', duration: 227 }

const ACOUSTID_ANSWER: Answer = {
  body: {
    status: 'ok',
    results: [
      {
        id: ACOUSTID,
        score: 0.96,
        recordings: [{ id: MBID, title: 'Around the World', artists: [{ name: 'Daft Punk' }] }]
      }
    ]
  }
}
const RECORDING_ANSWER: Answer = {
  body: {
    id: MBID,
    title: 'Around the World',
    length: 226866,
    'first-release-date': '1997-06',
    'artist-credit': [{ name: 'Daft Punk', joinphrase: '' }],
    releases: [{ title: 'Homework', status: 'Official', date: '1997-01-20' }]
  }
}
const DISCOGS_ANSWER: Answer = {
  body: { results: [{ title: 'Daft Punk - Around The World', year: '1997', label: ['Virgin'] }] }
}

type Call = PythonBridge['call']

let testDatabase: TestDatabase
let track: Track
let logged: string[]

function context(overrides: Partial<StageContext> = {}): StageContext {
  return {
    signal: new AbortController().signal,
    batchId: 1,
    files: null,
    proposal: {},
    ...overrides
  }
}

/** The real clients and the real cache table, over canned answers of the services. */
function lookupOver(
  answers: Answer[],
  keys: Partial<typeof KEYS> = KEYS
): { requests: Recorded[]; cache: LookupCache; stage: Stage } {
  const { fetch, requests } = answering(answers)
  const http = createLookupHttp({ userAgent: USER_AGENT, fetch }, openLimiters())
  const cache = createLookupCache(testDatabase.db)
  const clients: LookupClients = {
    acoustid: createAcoustIdClient({ http, cache, apiKey: () => keys.acoustid }),
    musicbrainz: createMusicBrainzClient({ http, cache }),
    discogs: createDiscogsClient({
      http,
      cache,
      credentials: () =>
        keys.discogsKey && keys.discogsSecret
          ? { key: keys.discogsKey, secret: keys.discogsSecret }
          : undefined
    })
  }
  return { requests, cache, stage: createLookupStage({ cache, clients }) }
}

function fingerprintStage(
  call: Call,
  options: { wanted?: boolean; cache?: LookupCache } = {}
): { cache: LookupCache; stage: Stage } {
  const cache = options.cache ?? createLookupCache(testDatabase.db)
  return {
    cache,
    stage: createFingerprintStage({
      cache,
      python: () => ({ call }),
      wanted: () => options.wanted ?? true
    })
  }
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  const [id] = insertTracks(testDatabase.db, [
    {
      path: '/Music/daft punk - around the world.mp3',
      originalPath: '/Music/daft punk - around the world.mp3',
      format: 'mp3',
      artist: 'daft punk',
      title: 'around the world',
      durationMs: 227_000,
      fileSizeBytes: 9_000_000,
      fileMtimeMs: 1_700_000_000_000
    }
  ]) as [number]
  track = getTrackById(testDatabase.db, id, new Set()) as Track
  logged = []
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((message, ...details) => {
      logged.push([message, ...details.map(String)].join(' '))
    })
  }
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('the fingerprint stage', () => {
  it('asks the sidecar for the fingerprint of the file and keeps it for the lookup', async () => {
    // Arrange
    const calls: unknown[][] = []
    const { stage, cache } = fingerprintStage((async (...call: unknown[]) => {
      calls.push(call)
      return FINGERPRINT
    }) as Call)
    const signal = new AbortController().signal

    // Act
    const outcome = await stage.run(context({ signal }), track)

    // Assert
    expect(outcome).toBeUndefined()
    expect(keptFingerprint(cache, track)).toEqual(FINGERPRINT)
    const [method, params, options] = calls[0] as [string, { jobId: string }, unknown]
    expect(method).toBe('fingerprint.compute')
    expect(params).toEqual({ path: track.path, jobId: params.jobId })
    expect(options).toEqual({ timeoutMs: 120_000, job: { id: params.jobId, signal } })
  })

  it('fingerprints a file once', async () => {
    // Arrange
    const call = vi.fn(async () => FINGERPRINT) as unknown as Call
    const { stage } = fingerprintStage(call)
    await stage.run(context(), track)

    // Act
    await stage.run(context(), track)

    // Assert
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('fingerprints a file again when the file has changed', async () => {
    // Arrange
    const call = vi.fn(async () => FINGERPRINT) as unknown as Call
    const { stage, cache } = fingerprintStage(call)
    await stage.run(context(), track)
    const changed = { ...track, fileMtimeMs: 1_800_000_000_000 }

    // Act
    await stage.run(context(), changed)

    // Assert
    expect(call).toHaveBeenCalledTimes(2)
    expect(keptFingerprint(cache, changed)).toEqual(FINGERPRINT)
  })

  it('does nothing while there is no AcoustID key to look a fingerprint up with', async () => {
    // Arrange
    const call = vi.fn(async () => FINGERPRINT) as unknown as Call
    const { stage, cache } = fingerprintStage(call, { wanted: false })

    // Act
    await stage.run(context(), track)

    // Assert
    expect(call).not.toHaveBeenCalled()
    expect(keptFingerprint(cache, track)).toBeNull()
  })

  it('does not fail a track whose file cannot be fingerprinted', async () => {
    // Arrange
    const { stage, cache } = fingerprintStage((async () => {
      throw new AppError('PYTHON_ERROR', 'fingerprint.compute: the sidecar reported an error')
    }) as Call)

    // Act
    const outcome = await stage.run(context(), track)

    // Assert
    expect(outcome).toBeUndefined()
    expect(keptFingerprint(cache, track)).toBeNull()
    expect(logged.join('\n')).toContain(`Track ${track.id} has no fingerprint`)
  })

  it.each(['PYTHON_CRASHED', 'TIMEOUT'] as const)(
    'fails the track when the sidecar itself is the problem (%s)',
    async (code) => {
      // Arrange
      const { stage } = fingerprintStage((async () => {
        throw new AppError(code, 'the sidecar is gone')
      }) as Call)

      // Act
      const running = stage.run(context(), track)

      // Assert
      await expect(running).rejects.toMatchObject({ code })
    }
  )

  it('is a step of its own that the user does not ask for by name', () => {
    expect(fingerprintStage(vi.fn() as unknown as Call).stage).toMatchObject({
      name: 'fingerprint',
      phase: 'compute',
      resource: 'cpu',
      selectable: false
    })
  })
})

describe('the lookup stage', () => {
  it('proposes what the services found, each field with its source and the confidence', async () => {
    // Arrange
    const { stage, cache } = lookupOver([ACOUSTID_ANSWER, RECORDING_ANSWER, DISCOGS_ANSWER])
    cache.put('fingerprint', `${track.id}:9000000:1700000000000`, FINGERPRINT)

    // Act
    const outcome = await stage.run(context(), track)

    // Assert: 0.6 × 0.96 + 0.3 × 1 + 0.1 × 1
    const confidence = expect.closeTo(0.976, 5)
    expect(outcome?.proposal).toEqual({
      fields: {
        artist: { value: 'Daft Punk', source: 'musicbrainz', confidence },
        title: { value: 'Around the World', source: 'musicbrainz', confidence },
        album: { value: 'Homework', source: 'musicbrainz', confidence },
        year: { value: 1997, source: 'musicbrainz', confidence },
        label: { value: 'Virgin', source: 'discogs', confidence }
      },
      identifiers: { acoustId: ACOUSTID, musicbrainzRecordingId: MBID }
    })
    // What it proposes is what the preview reads: nothing is dropped as invalid.
    expect(readProposal(outcome?.proposal).fields).toEqual(outcome?.proposal?.fields)
    expect(identifiersSchema.safeParse(outcome?.proposal?.['identifiers']).success).toBe(true)
  })

  it('sends no request the second time: every answer was kept', async () => {
    // Arrange
    const { stage, cache, requests } = lookupOver([
      ACOUSTID_ANSWER,
      RECORDING_ANSWER,
      DISCOGS_ANSWER
    ])
    cache.put('fingerprint', `${track.id}:9000000:1700000000000`, FINGERPRINT)
    const first = await stage.run(context(), track)

    // Act
    const second = await stage.run(context(), track)

    // Assert
    expect(requests).toHaveLength(3)
    expect(second).toEqual(first)
  })

  it('asks every service again when the user asks for a refresh', async () => {
    // Arrange
    const { stage, cache, requests } = lookupOver([
      ACOUSTID_ANSWER,
      RECORDING_ANSWER,
      DISCOGS_ANSWER,
      ACOUSTID_ANSWER,
      RECORDING_ANSWER,
      { body: { results: [{ title: 'Daft Punk - Around The World', label: ['Soma'] }] } }
    ])
    cache.put('fingerprint', `${track.id}:9000000:1700000000000`, FINGERPRINT)
    await stage.run(context(), track)

    // Act
    const refreshed = await stage.run(context({ refresh: true }), track)

    // Assert
    expect(requests).toHaveLength(6)
    expect(refreshed?.proposal?.fields?.label?.value).toBe('Soma')
  })

  it('searches by the names of the track when it has no fingerprint', async () => {
    // Arrange
    const { stage, requests } = lookupOver([RECORDING_ANSWER_AS_SEARCH()], {})

    // Act
    const outcome = await stage.run(context(), track)

    // Assert
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]?.url ?? '').searchParams.get('query')).toBe(
      'recording:"around the world" AND artist:"daft punk"'
    )
    expect(outcome?.proposal?.fields?.title).toMatchObject({
      value: 'Around the World',
      source: 'musicbrainz',
      confidence: 1
    })
  })

  it('keeps the tags of a track nobody knows, names them as ID3, and flags the row', async () => {
    // Arrange
    const { stage } = lookupOver([{ body: { recordings: [] } }, { body: { results: [] } }], {
      discogsKey: KEYS.discogsKey,
      discogsSecret: KEYS.discogsSecret
    })

    // Act
    const outcome = await stage.run(context(), track)

    // Assert
    expect(outcome?.proposal).toEqual({
      fields: {
        artist: { value: 'daft punk', source: 'id3', confidence: 0 },
        title: { value: 'around the world', source: 'id3', confidence: 0 }
      },
      warnings: ['LOW_CONFIDENCE'],
      identifiers: null
    })
  })

  it('fails a track it found nothing for while a service could not be asked', async () => {
    // Arrange
    const busy: Answer = { status: 503, body: 'busy' }
    const { stage } = lookupOver([{ body: { recordings: [] } }, busy, busy], {
      discogsKey: KEYS.discogsKey,
      discogsSecret: KEYS.discogsSecret
    })

    // Act
    const running = stage.run(context(), track)

    // Assert: "not found" would not be true, Discogs was never heard.
    await expect(running).rejects.toMatchObject({ code: 'LOOKUP_FAILED' })
  })

  it('goes on without a service that is busy, and says so in the log', async () => {
    // Arrange
    const busy: Answer = { status: 503, body: 'busy' }
    const { stage } = lookupOver([RECORDING_ANSWER_AS_SEARCH(), busy, busy], {
      discogsKey: KEYS.discogsKey,
      discogsSecret: KEYS.discogsSecret
    })

    // Act
    const outcome = await stage.run(context(), track)

    // Assert
    expect(outcome?.proposal?.fields?.title?.source).toBe('musicbrainz')
    expect(outcome?.proposal?.fields).not.toHaveProperty('label')
    expect(logged).toContain(`Lookup of track ${track.id} went on without: discogs busy`)
  })

  it('fails the track when no service could be asked, and keeps nothing', async () => {
    // Arrange
    const offline = new TypeError('fetch failed')
    const { stage, requests } = lookupOver([offline, offline, offline, offline])

    // Act
    const failed = await stage.run(context(), track).catch((error: unknown) => error)
    const again = await stage.run(context(), track).catch((error: unknown) => error)

    // Assert
    expect(failed).toMatchObject({ code: 'LOOKUP_FAILED' })
    expect(again).toMatchObject({ code: 'LOOKUP_FAILED' })
    // Asked again the second time: a failure is not an answer.
    expect(requests).toHaveLength(4)
  })

  it('never writes a key to the log, whatever goes wrong', async () => {
    // Arrange
    const leaking = new TypeError(
      `fetch failed for client=${KEYS.acoustid} key=${KEYS.discogsKey} secret=${KEYS.discogsSecret}`
    )
    const { stage, cache } = lookupOver([
      leaking,
      { status: 401, body: { message: `Invalid consumer ${KEYS.discogsKey}` } },
      { status: 500, body: KEYS.discogsSecret }
    ])
    cache.put('fingerprint', `${track.id}:9000000:1700000000000`, FINGERPRINT)

    // Act
    await stage.run(context(), track).catch(() => {})

    // Assert
    expect(logged.length).toBeGreaterThan(0)
    for (const key of Object.values(KEYS)) expect(logged.join('\n')).not.toContain(key)
  })

  it('waits for the fingerprint, uses the network, and can be asked for again', () => {
    expect(lookupOver([]).stage).toMatchObject({
      name: 'lookup',
      phase: 'compute',
      resource: 'network',
      dependsOn: ['fingerprint'],
      selectable: true,
      refreshable: true,
      timeoutMs: 30_000,
      warnings: ['LOW_CONFIDENCE']
    })
  })
})

function RECORDING_ANSWER_AS_SEARCH(): Answer {
  return { body: { recordings: [(RECORDING_ANSWER as { body: unknown }).body] } }
}

const PYTHON_DIR = join(__dirname, '../../../../python')
const PYTHON_PATH = join(PYTHON_DIR, '.venv/bin/python')
const BIN_DIR = join(__dirname, '../../../../resources/bin')

// Needs the development Python environment and the tools of scripts/fetch-binaries.sh;
// CI has neither.
describe.skipIf(!existsSync(PYTHON_PATH) || !existsSync(join(BIN_DIR, 'fpcalc')))(
  'the fingerprint stage with the real sidecar',
  () => {
    let folder: string
    let bridge: PythonBridge

    beforeEach(() => {
      // As the app names a library file: the sidecar opens nothing through a link,
      // and the temp folder of macOS is reached through one.
      folder = realpathSync(mkdtempSync(join(tmpdir(), 'fixlibrary-fingerprint-')))
      bridge = createPythonBridge({
        pythonPath: PYTHON_PATH,
        cwd: PYTHON_DIR,
        logDir: folder,
        ffmpegPath: join(BIN_DIR, 'ffmpeg'),
        fpcalcPath: join(BIN_DIR, 'fpcalc'),
        log: () => {},
        onSidecarOutput: () => {}
      })
      bridge.start()
    })

    afterEach(async () => {
      await bridge.stop()
      rmSync(folder, { recursive: true, force: true })
    })

    function trackAt(path: string): Track {
      const [id] = insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'wav' }]) as [
        number
      ]
      return getTrackById(testDatabase.db, id, new Set()) as Track
    }

    it('fingerprints a generated track and keeps what the sidecar answered', async () => {
      // Arrange
      const path = join(folder, 'loop.wav')
      writeHouseLoop(path, 124, 20)
      const cache = createLookupCache(testDatabase.db)
      const stage = createFingerprintStage({ cache, python: () => bridge, wanted: () => true })
      const loop = trackAt(path)

      // Act
      await stage.run(context(), loop)

      // Assert
      const kept = keptFingerprint(cache, loop)
      expect(kept?.duration).toBe(20)
      expect(kept?.fingerprint).toMatch(/^AQAA[A-Za-z0-9_-]{50,}$/)
    }, 60_000)

    it('leaves a file without audio unfingerprinted, and the sidecar stays up', async () => {
      // Arrange
      const path = join(folder, 'broken.wav')
      writeFileSync(path, 'this is not audio')
      const cache = createLookupCache(testDatabase.db)
      const stage = createFingerprintStage({ cache, python: () => bridge, wanted: () => true })
      const broken = trackAt(path)

      // Act
      await stage.run(context(), broken)

      // Assert
      expect(keptFingerprint(cache, broken)).toBeNull()
      await expect(bridge.call('ping', {})).resolves.toMatchObject({ version: expect.any(String) })
    }, 60_000)
  }
)
