// Every limit on how long a step may take, in one place. A value that is too short
// turns slow but healthy tracks into errors, so tune them here and nowhere else.

const SECOND = 1000
const MINUTE = 60 * SECOND

/** How long one pipeline stage may work on one track. */
export const STAGE_TIMEOUTS_MS = {
  lookup: 30 * SECOND,
  fingerprint: 120 * SECOND,
  naming: 10 * SECOND,
  // In the clean library the copy of the whole file is made by this step.
  rename: 5 * MINUTE,
  duplicates: 10 * SECOND,
  // Like a rename: the backup or the copy of the whole file is made by this step.
  setAside: 5 * MINUTE,
  bpmKey: 120 * SECOND,
  energy: 120 * SECOND,
  demucs: 15 * MINUTE,
  // The rules over the envelopes of one track; the sidecar reads a file of some 50 KB.
  cues: 60 * SECOND,
  convert: 120 * SECOND,
  // One call to the sidecar that copies a file and changes its tags.
  tags: 120 * SECOND,
  // The backup or the copy of the whole file, and then the writing of its tags.
  writeTags: 6 * MINUTE,
  // The backup or the copy of the whole file, and then the conversion of it.
  convertFile: 6 * MINUTE,
  // One measure by ffmpeg of a whole file.
  loudness: 120 * SECOND,
  // The plan of a gain from what was measured; no file is read.
  normalizePlan: 10 * SECOND,
  // One call to the sidecar that copies a file and changes its gain.
  normalize: 120 * SECOND,
  // The backup or the copy of the whole file, its gain changed, and measured again.
  normalizeFile: 8 * MINUTE,
  // Up to three services asked, a picture downloaded and a cover made of it.
  cover: 60 * SECOND,
  // The backup or the copy of the whole file, and then the writing of its cover.
  embedCover: 6 * MINUTE,
  // One call of twenty tracks, its second try and one more for an answer left out,
  // calls going one at a time.
  style: 7 * MINUTE,
  organize: 10 * SECOND,
  // The backup or the copy of the whole file, its tags, and the move into its folder.
  organizeFile: 6 * MINUTE
} as const

export type TimedStage = keyof typeof STAGE_TIMEOUTS_MS

/** For one `analysis.peaks` call of the cue editor: a whole file decoded once. */
export const PEAKS_RPC_TIMEOUT_MS = 120 * SECOND

/** For asking yt-dlp what one address is (T-034). */
export const DOWNLOAD_INFO_TIMEOUT_MS = 60 * SECOND

/** For one search of YouTube or SoundCloud through yt-dlp. */
export const DOWNLOAD_SEARCH_TIMEOUT_MS = 60 * SECOND

/** For one download and its conversion to MP3. */
export const DOWNLOAD_TIMEOUT_MS = 20 * MINUTE

/** For one `cover.inspect` or `cover.prepare` call: one picture decoded and resized. */
export const COVER_RPC_TIMEOUT_MS = 20 * SECOND

/** For a sidecar call that belongs to no stage, such as `ping`. */
export const DEFAULT_RPC_TIMEOUT_MS = 30 * SECOND

/** For one `tags.read` batch of a library scan; an exFAT drive is slow at this. */
export const TAG_BATCH_TIMEOUT_MS = 2 * MINUTE

/**
 * For asking the sidecar whether it is alive after a read has failed. Long enough
 * for a sidecar that has just crashed to be started again.
 */
export const ENGINE_CHECK_TIMEOUT_MS = 15 * SECOND

/** How long a job in the sidecar may take to stop after it was told to. */
export const JOB_CANCEL_TIMEOUT_MS = 5 * SECOND

/**
 * How long quitting waits for a stage to end the file step it is in, before the
 * database is closed. A copy of a large file to a slow drive is the longest such step.
 */
export const QUIT_FILE_WORK_WAIT_MS = 30 * SECOND

/** How long one `claude -p` call may take, whatever it was asked. */
export const CLAUDE_CALL_TIMEOUT_MS = 120 * SECOND

/** For finding `claude` and asking it for its version or its login state. */
export const CLAUDE_CHECK_TIMEOUT_MS = 15 * SECOND

/** How long the app waits before it tries Claude again after the usage limit was reached. */
export const CLAUDE_LIMIT_RETRY_MS = 15 * MINUTE
