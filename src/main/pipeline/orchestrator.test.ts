import { createHash } from 'crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBatch, setBatchStatus } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { listJobs } from '../db/jobs'
import { batchItems, batches } from '../db/schema'
import { insertTracks, setTracksMissing } from '../db/tracks'
import { logger } from '../services/logger'
import { AppError } from '@shared/errors'
import type { Resource, ResourceLimits, RunProgress } from '@shared/pipeline'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { validateStages } from './stages'
import type { Stage, StageResult } from './stages/stage'

const FIXTURE = join(import.meta.dirname, '../../../tests/fixtures/synthetic/sine.mp3')

interface FakeStageOptions {
  resource?: Resource
  dependsOn?: string[]
  phase?: Stage['phase']
  ms?: number
  timeoutMs?: number
  /** Ignores its abort signal, like a stage that is stuck in a call. */
  stubborn?: boolean
  fails?: (trackId: number) => boolean
  result?: (trackId: number) => StageResult
}

let testDatabase: TestDatabase
let mounted: Set<string>
let limits: ResourceLimits
let runningNow: Record<Resource, number>
let mostAtOnce: Record<Resource, number>
/** `stage:trackId` in the order the jobs started and finished. */
let started: string[]
let finished: string[]
let progress: RunProgress[]
let busy: boolean[]

function counters(): Record<Resource, number> {
  return { cpu: 0, gpu: 0, network: 0, claude: 0, io: 0 }
}

function fakeStage(name: string, options: FakeStageOptions = {}): Stage {
  const resource = options.resource ?? 'cpu'
  return {
    name,
    phase: options.phase ?? 'compute',
    resource,
    dependsOn: options.dependsOn ?? [],
    selectable: true,
    timeoutMs: options.timeoutMs ?? 60_000,
    run: async ({ signal }, track) => {
      started.push(`${name}:${track.id}`)
      runningNow[resource] += 1
      mostAtOnce[resource] = Math.max(mostAtOnce[resource], runningNow[resource])
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.ms ?? 100)
          if (options.stubborn) return
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
        if (options.fails?.(track.id)) throw new AppError('FILE_UNREADABLE', 'broken file')
        finished.push(`${name}:${track.id}`)
        return options.result?.(track.id)
      } finally {
        runningNow[resource] -= 1
      }
    }
  }
}

function addTracks(count: number, folder = '/Music'): number[] {
  return insertTracks(
    testDatabase.db,
    Array.from({ length: count }, (_, index) => ({
      path: `${folder}/${String(index).padStart(4, '0')}.mp3`,
      originalPath: `${folder}/${String(index).padStart(4, '0')}.mp3`,
      format: 'mp3' as const
    }))
  )
}

function orchestrator(stages: Stage[], db = testDatabase.db): Orchestrator {
  validateStages(stages)
  return createOrchestrator({
    db,
    stages,
    limits: () => limits,
    listMountedVolumes: () => mounted,
    mode: () => 'clean_library',
    onProgress: (report) => progress.push(report),
    onBusyChange: (isBusy) => busy.push(isBusy)
  })
}

