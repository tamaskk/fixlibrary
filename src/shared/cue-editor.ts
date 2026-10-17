// The cue editor (T-030): what the page shows of a track, and the edits it can ask for.
// The main process decides where a cue lands: it snaps every position to the grid
// itself, so the page only says where the user let go, and how.
import { z } from 'zod'
import type { GridMarker } from './beat-grid'

/** Which tracks the list shows. */
export const CUE_EDITOR_FILTERS = ['all', 'review', 'noCues'] as const
export type CueEditorFilter = (typeof CUE_EDITOR_FILTERS)[number]

/** One row of the track list: a track with Rekordbox's grid. */
export interface CueEditorListItem {
  trackId: number
  /** The file name, as the row is known by. */
  fileName: string
  artist: string | null
  title: string | null
  /** How many of the eight slots hold a cue. */
  cueCount: number
  /** The last batch that placed cues asked for a look at this track (`CUE_REVIEW`). */
  review: boolean
}

export interface CueEditorCue {
  /** 1 is A. */
  slot: number
  positionMs: number
  name: string
  color: string
  /** Placed or moved by hand: no automatic run changes it. */
  locked: boolean
}

/** What the editor needs of one track, but its waveform. */
export interface CueEditorTrack {
  trackId: number
  fileName: string
  artist: string | null
  title: string | null
  durationMs: number
  grid: GridMarker[]
  /** One per slot that holds a cue, by slot. */
  cues: CueEditorCue[]
  /** Slots emptied by hand: they stay empty until they are given back to the automatic run. */
  lockedEmpty: number[]
}

/** The waveform of a track: a peak per hundredth of a second, per thousand of full scale. */
export interface CueEditorPeaks {
  peaksPerSecond: number
  durationSeconds: number
  /** The track goes on past the twenty minutes the waveform shows. */
  truncated: boolean
  peaks: number[]
}

const slot = z.number().int().min(1).max(8)
const trackId = z.number().int().positive()

/** What the page can ask the main process to do to the cues of a track. */
export const cueEditActionSchema = z.discriminatedUnion('type', [
  /** Places or moves the cue of a slot: let go at `atMs`, snapped by `snap`. */
  z.object({
    type: z.literal('place'),
    trackId,
    slot,
    atMs: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 60 * 60 * 1000),
    snap: z.enum(['beat', 'bar'])
  }),
  /** Empties a slot, and keeps it empty. */
  z.object({ type: z.literal('delete'), trackId, slot }),
  /** Gives a slot back to the automatic run: the next run of the cues places it. */
  z.object({ type: z.literal('release'), trackId, slot })
])

export type CueEditAction = z.output<typeof cueEditActionSchema>
