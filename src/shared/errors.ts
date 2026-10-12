import { z } from 'zod'

// Codes for expected failures.
export const ERROR_CODES = [
  // What can go wrong with one track in one pipeline stage.
  'FILE_UNREADABLE',
  'TIMEOUT',
  'LOOKUP_FAILED',
  'PYTHON_CRASHED',
  'CLAUDE_FAILED',
  // Not a failure of the track: the Claude subscription has no room now. The job waits.
  'CLAUDE_LIMIT',
  'WRITE_FAILED',
  // Other expected failures.
  'PYTHON_ERROR',
  'INVALID_INPUT',
  'STYLE_IN_USE',
  'SECRET_STORAGE_UNAVAILABLE',
  // Why a library scan did not run, or stopped.
  'LIBRARY_NOT_SET',
  'LIBRARY_UNAVAILABLE',
  'LIBRARY_ROOT_UNSUITABLE',
  // A run was asked for while another one is being computed or applied.
  'RUN_ACTIVE',
  // What a batch holds was not what its preview showed; the preview must be read again.
  'PREVIEW_CHANGED',
  // The volume has too little room for the backups or copies of a batch.
  'NOT_ENOUGH_SPACE',
  // Undo was asked for, but no batch that changed files is left to undo.
  'NOTHING_TO_UNDO',
  // The backup folder would change while the last batch can still be undone from it.
  'BACKUPS_IN_USE',
  // Something failed that no code above describes; the detail is in the log.
  'UNEXPECTED'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class AppError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

/**
 * The result of a call that can fail in an expected way. Errors thrown across IPC
 * lose their code, so such calls return this instead; the renderer maps the code to text.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode }

const MAX_TRACK_ERROR_MESSAGE_LENGTH = 300

/**
 * Why one track was skipped in one stage. The batch goes on without it, and the
 * track is listed with this on the "Hibák" tab. It is stored in `batch_items.error`,
 * so it is validated with this schema when read.
 */
export const trackErrorSchema = z.object({
  trackId: z.number().int().positive(),
  stage: z.string().min(1).max(40),
  code: z.enum(ERROR_CODES),
  // Shown to the user: one short line, never a stack trace or raw tool output.
  message: z.string().max(MAX_TRACK_ERROR_MESSAGE_LENGTH)
})

export type TrackError = z.output<typeof trackErrorSchema>

/**
 * The message of a `TrackError`, by code. It is fixed text of the app's own, so
 * nothing a tool printed and no path can reach the user through it. What the user
 * finally reads is Hungarian text chosen from the code; this is the diagnostic line.
 */
export const TRACK_ERROR_MESSAGES: Record<ErrorCode, string> = {
  FILE_UNREADABLE: 'The file could not be read',
  TIMEOUT: 'The stage took too long',
  LOOKUP_FAILED: 'The online lookup failed',
  PYTHON_CRASHED: 'The audio engine stopped while working on the track',
  CLAUDE_FAILED: 'Claude gave no usable answer',
  CLAUDE_LIMIT: 'The Claude usage limit is reached',
  WRITE_FAILED: 'The file could not be written',
  PYTHON_ERROR: 'The audio engine reported an error',
  INVALID_INPUT: 'The stage was given invalid input',
  STYLE_IN_USE: 'A style is still in use',
  SECRET_STORAGE_UNAVAILABLE: 'The Keychain is not available',
  LIBRARY_NOT_SET: 'No library folder is chosen',
  LIBRARY_UNAVAILABLE: 'The library folder cannot be reached',
  LIBRARY_ROOT_UNSUITABLE: 'This folder cannot be used as the library',
  RUN_ACTIVE: 'Another run is in progress',
  PREVIEW_CHANGED: 'The batch is not what its preview showed',
  NOT_ENOUGH_SPACE: 'There is not enough free space',
  NOTHING_TO_UNDO: 'There is no batch to undo',
  BACKUPS_IN_USE: 'The backup folder is in use',
  UNEXPECTED: 'Unexpected error'
}
