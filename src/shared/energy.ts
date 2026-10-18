// The energy of a track on the user's own 1–10 scale (T-024): the model fitted to their
// ratings, the scale of each style, and which tracks they are asked to rate. Pure.
import { z } from 'zod'

/** The features of `analysis.energy_features` the model reads, by name. */
export type EnergyFeatures = Record<string, number>

export const energyModelSchema = z
  .object({
    names: z.array(z.string().min(1).max(64)).min(1).max(32),
    means: z.array(z.number()),
    scales: z.array(z.number().positive()),
    weights: z.array(z.number()),
    intercept: z.number(),
    /** The mean error of a rating left out of the fit, in steps of the scale. */
    looMae: z.number().nonnegative()
  })
  .refine(
    (model) =>
      model.means.length === model.names.length &&
      model.scales.length === model.names.length &&
      model.weights.length === model.names.length
  )

export type EnergyModel = z.output<typeof energyModelSchema>

/** Where a style's raw scores lie: what maps to 1 and what to 10. */
export const scoreRangeSchema = z.object({ low: z.number(), high: z.number() })
export type ScoreRange = z.output<typeof scoreRangeSchema>

/** The model as the app keeps it, with the scales it set when it was fitted. */
export const keptEnergyModelSchema = z.object({
  model: energyModelSchema,
  /** The analyzer the features were measured by; another one asks for a new fit. */
  analyzerVersion: z.string(),
  /** The scale of the whole library: for a small style and a track with none. */
  library: scoreRangeSchema,
  /** By style id, for each style of at least MIN_STYLE_TRACKS tracks. */
  styles: z.record(z.string().regex(/^[1-9][0-9]*$/u), scoreRangeSchema),
  ratedCount: z.number().int().nonnegative(),
  fittedAt: z.number()
})
export type KeptEnergyModel = z.output<typeof keptEnergyModelSchema>

/** A style with fewer tracks is scaled with the whole library, and sampled with it. */
export const MIN_STYLE_TRACKS = 10
export const MIN_SAMPLE_PER_STYLE = 3
export const MAX_SAMPLE_PER_STYLE = 5
export const MAX_SAMPLE = 30
/** Fewer ratings than this make no model worth trusting. */
export const MIN_RATINGS_TO_FIT = 10
// The ends of a scale: the loudest and the quietest few tracks do not stretch it.
const LOW_PERCENTILE = 5
const HIGH_PERCENTILE = 95

/** The raw score of a track: what the model makes of its features, near the 1–10 range. */
export function scoreOf(model: EnergyModel, features: EnergyFeatures): number | null {
  let score = model.intercept
  for (const [index, name] of model.names.entries()) {
    const value = features[name]
    if (value === undefined || !Number.isFinite(value)) return null
    score +=
      ((model.weights[index] ?? 0) * (value - (model.means[index] ?? 0))) /
      (model.scales[index] ?? 1)
  }
  return score
}

/** A raw score on its style's scale: the low end 1, the high end 10, whole, clamped. */
export function energyOf(score: number, range: ScoreRange): number {
  const span = range.high - range.low
  const value = span > 0 ? 1 + (9 * (score - range.low)) / span : 5.5
  return Math.min(10, Math.max(1, Math.round(value)))
}

/** The value at `percent` of sorted numbers, between the two nearest. */
export function percentileOf(sorted: readonly number[], percent: number): number {
  if (sorted.length === 0) return 0
  const at = ((sorted.length - 1) * percent) / 100
  const below = Math.floor(at)
  const low = sorted[below] ?? 0
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low
  return low + (high - low) * (at - below)
}

function rangeOf(scores: readonly number[]): ScoreRange {
  const sorted = [...scores].sort((a, b) => a - b)
  return {
    low: percentileOf(sorted, LOW_PERCENTILE),
    high: percentileOf(sorted, HIGH_PERCENTILE)
  }
}

export interface ScoredTrack {
  trackId: number
  styleId: number | null
  score: number
}

/** The scale of the library, and of each style that has enough tracks for its own. */
export function scoreRanges(tracks: readonly ScoredTrack[]): {
  library: ScoreRange
  styles: Record<string, ScoreRange>
} {
  const styles: Record<string, ScoreRange> = {}
  for (const [styleId, members] of byStyle(tracks)) {
    if (styleId !== null && members.length >= MIN_STYLE_TRACKS) {
      styles[String(styleId)] = rangeOf(members.map((track) => track.score))
    }
  }
  return { library: rangeOf(tracks.map((track) => track.score)), styles }
}

/** The 1–10 energy of a track by the kept model, or null when it cannot be told. */
export function energyByModel(
  kept: KeptEnergyModel,
  features: EnergyFeatures,
  styleId: number | null
): number | null {
  const score = scoreOf(kept.model, features)
  if (score === null) return null
  const range = (styleId !== null && kept.styles[String(styleId)]) || kept.library
  return energyOf(score, range)
}

