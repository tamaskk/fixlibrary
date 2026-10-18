// The energy calibration (T-024): the sample of tracks the user rates, the model fitted
// to their ratings, and the scale of each style the model's scores are put on. The
// model and the sample are kept in the settings table; the ratings in their own.
import { basename } from 'path'
import { z } from 'zod'
import { listAnalysesOfType } from '../db/analyses'
import type { AppDatabase } from '../db/connection'
import {
  listCalibrationTracks,
  listEnergyRatings,
  saveEnergyRating,
  type CalibrationTrack
} from '../db/energy-calibration'
import { getSetting, setSetting } from '../db/settings'
import { listStyles } from '../db/styles'
import { describeError } from '../services/error-text'
import { logger } from '../services/logger'
import type { PythonBridge } from '../services/python-bridge'
import { currentEnergyFeatures } from './stages/energy'
import {
  defaultScores,
  keptEnergyModelSchema,
  MIN_RATINGS_TO_FIT,
  scoreOf,
  scoreRanges,
  selectCalibrationSample,
  type CalibrationRating,
  type CalibrationView,
  type EnergyFeatures,
  type EnergyModel,
  type KeptEnergyModel,
  type ScoredTrack
} from '@shared/energy'
import { AppError, type Result } from '@shared/errors'
import { ENERGY_ANALYZER_VERSION } from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'

const MODEL_KEY = 'energyModel'
const SAMPLE_KEY = 'energyCalibrationSample'
const sampleSchema = z.array(z.number().int().positive()).max(1000)

export interface EnergyCalibrationDependencies {
  db: AppDatabase
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
}

/** The kept model, or null while there is none or it cannot be read. */
export function readEnergyModel(db: AppDatabase): KeptEnergyModel | null {
  try {
    return getSetting(db, MODEL_KEY, keptEnergyModelSchema) ?? null
  } catch (error) {
    logger.warn(`The kept energy model is unreadable: ${describeError(error)}`)
    return null
  }
}

/** The kept model, if it was fitted to features of the analyzer of this build. */
export function currentEnergyModel(db: AppDatabase): KeptEnergyModel | null {
  const kept = readEnergyModel(db)
  return kept?.analyzerVersion === ENERGY_ANALYZER_VERSION ? kept : null
}

interface MeasuredTrack extends CalibrationTrack {
  features: EnergyFeatures
}

/** The tracks whose features are measured for their file as it is. */
function measuredTracks(db: AppDatabase): MeasuredTrack[] {
  const stored = listAnalysesOfType(db, 'energy_features')
  const measured: MeasuredTrack[] = []
  for (const track of listCalibrationTracks(db)) {
    const features = currentEnergyFeatures(stored.get(track.id), track)
    if (features) measured.push({ ...track, features })
  }
  return measured
}

function scored(tracks: readonly MeasuredTrack[], model: EnergyModel | null): ScoredTrack[] {
  const input = tracks.map((track) => ({
    trackId: track.id,
    styleId: track.primaryStyleId,
    features: track.features
  }))
  if (!model) return defaultScores(input)
  return input.flatMap((track) => {
    const score = scoreOf(model, track.features)
    return score === null ? [] : [{ trackId: track.trackId, styleId: track.styleId, score }]
  })
}

function keptSample(db: AppDatabase): number[] | null {
  try {
    return getSetting(db, SAMPLE_KEY, sampleSchema) ?? null
  } catch (error) {
    logger.warn(`The kept calibration sample is unreadable: ${describeError(error)}`)
    return null
  }
}

function viewOf(
  db: AppDatabase,
  measured: readonly MeasuredTrack[],
  sample: readonly number[]
): CalibrationView {
  const ratings = listEnergyRatings(db)
  const styles = new Map(listStyles(db).map((style) => [style.id, style.name]))
  const byId = new Map(measured.map((track) => [track.id, track]))
  const items = sample.flatMap((trackId) => {
    const track = byId.get(trackId)
    if (!track) return []
    return [
      {
        trackId,
        fileName: basename(track.path),
        artist: track.artist,
        title: track.title,
        styleName:
          track.primaryStyleId === null ? null : (styles.get(track.primaryStyleId) ?? null),
        rating: ratings.get(trackId) ?? null
      }
    ]
  })
  const kept = readEnergyModel(db)
  const view: CalibrationView = {
    measuredCount: measured.length,
    sample: items,
    ratedCount: ratings.size,
    model: kept && {
      looMae: kept.model.looMae,
      ratedCount: kept.ratedCount,
      fittedAt: kept.fittedAt,
      stale: kept.analyzerVersion !== ENERGY_ANALYZER_VERSION
    }
  }
  return view
}

