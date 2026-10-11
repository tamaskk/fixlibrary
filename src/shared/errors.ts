// Codes for expected failures. T-007 adds the per-track codes and TrackError.
export const ERROR_CODES = [
  'PYTHON_CRASHED',
  'PYTHON_ERROR',
  'TIMEOUT',
  'INVALID_INPUT',
  'STYLE_IN_USE',
  'SECRET_STORAGE_UNAVAILABLE',
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
