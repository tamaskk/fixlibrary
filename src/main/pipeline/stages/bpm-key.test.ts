import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAnalysis, saveAnalysis } from '../../db/analyses'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { getTrackById, insertTracks, type Track } from '../../db/tracks'
import { logger } from '../../services/logger'
import { createPythonBridge, type PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import { readProposal } from '@shared/preview'
import { BPM_KEY_ANALYZER_VERSION, type BpmKeyResult } from '@shared/rpc'
import { z } from 'zod'
import { writeHouseLoop } from './audio.test-util'
import { bpmConfidenceOf, createBpmKeyStage } from './bpm-key'
import type { StageContext } from './stage'

const RANGE = { bpmMin: 85, bpmMax: 175 }
const RESULT: BpmKeyResult = {
  bpm: 123.65,
  rawBpm: 61.83,
  bpmConfidence: 3.2,
  keyName: 'A',
  scale: 'minor',
  keyStrength: 0.81,
  camelot: '8A',
  musical: 'Am',
  analyzerVersion: BPM_KEY_ANALYZER_VERSION
}

type Call = PythonBridge['call']

let testDatabase: TestDatabase
let track: Track
let calls: { method: string; params: unknown; options: unknown }[]
let answer: () => Promise<unknown>
let range: { bpmMin: number; bpmMax: number }

function context(signal: AbortSignal = new AbortController().signal): StageContext {
  return { signal, batchId: 1, files: null, proposal: {} }
}

function stage(): ReturnType<typeof createBpmKeyStage> {
  const call = (async (method: string, params: unknown, options: unknown) => {
    calls.push({ method, params, options })
    return answer()
  }) as Call
  return createBpmKeyStage({ db: testDatabase.db, python: () => ({ call }), bpmRange: () => range })
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  const [id] = insertTracks(testDatabase.db, [
    { path: '/Music/one.mp3', originalPath: '/Music/one.mp3', format: 'mp3' }
  ]) as [number]
  track = getTrackById(testDatabase.db, id, new Set()) as Track
  calls = []
  answer = async () => RESULT
  range = { ...RANGE }
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('the tempo and key stage', () => {
  it('proposes the tempo as a whole number and the key as its Camelot code', async () => {
    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(outcome?.proposal?.fields).toEqual({
      bpm: { value: 124, source: 'analysis', confidence: 1 },
      key: { value: '8A', source: 'analysis' }
    })
    // What it proposes is what the preview reads: nothing is dropped as invalid.
    expect(readProposal(outcome?.proposal).fields).toEqual(outcome?.proposal?.fields)
  })

  it('asks the sidecar about the file of the track, with the tempo range of the settings', async () => {
    // Arrange
    range = { bpmMin: 70, bpmMax: 150 }
    const signal = new AbortController().signal

    // Act
    await stage().run(context(signal), track)

    // Assert
    expect(calls).toHaveLength(1)
    const [{ method, params, options }] = calls as [(typeof calls)[number]]
    const { jobId } = params as { jobId: string }
    expect(method).toBe('analysis.bpm_key')
    expect(params).toEqual({ path: '/Music/one.mp3', jobId, bpmMin: 70, bpmMax: 150 })
    expect(jobId).toMatch(/^[\w-]{1,64}$/)
    expect(options).toEqual({ timeoutMs: 120_000, job: { id: jobId, signal } })
  })

  it('gives every attempt a job id of its own', async () => {
    // Arrange
    const analysing = stage()
    answer = async () => {
      throw new AppError('PYTHON_ERROR', 'failed')
    }

    // Act
    await analysing.run(context(), track).catch(() => {})
    await analysing.run(context(), track).catch(() => {})

    // Assert
    const ids = calls.map((call) => (call.params as { jobId: string }).jobId)
    expect(new Set(ids).size).toBe(2)
  })

  it('keeps the result with the analyzer version and the range it was asked with', async () => {
    // Act
    await stage().run(context(), track)

    // Assert
    expect(getAnalysis(testDatabase.db, track.id, 'bpm_key', z.unknown())).toEqual({
      result: { range: RANGE, result: RESULT },
      analyzerVersion: BPM_KEY_ANALYZER_VERSION
    })
  })

  it('does not analyse a track again while the analyzer is the same', async () => {
    // Arrange
    const analysing = stage()
    await analysing.run(context(), track)

    // Act
    const again = await analysing.run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
    expect(again?.proposal?.fields?.bpm?.value).toBe(124)
    expect(again?.proposal?.fields?.key?.value).toBe('8A')
  })

  it('analyses a track again when the kept result is of another analyzer version', async () => {
    // Arrange
    saveAnalysis(testDatabase.db, {
      trackId: track.id,
      type: 'bpm_key',
      result: { range: RANGE, result: { ...RESULT, analyzerVersion: 'older' } },
      analyzerVersion: 'older'
    })

    // Act
    await stage().run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
    expect(getAnalysis(testDatabase.db, track.id, 'bpm_key', z.unknown())?.analyzerVersion).toBe(
      BPM_KEY_ANALYZER_VERSION
    )
  })

  it('analyses a track again when the tempo range of the settings has changed', async () => {
    // Arrange
    const analysing = stage()
    await analysing.run(context(), track)
    range = { bpmMin: 70, bpmMax: 150 }

    // Act
    await analysing.run(context(), track)

    // Assert
    expect(calls).toHaveLength(2)
  })

  it('analyses a track again when the kept result cannot be read', async () => {
    // Arrange
    saveAnalysis(testDatabase.db, {
      trackId: track.id,
      type: 'bpm_key',
      result: { range: RANGE, result: { ...RESULT, camelot: '13A' } },
      analyzerVersion: BPM_KEY_ANALYZER_VERSION
    })

    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
    expect(outcome?.proposal?.fields?.key?.value).toBe('8A')
  })

  it.each([84.9, 175.1])(
    'fails the track and keeps nothing when the tempo of the answer is %f, outside the range',
    async (bpm) => {
      // Arrange
      answer = async () => ({ ...RESULT, bpm })

      // Act
      const running = stage().run(context(), track)

      // Assert
      await expect(running).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
      expect(getAnalysis(testDatabase.db, track.id, 'bpm_key', z.unknown())).toBeUndefined()
    }
  )

  it('analyses a track again when the kept tempo is outside the range it was asked with', async () => {
    // Arrange
    saveAnalysis(testDatabase.db, {
      trackId: track.id,
      type: 'bpm_key',
      result: { range: RANGE, result: { ...RESULT, bpm: 300 } },
      analyzerVersion: BPM_KEY_ANALYZER_VERSION
    })

    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
    expect(outcome?.proposal?.fields?.bpm?.value).toBe(124)
  })

  it('fails the track and keeps nothing when the sidecar fails', async () => {
    // Arrange
    answer = async () => {
      throw new AppError('PYTHON_ERROR', 'analysis.bpm_key: the sidecar reported an error')
    }

    // Act
    const running = stage().run(context(), track)

    // Assert
    await expect(running).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
    expect(getAnalysis(testDatabase.db, track.id, 'bpm_key', z.unknown())).toBeUndefined()
  })

  it('fails the track when there is no sidecar to ask', async () => {
    // Arrange
    const analysing = createBpmKeyStage({
      db: testDatabase.db,
      python: () => null,
      bpmRange: () => RANGE
    })

    // Act
    const running = analysing.run(context(), track)

    // Assert
    await expect(running).rejects.toMatchObject({ code: 'PYTHON_CRASHED' })
  })

  it('keeps nothing of an answer that arrives after the stage was stopped', async () => {
    // Arrange
    const controller = new AbortController()
    answer = async () => {
      controller.abort()
      return RESULT
    }

    // Act
    const running = stage().run(context(controller.signal), track)

    // Assert
    await expect(running).rejects.toBeInstanceOf(AppError)
    expect(getAnalysis(testDatabase.db, track.id, 'bpm_key', z.unknown())).toBeUndefined()
  })

  it('is a compute stage on the cpu that the user can ask for', () => {
    // Act
    const analysing = stage()

    // Assert
    expect(analysing).toMatchObject({
      name: 'bpmKey',
      phase: 'compute',
      resource: 'cpu',
      dependsOn: [],
      selectable: true,
      timeoutMs: 120_000
    })
  })
})

describe('bpmConfidenceOf', () => {
  it.each([
    [0, 0],
    [0.75, 0.35],
    [1.5, 0.7],
    [3.5, 1],
    [5.32, 1]
  ])('reads an Essentia confidence of %f as %f', (bpmConfidence, expected) => {
    expect(bpmConfidenceOf({ ...RESULT, bpmConfidence })).toBeCloseTo(expected)
  })

  it('flags what Essentia calls a weak guess, and nothing surer', () => {
    expect(bpmConfidenceOf({ ...RESULT, bpmConfidence: 1.49 })).toBeLessThan(0.7)
    expect(bpmConfidenceOf({ ...RESULT, bpmConfidence: 1.5 })).toBeGreaterThanOrEqual(0.7)
  })
})

const PYTHON_DIR = join(__dirname, '../../../../python')
const PYTHON_PATH = join(PYTHON_DIR, '.venv/bin/python')
const FFMPEG_PATH = join(__dirname, '../../../../resources/bin/ffmpeg')

// Needs the development Python environment and the tools of scripts/fetch-binaries.sh;
// CI has neither.
describe.skipIf(!existsSync(PYTHON_PATH) || !existsSync(FFMPEG_PATH))(
  'the tempo and key stage with the real sidecar',
  () => {
    let folder: string
    let bridge: PythonBridge

    beforeEach(() => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      // As the app names a library file: the sidecar opens nothing through a link,
      // and the temp folder of macOS is reached through one.
      folder = realpathSync(mkdtempSync(join(tmpdir(), 'fixlibrary-bpm-key-')))
      bridge = createPythonBridge({
        pythonPath: PYTHON_PATH,
        cwd: PYTHON_DIR,
        logDir: folder,
        ffmpegPath: FFMPEG_PATH,
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

    it('measures a generated 124 BPM loop in A minor as 124 and 8A', async () => {
      // Arrange
      const path = join(folder, 'loop.wav')
      writeHouseLoop(path, 124, 30)
      const analysing = createBpmKeyStage({
        db: testDatabase.db,
        python: () => bridge,
        bpmRange: () => RANGE
      })

      // Act
      const outcome = await analysing.run(context(), trackAt(path))

      // Assert
      expect(outcome?.proposal?.fields?.bpm?.value).toBe(124)
      expect(outcome?.proposal?.fields?.key?.value).toBe('8A')
    }, 60_000)

    it('fails a file that holds no audio, and the sidecar stays up', async () => {
      // Arrange
      const path = join(folder, 'broken.wav')
      writeFileSync(path, 'this is not audio')
      const analysing = createBpmKeyStage({
        db: testDatabase.db,
        python: () => bridge,
        bpmRange: () => RANGE
      })

      // Act
      const running = analysing.run(context(), trackAt(path))

      // Assert
      await expect(running).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
      await expect(bridge.call('ping', {})).resolves.toMatchObject({ version: expect.any(String) })
    }, 60_000)
  }
)
