import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { addStyle } from '../db/styles'
import { insertTracks, updateTrack } from '../db/tracks'
import { listPlaylistsWithTracks } from '../db/playlists'
import { editPlaylist, neighbourOf, playlistView, type PlaylistDependencies } from './playlists'
import type { PlaylistEditResult } from '@shared/playlists'
import type { Result } from '@shared/errors'

let testDatabase: TestDatabase
let dependencies: PlaylistDependencies

function addTrack(path: string, values: Parameters<typeof updateTrack>[2] = {}): number {
  const [id] = insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'mp3' }]) as [
    number
  ]
  updateTrack(testDatabase.db, id, values)
  return id
}

function valueOf(result: Result<PlaylistEditResult>): PlaylistEditResult {
  if (!result.ok) throw new Error(`the edit failed: ${result.code}`)
  return result.value
}

function newPlaylist(name = 'Sunset set'): number {
  return valueOf(editPlaylist(dependencies, { action: 'create', name })).view?.id ?? -1
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  dependencies = { db: testDatabase.db, listMountedVolumes: () => new Set() }
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('editing playlists', () => {
  it('creates, renames and deletes a playlist, and leaves its tracks in the library', () => {
    // Arrange
    const id = newPlaylist()
    const track = addTrack('/Music/a.mp3')
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: [track] })

    // Act
    const renamed = valueOf(
      editPlaylist(dependencies, { action: 'rename', playlistId: id, name: 'Afterhours' })
    )
    const deleted = valueOf(editPlaylist(dependencies, { action: 'delete', playlistId: id }))

    // Assert
    expect(renamed.playlists).toEqual([{ id, name: 'Afterhours', trackCount: 1 }])
    expect(deleted).toEqual({ playlists: [], view: null, skipped: 0 })
    expect(listPlaylistsWithTracks(testDatabase.db)).toEqual([])
  })

  it('adds tracks at the end, each once, and counts what it skipped', () => {
    // Arrange
    const id = newPlaylist()
    const [a, b, c] = ['/Music/a.mp3', '/Music/b.mp3', '/Music/c.mp3'].map((path) => addTrack(path))
    const setAside = addTrack('/Music/_Duplicates/a.mp3')
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: [a as number] })

    // Act
    const result = valueOf(
      editPlaylist(dependencies, {
        action: 'add',
        playlistId: id,
        trackIds: [b as number, a as number, c as number, b as number, setAside, 999]
      })
    )

    // Assert
    expect(result.view?.tracks.map((track) => track.trackId)).toEqual([a, b, c])
    expect(result.skipped).toBe(4)
  })

  it('removes a track and moves one a place up or down', () => {
    // Arrange
    const id = newPlaylist()
    const [a, b, c] = ['/Music/a.mp3', '/Music/b.mp3', '/Music/c.mp3'].map((path) => addTrack(path))
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: [a, b, c] as number[] })

    // Act
    editPlaylist(dependencies, {
      action: 'move',
      playlistId: id,
      trackId: c as number,
      direction: -1
    })
    const result = valueOf(
      editPlaylist(dependencies, { action: 'remove', playlistId: id, trackId: a as number })
    )

    // Assert
    expect(result.view?.tracks.map((track) => track.trackId)).toEqual([c, b])
  })

  it('refuses an edit of a playlist that does not exist', () => {
    // Act
    const result = editPlaylist(dependencies, { action: 'rename', playlistId: 7, name: 'x' })

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('neighbourOf', () => {
  it.each([
    [[1, 2, 3], 2, -1, 1],
    [[1, 2, 3], 2, 1, 3],
    [[1, 2, 3], 1, -1, null],
    [[1, 2, 3], 3, 1, null],
    [[1, 2, 3], 9, 1, null]
  ] as const)(
    'in %o, track %i moved by %i swaps with %s',
    (order, trackId, direction, expected) => {
      // Act
      const other = neighbourOf(order, trackId, direction)

      // Assert
      expect(other).toBe(expected)
    }
  )
})

describe('the limits', () => {
  it('keeps the order of a playlist of more than one chunk of rows', () => {
    // Arrange
    const id = newPlaylist()
    const ids = insertTracks(
      testDatabase.db,
      Array.from({ length: 1200 }, (_, index) => ({
        path: `/Music/${index}.mp3`,
        originalPath: `/Music/${index}.mp3`,
        format: 'mp3' as const
      }))
    )
    const shuffled = [...ids].reverse()

    // Act
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: shuffled.slice(0, 700) })
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: shuffled.slice(700) })

    // Assert
    expect(listPlaylistsWithTracks(testDatabase.db)[0]?.trackIds).toEqual(shuffled)
  })

  it('makes no more than 500 playlists', () => {
    // Arrange
    for (let index = 0; index < 500; index += 1) newPlaylist(`P ${index}`)

    // Act
    const result = editPlaylist(dependencies, { action: 'create', name: 'One more' })

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('the playlist view', () => {
  it('adds up the length, the tempo range and the keys', () => {
    // Arrange
    const id = newPlaylist()
    const a = addTrack('/Music/a.mp3', { durationMs: 300_000, bpm: 122.6, camelotKey: '8A' })
    const b = addTrack('/Music/b.mp3', { durationMs: 360_000, bpm: 126, camelotKey: '9A' })
    const c = addTrack('/Music/c.mp3', { durationMs: null, bpm: null, camelotKey: '8A' })
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: [a, b, c] })

    // Act
    const view = playlistView(dependencies, id)

    // Assert
    expect(view).toMatchObject({ totalMs: 660_000, bpmRange: [123, 126], keys: ['8A', '9A'] })
  })

  it('recommends the ten tracks that fit best, none of the playlist, set aside or offline', () => {
    // Arrange
    const house = addStyle(testDatabase.db, 'Deep House', '#ffffff')?.id ?? null
    const techno = addStyle(testDatabase.db, 'Techno', '#000000')?.id ?? null
    const fits = { primaryStyleId: house, bpm: 122, camelotKey: '8A', energy: 5 }
    const id = newPlaylist()
    const member = addTrack('/Music/member.mp3', fits)
    editPlaylist(dependencies, { action: 'add', playlistId: id, trackIds: [member] })
    const good = Array.from({ length: 12 }, (_, index) =>
      addTrack(`/Music/good-${index}.mp3`, { ...fits, bpm: 122 + index })
    )
    const poor = addTrack('/Music/poor.mp3', { primaryStyleId: techno, bpm: 140, energy: 9 })
    const offline = addTrack('/Volumes/Gone/fits.mp3', fits)
    const missing = addTrack('/Music/missing.mp3', { ...fits, fileMissing: true })
    const setAside = addTrack('/Music/_Duplicates/fits.mp3', fits)

    // Act
    const view = playlistView(dependencies, id)

    // Assert
    const recommended = view?.recommendations?.map((item) => item.trackId) ?? []
    expect(recommended).toHaveLength(10)
    expect(recommended[0]).toBe(good[0])
    expect(recommended).not.toContain(member)
    for (const left of [poor, offline, missing, setAside]) expect(recommended).not.toContain(left)
    const scores = view?.recommendations?.map((item) => item.score) ?? []
    expect([...scores].sort((x, y) => y - x)).toEqual(scores)
  })

  it('recommends nothing for an empty playlist', () => {
    // Arrange
    const id = newPlaylist()
    addTrack('/Music/a.mp3', { bpm: 124 })

    // Act
    const view = playlistView(dependencies, id)

    // Assert
    expect(view?.recommendations).toEqual([])
  })
})
