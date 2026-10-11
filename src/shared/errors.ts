// Codes for expected failures. T-007 adds the per-track codes and TrackError.
export const ERROR_CODES = ['PYTHON_CRASHED', 'PYTHON_ERROR', 'TIMEOUT'] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class AppError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}
