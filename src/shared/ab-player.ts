// The A/B player of the preview (T-033): the original (A) and what the normalization
// will make of it (B) from one source. Both ways of normalizing are a linear gain, so B
// is A played louder or softer by the gain the plan applies: by whole steps of mp3gain
// for a lossless MP3, exactly otherwise. The plan's gain (shared/normalize.ts) is
// rounded so already.

/** How long a switch between A and B fades over, in seconds: no click, no gap. */
export const AB_CROSSFADE_S = 0.02

/** The gain of each branch as a factor of the signal: A as it is, B by the plan. */
export function abGainsOf(gainDb: number | null): { a: number; b: number } {
  return { a: 1, b: gainDb === null ? 1 : 10 ** (gainDb / 20) }
}

/** A level as a factor, in dB; −∞ for silence. */
export function decibelsOf(factor: number): number {
  return factor > 0 ? 20 * Math.log10(factor) : Number.NEGATIVE_INFINITY
}

/** The root mean square of samples, as an analyser node gives them. */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] as number
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

/** Whether a preview row has something to listen to: a gain the normalization will apply. */
export function canListen(row: { cells: { gain: { after: unknown } } }): boolean {
  return typeof row.cells.gain.after === 'number'
}
