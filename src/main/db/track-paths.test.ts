import { describe, expect, it } from 'vitest'
import { normalizeTrackPath, volumeNameOfPath } from './track-paths'

describe('normalizeTrackPath', () => {
  it('stores a decomposed and a composed spelling as the same path', () => {
    // Arrange
    const composed = '/Volumes/Zenék/Tűz.mp3'.normalize('NFC')
    const decomposed = composed.normalize('NFD')

    // Act
    const normalized = normalizeTrackPath(decomposed)

    // Assert
    expect(decomposed).not.toBe(composed)
    expect(normalized).toBe(composed)
  })

  it.each([
    ['//Volumes/DJ SSD/a.mp3', '/Volumes/DJ SSD/a.mp3'],
    ['/Volumes/DJ SSD//House/./a.mp3', '/Volumes/DJ SSD/House/a.mp3'],
    ['/Volumes/DJ SSD/House/../a.mp3', '/Volumes/DJ SSD/a.mp3']
  ])('cleans %s to %s', (filePath, expected) => {
    // Act
    const normalized = normalizeTrackPath(filePath)

    // Assert
    expect(normalized).toBe(expected)
  })

  it('rejects a relative path', () => {
    // Act
    const normalize = (): unknown => normalizeTrackPath('Music/a.mp3')

    // Assert
    expect(normalize).toThrow(/absolute/)
  })
})

describe('volumeNameOfPath', () => {
  it.each([
    ['/Volumes/DJ SSD/House/Track.mp3', 'DJ SSD'],
    ['//Volumes/DJ SSD/Track.mp3', 'DJ SSD'],
    ['/Volumes/Zenék/a.wav'.normalize('NFD'), 'Zenék'.normalize('NFC')],
    ['/Users/dj/Music/Track.mp3', null],
    ['/Volumes/../Users/dj/a.mp3', null],
    ['/Volumes', null],
    ['/Volumes/', null],
    ['/volumes/DJ SSD/a.mp3', null]
  ])('reads %s as volume %s', (filePath, expected) => {
    // Act
    const volume = volumeNameOfPath(filePath)

    // Assert
    expect(volume).toBe(expected)
  })
})
