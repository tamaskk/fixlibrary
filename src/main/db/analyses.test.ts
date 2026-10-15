import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deleteAnalysis, getAnalysis, saveAnalysis } from './analyses'
import { createTestDatabase, type TestDatabase } from './database.test-util'
import { insertTracks } from './tracks'

let testDatabase: TestDatabase
let trackId: number

beforeEach(() => {
  testDatabase = createTestDatabase()
  ;[trackId] = insertTracks(testDatabase.db, [
    { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' }
  ]) as [number]
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('deleteAnalysis', () => {
  it('removes the result of one type and leaves the others', () => {
    // Arrange
    for (const type of ['rb_grid', 'bpm_key'] as const) {
      saveAnalysis(testDatabase.db, { trackId, type, result: { type }, analyzerVersion: '1' })
    }

    // Act
    deleteAnalysis(testDatabase.db, trackId, 'rb_grid')
    deleteAnalysis(testDatabase.db, trackId, 'rb_grid')

    // Assert
    expect(getAnalysis(testDatabase.db, trackId, 'rb_grid', z.unknown())).toBeUndefined()
    expect(getAnalysis(testDatabase.db, trackId, 'bpm_key', z.unknown())?.result).toEqual({
      type: 'bpm_key'
    })
  })
})
