// The plan of a normalization (T-032): the gain that brings a track to the target
// loudness, how it is applied, and whether it can be applied at all. Pure, so that the
// preview, the apply stage and the A/B player of T-033 compute the same gain.
import type { NormalizeApplyPlan } from './rpc'
import type { NormalizationMethod } from './settings'

/** One step of mp3gain: the gain field of an MP3 frame counts in 1.5 dB. */
export const LOSSLESS_STEP_DB = 1.5

/** The highest true peak a track may have after its gain was raised. */
export const MAX_TRUE_PEAK_DBTP = -1

/**
 * How far a measure may be from what it is compared with: ffmpeg prints the values to a
 * tenth, and dither or a new encoding moves a peak by a few hundredths.
 */
const MEASURE_SLACK_DB = 0.1

/** The most gain the sidecar applies either way (`normalize.apply`). */
export const MAX_GAIN_DB = 39

/** A gain smaller than this changes nothing one can measure: the track is at its target. */
const LEAST_GAIN_DB = 0.1

/** How far from the target a track may be measured after it was normalized. */
export const NORMALIZE_TOLERANCE_LU = {
  exact: 0.2,
  // Half a step of mp3gain.
  steps: LOSSLESS_STEP_DB / 2
} as const

/** How a gain is applied: to an MP3 by steps or encoded again, to the samples of an AIFF or WAV. */
export type NormalizeKind = NormalizeApplyPlan['kind']

export interface MeasuredLoudness {
  integratedLufs: number
  truePeakDbtp: number
}

export type NormalizePlan =
  | {
      action: 'apply'
      kind: NormalizeKind
      /** The gain that is applied: the needed one, by steps of 1.5 dB for mp3gain. */
      gainDb: number
      expectedLufs: number
      expectedTruePeakDbtp: number
      /** How far from `expectedLufs` the measure after the apply may be. */
      toleranceLu: number
    }
  /** At its target already, as near as the method can bring it. */
  | { action: 'none'; kind: NormalizeKind }
  /**
   * The gain would take the true peak above −1 dBTP, and no limiter is used; or it is
   * more than the most the sidecar applies.
   */
  | { action: 'skip'; kind: NormalizeKind; neededGainDb: number; possibleGainDb: number }

/** The way a file is normalized, by its name: null for a format the app does not normalize. */
export function normalizeKindOf(
  fileName: string,
  method: NormalizationMethod
): NormalizeKind | null {
  const name = fileName.toLowerCase()
  if (name.endsWith('.mp3')) return method === 'lossless' ? 'mp3gain' : 'reencode'
  if (name.endsWith('.aif') || name.endsWith('.aiff') || name.endsWith('.wav')) return 'pcm'
  return null
}

// Half away from zero, as `round` reads in the plan: −2.5 steps are −3, not −2.
function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

// Two places: what a gain or a level is shown and stored with.
function hundredths(value: number): number {
  return Math.round(value * 100) / 100 + 0
}

/**
 * The plan for one measured track. A gain that lowers the track is always applied;
 * one that raises it is applied only while the true peak stays at or below −1 dBTP,
 * otherwise the track is skipped with the gain it needed and the gain it could have had.
 */
export function planNormalization(
  measured: MeasuredLoudness,
  targetLufs: number,
  kind: NormalizeKind
): NormalizePlan {
  const needed = targetLufs - measured.integratedLufs
  const steps = kind === 'mp3gain' ? roundHalfAway(needed / LOSSLESS_STEP_DB) : null
  const gain = steps === null ? needed : steps * LOSSLESS_STEP_DB
  if (steps === 0 || Math.abs(gain) < LEAST_GAIN_DB) return { action: 'none', kind }
  const headroom = MAX_TRUE_PEAK_DBTP - measured.truePeakDbtp
  const room = Math.min(headroom, MAX_GAIN_DB)
  // A thousandth of a dB is the rounding of the values, not a peak above the limit.
  if (gain > 0 && gain > room + 0.001) {
    const possible =
      steps === null
        ? Math.floor(room * 10) / 10
        : Math.floor(room / LOSSLESS_STEP_DB) * LOSSLESS_STEP_DB
    return {
      action: 'skip',
      kind,
      neededGainDb: hundredths(needed),
      possibleGainDb: hundredths(Math.max(0, possible))
    }
  }
  return {
    action: 'apply',
    kind,
    gainDb: hundredths(gain),
    expectedLufs: hundredths(measured.integratedLufs + gain),
    expectedTruePeakDbtp: hundredths(measured.truePeakDbtp + gain),
    toleranceLu: kind === 'mp3gain' ? NORMALIZE_TOLERANCE_LU.steps : NORMALIZE_TOLERANCE_LU.exact
  }
}

/** What the sidecar is given to apply a plan. */
export function applyPlanOf(plan: Extract<NormalizePlan, { action: 'apply' }>): NormalizeApplyPlan {
  return plan.kind === 'mp3gain'
    ? { kind: 'mp3gain', steps: Math.round(plan.gainDb / LOSSLESS_STEP_DB) }
    : { kind: plan.kind, gainDb: plan.gainDb }
}

/**
 * Whether a track measured after its apply is what the plan promised: its loudness
 * within the tolerance of the expected one, and, where the gain raised it, its true
 * peak at or below −1 dBTP.
 */
export function reachedPlan(
  plan: Extract<NormalizePlan, { action: 'apply' }>,
  after: MeasuredLoudness
): boolean {
  const loudnessHeld =
    Math.abs(after.integratedLufs - plan.expectedLufs) <= plan.toleranceLu + MEASURE_SLACK_DB / 2
  const peakHeld = plan.gainDb < 0 || after.truePeakDbtp <= MAX_TRUE_PEAK_DBTP + MEASURE_SLACK_DB
  return loudnessHeld && peakHeld
}
