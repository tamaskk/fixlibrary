// Runs one stage for one track so that its failure cannot stop the batch.
import { logger } from '../services/logger'
import { AppError, TRACK_ERROR_MESSAGES, type ErrorCode, type TrackError } from '@shared/errors'

export interface StageRun {
  trackId: number
  /** The stage's name as it is shown on the "Hibák" tab. */
  stage: string
  timeoutMs: number
}

export type StageOutcome<T> = { ok: true; value: T } | { ok: false; error: TrackError }

/**
 * Runs `work` and never throws. A failure, or taking longer than `timeoutMs`, becomes
 * a `TrackError` for the caller to record; the caller then moves on to the next track.
 *
 * `work` gets a signal that is aborted on timeout. Its late result is ignored, but
 * whatever it still does is not undone: work that writes a file must stop on abort
 * (kill its child process, and never rename its temp file into place afterwards),
 * or the file would change after the track was recorded as failed.
 */
export async function runStage<T>(
  run: StageRun,
  work: (signal: AbortSignal) => Promise<T>
): Promise<StageOutcome<T>> {
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined

  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort()
      reject(new AppError('TIMEOUT', 'the stage timed out'))
    }, run.timeoutMs)
  })

  try {
    // Started inside the try block, so a `work` that throws before returning a promise is caught too.
    const working = Promise.resolve().then(() => work(abort.signal))
    // The abandoned work may still fail later; that failure has nowhere to go.
    working.catch(() => {})
    return { ok: true, value: await Promise.race([working, timedOut]) }
  } catch (error) {
    // Work that fails because it was told to stop is a timeout, whatever it threw.
    const cause = abort.signal.aborted ? new AppError('TIMEOUT', 'the stage timed out') : error
    return { ok: false, error: toTrackError(run, cause, error) }
  } finally {
    clearTimeout(timer)
  }
}

function toTrackError(run: StageRun, error: unknown, logged: unknown = error): TrackError {
  // An error the app raised itself says which kind of failure this is. Its text, and
  // anything else (a library error, what a tool or the sidecar printed), goes to the
  // log only: the message of a TrackError is always the app's own fixed text.
  const code: ErrorCode = error instanceof AppError ? error.code : 'UNEXPECTED'
  const limit = Math.max(1, Math.ceil(run.timeoutMs / 1000))
  const message = code === 'TIMEOUT' ? `No result within ${limit} s` : TRACK_ERROR_MESSAGES[code]

  logger.warn(`Track ${run.trackId} skipped in stage ${run.stage}: ${code}`, logged)
  return { trackId: run.trackId, stage: run.stage, code, message }
}
