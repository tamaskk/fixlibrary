// What the Library page and the main process say to each other about the library.
import { z } from 'zod'

/** What one scan did. `found` counts the audio files seen on disk. */
export interface ScanSummary {
  found: number
  added: number
  updated: number
  unchanged: number
  /**
   * All tracks of this library whose file is not there, not only the ones this scan
   * noticed. Their rows are kept. Always 0 for a scan that was not complete.
   */
  missing: number
  /** Files found in this scan that cannot be read; they are listed without tags. */
  unreadable: number
  /**
   * False when part of the library could not be looked at. Such a scan marks
   * nothing missing, because a file it did not see may still be there.
   */
  complete: boolean
}

export type ScanProgress =
  { phase: 'walking'; found: number } | { phase: 'reading'; done: number; total: number }

export interface LibraryStatus {
  /** False until a library folder is chosen in Settings. */
  rootChosen: boolean
  trackCount: number
  /** True while a scan runs, also one the app started by itself. */
  scanning: boolean
}

/** How many tracks one `library:list` call returns at most. */
export const LIBRARY_PAGE_SIZE = 500

export type TrackFormat = 'mp3' | 'wav' | 'aiff'
export type TrackCoverStatus = 'unknown' | 'missing' | 'embedded' | 'placeholder'
export type TrackStageStatus = 'pending' | 'done' | 'failed' | 'skipped'

/** One row of the Library table: what the page shows of a track, and nothing more. */
export interface LibraryTrack {
  id: number
  fileName: string
  /** The folder the file is in, for the tooltip of the row. */
  folder: string
  format: TrackFormat
  durationMs: number | null
  artist: string | null
  title: string | null
  bpm: number | null
  camelotKey: string | null
  energy: number | null
  styleId: number | null
  coverStatus: TrackCoverStatus
  /** Per function: how far the track is. A function that is not listed has not run. */
  stageStatus: Record<string, TrackStageStatus>
  /** True while the track's drive is not connected. */
  offline: boolean
  /** True when the last scan did not find the file. */
  fileMissing: boolean
}

export interface LibraryPage {
  tracks: LibraryTrack[]
  /** All tracks of the library, not only the ones on this page. */
  total: number
}

export const libraryPageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(LIBRARY_PAGE_SIZE),
  offset: z.number().int().min(0)
})

export type LibraryPageRequest = z.input<typeof libraryPageRequestSchema>

/** More ids than a library can hold is a broken or hostile page, not a selection. */
export const MAX_RUN_TRACKS = 20_000

/** More names than the app can have functions. */
export const MAX_RUN_STAGES = 50

// The names of the functions to run; the app adds the stages they depend on.
const requestedStages = z.array(z.string().min(1).max(40)).min(1).max(MAX_RUN_STAGES)

export const runRequestSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('selection'),
    trackIds: z.array(z.number().int().positive()).min(1).max(MAX_RUN_TRACKS),
    stages: requestedStages
  }),
  z.strictObject({ scope: z.literal('library'), stages: requestedStages })
])

/** What to run, and on what: the tracks the user selected, or every track of the library. */
export type RunRequest = z.input<typeof runRequestSchema>

/** The tracks a run processes, decided by the main process. */
export interface RunTargets {
  /** For a selection in the order it was given, without repeats; else in library order. */
  trackIds: number[]
  /**
   * Asked for but left out: offline, without a file, or not a track of the library.
   * A track whose tags could not be read is not left out: its audio may still be fine,
   * and a stage that cannot read it records that for the track.
   */
  skipped: number
}

/** The answer to a run that was started. */
export interface RunStarted extends RunTargets {
  batchId: number
}