function byStyle(tracks: readonly ScoredTrack[]): Map<number | null, ScoredTrack[]> {
  const groups = new Map<number | null, ScoredTrack[]>()
  for (const track of tracks) {
    const group = groups.get(track.styleId) ?? []
    group.push(track)
    groups.set(track.styleId, group)
  }
  return groups
}

/** `count` tracks spread over the scores, from the lowest to the highest. */
function spread(tracks: readonly ScoredTrack[], count: number): ScoredTrack[] {
  const sorted = [...tracks].sort((a, b) => a.score - b.score || a.trackId - b.trackId)
  if (count >= sorted.length) return sorted
  const picked = new Set<number>()
  for (let index = 0; index < count; index++) {
    picked.add(Math.round((index * (sorted.length - 1)) / Math.max(1, count - 1)))
  }
  return [...picked].map((at) => sorted[at] as ScoredTrack)
}

/**
 * The tracks to rate: from each style of at least MIN_STYLE_TRACKS tracks 3 to 5,
 * spread from its quietest to its hardest, and from the small styles and the tracks
 * without a style together what room is left (5 kept for them at least); MAX_SAMPLE at most. The largest styles come first when not all fit.
 */
export function selectCalibrationSample(tracks: readonly ScoredTrack[]): number[] {
  const groups = byStyle(tracks)
  const large = [...groups]
    .filter(([styleId, members]) => styleId !== null && members.length >= MIN_STYLE_TRACKS)
    .sort((a, b) => b[1].length - a[1].length || (a[0] ?? 0) - (b[0] ?? 0))
    .slice(0, Math.floor(MAX_SAMPLE / MIN_SAMPLE_PER_STYLE))
  const rest = tracks.filter((track) => !large.some(([styleId]) => styleId === track.styleId))
  // Each large style its least, then more for each while there is room, a round at a time.
  const counts = large.map(() => MIN_SAMPLE_PER_STYLE)
  let room = MAX_SAMPLE - counts.reduce((sum, count) => sum + count, 0)
  const restShare = rest.length > 0 ? Math.min(rest.length, MAX_SAMPLE_PER_STYLE) : 0
  room -= Math.min(room, restShare)
  for (let round = MIN_SAMPLE_PER_STYLE; round < MAX_SAMPLE_PER_STYLE && room > 0; round++) {
    for (let index = 0; index < counts.length && room > 0; index++) {
      counts[index] = (counts[index] ?? 0) + 1
      room -= 1
    }
  }
  const picked = large.flatMap(([, members], index) => spread(members, counts[index] ?? 0))
  const restCount = Math.min(rest.length, MAX_SAMPLE - picked.length)
  return [...picked, ...spread(rest, restCount)].map((track) => track.trackId)
}

/**
 * A score for tracks before any model: the features that rise with energy, each on the
 * scale of the library, summed. Only to spread the first sample over the range.
 */
export function defaultScores(
  tracks: readonly { trackId: number; styleId: number | null; features: EnergyFeatures }[]
): ScoredTrack[] {
  const names = ['rmsDb', 'percussiveRatio', 'onsetRate', 'spectralFlux', 'lowRatio']
  const stats = names.map((name) => {
    const values = tracks.map((track) => track.features[name] ?? 0)
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length)
    return { name, mean, scale: Math.sqrt(variance) || 1 }
  })
  return tracks.map((track) => ({
    trackId: track.trackId,
    styleId: track.styleId,
    score: stats.reduce(
      (sum, { name, mean, scale }) => sum + ((track.features[name] ?? mean) - mean) / scale,
      0
    )
  }))
}

/** One track of the calibration sample, as the page shows it. */
export interface CalibrationItem {
  trackId: number
  fileName: string
  artist: string | null
  title: string | null
  /** The track's primary style, or null for none. */
  styleName: string | null
  /** The user's rating, 1 to 10, or null while they have not rated it. */
  rating: number | null
}

/** What the calibration page shows. */
export interface CalibrationView {
  /** Tracks whose energy features are measured for their file as it is. */
  measuredCount: number
  sample: CalibrationItem[]
  ratedCount: number
  /** The kept model, or null while there is none. */
  model: {
    /** The mean error of a rating left out of the fit, in steps of the scale. */
    looMae: number
    ratedCount: number
    fittedAt: number
    /** Fitted to features of another analyzer: the next fit replaces it. */
    stale: boolean
  } | null
}

export const calibrationRatingSchema = z.object({
  trackId: z.number().int().positive(),
  rating: z.number().int().min(1).max(10)
})
export type CalibrationRating = z.output<typeof calibrationRatingSchema>
