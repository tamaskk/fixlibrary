import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveAnalysis } from '../db/analyses'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { listTrackCues } from '../db/cues'
import { batches, batchItems, jobs } from '../db/schema'
import { getTrackById, insertTracks } from '../db/tracks'
import { logger } from '../services/logger'
import type { PeaksStore, StoredPeaks } from '../services/peaks-store'
import type { PythonBridge } from '../services/python-bridge'
import type { CueEditAction } from '@shared/cue-editor'
import { applyCueEdit, cueEditorPeaks, cueEditorTrack, listCueEditorTracks } from './cue-editor'
import { writeTrackCues } from './cues'
import { readSettings } from './settings'

// 120 BPM from 0.5 s: a beat every half second, a bar every two seconds.
const GRID = [{ inizio: 0.5, bpm: 120, metro: '4/4', battito: 1 }]
const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase
let gridded: number
let plain: number
let stored: StoredPeaks | null
let calls: unknown[]
let failing: boolean

function addTrack(name: string): number {
  const path = `/Music/${name}`
  const [id] = insertTracks(testDatabase.db, [
    {
      path,
      originalPath: path,
      format: 'mp3',
      durationMs: 300_000,
      fileSizeBytes: 1000,
      fileMtimeMs: 5
    }
  ]) as [number]
  return id
}

function withGrid(trackId: number): void {
  saveAnalysis(testDatabase.db, {
    trackId,
    type: 'rb_grid',
    result: { tempos: GRID, exportedAt: 1, readAt: 2 },
    analyzerVersion: 'rekordbox-xml'
  })
}

const peaks: Pick<PeaksStore, 'ensure' | 'read'> = {
  ensure: async () => {},
  read: async () => stored
}

const python: Pick<PythonBridge, 'call'> = {
  call: (async (method: string, params: unknown) => {
    calls.push({ method, params })
    if (failing) throw new Error('ffmpeg failed')
    stored = {
      peaksPerSecond: 100,
      truncated: false,
      durationSeconds: 300,
      fileSizeBytes: 1000,
      fileMtimeMs: 5,
      peaks: [1, 2, 3]
    }
    return { file: '1.json', count: 3, bytes: 10, durationSeconds: 300 }
  }) as PythonBridge['call']
}

