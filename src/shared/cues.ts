// The eight hot cues of the fixed scheme as the preview shows them (T-029).
import { HOT_CUE_LETTERS } from './settings'

/** A hot cue: slot 1 is A, 8 is H; where it is, in ms. */
export interface PlacedCue {
  slot: number
  positionMs: number
}

const EMPTY_SLOT = '–'

/**
 * The cues of a track by their letters, a dash for an empty slot: `A B – D E F G –`.
 * Null when it has none at all.
 */
export function cueLettersOf(cues: readonly Pick<PlacedCue, 'slot'>[]): string | null {
  if (cues.length === 0) return null
  const filled = new Set(cues.map((cue) => cue.slot))
  return HOT_CUE_LETTERS.map((letter, index) => (filled.has(index + 1) ? letter : EMPTY_SLOT)).join(
    ' '
  )
}
