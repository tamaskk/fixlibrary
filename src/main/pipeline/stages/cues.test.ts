import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveAnalysis } from '../../db/analyses'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { cues } from '../../db/schema'
import { getTrackById, insertTracks, type Track } from '../../db/tracks'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import {
  STEMS_ANALYZER_VERSION,
  STRUCTURE_ANALYZER_VERSION,
  type StructureResult
} from '@shared/rpc'
import { createCuesStage } from './cues'
import type { StageContext } from './stage'

type Call = PythonBridge['call']

const GRID = [{ inizio: 0.02, bpm: 128, metro: '4/4', battito: 1 }]

let testDatabase: TestDatabase
let track: Track
let calls: { method: string; params: unknown }[]
let answer: StructureResult

function context(signal: AbortSignal = new AbortController().signal): StageContext {
  return { signal, batchId: 1, files: null, proposal: {} }
}

function stage(): ReturnType<typeof createCuesStage> {
  const call = (async (method: string, params: unknown) => {
    calls.push({ method, params })
    return answer
  }) as Call
  return createCuesStage({ db: testDatabase.db, python: () => ({ call }) })
}

function withStemsAndGrid(): void {
  saveAnalysis(testDatabase.db, {
    trackId: track.id,
    type: 'stems',
    result: {
      result: {
        file: `${track.id}.npz`,
        frames: 3000,
        bytes: 24_000,
        seconds: 40,
        durationSeconds: 300,
        truncated: false,
        analyzerVersion: STEMS_ANALYZER_VERSION
      },
      fileSizeBytes: track.fileSizeBytes,
      fileMtimeMs: track.fileMtimeMs
    },
    analyzerVersion: STEMS_ANALYZER_VERSION
  })
  saveAnalysis(testDatabase.db, {
    trackId: track.id,
    type: 'rb_grid',
    result: { tempos: GRID, exportedAt: 1, readAt: 2 },
    analyzerVersion: 'rekordbox-xml'
  })
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  const [id] = insertTracks(testDatabase.db, [
    {
      path: '/Music/one.mp3',
      originalPath: '/Music/one.mp3',
      format: 'mp3',
      durationMs: 301_500,
      fileSizeBytes: 9_000_000,
      fileMtimeMs: 1_700_000_000_000
    }
  ]) as [number]
  track = getTrackById(testDatabase.db, id, new Set()) as Track
  calls = []
  answer = {
    cues: [
      { slot: 1, timeSec: 0.02 },
      { slot: 2, timeSec: 15.02 },
      { slot: 4, timeSec: 60.02 }
    ],
    review: false,
    instrumental: true,
    analyzerVersion: STRUCTURE_ANALYZER_VERSION
  }
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('the cues stage', () => {
  it('places no cues on a track without a Rekordbox grid, and says why', async () => {
    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(outcome).toEqual({ proposal: { warnings: ['NO_GRID'] } })
    expect(calls).toHaveLength(0)
  })

  it('asks the sidecar with the grid and the length, and proposes the cues on the ms', async () => {
    // Arrange
    withStemsAndGrid()
    testDatabase.db
      .insert(cues)
      .values({ trackId: track.id, slot: 8, positionMs: 1, name: 'Drop 3', color: '#ec4899' })
      .run()

    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(calls).toEqual([
      {
        method: 'analysis.structure',
        params: { trackId: track.id, grid: GRID, durationSeconds: 301.5 }
      }
    ])
    expect(outcome).toEqual({
      proposal: {
        fields: { cues: { value: 'A B – D – – – –', source: 'analysis' } },
        cues: {
          slots: [
            { slot: 1, positionMs: 20 },
            { slot: 2, positionMs: 15_020 },
            { slot: 4, positionMs: 60_020 }
          ],
          before: '– – – – – – – H'
        }
      }
    })
  })

  it('asks for a review when a slot was emptied for the order', async () => {
    // Arrange
    withStemsAndGrid()
    answer = { ...answer, review: true }

    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(outcome?.proposal?.warnings).toEqual(['CUE_REVIEW'])
  })

  it('proposes nothing when the structure finds no cue, so the cues the track has stay', async () => {
    // Arrange
    withStemsAndGrid()
    answer = { ...answer, cues: [] }

    // Act
    const outcome = await stage().run(context(), track)

    // Assert
    expect(outcome).toEqual({ proposal: { warnings: ['NO_CUES'] } })
  })

  it('fails a track whose stems are not there', async () => {
    // Arrange
    saveAnalysis(testDatabase.db, {
      trackId: track.id,
      type: 'rb_grid',
      result: { tempos: GRID, exportedAt: 1, readAt: 2 },
      analyzerVersion: 'rekordbox-xml'
    })

    // Act
    const run = stage().run(context(), track)

    // Assert
    await expect(run).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
  })
})
