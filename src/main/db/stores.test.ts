import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getAnalysis, saveAnalysis } from './analyses'
import { getCachedLookup, putCachedLookup } from './lookup-cache'
import { getSetting, setSetting } from './settings'
import { createTestDatabase, type TestDatabase } from './database.test-util'
import { deleteTrack, insertTracks } from './tracks'

let testDatabase: TestDatabase

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('settings', () => {
  const targetSchema = z.object({ lufs: z.number() })

  it('returns undefined for a key that was never set', () => {
    // Act
    const value = getSetting(testDatabase.db, 'normalization.target', targetSchema)

    // Assert
    expect(value).toBeUndefined()
  })

  it('stores a value and replaces it on the next write', () => {
    // Arrange
    setSetting(testDatabase.db, 'normalization.target', { lufs: -11 })

    // Act
    setSetting(testDatabase.db, 'normalization.target', { lufs: -9 })
    const value = getSetting(testDatabase.db, 'normalization.target', targetSchema)

    // Assert
    expect(value).toEqual({ lufs: -9 })
  })

  it('refuses to store a key from the namespace reserved for secrets', () => {
    // Act
    const write = (): unknown => setSetting(testDatabase.db, 'secret.acoustid', 'plain-text-key')

    // Assert
    expect(write).toThrow(/Secrets/)
    expect(getSetting(testDatabase.db, 'secret.acoustid', z.string())).toBeUndefined()
  })

  it('rejects a stored value that does not fit the schema', () => {
    // Arrange
    setSetting(testDatabase.db, 'normalization.target', { lufs: 'loud' })

    // Act
    const read = (): unknown => getSetting(testDatabase.db, 'normalization.target', targetSchema)

    // Assert
    expect(read).toThrow()
  })
})

describe('lookup cache', () => {
  const responseSchema = z.object({ title: z.string() })
  const fetchedAt = new Date('2026-10-01T12:00:00Z')

  it('returns a cached response for the same source and key only', () => {
    // Arrange
    putCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', { title: 'Tűz' }, fetchedAt)

    // Act
    const hit = getCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', responseSchema)
    const otherSource = getCachedLookup(testDatabase.db, 'discogs', 'rec:1', responseSchema)
    const otherKey = getCachedLookup(testDatabase.db, 'musicbrainz', 'rec:2', responseSchema)

    // Assert
    expect(hit).toEqual({ title: 'Tűz' })
    expect(otherSource).toBeUndefined()
    expect(otherKey).toBeUndefined()
  })

  it('treats an entry older than the allowed age as missing', () => {
    // Arrange
    putCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', { title: 'Tűz' }, fetchedAt)
    const oneDayMs = 24 * 60 * 60 * 1000

    // Act
    const fresh = getCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', responseSchema, {
      maxAgeMs: oneDayMs,
      now: new Date('2026-10-02T11:59:59Z')
    })
    const stale = getCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', responseSchema, {
      maxAgeMs: oneDayMs,
      now: new Date('2026-10-02T12:00:01Z')
    })

    // Assert
    expect(fresh).toEqual({ title: 'Tűz' })
    expect(stale).toBeUndefined()
  })

  it('replaces the response and its time when the same lookup is stored again', () => {
    // Arrange
    putCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', { title: 'Old' }, fetchedAt)
    const later = new Date('2026-10-05T12:00:00Z')

    // Act
    putCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', { title: 'New' }, later)
    const value = getCachedLookup(testDatabase.db, 'musicbrainz', 'rec:1', responseSchema, {
      maxAgeMs: 1000,
      now: later
    })

    // Assert
    expect(value).toEqual({ title: 'New' })
  })
})

describe('analyses', () => {
  const bpmKeySchema = z.object({ bpm: z.number(), key: z.string() })
  let trackId: number

  beforeEach(() => {
    const [id] = insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' }
    ])
    trackId = id as number
  })

  it('keeps one result per track and type, the newest one', () => {
    // Arrange
    const first = { trackId, type: 'bpm_key', result: { bpm: 62, key: 'Am' }, analyzerVersion: '1' }
    const second = { ...first, result: { bpm: 124, key: 'Am' }, analyzerVersion: '2' }

    // Act
    saveAnalysis(testDatabase.db, { ...first, type: 'bpm_key' })
    saveAnalysis(testDatabase.db, { ...second, type: 'bpm_key' })
    const stored = getAnalysis(testDatabase.db, trackId, 'bpm_key', bpmKeySchema)
    const otherType = getAnalysis(testDatabase.db, trackId, 'loudness', bpmKeySchema)

    // Assert
    expect(stored).toEqual({ result: { bpm: 124, key: 'Am' }, analyzerVersion: '2' })
    expect(otherType).toBeUndefined()
  })

  it('refuses a result for a track that does not exist', () => {
    // Arrange
    const orphan = { trackId: 999, type: 'bpm_key' as const, result: {}, analyzerVersion: '1' }

    // Act
    const save = (): unknown => saveAnalysis(testDatabase.db, orphan)

    // Assert
    expect(save).toThrow(/FOREIGN KEY/)
  })

  it('removes the results together with their track', () => {
    // Arrange
    saveAnalysis(testDatabase.db, {
      trackId,
      type: 'bpm_key',
      result: { bpm: 124, key: 'Am' },
      analyzerVersion: '1'
    })

    // Act
    deleteTrack(testDatabase.db, trackId)
    const stored = getAnalysis(testDatabase.db, trackId, 'bpm_key', bpmKeySchema)

    // Assert
    expect(stored).toBeUndefined()
  })
})
