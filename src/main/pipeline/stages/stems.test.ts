import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAnalysis } from '../../db/analyses'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { getTrackById, insertTracks, updateTrack, type Track } from '../../db/tracks'
import { logger } from '../../services/logger'
import { createPythonBridge, type PythonBridge } from '../../services/python-bridge'
import { createStemsStore, stemModelInstalled } from '../../services/stems-store'
import { STEMS_ANALYZER_VERSION, type StemsResult } from '@shared/rpc'
import { z } from 'zod'
import { writeHouseLoop } from './audio.test-util'
import type { StageContext } from './stage'
import { createStemsStage, keptStems } from './stems'

type Call = PythonBridge['call']

let testDatabase: TestDatabase
let track: Track
let calls: { method: string; params: unknown }[]
let answer: () => Promise<StemsResult>
let envelopesThere: boolean
let modelThere: boolean

function resultFor(trackId: number): StemsResult {
  return {
    file: `${trackId}.npz`,
    frames: 3000,
    bytes: 24_000,
    seconds: 40,
    durationSeconds: 300,
    truncated: false,
    analyzerVersion: STEMS_ANALYZER_VERSION
  }
}

function context(signal: AbortSignal = new AbortController().signal): StageContext {
  return { signal, batchId: 1, files: null, proposal: {} }
}

function stage(): ReturnType<typeof createStemsStage> {
  const call = (async (method: string, params: unknown) => {
    calls.push({ method, params })
    const result = await answer()
    envelopesThere = true
    return result
  }) as Call
  return createStemsStage({
    db: testDatabase.db,
    python: () => ({ call }),
    stems: { ensure: async () => {}, has: async () => envelopesThere },
    modelInstalled: async () => modelThere
  })
}

function reload(): Track {
  return getTrackById(testDatabase.db, track.id, new Set()) as Track
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  const [id] = insertTracks(testDatabase.db, [
    {
      path: '/Music/one.mp3',
      originalPath: '/Music/one.mp3',
      format: 'mp3',
      fileSizeBytes: 9_000_000,
      fileMtimeMs: 1_700_000_000_000
    }
  ]) as [number]
  track = getTrackById(testDatabase.db, id, new Set()) as Track
  calls = []
  answer = async () => resultFor(track.id)
  envelopesThere = false
  modelThere = true
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('the stems stage', () => {
  it('separates a track once, and keeps the result with the file as it was', async () => {
    // Act
    await stage().run(context(), track)
    await stage().run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'analysis.stems',
      params: { path: '/Music/one.mp3', trackId: track.id }
    })
    expect(getAnalysis(testDatabase.db, track.id, 'stems', z.unknown())).toEqual({
      result: {
        result: resultFor(track.id),
        fileSizeBytes: 9_000_000,
        fileMtimeMs: 1_700_000_000_000
      },
      analyzerVersion: STEMS_ANALYZER_VERSION
    })
    expect(keptStems(testDatabase.db, track)?.result.frames).toBe(3000)
  })

  it('separates again a track whose file changed, or whose envelopes are gone', async () => {
    // Arrange
    await stage().run(context(), track)
    updateTrack(testDatabase.db, track.id, { fileMtimeMs: 1_800_000_000_000 })

    // Act
    await stage().run(context(), reload())
    envelopesThere = false
    await stage().run(context(), reload())

    // Assert
    expect(calls).toHaveLength(3)
  })

  it('fails a track while the model is not installed, without asking the sidecar', async () => {
    // Arrange
    modelThere = false

    // Act
    const run = stage().run(context(), track)

    // Assert
    await expect(run).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
    expect(calls).toHaveLength(0)
  })

  it('keeps nothing of an answer for another track', async () => {
    // Arrange
    answer = async () => resultFor(track.id + 1)

    // Act
    const run = stage().run(context(), track)

    // Assert
    await expect(run).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
    expect(getAnalysis(testDatabase.db, track.id, 'stems', z.unknown())).toBeUndefined()
  })

  it('keeps nothing of an answer that came after the run was stopped', async () => {
    // Arrange
    const stopped = new AbortController()
    answer = async () => {
      stopped.abort()
      return resultFor(track.id)
    }

    // Act
    const run = stage().run(context(stopped.signal), track)

    // Assert
    await expect(run).rejects.toMatchObject({ code: 'UNEXPECTED' })
    expect(getAnalysis(testDatabase.db, track.id, 'stems', z.unknown())).toBeUndefined()
  })
})

const PYTHON_DIR = join(__dirname, '../../../../python')
const PYTHON_PATH = join(PYTHON_DIR, '.venv/bin/python')
const FFMPEG_PATH = join(__dirname, '../../../../resources/bin/ffmpeg')
const MODELS_DIR = join(__dirname, '../../../../resources/models')

// Needs the development Python environment, the tools of scripts/fetch-binaries.sh and
// the model of scripts/fetch-demucs-weights.sh; CI has none of them.
describe.skipIf(
  !existsSync(PYTHON_PATH) ||
    !existsSync(FFMPEG_PATH) ||
    !existsSync(join(MODELS_DIR, 'htdemucs', 'state.pt'))
)('the stems stage with the real sidecar', () => {
  let folder: string
  let bridge: PythonBridge

  beforeEach(() => {
    // As the app names a library file: the temp folder of macOS is reached through a link.
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'fixlibrary-stems-')))
    bridge = createPythonBridge({
      pythonPath: PYTHON_PATH,
      cwd: PYTHON_DIR,
      logDir: folder,
      ffmpegPath: FFMPEG_PATH,
      stemsDir: join(folder, 'stems'),
      modelsDir: MODELS_DIR,
      torchHome: join(folder, 'torch'),
      log: () => {},
      onSidecarOutput: () => {}
    })
    bridge.start()
  })

  afterEach(async () => {
    await bridge.stop()
    rmSync(folder, { recursive: true, force: true })
  })

  it('keeps the envelopes of a generated loop, and goes on without separating it again', async () => {
    // Arrange
    const path = join(folder, 'loop.wav')
    writeHouseLoop(path, 124, 20)
    const [id] = insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'wav' }]) as [
      number
    ]
    const loop = getTrackById(testDatabase.db, id, new Set()) as Track
    const separating = createStemsStage({
      db: testDatabase.db,
      python: () => bridge,
      stems: createStemsStore(join(folder, 'stems')),
      modelInstalled: () => stemModelInstalled(MODELS_DIR)
    })
    const call = vi.spyOn(bridge, 'call')

    // Act
    await separating.run(context(), loop)
    await separating.run(context(), loop)

    // Assert
    const file = join(folder, 'stems', `${id}.npz`)
    expect(statSync(file).size).toBeLessThan(200 * 1024)
    expect(keptStems(testDatabase.db, loop)?.result.frames).toBe(200)
    expect(call.mock.calls.filter(([method]) => method === 'analysis.stems')).toHaveLength(1)
  }, 180_000)
})