function dependencies(): Parameters<typeof listCueEditorTracks>[0] {
  return {
    db: testDatabase.db,
    listMountedVolumes: () => NO_VOLUMES,
    python: () => python,
    peaks
  }
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  gridded = addTrack('b.mp3')
  plain = addTrack('a.mp3')
  withGrid(gridded)
  stored = null
  calls = []
  failing = false
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('the track list of the cue editor', () => {
  it('lists only the tracks that have Rekordbox’s grid, and those without cues', () => {
    // Arrange
    const second = addTrack('c.mp3')
    withGrid(second)
    applyCueEdit(dependencies(), {
      type: 'place',
      trackId: second,
      slot: 1,
      atMs: 500,
      snap: 'beat'
    })

    // Act
    const all = listCueEditorTracks(dependencies(), 'all')
    const empty = listCueEditorTracks(dependencies(), 'noCues')

    // Assert
    expect(all.map((item) => [item.fileName, item.cueCount])).toEqual([
      ['b.mp3', 0],
      ['c.mp3', 1]
    ])
    expect(empty.map((item) => item.trackId)).toEqual([gridded])
    expect(all.some((item) => item.trackId === plain)).toBe(false)
  })
})

describe('the filter of tracks to look at', () => {
  it('names a track whose latest run of the cues asked for a review', () => {
    // Arrange: an older batch asked for one, the newer one did not; another track asks.
    const other = addTrack('c.mp3')
    withGrid(other)
    const ran = (trackId: number, warnings: string[]): void => {
      const [batch] = testDatabase.db
        .insert(batches)
        .values({ type: 'run', mode: 'in_place', status: 'applied' })
        .returning({ id: batches.id })
        .all()
      if (!batch) throw new Error('no batch')
      testDatabase.db
        .insert(batchItems)
        .values({ batchId: batch.id, trackId, before: {}, after: { warnings } })
        .run()
      testDatabase.db
        .insert(jobs)
        .values({ batchId: batch.id, trackId, stage: 'cues', phase: 'compute', status: 'done' })
        .run()
    }
    ran(gridded, ['CUE_REVIEW'])
    ran(gridded, [])
    ran(other, ['CUE_REVIEW'])

    // Act
    const review = listCueEditorTracks(dependencies(), 'review')

    // Assert
    expect(review.map((item) => item.trackId)).toEqual([other])
  })
})

describe('an edit of the cue editor', () => {
  it('puts a cue let go off the beat onto the nearest beat, and locks its slot', () => {
    // Act
    const result = applyCueEdit(dependencies(), {
      type: 'place',
      trackId: gridded,
      slot: 4,
      atMs: 61_240,
      snap: 'beat'
    })

    // Assert
    expect(result.ok && result.value.cues).toEqual([
      { slot: 4, positionMs: 61_000, name: 'Drop 1', color: expect.any(String), locked: true }
    ])
    expect(getTrackById(testDatabase.db, gridded, NO_VOLUMES)?.lockedFields).toEqual(['cue:4'])
  })

  it('puts it onto the start of the nearest bar with Shift', () => {
    // Act
    const result = applyCueEdit(dependencies(), {
      type: 'place',
      trackId: gridded,
      slot: 2,
      atMs: 61_240,
      snap: 'bar'
    })

    // Assert
    expect(result.ok && result.value.cues[0]?.positionMs).toBe(60_500)
  })

  it('moves a cue that is there, and keeps one slot one cue', () => {
    // Arrange
    applyCueEdit(dependencies(), {
      type: 'place',
      trackId: gridded,
      slot: 1,
      atMs: 500,
      snap: 'beat'
    })

    // Act
    applyCueEdit(dependencies(), {
      type: 'place',
      trackId: gridded,
      slot: 1,
      atMs: 8_400,
      snap: 'beat'
    })

    // Assert
    expect(listTrackCues(testDatabase.db, gridded).map((cue) => cue.positionMs)).toEqual([8_500])
  })

  it('empties a slot and keeps it empty against a new automatic run', () => {
    // Arrange
    applyCueEdit(dependencies(), {
      type: 'place',
      trackId: gridded,
      slot: 3,
      atMs: 4_500,
      snap: 'beat'
    })
    applyCueEdit(dependencies(), {
      type: 'place',
      trackId: gridded,
      slot: 5,
      atMs: 9_000,
      snap: 'beat'
    })

    // Act
    const deleted = applyCueEdit(dependencies(), { type: 'delete', trackId: gridded, slot: 3 })
    const track = getTrackById(testDatabase.db, gridded, NO_VOLUMES)
    if (!track) throw new Error('no track')
    writeTrackCues(
      testDatabase.db,
      gridded,
      {
        slots: [
          { slot: 3, positionMs: 1_000 },
          { slot: 5, positionMs: 2_000 },
          { slot: 6, positionMs: 3_000 }
        ],
        before: null
      },
      readSettings(testDatabase.db).hotCues,
      track.lockedFields
    )

    // Assert
    expect(deleted.ok && deleted.value.lockedEmpty).toEqual([3])
    expect(
      listTrackCues(testDatabase.db, gridded).map((cue) => [cue.slot, cue.positionMs])
    ).toEqual([
      [5, 9_000],
      [6, 3_000]
    ])
  })

  it('gives a slot back to the automatic run when it is released', () => {
    // Arrange
    applyCueEdit(dependencies(), { type: 'delete', trackId: gridded, slot: 3 })

    // Act
    const released = applyCueEdit(dependencies(), { type: 'release', trackId: gridded, slot: 3 })

    // Assert
    expect(released.ok && released.value.lockedEmpty).toEqual([])
    expect(getTrackById(testDatabase.db, gridded, NO_VOLUMES)?.lockedFields).toEqual([])
  })

  it.each([
    ['a track without a grid', () => ({ type: 'delete', trackId: plain, slot: 1 })],
    ['a track that is not there', () => ({ type: 'delete', trackId: 999, slot: 1 })],
    [
      'a place past the end of the track',
      () => ({ type: 'place', trackId: gridded, slot: 1, atMs: 300_500, snap: 'beat' })
    ]
  ])('refuses %s', (_, request) => {
    // Act
    const result = applyCueEdit(dependencies(), request() as CueEditAction)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('the waveform of the cue editor', () => {
  it('reads the kept waveform of the file as it is, without asking the sidecar', async () => {
    // Arrange
    stored = {
      peaksPerSecond: 100,
      truncated: false,
      durationSeconds: 3,
      fileSizeBytes: 1000,
      fileMtimeMs: 5,
      peaks: [7]
    }

    // Act
    const result = await cueEditorPeaks(dependencies(), gridded)

    // Assert
    expect(result).toEqual({
      ok: true,
      value: { peaksPerSecond: 100, truncated: false, durationSeconds: 3, peaks: [7] }
    })
    expect(calls).toEqual([])
  })

  it('makes it again for a file that changed since', async () => {
    // Arrange
    stored = {
      peaksPerSecond: 100,
      truncated: false,
      durationSeconds: 3,
      fileSizeBytes: 999,
      fileMtimeMs: 5,
      peaks: [7]
    }

    // Act
    const result = await cueEditorPeaks(dependencies(), gridded)

    // Assert
    expect(result.ok && result.value.peaks).toEqual([1, 2, 3])
    expect(calls).toEqual([
      {
        method: 'analysis.peaks',
        params: expect.objectContaining({
          path: '/Music/b.mp3',
          trackId: gridded,
          fileSizeBytes: 1000,
          fileMtimeMs: 5
        })
      }
    ])
  })

  it('makes none for a track the page has gone on from', async () => {
    // Arrange
    const gone = new AbortController()
    gone.abort()

    // Act
    const result = await cueEditorPeaks(dependencies(), gridded, gone.signal)

    // Assert
    expect(result).toEqual({ ok: false, code: 'UNEXPECTED' })
    expect(calls).toEqual([])
  })

  it('says the file cannot be read when the sidecar cannot make it', async () => {
    // Arrange
    failing = true

    // Act
    const result = await cueEditorPeaks(dependencies(), gridded)

    // Assert
    expect(result).toEqual({ ok: false, code: 'FILE_UNREADABLE' })
  })

  it('shows nothing of a track the editor does not work on', () => {
    // Act
    const result = cueEditorTrack(dependencies(), plain)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})
