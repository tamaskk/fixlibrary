// How the hot cues the app placed compare with the owner's own (T-029, scripts/eval-cues.ts):
// a cue counts as found when it is at most one bar from the owner's.
import { HOT_CUE_LETTERS } from './settings'
import { splitCsvLine } from './style-eval'

/** One cue the owner placed: the file, the slot (1 is A) and where, in seconds. */
export interface ExpectedCue {
  fileName: string
  slot: number
  seconds: number
}

/**
 * The rows of `cues.csv`: file name, slot (a letter A–H or 1–8) and seconds. A header,
 * blank lines and rows that are not one of these are left out.
 */
export function parseCuesCsv(text: string): ExpectedCue[] {
  const rows: ExpectedCue[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const [fileName, slotText, secondsText] = splitCsvLine(line).map((cell) => cell.trim())
    if (!fileName || !slotText || !secondsText) continue
    const letter = HOT_CUE_LETTERS.indexOf(
      slotText.toUpperCase() as (typeof HOT_CUE_LETTERS)[number]
    )
    const slot = letter !== -1 ? letter + 1 : Number(slotText)
    const seconds = Number(secondsText.replace(',', '.'))
    if (
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > 8 ||
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      continue
    }
    rows.push({ fileName, slot, seconds })
  }
  return rows
}

/** What the app has for one file: its cues by slot (ms), and how long a bar is at a time. */
export interface PlacedTrack {
  cues: ReadonlyMap<number, number>
  barSeconds: (seconds: number) => number
}

export interface CueMiss {
  fileName: string
  slot: number
  expectedSeconds: number
  foundSeconds: number | null
  /** How many bars away, or null when the app left the slot empty. */
  bars: number | null
}

export interface CueEvaluation {
  compared: number
  found: number
  rate: number
  misses: CueMiss[]
  /** Files of the CSV the library has no track for. */
  missing: string[]
}

/** Compares the owner's cues with the app's: found within one bar. */
export function evaluateCues(
  expected: readonly ExpectedCue[],
  placed: (fileName: string) => PlacedTrack | null
): CueEvaluation {
  const misses: CueMiss[] = []
  const missing = new Set<string>()
  let compared = 0
  let found = 0
  for (const cue of expected) {
    const track = placed(cue.fileName)
    if (!track) {
      missing.add(cue.fileName)
      continue
    }
    compared += 1
    const at = track.cues.get(cue.slot)
    const foundSeconds = at === undefined ? null : at / 1000
    const bars =
      foundSeconds === null
        ? null
        : Math.abs(foundSeconds - cue.seconds) / track.barSeconds(cue.seconds)
    if (bars !== null && bars <= 1 + 1e-9) found += 1
    else
      misses.push({
        fileName: cue.fileName,
        slot: cue.slot,
        expectedSeconds: cue.seconds,
        foundSeconds,
        bars
      })
  }
  return {
    compared,
    found,
    rate: compared === 0 ? 0 : found / compared,
    misses,
    missing: [...missing]
  }
}
