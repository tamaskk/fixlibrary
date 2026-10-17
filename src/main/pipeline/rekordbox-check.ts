// What the checks of the Rekordbox wizard (T-027) make of an export: which steps of
// phase A are to be done again, and, for phase B, whether every hot cue is in place.
import type { RekordboxExportCheck } from '@shared/rekordbox'
import type { CheckHold, CheckVerdict, WizardStep } from '@shared/rekordbox-wizard'

/**
 * The verdict on an export after phase A. Tracks it lacks: import them again (3.3).
 * Entries pointing at no file: remove the missing ones again (3.6). Tracks without a
 * grid: wait for the analysis (3.5). Only a check with none of these, of an export
 * made since the export step was reached, and with every entry read and looked at, is
 * clean.
 */
export function judgeExportCheck(
  check: RekordboxExportCheck,
  exportFrom: number | null = null
): CheckVerdict {
  const repeat: WizardStep[] = []
  if (check.notInExport.count > 0) repeat.push('a.importTracks')
  if (check.unanalysed.count > 0) repeat.push('a.waitAnalysis')
  if (check.missingFiles.count > 0) repeat.push('a.removeMissing')
  const holds: CheckHold[] = []
  // A file system may keep times to two seconds only (exFAT).
  if (exportFrom !== null && check.exportedAt < exportFrom - EXPORT_TIME_SLACK_MS) {
    holds.push('stale')
  }
  if (check.unavailable > 0) holds.push('unavailable')
  if (check.unchecked > 0) holds.push('unchecked')
  if (check.skipped > 0) holds.push('skipped')
  return { clean: repeat.length === 0 && holds.length === 0, repeat, holds }
}

/** How much older than the export step an export may look and still count as made in it. */
export const EXPORT_TIME_SLACK_MS = 2000

/** A hot cue the app placed: slot 1 is A. */
export interface ExpectedCue {
  trackId: number
  slot: number
  positionMs: number
}

/** A hot cue the export has: `num` 0 is A, as Rekordbox counts. */
export interface ExportedCue {
  num: number
  startSeconds: number
}

export interface CueMismatch {
  trackId: number
  slot: number
  /** Where the export has it, in ms, or null when it has none in that slot. */
  foundMs: number | null
  expectedMs: number
}

/** How far a hot cue may be from where the app placed it and still count as in place. */
export const CUE_TOLERANCE_MS = 10

/**
 * The hot cues that are not where the app placed them after phase B: missing from
 * the export's track, or more than `CUE_TOLERANCE_MS` away. A track the export lacks
 * has every cue missing.
 */
export function compareCues(
  expected: readonly ExpectedCue[],
  exportedCuesOf: (trackId: number) => readonly ExportedCue[] | null
): CueMismatch[] {
  const mismatches: CueMismatch[] = []
  for (const cue of expected) {
    const found = exportedCuesOf(cue.trackId)?.find((each) => each.num === cue.slot - 1)
    const foundMs = found ? Math.round(found.startSeconds * 1000) : null
    if (foundMs === null || Math.abs(foundMs - cue.positionMs) > CUE_TOLERANCE_MS) {
      mismatches.push({ trackId: cue.trackId, slot: cue.slot, foundMs, expectedMs: cue.positionMs })
    }
  }
  return mismatches
}

/** A beat marker as a grid is compared: the time and the tempo, and the beat of its bar. */
export interface GridMarker {
  inizio: number
  bpm: number
  battito: number
}

// How far a marker may be from the one read before and still be the same: Rekordbox
// writes the time to the millisecond and the tempo to two places.
const GRID_TIME_TOLERANCE_S = 0.0015
const GRID_BPM_TOLERANCE = 0.006

/** True when Rekordbox's grid in an export is the one the app read before. */
export function sameGrid(before: readonly GridMarker[], after: readonly GridMarker[]): boolean {
  return (
    before.length === after.length &&
    before.every((marker, index) => {
      const other = after[index]
      return (
        other !== undefined &&
        Math.abs(other.inizio - marker.inizio) <= GRID_TIME_TOLERANCE_S &&
        Math.abs(other.bpm - marker.bpm) <= GRID_BPM_TOLERANCE &&
        other.battito === marker.battito
      )
    })
  )
}
