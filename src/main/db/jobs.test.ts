import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelPreviewBatches,
  createBatch,
  findActiveBatch,
  getBatch,
  listBatchItemStates,
  mergeBatchItemProposal,
  setBatchItemError,
  setBatchPaused,
  setBatchStatus
} from './batches'
import { createTestDatabase, type TestDatabase } from './database.test-util'
import {
  finishJob,
  insertJobs,
  listJobs,
  markJobRunning,
  recoverInterruptedJobs,
  requeueJobs,
  skipJobs
} from './jobs'
import { batchItems, JOB_PHASES, jobs } from './schema'
import { deleteTrack, insertTracks } from './tracks'
import type { TrackError } from '@shared/errors'
import { JOB_PHASES as SHARED_JOB_PHASES } from '@shared/pipeline'

let testDatabase: TestDatabase
let trackIds: number[]

function newBatch(tracks = trackIds): number {
  return createBatch(testDatabase.db, {
    type: 'run',
    mode: 'clean_library',
    items: tracks.map((trackId) => ({ trackId, before: { title: `before ${trackId}` } }))
  })
}

function trackError(trackId: number, stage = 'bpmKey'): TrackError {
  return { trackId, stage, code: 'TIMEOUT', message: 'No result within 120 s' }
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  trackIds = insertTracks(
    testDatabase.db,
    ['a', 'b', 'c'].map((name) => ({
      path: `/Music/${name}.mp3`,
      originalPath: `/Music/${name}.mp3`,
      format: 'mp3' as const
    }))
  )
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('createBatch', () => {
  it('creates a computing, unpaused batch with one empty item per track', () => {
    // Act
    const id = newBatch()

    // Assert
    expect(getBatch(testDatabase.db, id)).toMatchObject({
      type: 'run',
      mode: 'clean_library',
      status: 'computing',
      paused: false,
      appliedAt: null
    })
    expect(testDatabase.db.select().from(batchItems).all()).toMatchObject(
      trackIds.map((trackId) => ({
        batchId: id,
        trackId,
        before: { title: `before ${trackId}` },
        after: {},
        error: null
      }))
    )
  })

  it('creates nothing when one item names a track that does not exist', () => {
    // Act
    const create = (): unknown => newBatch([trackIds[0] as number, 999_999])

    // Assert
    expect(create).toThrow(/FOREIGN KEY/)
    expect(findActiveBatch(testDatabase.db)).toBeUndefined()
  })

  it('holds a whole library', () => {
    // Arrange
    const many = insertTracks(
      testDatabase.db,
      Array.from({ length: 3000 }, (_, index) => ({
        path: `/Music/many/${index}.mp3`,
        originalPath: `/Music/many/${index}.mp3`,
        format: 'mp3' as const
      }))
    )

    // Act
    const id = newBatch(many)

    // Assert
    expect(listBatchItemStates(testDatabase.db, id)).toHaveLength(3000)
  })
})

describe('batch status', () => {
  it('finds the batch that is computing or applying, and no other', () => {
    // Arrange
    const id = newBatch()

    // Act
    const computing = findActiveBatch(testDatabase.db)?.id
    setBatchStatus(testDatabase.db, id, 'preview')
    const preview = findActiveBatch(testDatabase.db)
    setBatchStatus(testDatabase.db, id, 'applying')
    const applying = findActiveBatch(testDatabase.db)?.id

    // Assert
    expect([computing, preview, applying]).toEqual([id, undefined, id])
  })

  it('records when a batch was applied', () => {
    // Arrange
    const id = newBatch()

    // Act
    setBatchStatus(testDatabase.db, id, 'applied')

    // Assert
    expect(getBatch(testDatabase.db, id)?.appliedAt).toBeInstanceOf(Date)
  })

  it('keeps a pause across a restart', () => {
    // Arrange
    const id = newBatch()
    setBatchPaused(testDatabase.db, id, true)

    // Act
    const db = testDatabase.reopen()

    // Assert
    expect(getBatch(db, id)?.paused).toBe(true)
  })

  it('cancels the batches that wait for approval, and only those', () => {
    // Arrange
    const waiting = newBatch()
    setBatchStatus(testDatabase.db, waiting, 'preview')
    const applied = newBatch()
    setBatchStatus(testDatabase.db, applied, 'applied')

    // Act
    cancelPreviewBatches(testDatabase.db)

    // Assert
    expect(getBatch(testDatabase.db, waiting)?.status).toBe('cancelled')
    expect(getBatch(testDatabase.db, applied)?.status).toBe('applied')
  })
})

describe('batch items', () => {
  it('adds the proposals of later stages to those of earlier ones', () => {
    // Arrange
    const id = newBatch()
    const [trackId] = trackIds as [number]

    // Act
    mergeBatchItemProposal(testDatabase.db, id, trackId, { bpm: 124, key: '8A' })
    mergeBatchItemProposal(testDatabase.db, id, trackId, { key: '9A', energy: 7 })

    // Assert
    const [item] = testDatabase.db.select().from(batchItems).all()
    expect(item?.after).toEqual({ bpm: 124, key: '9A', energy: 7 })
  })

  it('keeps the first error of a track', () => {
    // Arrange
    const id = newBatch()
    const [trackId] = trackIds as [number]

    // Act
    setBatchItemError(testDatabase.db, id, trackError(trackId, 'bpmKey'))
    setBatchItemError(testDatabase.db, id, trackError(trackId, 'energy'))

    // Assert
    const [item] = testDatabase.db.select().from(batchItems).all()
    expect(item?.error).toEqual(trackError(trackId, 'bpmKey'))
  })
})

describe('jobs', () => {
  it('knows the same phases as the rest of the app', () => {
    // Assert
    expect(JOB_PHASES).toEqual(SHARED_JOB_PHASES)
  })

  function addJobs(batchId: number): void {
    insertJobs(
      testDatabase.db,
      trackIds.flatMap((trackId) => [
        { batchId, trackId, stage: 'bpmKey', phase: 'compute' as const },
        { batchId, trackId, stage: 'rename', phase: 'apply' as const }
      ])
    )
  }

  it('starts every job queued, in the order given', () => {
    // Arrange
    const batchId = newBatch()

    // Act
    addJobs(batchId)

    // Assert
    const stored = listJobs(testDatabase.db, batchId)
    expect(stored.map((job) => [job.trackId, job.stage, job.status, job.attempts])).toEqual(
      trackIds.flatMap((trackId) => [
        [trackId, 'bpmKey', 'queued', 0],
        [trackId, 'rename', 'queued', 0]
      ])
    )
  })

  it('refuses the same stage twice for a track of a batch', () => {
    // Arrange
    const batchId = newBatch()
    addJobs(batchId)

    // Act
    const again = (): unknown => addJobs(batchId)

    // Assert
    expect(again).toThrow(/UNIQUE/)
    expect(listJobs(testDatabase.db, batchId)).toHaveLength(6)
  })

  it('counts every start of a job, and records how it ended', () => {
    // Arrange
    const batchId = newBatch()
    addJobs(batchId)
    const [first, second, third] = listJobs(testDatabase.db, batchId) as [
      typeof jobs.$inferSelect,
      typeof jobs.$inferSelect,
      typeof jobs.$inferSelect
    ]

    // Act
    markJobRunning(testDatabase.db, first.id)
    markJobRunning(testDatabase.db, first.id)
    finishJob(testDatabase.db, first.id, { status: 'done' })
    markJobRunning(testDatabase.db, second.id)
    finishJob(testDatabase.db, second.id, { status: 'failed', error: trackError(second.trackId) })
    skipJobs(testDatabase.db, [third.id])

    // Assert
    const stored = listJobs(testDatabase.db, batchId)
    expect(stored.slice(0, 3)).toMatchObject([
      { status: 'done', attempts: 2, error: null },
      { status: 'failed', attempts: 1, error: trackError(second.trackId) },
      { status: 'skipped', attempts: 0 }
    ])
    expect(stored[0]?.finishedAt).toBeInstanceOf(Date)
  })

  it('puts interrupted jobs back in line, and hands back the ones started too often', () => {
    // Arrange
    const batchId = newBatch()
    addJobs(batchId)
    const [once, often, untouched] = listJobs(testDatabase.db, batchId)
    markJobRunning(testDatabase.db, once?.id as number)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      markJobRunning(testDatabase.db, often?.id as number)
    }

    // Act
    const givenUp = recoverInterruptedJobs(testDatabase.db, batchId, 3)

    // Assert
    expect(givenUp.map((job) => job.id)).toEqual([often?.id])
    const stored = listJobs(testDatabase.db, batchId)
    expect(stored.slice(0, 3).map((job) => [job.id, job.status, job.attempts])).toEqual([
      [once?.id, 'queued', 1],
      [often?.id, 'running', 3],
      [untouched?.id, 'queued', 0]
    ])
  })

  it('puts a started job back in line without counting the start, and touches no other job', () => {
    // Arrange
    const batchId = newBatch()
    addJobs(batchId)
    const [running, done] = listJobs(testDatabase.db, batchId)
    markJobRunning(testDatabase.db, running?.id as number)
    markJobRunning(testDatabase.db, done?.id as number)
    finishJob(testDatabase.db, done?.id as number, { status: 'done' })

    // Act
    requeueJobs(testDatabase.db, [running?.id as number, done?.id as number])

    // Assert
    const stored = listJobs(testDatabase.db, batchId)
    expect(stored.slice(0, 2).map((job) => [job.status, job.attempts])).toEqual([
      ['queued', 0],
      ['done', 1]
    ])
  })

  it('says which tracks of a batch failed', () => {
    // Arrange
    const batchId = newBatch()
    setBatchItemError(testDatabase.db, batchId, trackError(trackIds[1] as number))

    // Act
    const states = listBatchItemStates(testDatabase.db, batchId)

    // Assert
    expect(states.map((state) => state.failed)).toEqual([false, true, false])
  })

  it('removes the jobs with their batch, and keeps a track that a job refers to', () => {
    // Arrange
    const batchId = newBatch([trackIds[0] as number])
    insertJobs(testDatabase.db, [
      { batchId, trackId: trackIds[0] as number, stage: 'bpmKey', phase: 'compute' }
    ])

    // Act
    const removeTrack = (): unknown => deleteTrack(testDatabase.db, trackIds[0] as number)

    // Assert
    expect(removeTrack).toThrow(/FOREIGN KEY/)
  })
})
