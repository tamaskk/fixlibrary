import { describe, expect, it } from 'vitest'
import { folderNameOf } from './file-names'

describe('folderNameOf', () => {
  it.each([
    ['Tech House', 'Tech House'],
    ['R&B/Soul', 'R&B-Soul'],
    ['Drum: Bass?', 'Drum- Bass-'],
    ['  Deep House. ', 'Deep House'],
    ['Afro​ House', 'Afro House'],
    ['...', null],
    ['', null]
  ])('makes a folder of %s: %s', (name, folder) => {
    // Act
    const made = folderNameOf(name)

    // Assert
    expect(made).toBe(folder)
  })
})
