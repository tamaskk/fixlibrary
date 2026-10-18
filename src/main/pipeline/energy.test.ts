import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveAnalysis } from '../db/analyses'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { addStyle } from '../db/styles'
import { getTrackById, insertTracks, updateTrack, type Track } from '../db/tracks'
import type { PythonBridge } from '../services/python-bridge'
import type { EnergyModel } from '@shared/energy'
import { ENERGY_ANALYZER_VERSION } from '@shared/rpc'
import {
  calibrationView,
  currentEnergyModel,
  fitEnergyModel,
  newCalibrationSample,
  rateCalibrationTrack,
  type EnergyCalibrationDependencies
} from './energy'
import { createEnergyValueStage } from './stages/energy-value'
import type { StageContext } from './stages/stage'

// Loudness alone decides: the model the fake sidecar answers with.
const MODEL: EnergyModel = {
  names: ['rmsDb'],
  means: [-14],
  scales: [4],
  weights: [2],
  intercept: 5.5,
  looMae: 0.8
}

let testDatabase: TestDatabase
let fitCalls: unknown[]
let dependencies: EnergyCalibrationDependencies

function newStyle(name: string): { id: number } {
  const style = addStyle(testDatabase.db, name, '#ffffff')
  if (!style) throw new Error('the style was not added')
  return style
}

function addMeasuredTracks(count: number, styleId: number | null): number[] {
  const ids = insertTracks(
    testDatabase.db,
    Array.from({ length: count }, () => {
      const path = `/Music/${styleId}-${Math.random()}.mp3`
      return {
        path,
        originalPath: path,
        format: 'mp3' as const,
        fileSizeBytes: 10,
        fileMtimeMs: 20
      }
    })
  )
  ids.forEach((id, index) => {
    if (styleId !== null) updateTrack(testDatabase.db, id, { primaryStyleId: styleId })
    saveAnalysis(testDatabase.db, {
      trackId: id,
      type: 'energy_features',
      result: {
        features: {
          integratedLufs: -10,
          rmsDb: -20 + index,
          percussiveRatio: 0.5,
          onsetRate: 2,
          spectralCentroidHz: 2000,
          spectralFlux: 0.1,
          lowRatio: 0.3
        },
        fileSizeBytes: 10,
        fileMtimeMs: 20
      },
      analyzerVersion: ENERGY_ANALYZER_VERSION
    })
  })
  return ids
}