function jobStatuses(batchId: number): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const job of listJobs(testDatabase.db, batchId)) {
    const key = `${job.stage}:${job.status}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function startedCount(key: string): number {
  return started.filter((each) => each === key).length
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  mounted = new Set(['DJ SSD'])
  limits = { cpu: 3, gpu: 1, network: 4, claude: 1, io: 2 }
  runningNow = counters()
  mostAtOnce = counters()
  started = []
  finished = []
  progress = []
  busy = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  testDatabase.cleanup()
})

describe('a run', () => {
  it('runs 200 tracks without ever exceeding the limit of a resource', async () => {
    // Arrange
    const trackIds = addTracks(200)
    const run = orchestrator([
      fakeStage('bpmKey', { resource: 'cpu', ms: 30 }),
      fakeStage('demucs', { resource: 'gpu', ms: 50 }),
      fakeStage('copy', { resource: 'io', ms: 10 })
    ])

    // Act
    const result = run.start({ trackIds, stages: ['bpmKey', 'demucs', 'copy'] })
    await vi.runAllTimersAsync()

    // Assert
    expect(result.ok).toBe(true)
    expect(finished).toHaveLength(600)
    expect(mostAtOnce).toEqual({ cpu: 3, gpu: 1, network: 0, claude: 0, io: 2 })
    expect(run.progress()).toBeNull()
  })

  it('starts a stage of a track only after the stages it depends on are done', async () => {
    // Arrange
    const trackIds = addTracks(20)
    const run = orchestrator([
      fakeStage('naming', { dependsOn: ['bpmKey', 'lookup'], ms: 5 }),
      fakeStage('bpmKey', { ms: 40 }),
      fakeStage('lookup', { resource: 'network', ms: 90 })
    ])

    // Act
    run.start({ trackIds, stages: ['naming'] })
    await vi.runAllTimersAsync()

    // Assert
    for (const trackId of trackIds) {
      const namingStarted = started.indexOf(`naming:${trackId}`)
      expect(namingStarted).toBeGreaterThan(-1)
      // Everything that had finished before naming started includes both dependencies.
      const before = new Set(finished.slice(0, finished.indexOf(`naming:${trackId}`)))
      expect(before.has(`bpmKey:${trackId}`) && before.has(`lookup:${trackId}`)).toBe(true)
    }
    expect(finished).toHaveLength(60)
  })

  it('ends the compute phase as a batch that waits for approval, with the proposals stored', async () => {
    // Arrange
    const [trackId] = addTracks(1) as [number]
    const run = orchestrator([
      fakeStage('bpmKey', { result: () => ({ proposal: { bpm: 124, camelotKey: '8A' } }) }),
      fakeStage('energy', { dependsOn: ['bpmKey'], result: () => ({ proposal: { energy: 7 } }) })
    ])

    // Act
    const result = run.start({ trackIds: [trackId], stages: ['energy'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    expect(getBatch(testDatabase.db, batchId)).toMatchObject({
      status: 'preview',
      mode: 'clean_library',
      pauseReason: null
    })
    const [item] = testDatabase.db.select().from(batchItems).all()
    expect(item).toMatchObject({
      trackId,
      before: { id: trackId, path: '/Music/0000.mp3', bpm: null },
      after: { bpm: 124, camelotKey: '8A', energy: 7 },
      error: null
    })
    expect(item?.before).not.toHaveProperty('offline')
  })

  it('changes no file in the compute phase', async () => {
    // Arrange
    vi.useRealTimers()
    const folder = mkdtempSync(join(tmpdir(), 'fixlibrary-run-'))
    const paths = Array.from({ length: 5 }, (_, index) => join(folder, `${index}.mp3`))
    for (const path of paths) copyFileSync(FIXTURE, path)
    const hashes = (): string[] =>
      paths.map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'))
    const before = hashes()
    const trackIds = insertTracks(
      testDatabase.db,
      paths.map((path) => ({ path, originalPath: path, format: 'mp3' as const }))
    )
    const reading: Stage = {
      ...fakeStage('read'),
      run: async (_context, track) => ({ proposal: { bytes: readFileSync(track.path).length } })
    }
    const run = orchestrator([reading, fakeStage('after', { dependsOn: ['read'], ms: 1 })])

    // Act
    run.start({ trackIds, stages: ['after'] })
    await run.whenFinished()

    // Assert
    expect(hashes()).toEqual(before)
    expect(testDatabase.db.select().from(batchItems).all()[0]?.after).toEqual({ bytes: 10_468 })
    rmSync(folder, { recursive: true, force: true })
  })
})

describe('a track that fails', () => {
  it('is recorded with its error, skips the stages that wait for it, and stops no other track', async () => {
    // Arrange
    const trackIds = addTracks(10)
    const broken = trackIds[3] as number
    const run = orchestrator([
      fakeStage('bpmKey', { fails: (trackId) => trackId === broken }),
      fakeStage('energy', { dependsOn: ['bpmKey'] }),
      fakeStage('naming', { dependsOn: ['energy'] }),
      fakeStage('lookup', { resource: 'network' })
    ])

    // Act
    const result = run.start({ trackIds, stages: ['naming', 'lookup'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    expect(jobStatuses(batchId)).toEqual({
      'bpmKey:done': 9,
      'bpmKey:failed': 1,
      'energy:done': 9,
      'energy:skipped': 1,
      'naming:done': 9,
      'naming:skipped': 1,
      'lookup:done': 10
    })
    const [item] = testDatabase.db
      .select()
      .from(batchItems)
      .where(eq(batchItems.trackId, broken))
      .all()
    expect(item?.error).toEqual({
      trackId: broken,
      stage: 'bpmKey',
      code: 'FILE_UNREADABLE',
      message: 'The file could not be read'
    })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
  })

  it('fails with TIMEOUT when a stage takes longer than it may, and tells the stage to stop', async () => {
    // Arrange
    const [trackId] = addTracks(1) as [number]
    const run = orchestrator([fakeStage('demucs', { ms: 5000, timeoutMs: 1000 })])

    // Act
    const result = run.start({ trackIds: [trackId], stages: ['demucs'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    const [job] = listJobs(testDatabase.db, batchId)
    expect(job).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } })
    expect(finished).toEqual([])
  })

  it('fails a track whose file the last scan did not find, without running a stage for it', async () => {
    // Arrange
    const [present, gone] = addTracks(2) as [number, number]
    limits.cpu = 1
    const run = orchestrator([fakeStage('bpmKey', { ms: 50 })])
    run.start({ trackIds: [present, gone], stages: ['bpmKey'] })

    // Act
    setTracksMissing(testDatabase.db, [gone], true)
    await vi.runAllTimersAsync()

    // Assert
    expect(started).toEqual([`bpmKey:${present}`])
  })
})

describe('pause and resume', () => {
  it('starts nothing new while paused, lets the running jobs finish, and goes on after resume', async () => {
    // Arrange
    const trackIds = addTracks(12)
    const run = orchestrator([fakeStage('bpmKey', { ms: 100 })])
    const result = run.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(50)

    // Act
    run.pause()
    await vi.advanceTimersByTimeAsync(10_000)
    const whilePaused = {
      finished: finished.length,
      state: run.progress()?.state,
      reason: run.progress()?.pauseReason,
      stored: getBatch(testDatabase.db, batchId)?.pauseReason
    }
    run.resume()
    await vi.runAllTimersAsync()

    // Assert
    expect(whilePaused).toEqual({ finished: 3, state: 'paused', reason: 'user', stored: 'user' })
    expect(finished).toHaveLength(12)
    expect(getBatch(testDatabase.db, batchId)).toMatchObject({
      status: 'preview',
      pauseReason: null
    })
  })

  it('lets the Mac sleep while a paused run has nothing running, and keeps it awake otherwise', async () => {
    // Arrange
    const trackIds = addTracks(6)
    const run = orchestrator([fakeStage('bpmKey', { ms: 100 })])
    run.start({ trackIds, stages: ['bpmKey'] })
    await vi.advanceTimersByTimeAsync(50)

    // Act
    run.pause()
    const stillRunning = [...busy]
    await vi.advanceTimersByTimeAsync(1000)
    const idle = [...busy]
    run.resume()
    await vi.runAllTimersAsync()

    // Assert
    expect(stillRunning).toEqual([true])
    expect(idle).toEqual([true, false])
    expect(busy).toEqual([true, false, true, false])
  })

  it('pauses instead of failing the tracks when the drive of the library goes away', async () => {
    // Arrange
    const trackIds = addTracks(8, '/Volumes/DJ SSD/Music')
    limits.cpu = 2
    const run = orchestrator([fakeStage('bpmKey', { ms: 100 })])
    const result = run.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(150)

    // Act
    mounted = new Set()
    await vi.advanceTimersByTimeAsync(10_000)
    const unplugged = {
      state: run.progress()?.state,
      reason: run.progress()?.pauseReason,
      statuses: jobStatuses(batchId)
    }
    mounted = new Set(['DJ SSD'])
    run.resume()
    await vi.runAllTimersAsync()

    // Assert
    expect(unplugged).toEqual({
      state: 'paused',
      reason: 'offline',
      statuses: { 'bpmKey:done': 4, 'bpmKey:queued': 4 }
    })
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:done': 8 })
  })
})

describe('cancel', () => {
  it('stops the running jobs, skips the rest, and ends the batch as cancelled', async () => {
    // Arrange
    const trackIds = addTracks(10)
    const run = orchestrator([
      fakeStage('bpmKey', { ms: 1000 }),
      fakeStage('energy', { dependsOn: ['bpmKey'] }),
      fakeStage('rename', { dependsOn: ['energy'], phase: 'apply', resource: 'io' })
    ])
    const result = run.start({ trackIds, stages: ['rename'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(1500)

    // Act
    run.cancel()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('cancelled')
    expect(jobStatuses(batchId)).toEqual({
      'bpmKey:done': 3,
      'bpmKey:skipped': 7,
      'energy:skipped': 10,
      'rename:skipped': 10
    })
    expect(run.progress()).toBeNull()
    expect(progress.at(-1)).toMatchObject({ state: 'finished', outcome: 'cancelled' })
  })

  it('does not wait for a stage that ignores being told to stop', async () => {
    // Arrange
    const trackIds = addTracks(3)
    const run = orchestrator([fakeStage('stuck', { ms: 3_600_000, stubborn: true })])
    const result = run.start({ trackIds, stages: ['stuck'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(100)

    // Act
    run.cancel()
    const endedAtOnce = run.progress() === null

    // Assert
    expect(endedAtOnce).toBe(true)
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('cancelled')
    expect(jobStatuses(batchId)).toEqual({ 'stuck:skipped': 3 })
  })

  it('cancels a paused run', async () => {
    // Arrange
    const trackIds = addTracks(5)
    const run = orchestrator([fakeStage('bpmKey')])
    const result = run.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    run.pause()
    await vi.runAllTimersAsync()

    // Act
    run.cancel()

    // Assert
    expect(getBatch(testDatabase.db, batchId)).toMatchObject({
      status: 'cancelled',
      pauseReason: null
    })
  })

  it('lets a new run start after a cancelled one', async () => {
    // Arrange
    const trackIds = addTracks(2)
    const run = orchestrator([fakeStage('bpmKey')])
    run.start({ trackIds, stages: ['bpmKey'] })
    run.cancel()

    // Act
    const again = run.start({ trackIds, stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Assert
    expect(again.ok).toBe(true)
    expect(finished).toHaveLength(2)
  })
})

describe('closing the app and starting it again', () => {
  const stages = (): Stage[] => [
    fakeStage('bpmKey', { ms: 100 }),
    fakeStage('energy', { dependsOn: ['bpmKey'], ms: 100 })
  ]

  it('goes on with the run, and does not run again what was done', async () => {
    // Arrange
    const trackIds = addTracks(9)
    const first = orchestrator(stages())
    const result = first.start({ trackIds, stages: ['energy'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(250)
    const doneBeforeClose = [...finished]

    // Act
    first.shutdown()
    await vi.advanceTimersByTimeAsync(1000)
    const second = orchestrator(stages(), testDatabase.reopen())
    second.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(doneBeforeClose.length).toBeGreaterThan(0)
    for (const key of doneBeforeClose) expect(startedCount(key)).toBe(1)
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:done': 9, 'energy:done': 9 })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
  })

  it('leaves a paused run paused until the user resumes it', async () => {
    // Arrange
    const trackIds = addTracks(4)
    const first = orchestrator(stages())
    first.start({ trackIds, stages: ['energy'] })
    first.pause()
    await vi.runAllTimersAsync()
    first.shutdown()
    const doneBeforeClose = finished.length

    // Act
    const second = orchestrator(stages(), testDatabase.reopen())
    second.recover()
    await vi.advanceTimersByTimeAsync(10_000)
    const afterRestart = { finished: finished.length, state: second.progress()?.state }
    second.resume()
    await vi.runAllTimersAsync()

    // Assert
    expect(afterRestart).toEqual({ finished: doneBeforeClose, state: 'paused' })
    expect(finished).toHaveLength(8)
  })

  it('gives up a job that was running in three crashes of the app, and goes on with the rest', async () => {
    // Arrange
    const trackIds = addTracks(2)
    limits.cpu = 1
    let batchId = -1
    for (let crash = 0; crash < 3; crash += 1) {
      const run = orchestrator(stages(), crash === 0 ? testDatabase.db : testDatabase.reopen())
      if (crash === 0) {
        const result = run.start({ trackIds, stages: ['energy'] })
        batchId = result.ok ? result.value.batchId : -1
      } else {
        run.recover()
      }
      await vi.advanceTimersByTimeAsync(50)
      // The app is gone in the middle of the job: nothing of it happens any more.
      vi.clearAllTimers()
    }

    // Act
    const last = orchestrator(stages(), testDatabase.reopen())
    last.recover()
    await vi.runAllTimersAsync()

    // Assert
    const [poison, other] = trackIds as [number, number]
    expect(startedCount(`bpmKey:${poison}`)).toBe(3)
    expect(jobStatuses(batchId)).toEqual({
      'bpmKey:failed': 1,
      'energy:skipped': 1,
      'bpmKey:done': 1,
      'energy:done': 1
    })
    expect(finished).toEqual([`bpmKey:${other}`, `energy:${other}`])
    const items = testDatabase.db.select().from(batchItems).all()
    expect(items.find((item) => item.trackId === poison)?.error).toMatchObject({
      stage: 'bpmKey',
      code: 'UNEXPECTED'
    })
  })

  it('does not count closing the app on purpose as an attempt', async () => {
    // Arrange
    const trackIds = addTracks(1)
    let batchId = -1
    for (let quit = 0; quit < 5; quit += 1) {
      const run = orchestrator(stages(), quit === 0 ? testDatabase.db : testDatabase.reopen())
      if (quit === 0) {
        const result = run.start({ trackIds, stages: ['bpmKey'] })
        batchId = result.ok ? result.value.batchId : -1
      } else {
        run.recover()
      }
      await vi.advanceTimersByTimeAsync(50)
      run.shutdown()
      await vi.advanceTimersByTimeAsync(1000)
    }

    // Act
    const last = orchestrator(stages(), testDatabase.reopen())
    last.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(listJobs(testDatabase.db, batchId)).toMatchObject([{ status: 'done', attempts: 1 }])
  })

  it('never takes a cancelled batch up again, also when the app crashes right after the cancel', async () => {
    // Arrange
    const trackIds = addTracks(4)
    limits.cpu = 2
    const first = orchestrator(stages())
    const result = first.start({ trackIds, stages: ['energy'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(50)

    // Act
    first.cancel()
    // The app is gone before the stopped jobs have unwound.
    vi.clearAllTimers()
    const second = orchestrator(stages(), testDatabase.reopen())
    second.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('cancelled')
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:skipped': 4, 'energy:skipped': 4 })
    expect(second.progress()).toBeNull()
    expect(finished).toEqual([])
  })

  it('goes on by itself after a restart when it had paused for a drive that is back', async () => {
    // Arrange
    const trackIds = addTracks(4, '/Volumes/DJ SSD/Music')
    limits.cpu = 1
    const first = orchestrator(stages())
    const result = first.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(150)
    mounted = new Set()
    await vi.advanceTimersByTimeAsync(1000)
    const storedReason = getBatch(testDatabase.db, batchId)?.pauseReason
    first.shutdown()

    // Act
    mounted = new Set(['DJ SSD'])
    const second = orchestrator(stages(), testDatabase.reopen())
    second.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(storedReason).toBe('offline')
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:done': 4 })
    expect(getBatch(testDatabase.db, batchId)).toMatchObject({
      status: 'preview',
      pauseReason: null
    })
  })

  it('pauses again after a restart when the drive it had paused for is still away', async () => {
    // Arrange
    const trackIds = addTracks(4, '/Volumes/DJ SSD/Music')
    limits.cpu = 1
    const first = orchestrator(stages())
    const result = first.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(150)
    first.shutdown()
    mounted = new Set()

    // Act
    const second = orchestrator(stages(), testDatabase.reopen())
    second.recover()
    await vi.advanceTimersByTimeAsync(10_000)

    // Assert
    expect(second.progress()).toMatchObject({ state: 'paused', pauseReason: 'offline' })
    expect(getBatch(testDatabase.db, batchId)?.pauseReason).toBe('offline')
  })

  it('goes on with the apply phase after a restart, still only for the approved tracks', async () => {
    // Arrange
    const [approved, other] = addTracks(2) as [number, number]
    const applyStages = (): Stage[] => [
      fakeStage('naming'),
      fakeStage('rename', { dependsOn: ['naming'], phase: 'apply', resource: 'io', ms: 500 })
    ]
    const first = orchestrator(applyStages())
    const result = first.start({ trackIds: [approved, other], stages: ['rename'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.runAllTimersAsync()
    testDatabase.db
      .update(batchItems)
      .set({ approved: true })
      .where(eq(batchItems.trackId, approved))
      .run()
    first.applyBatch(batchId)
    await vi.advanceTimersByTimeAsync(100)
    first.shutdown()
    await vi.advanceTimersByTimeAsync(1000)
    started = []

    // Act
    const second = orchestrator(applyStages(), testDatabase.reopen())
    second.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(started).toEqual([`rename:${approved}`])
    expect(jobStatuses(batchId)).toEqual({
      'naming:done': 2,
      'rename:done': 1,
      'rename:skipped': 1
    })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('applied')
  })

  it('finishes a batch whose last job ended just before the app closed', async () => {
    // Arrange
    const trackIds = addTracks(1)
    const first = orchestrator(stages())
    const result = first.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.runAllTimersAsync()
    // As if the app had stopped between the last job and the change of the status.
    setBatchStatus(testDatabase.db, batchId, 'computing')

    // Act
    const second = orchestrator(stages(), testDatabase.reopen())
    second.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
    expect(startedCount(`bpmKey:${trackIds[0]}`)).toBe(1)
  })

  it('skips the jobs of a stage that the app no longer has', async () => {
    // Arrange
    const trackIds = addTracks(2)
    const first = orchestrator([fakeStage('bpmKey'), fakeStage('old', { ms: 5000 })])
    const result = first.start({ trackIds, stages: ['bpmKey', 'old'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(10)
    first.shutdown()

    // Act
    const second = orchestrator([fakeStage('bpmKey')], testDatabase.reopen())
    second.recover()
    await vi.runAllTimersAsync()

    // Assert
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:done': 2, 'old:skipped': 2 })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
  })
})

describe('what listens to a run', () => {
  it('cannot stop a run by failing', async () => {
    // Arrange
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const trackIds = addTracks(3)
    const run = createOrchestrator({
      db: testDatabase.db,
      stages: [fakeStage('bpmKey')],
      limits: () => limits,
      listMountedVolumes: () => mounted,
      mode: () => 'clean_library',
      onProgress: () => {
        throw new Error('Object has been destroyed')
      },
      onBusyChange: () => {
        throw new Error('the sleep blocker failed')
      }
    })

    // Act
    const result = run.start({ trackIds, stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:done': 3 })
    expect(run.progress()).toBeNull()
  })
})

describe('a listener that acts on the run from inside a report', () => {
  function withListener(stages: Stage[], onProgress: (report: RunProgress) => void): Orchestrator {
    validateStages(stages)
    const run: Orchestrator = createOrchestrator({
      db: testDatabase.db,
      stages,
      limits: () => limits,
      listMountedVolumes: () => mounted,
      mode: () => 'clean_library',
      onProgress: (report) => {
        progress.push(report)
        onProgress(report)
      }
    })
    return run
  }

  it('frees the place of a job that was cancelled as it started', async () => {
    // Arrange
    const trackIds = addTracks(2)
    let cancelOnStart = true
    const run: Orchestrator = withListener(
      [fakeStage('demucs', { resource: 'gpu', ms: 100, timeoutMs: 600_000, stubborn: true })],
      (report) => {
        if (cancelOnStart && report.counts.running === 1) {
          cancelOnStart = false
          run.cancel()
        }
      }
    )
    run.start({ trackIds, stages: ['demucs'] })
    started = []

    // Act
    const again = run.start({ trackIds, stages: ['demucs'] })
    await vi.advanceTimersByTimeAsync(5000)

    // Assert: the one gpu place is free for the new run long before the old timeout.
    expect(again.ok).toBe(true)
    expect(finished).toHaveLength(2)
    expect(run.progress()).toBeNull()
  })

  it('finds no run to cancel once the last report of a run is out', async () => {
    // Arrange
    const trackIds = addTracks(2)
    const run: Orchestrator = withListener([fakeStage('bpmKey')], (report) => {
      if (report.state === 'finished') run.cancel()
    })

    // Act
    const result = run.start({ trackIds, stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
    expect(progress.filter((report) => report.state === 'finished')).toMatchObject([
      { outcome: 'preview' }
    ])
  })

  it('does not put a job back in line when the pause for a missing drive is answered with a cancel', async () => {
    // Arrange
    const trackIds = addTracks(3, '/Volumes/DJ SSD/Music')
    const run: Orchestrator = withListener([fakeStage('bpmKey')], (report) => {
      if (report.pauseReason === 'offline') run.cancel()
    })
    limits.cpu = 1
    const result = run.start({ trackIds, stages: ['bpmKey'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.advanceTimersByTimeAsync(150)

    // Act
    mounted = new Set()
    await vi.runAllTimersAsync()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('cancelled')
    expect(run.progress()).toBeNull()
    expect(jobStatuses(batchId)).toEqual({ 'bpmKey:done': 2, 'bpmKey:skipped': 1 })
  })
})

describe('starting a run', () => {
  it('refuses a second run while one is active', async () => {
    // Arrange
    const trackIds = addTracks(3)
    const run = orchestrator([fakeStage('bpmKey')])
    run.start({ trackIds, stages: ['bpmKey'] })

    // Act
    const second = run.start({ trackIds, stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Assert
    expect(second).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(finished).toHaveLength(3)
  })

  it('refuses a run while a batch of an earlier session is still active', () => {
    // Arrange
    const trackIds = addTracks(1)
    const first = orchestrator([fakeStage('bpmKey')])
    first.start({ trackIds, stages: ['bpmKey'] })
    first.shutdown()

    // Act
    const other = orchestrator([fakeStage('bpmKey')]).start({ trackIds, stages: ['bpmKey'] })

    // Assert
    expect(other).toEqual({ ok: false, code: 'RUN_ACTIVE' })
  })

  it.each([
    ['a stage that does not exist', (ids: number[]) => ({ trackIds: ids, stages: ['demucs'] })],
    ['no stage', (ids: number[]) => ({ trackIds: ids, stages: [] })],
    ['no track', () => ({ trackIds: [], stages: ['bpmKey'] })],
    ['only tracks that do not exist', () => ({ trackIds: [999_999], stages: ['bpmKey'] })],
    ['a path in place of an id', () => ({ trackIds: ['/etc/passwd'], stages: ['bpmKey'] })],
    ['an extra field', (ids: number[]) => ({ trackIds: ids, stages: ['bpmKey'], mode: 'in_place' })]
  ])('refuses %s, and creates no batch', (_name, request) => {
    // Arrange
    const trackIds = addTracks(2)
    const run = orchestrator([fakeStage('bpmKey')])

    // Act
    const result = run.start(request(trackIds))

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(testDatabase.db.select().from(batches).all()).toEqual([])
  })

  it('leaves out a track that is offline or has no file, and runs the others', async () => {
    // Arrange
    const [online, missing] = addTracks(2) as [number, number]
    const [offline] = addTracks(1, '/Volumes/Gone/Music') as [number]
    setTracksMissing(testDatabase.db, [missing], true)
    const run = orchestrator([fakeStage('bpmKey')])

    // Act
    const result = run.start({ trackIds: [offline, online, missing, online], stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Assert
    expect(result.ok).toBe(true)
    expect(started).toEqual([`bpmKey:${online}`])
  })

  it('gives up an older batch that still waited for approval, and deletes it', async () => {
    // Arrange
    const trackIds = addTracks(1)
    const run = orchestrator([fakeStage('bpmKey')])
    const first = run.start({ trackIds, stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Act
    const second = run.start({ trackIds, stages: ['bpmKey'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchOf = (result: typeof first): ReturnType<typeof getBatch> =>
      result.ok ? getBatch(testDatabase.db, result.value.batchId) : undefined
    expect(batchOf(first)).toBeUndefined()
    expect(batchOf(second)?.status).toBe('preview')
    expect(testDatabase.db.select().from(batchItems).all()).toHaveLength(1)
  })

  it('does not pile up batches when runs are started and cancelled again and again', async () => {
    // Arrange
    const trackIds = addTracks(50)
    const run = orchestrator([fakeStage('bpmKey'), fakeStage('energy', { dependsOn: ['bpmKey'] })])

    // Act
    for (let turn = 0; turn < 10; turn += 1) {
      run.start({ trackIds, stages: ['energy'] })
      await vi.advanceTimersByTimeAsync(50)
      run.cancel()
    }
    const last = run.start({ trackIds, stages: ['energy'] })

    // Assert: only the run that is active has rows.
    const batchId = last.ok ? last.value.batchId : -1
    expect(
      testDatabase.db
        .select()
        .from(batches)
        .all()
        .map((batch) => batch.id)
    ).toEqual([batchId])
    expect(testDatabase.db.select().from(batchItems).all()).toHaveLength(50)
    expect(listJobs(testDatabase.db, batchId)).toHaveLength(100)
  })

  it('keeps a batch that was cancelled while it was being applied', async () => {
    // Arrange
    const trackIds = addTracks(2)
    const stages = [
      fakeStage('naming'),
      fakeStage('rename', { dependsOn: ['naming'], phase: 'apply', resource: 'io', ms: 500 })
    ]
    const run = orchestrator(stages)
    const first = run.start({ trackIds, stages: ['rename'] })
    const firstId = first.ok ? first.value.batchId : -1
    await vi.runAllTimersAsync()
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    run.applyBatch(firstId)
    await vi.advanceTimersByTimeAsync(100)
    run.cancel()

    // Act
    run.start({ trackIds, stages: ['rename'] })
    await vi.runAllTimersAsync()

    // Assert: undo may need what that batch recorded.
    expect(getBatch(testDatabase.db, firstId)?.status).toBe('cancelled')
  })
})

describe('the apply phase', () => {
  const stages = (): Stage[] => [
    fakeStage('naming'),
    fakeStage('rename', { dependsOn: ['naming'], phase: 'apply', resource: 'io' }),
    fakeStage('writeTags', { dependsOn: ['rename'], phase: 'apply', resource: 'io' })
  ]

  it('does not run before the batch is approved', async () => {
    // Arrange
    const trackIds = addTracks(3)
    const run = orchestrator(stages())

    // Act
    const result = run.start({ trackIds, stages: ['writeTags'] })
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    expect(jobStatuses(batchId)).toEqual({
      'naming:done': 3,
      'rename:queued': 3,
      'writeTags:queued': 3
    })
    expect(started.some((key) => key.startsWith('rename'))).toBe(false)
  })

  it('writes only the tracks the user approved and did not take out', async () => {
    // Arrange
    const [approved, excluded, notApproved] = addTracks(3) as [number, number, number]
    const run = orchestrator(stages())
    const result = run.start({
      trackIds: [approved, excluded, notApproved],
      stages: ['writeTags']
    })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.runAllTimersAsync()
    testDatabase.db
      .update(batchItems)
      .set({ approved: true })
      .where(eq(batchItems.trackId, approved))
      .run()
    testDatabase.db
      .update(batchItems)
      .set({ approved: true, excluded: true })
      .where(eq(batchItems.trackId, excluded))
      .run()
    started = []

    // Act
    const applying = run.applyBatch(batchId)
    await vi.runAllTimersAsync()

    // Assert
    expect(applying).toEqual({ ok: true, value: { batchId } })
    expect(started).toEqual([`rename:${approved}`, `writeTags:${approved}`])
    expect(jobStatuses(batchId)).toMatchObject({
      'rename:done': 1,
      'rename:skipped': 2,
      'writeTags:done': 1,
      'writeTags:skipped': 2
    })
    const batch = getBatch(testDatabase.db, batchId)
    expect(batch?.status).toBe('applied')
    expect(batch?.appliedAt).toBeInstanceOf(Date)
  })

  it('does not write a track that a compute stage failed for, even when it was approved', async () => {
    // Arrange
    const [fine, failed] = addTracks(2) as [number, number]
    const run = orchestrator([
      fakeStage('lookup', { fails: (trackId) => trackId === failed }),
      // Does not wait for the lookup, so only the error on the item can hold it back.
      fakeStage('rename', { phase: 'apply', resource: 'io' })
    ])
    const result = run.start({ trackIds: [fine, failed], stages: ['lookup', 'rename'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.runAllTimersAsync()
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    started = []

    // Act
    run.applyBatch(batchId)
    await vi.runAllTimersAsync()

    // Assert
    expect(started).toEqual([`rename:${fine}`])
  })

  it('throws away what a stage returns after the batch was cancelled while applying', async () => {
    // Arrange
    const [trackId] = addTracks(1) as [number]
    const run = orchestrator([
      fakeStage('naming'),
      fakeStage('rename', {
        dependsOn: ['naming'],
        phase: 'apply',
        resource: 'io',
        ms: 500,
        stubborn: true,
        result: () => ({ proposal: { written: true } })
      })
    ])
    const result = run.start({ trackIds: [trackId], stages: ['rename'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.runAllTimersAsync()
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    run.applyBatch(batchId)
    await vi.advanceTimersByTimeAsync(100)

    // Act
    run.cancel()
    await vi.runAllTimersAsync()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('cancelled')
    expect(jobStatuses(batchId)).toEqual({ 'naming:done': 1, 'rename:skipped': 1 })
    expect(testDatabase.db.select().from(batchItems).all()[0]?.after).toEqual({})
  })

  it('ends at once as applied when no track of the batch was approved', async () => {
    // Arrange
    const trackIds = addTracks(2)
    const run = orchestrator(stages())
    const result = run.start({ trackIds, stages: ['writeTags'] })
    const batchId = result.ok ? result.value.batchId : -1
    await vi.runAllTimersAsync()
    progress = []
    busy = []

    // Act
    const applying = run.applyBatch(batchId)

    // Assert
    expect(applying).toEqual({ ok: true, value: { batchId } })
    expect(run.progress()).toBeNull()
    expect(progress).toMatchObject([{ state: 'finished', outcome: 'applied', phase: 'apply' }])
    expect(busy).toEqual([])
    expect(jobStatuses(batchId)).toMatchObject({ 'rename:skipped': 2, 'writeTags:skipped': 2 })
  })

  it('refuses to apply a batch that does not wait for approval', async () => {
    // Arrange
    const trackIds = addTracks(1)
    const run = orchestrator(stages())
    const result = run.start({ trackIds, stages: ['writeTags'] })
    const batchId = result.ok ? result.value.batchId : -1

    // Act
    const whileComputing = run.applyBatch(batchId)
    run.cancel()
    const afterCancel = run.applyBatch(batchId)
    const unknown = run.applyBatch(999_999)

    // Assert
    expect(whileComputing).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(afterCancel).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(unknown).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('progress', () => {
  it('reports the counts per stage in the order the stages run, and ends with a last report', async () => {
    // Arrange
    const trackIds = addTracks(4)
    const run = orchestrator([
      fakeStage('energy', { dependsOn: ['bpmKey'] }),
      fakeStage('bpmKey', { fails: (trackId) => trackId === trackIds[0] })
    ])

    // Act
    const result = run.start({ trackIds, stages: ['energy'] })
    const first = progress[0]
    await vi.runAllTimersAsync()

    // Assert
    const batchId = result.ok ? result.value.batchId : -1
    expect(first).toMatchObject({
      batchId,
      phase: 'compute',
      state: 'running',
      pauseReason: null,
      counts: { total: 8, done: 0, failed: 0, skipped: 0 },
      remainingMs: null
    })
    expect(progress.at(-1)).toMatchObject({
      state: 'finished',
      counts: { total: 8, done: 6, failed: 1, skipped: 1, running: 0 },
      stages: [
        { stage: 'bpmKey', total: 4, done: 3, failed: 1, skipped: 0, running: 0 },
        { stage: 'energy', total: 4, done: 3, failed: 0, skipped: 1, running: 0 }
      ]
    })
  })

  it('counts the time it works, not the time it is paused', async () => {
    // Arrange
    const trackIds = addTracks(6)
    limits.cpu = 1
    const run = orchestrator([fakeStage('bpmKey', { ms: 1000 })])
    run.start({ trackIds, stages: ['bpmKey'] })
    await vi.advanceTimersByTimeAsync(2500)

    // Act
    run.pause()
    const atPause = run.progress()?.elapsedMs
    await vi.advanceTimersByTimeAsync(60_000)
    const afterAnHourOfPause = run.progress()?.elapsedMs
    run.resume()
    await vi.advanceTimersByTimeAsync(1500)

    // Assert
    expect(atPause).toBe(2500)
    expect(afterAnHourOfPause).toBe(2500)
    expect(run.progress()?.elapsedMs).toBe(4000)
  })

  it('says how many tracks the batch has and how many of them failed', async () => {
    // Arrange
    const trackIds = addTracks(5)
    const run = orchestrator([
      fakeStage('bpmKey', { fails: (trackId) => trackId === trackIds[1] }),
      fakeStage('lookup', {
        resource: 'network',
        fails: (trackId) => trackId === trackIds[1] || trackId === trackIds[4]
      })
    ])

    // Act
    run.start({ trackIds, stages: ['bpmKey', 'lookup'] })
    await vi.runAllTimersAsync()

    // Assert: one track failed in two stages and counts once.
    expect(progress.at(-1)).toMatchObject({
      state: 'finished',
      tracks: { total: 5, failed: 2 },
      counts: { failed: 3 }
    })
  })

  it('estimates the time left from the jobs that have finished', async () => {
    // Arrange
    const trackIds = addTracks(20)
    limits.cpu = 2
    const run = orchestrator([fakeStage('bpmKey', { ms: 1000 })])
    run.start({ trackIds, stages: ['bpmKey'] })

    // Act
    await vi.advanceTimersByTimeAsync(2500)
    const midway = run.progress()
    await vi.runAllTimersAsync()

    // Assert: 4 done, 16 left, two at a time, one second each.
    expect(midway?.counts).toMatchObject({ done: 4, running: 2 })
    expect(midway?.remainingMs).toBe(8000)
  })
})
