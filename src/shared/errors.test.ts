import { describe, expect, it } from 'vitest'
import { ERROR_CODES, TRACK_ERROR_MESSAGES, trackErrorSchema } from './errors'

describe('ERROR_CODES', () => {
  it('contains the six documented per-track codes', () => {
    // Assert
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        'FILE_UNREADABLE',
        'TIMEOUT',
        'LOOKUP_FAILED',
        'PYTHON_CRASHED',
        'CLAUDE_FAILED',
        'CLAUDE_LIMIT',
        'WRITE_FAILED'
      ])
    )
  })
})

describe('trackErrorSchema', () => {
  const error = { trackId: 12, stage: 'bpmKey', code: 'TIMEOUT', message: 'No answer in 120 s' }

  it('accepts a track error as it is stored', () => {
    // Act
    const parsed = trackErrorSchema.safeParse(error)

    // Assert
    expect(parsed.success).toBe(true)
  })

  it.each([
    ['an unknown code', { ...error, code: 'EXPLODED' }],
    ['a missing stage', { ...error, stage: '' }],
    ['a track id that is not a positive integer', { ...error, trackId: 0 }],
    ['an overlong message', { ...error, message: 'x'.repeat(301) }]
  ])('rejects %s', (_name, value) => {
    // Act
    const parsed = trackErrorSchema.safeParse(value)

    // Assert
    expect(parsed.success).toBe(false)
  })
})

describe('TRACK_ERROR_MESSAGES', () => {
  it('has a short message for every code, each of which fits the stored shape', () => {
    // Act
    const stored = ERROR_CODES.map((code) =>
      trackErrorSchema.safeParse({
        trackId: 1,
        stage: 'bpmKey',
        code,
        message: TRACK_ERROR_MESSAGES[code]
      })
    )

    // Assert
    expect(stored.every((parsed) => parsed.success)).toBe(true)
    expect(ERROR_CODES.every((code) => TRACK_ERROR_MESSAGES[code].length > 0)).toBe(true)
  })
})