/**
 * What the calibration page shows. The first time there are measured tracks a sample
 * is chosen and kept; tracks of it that are gone or no longer measured drop out.
 */
export function calibrationView(dependencies: EnergyCalibrationDependencies): CalibrationView {
  const { db } = dependencies
  const measured = measuredTracks(db)
  let sample = keptSample(db)
  if (sample === null && measured.length > 0) {
    sample = selectCalibrationSample(scored(measured, currentEnergyModel(db)?.model ?? null))
    setSetting(db, SAMPLE_KEY, sample)
  }
  return viewOf(db, measured, sample ?? [])
}

/**
 * Chooses a new sample from the tracks not rated yet: by the model's scores when there
 * is one, so the new tracks spread over what the model calls calm and hard. When every
 * measured track is rated, from all of them. The ratings given stay, and count.
 */
export function newCalibrationSample(dependencies: EnergyCalibrationDependencies): CalibrationView {
  const { db } = dependencies
  const measured = measuredTracks(db)
  const ratings = listEnergyRatings(db)
  const unrated = measured.filter((track) => !ratings.has(track.id))
  const sample = selectCalibrationSample(
    scored(unrated.length > 0 ? unrated : measured, currentEnergyModel(db)?.model ?? null)
  )
  setSetting(db, SAMPLE_KEY, sample)
  return viewOf(db, measured, sample)
}

/**
 * Keeps the user's rating of a track of the sample, and answers with how many ratings
 * there are now. Reads the sample only: the page asks for this on every choice.
 */
export function rateCalibrationTrack(
  dependencies: EnergyCalibrationDependencies,
  { trackId, rating }: CalibrationRating
): Result<{ ratedCount: number }> {
  const { db } = dependencies
  if (!(keptSample(db) ?? []).includes(trackId)) return { ok: false, code: 'INVALID_INPUT' }
  saveEnergyRating(db, trackId, rating)
  return { ok: true, value: { ratedCount: listEnergyRatings(db).size } }
}

// One fit at a time: a second would race the first to the kept model.
const fitsInFlight = new WeakMap<AppDatabase, Promise<Result<CalibrationView>>>()

/**
 * Fits the model to every rated track that is measured, and sets the scale of every
 * style by the scores of the library's measured tracks. Replaces the kept model. Asked
 * again while it runs, it answers with the fit that runs.
 */
export function fitEnergyModel(
  dependencies: EnergyCalibrationDependencies
): Promise<Result<CalibrationView>> {
  const running = fitsInFlight.get(dependencies.db)
  if (running) return running
  const fit = fitOnce(dependencies).finally(() => fitsInFlight.delete(dependencies.db))
  fitsInFlight.set(dependencies.db, fit)
  return fit
}

async function fitOnce(
  dependencies: EnergyCalibrationDependencies
): Promise<Result<CalibrationView>> {
  const { db } = dependencies
  const measured = measuredTracks(db)
  const ratings = listEnergyRatings(db)
  const samples = measured.flatMap((track) => {
    const rating = ratings.get(track.id)
    return rating === undefined ? [] : [{ features: track.features, rating }]
  })
  // Ratings that are all the same say nothing; the sidecar refuses them too.
  const varied = new Set(samples.map((sample) => sample.rating)).size > 1
  if (samples.length < MIN_RATINGS_TO_FIT || !varied) return { ok: false, code: 'INVALID_INPUT' }
  const python = dependencies.python()
  if (!python) return { ok: false, code: 'PYTHON_CRASHED' }
  let model
  try {
    model = await python.call('energy.fit', { samples }, { timeoutMs: STAGE_TIMEOUTS_MS.energy })
  } catch (error) {
    logger.error(`The energy model could not be fitted: ${describeError(error)}`)
    return { ok: false, code: error instanceof AppError ? error.code : 'PYTHON_ERROR' }
  }
  const kept: KeptEnergyModel = {
    model,
    analyzerVersion: ENERGY_ANALYZER_VERSION,
    ...scoreRanges(scored(measured, model)),
    ratedCount: samples.length,
    fittedAt: Date.now()
  }
  setSetting(db, MODEL_KEY, kept)
  return { ok: true, value: viewOf(db, measured, keptSample(db) ?? []) }
}
