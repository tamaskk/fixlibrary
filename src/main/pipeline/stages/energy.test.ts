import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getAnalysis, saveAnalysis } from '../../db/analyses'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { getTrackById, insertTracks, type Track } from '../../db/tracks'
import type { PythonBridge } from '../../services/python-bridge'
import { ENERGY_ANALYZER_VERSION, type EnergyFeaturesResult } from '@shared/rpc'
import { createEnergyStage, keptEnergyFeatures } from './energy'
import type { StageContext } from './stage'

const RESULT: EnergyFeaturesResult = {
  features: {
    integratedLufs: -8.4,
    rmsDb: -9.1,
    percussiveRatio: 0.62,
    onsetRate: 4.1,
    spectralCentroidHz: 2400,
    spectralFlux: 0.11,
    lowRatio: 0.38
  },
  analyzerVersion: ENERGY_ANALYZER_VERSION
}

type Call = PythonBridge['call']

let testDatabase: TestDatabase
let track: Track
let calls: { method: string; params: unknown; options: unknown }[]

function context(signal: AbortSignal = new AbortController().signal): StageContext {
  return { signal, batchId: 1, files: null, proposal: {} }
}

function stage(): ReturnType<typeof createEnergyStage> {
  const call = (async (method: string, params: unknown, options: unknown) => {
    calls.push({ method, params, options })
    return RESULT
  }) as Call
  return createEnergyStage({ db: testDatabase.db, python: () => ({ call }) })
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  const [id] = insertTracks(testDatabase.db, [
    {
      path: '/Music/one.mp3',
      originalPath: '/Music/one.mp3',
      format: 'mp3',
      fileSizeBytes: 1000,
      fileMtimeMs: 5000
    }
  ]) as [number]
  track = getTrackById(testDatabase.db, id, new Set()) as Track
  calls = []
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('the energy features stage', () => {
  it('asks the sidecar about the file of the track and proposes nothing', async () => {
    // Arrange
    const signal = new AbortController().signal

    // Act
    const outcome = await stage().run(context(signal), track)

    // Assert
    expect(outcome).toBeUndefined()
    const [{ method, params, options }] = calls as [(typeof calls)[number]]
    const { jobId } = params as { jobId: string }
    expect(method).toBe('analysis.energy_features')
    expect(params).toEqual({ path: '/Music/one.mp3', jobId })
    expect(options).toEqual({ timeoutMs: 120_000, job: { id: jobId, signal } })
  })

  it('keeps the features with the file as it was', async () => {
    // Act
    await stage().run(context(), track)

    // Assert
    expect(getAnalysis(testDatabase.db, track.id, 'energy_features', z.unknown())).toEqual({
      result: { features: RESULT.features, fileSizeBytes: 1000, fileMtimeMs: 5000 },
      analyzerVersion: ENERGY_ANALYZER_VERSION
    })
    expect(keptEnergyFeatures(testDatabase.db, track)).toEqual(RESULT.features)
  })

  it('does not analyse a track again while its file and the analyzer are the same', async () => {
    // Arrange
    const analysing = stage()
    await analysing.run(context(), track)

    // Act
    await analysing.run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
  })

  it('analyses a track again when its file changed', async () => {
    // Arrange
    const analysing = stage()
    await analysing.run(context(), track)

    // Act
    await analysing.run(context(), { ...track, fileMtimeMs: 6000 })

    // Assert
    expect(calls).toHaveLength(2)
  })

  it('analyses a track again when the kept result is of another analyzer version', async () => {
    // Arrange
    saveAnalysis(testDatabase.db, {
      trackId: track.id,
      type: 'energy_features',
      result: { features: RESULT.features, fileSizeBytes: 1000, fileMtimeMs: 5000 },
      analyzerVersion: 'older'
    })

    // Act
    await stage().run(context(), track)

    // Assert
    expect(calls).toHaveLength(1)
  })

  it('keeps nothing when the run was stopped while the sidecar answered', async () => {
    // Arrange
    const stopping = new AbortController()
    stopping.abort()

    // Act
    const run = stage().run(context(stopping.signal), track)

    // Assert
    await expect(run).rejects.toThrow('stopped')
    expect(getAnalysis(testDatabase.db, track.id, 'energy_features', z.unknown())).toBeUndefined()
  })
})