function rateAll(rating: (index: number) => number): void {
  const view = calibrationView(dependencies)
  view.sample.forEach((item, index) =>
    rateCalibrationTrack(dependencies, { trackId: item.trackId, rating: rating(index) })
  )
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  fitCalls = []
  const call = (async (method: string, params: unknown) => {
    fitCalls.push({ method, params })
    return MODEL
  }) as PythonBridge['call']
  dependencies = { db: testDatabase.db, python: () => ({ call }) }
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('the calibration sample', () => {
  it('is chosen from the measured tracks once, and kept', () => {
    // Arrange
    const style = newStyle('Tech House')
    addMeasuredTracks(20, style.id)

    // Act
    const first = calibrationView(dependencies)
    const second = calibrationView(dependencies)

    // Assert
    expect(first.measuredCount).toBe(20)
    expect(first.sample.length).toBeGreaterThanOrEqual(3)
    expect(second.sample.map((item) => item.trackId)).toEqual(
      first.sample.map((item) => item.trackId)
    )
    expect(first.sample[0]?.styleName).toBe('Tech House')
  })

  it('is empty while no track is measured', () => {
    // Act
    const view = calibrationView(dependencies)

    // Assert
    expect(view).toEqual({ measuredCount: 0, sample: [], ratedCount: 0, model: null })
  })

  it('takes a rating only for a track of the sample', () => {
    // Arrange
    const [outside] = addMeasuredTracks(40, null)
    const sampled = calibrationView(dependencies).sample.map((item) => item.trackId)
    const notSampled = sampled.includes(outside as number) ? -1 : (outside as number)

    // Act
    const refused = rateCalibrationTrack(dependencies, { trackId: notSampled, rating: 5 })
    const taken = rateCalibrationTrack(dependencies, { trackId: sampled[0] as number, rating: 7 })

    // Assert
    expect(refused).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(taken.ok && taken.value.sample[0]?.rating).toBe(7)
    expect(taken.ok && taken.value.ratedCount).toBe(1)
  })

  it('keeps the ratings when a new sample is chosen', () => {
    // Arrange
    addMeasuredTracks(12, null)
    const [first] = calibrationView(dependencies).sample
    rateCalibrationTrack(dependencies, { trackId: first?.trackId as number, rating: 4 })

    // Act
    const view = newCalibrationSample(dependencies)

    // Assert
    expect(view.sample.find((item) => item.trackId === first?.trackId)?.rating).toBe(4)
  })
})

describe('fitting the model', () => {
  it('needs 10 ratings', async () => {
    // Arrange
    addMeasuredTracks(12, null)
    const [first] = calibrationView(dependencies).sample
    rateCalibrationTrack(dependencies, { trackId: first?.trackId as number, rating: 4 })

    // Act
    const result = await fitEnergyModel(dependencies)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(fitCalls).toEqual([])
  })

  it('sends the rated features to the sidecar and keeps the model with the scales', async () => {
    // Arrange
    const style = newStyle('Organic House')
    addMeasuredTracks(20, style.id)
    // A style gives five tracks at most; the rest of the ten come from those without.
    addMeasuredTracks(15, null)
    rateAll((index) => 1 + (index % 10))

    // Act
    const result = await fitEnergyModel(dependencies)

    // Assert
    expect(result.ok && result.value.model?.looMae).toBe(0.8)
    const [{ method, params }] = fitCalls as [{ method: string; params: { samples: unknown[] } }]
    expect(method).toBe('energy.fit')
    expect(params.samples.length).toBe(calibrationView(dependencies).ratedCount)
    const kept = currentEnergyModel(testDatabase.db)
    expect(Object.keys(kept?.styles ?? {})).toEqual([String(style.id)])
    expect(kept?.library.high).toBeGreaterThan(kept?.library.low ?? 0)
  })
})

describe('the energy stage', () => {
  function context(): StageContext {
    return { signal: new AbortController().signal, batchId: 1, files: null, proposal: {} }
  }

  function trackOf(id: number): Track {
    return getTrackById(testDatabase.db, id, new Set()) as Track
  }

  it('proposes nothing before the calibration', async () => {
    // Arrange
    const [id] = addMeasuredTracks(1, null)

    // Act
    const outcome = await createEnergyValueStage(dependencies).run(context(), trackOf(id as number))

    // Assert
    expect(outcome).toBeUndefined()
  })

  it('puts the quietest track of a style low and the loudest high on its scale', async () => {
    // Arrange
    const style = newStyle('Deep House')
    const ids = addMeasuredTracks(20, style.id)
    addMeasuredTracks(15, null)
    rateAll((index) => 1 + (index % 10))
    await fitEnergyModel(dependencies)
    const stage = createEnergyValueStage(dependencies)

    // Act
    const quiet = await stage.run(context(), trackOf(ids[0] as number))
    const loud = await stage.run(context(), trackOf(ids[19] as number))

    // Assert
    expect(quiet?.proposal?.fields?.energy).toEqual({ value: 1, source: 'analysis' })
    expect(loud?.proposal?.fields?.energy).toEqual({ value: 10, source: 'analysis' })
  })

  it('leaves an energy the user locked', async () => {
    // Arrange
    const ids = addMeasuredTracks(12, null)
    rateAll(() => 5)
    await fitEnergyModel(dependencies)
    updateTrack(testDatabase.db, ids[0] as number, { energy: 3, lockedFields: ['energy'] })

    // Act
    const outcome = await createEnergyValueStage(dependencies).run(
      context(),
      trackOf(ids[0] as number)
    )

    // Assert
    expect(outcome).toBeUndefined()
  })
})
