import { describe, expect, it } from 'vitest'
import { cueEditActionSchema } from './cue-editor'

describe('cueEditActionSchema', () => {
  it.each([
    ['a slot past H', { type: 'delete', trackId: 1, slot: 9 }],
    ['an edit it does not know', { type: 'copy', trackId: 1, slot: 1 }],
    [
      'a place of no whole millisecond',
      { type: 'place', trackId: 1, slot: 1, atMs: 1.5, snap: 'beat' }
    ],
    ['a snap it does not know', { type: 'place', trackId: 1, slot: 1, atMs: 1, snap: 'phrase' }],
    ['a path for a track', { type: 'delete', trackId: '/Music/a.mp3', slot: 1 }]
  ])('refuses %s', (_, action) => {
    // Act
    const parsed = cueEditActionSchema.safeParse(action)

    // Assert
    expect(parsed.success).toBe(false)
  })

  it('takes a place let go with Shift', () => {
    // Act
    const parsed = cueEditActionSchema.safeParse({
      type: 'place',
      trackId: 3,
      slot: 4,
      atMs: 61_240,
      snap: 'bar'
    })

    // Assert
    expect(parsed.success).toBe(true)
  })
})
