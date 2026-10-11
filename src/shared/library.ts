// What the Library page and the main process say to each other about scanning.

/** What one scan did. `found` counts the audio files seen on disk. */
export interface ScanSummary {
  found: number
  added: number
  updated: number
  unchanged: number
  /** Tracks of this library whose file is no longer there. Their rows are kept. */
  missing: number
  /** Files of a known format that could not be read; they are listed without tags. */
  unreadable: number
}

export type ScanProgress =
  { phase: 'walking'; found: number } | { phase: 'reading'; done: number; total: number }
