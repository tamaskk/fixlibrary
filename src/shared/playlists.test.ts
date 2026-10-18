import { describe, expect, it } from 'vitest'
import { playlistActionSchema, playlistNameSchema } from './playlists'

describe('playlistNameSchema', () => {
  it.each([
    ['  Sunset   set ', 'Sunset set'],
    ['Afterhours', 'Afterhours'],
    ['x'.repeat(100), 'x'.repeat(100)]
  ])('takes %j as %j', (input, expected) => {
    // Act
    const name = playlistNameSchema.parse(input)

    // Assert
    expect(name).toBe(expected)
  })

  it.each([[''], ['   '], ['x'.repeat(101)], ['Sunset‮set'], ['Sun\u0000set']])(
    'refuses %j',
    (input) => {
      // Act
      const result = playlistNameSchema.safeParse(input)

      // Assert
      expect(result.success).toBe(false)
    }
  )
})

describe('playlistActionSchema', () => {
  it.each([
    [{ action: 'move', playlistId: 1, trackId: 2, direction: 2 }],
    [{ action: 'add', playlistId: 1, trackIds: [] }],
    [{ action: 'delete', playlistId: 1, path: '/etc' }],
    [{ action: 'rename', playlistId: 0, name: 'x' }]
  ])('refuses %o', (action) => {
    // Act
    const result = playlistActionSchema.safeParse(action)

    // Assert
    expect(result.success).toBe(false)
  })
})
