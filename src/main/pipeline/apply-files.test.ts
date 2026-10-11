// A whole batch, from the run to the files on disk: the orchestrator, the file rules
// and the file operations together, with stand-in stages and files in a temp folder.
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listBackups } from '../db/backups'
import { getBatch, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { listJobs } from '../db/jobs'
import { batchItems } from '../db/schema'
import { getTrackById, insertTracks } from '../db/tracks'
import { createFileOps, type FileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import { createBatchFiles, type BatchFiles } from './batch-files'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import type { Stage, StageContext } from './stages/stage'

const FIXTURE = readFileSync(
  join(import.meta.dirname, '../../../tests/fixtures/synthetic/sine.mp3')
)
const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase
let folder: string
let library: string
let clean: string
let backups: string
let mode: BatchMode
let fileOps: FileOps
let batchFiles: BatchFiles
/** What the compute stage was handed as its way to change files. */
let computeFiles: StageContext['files'][]

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1))
    .sort()
}

function addTracks(count: number): { ids: number[]; paths: string[] } {
  const paths = Array.from({ length: count }, (_, index) =>
    join(library, 'Inbox', `track-${String(index + 1).padStart(2, '0')}.mp3`)
  )
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true })
    // Every file differs, so that two files that were mixed up would show.
    writeFileSync(path, Buffer.concat([FIXTURE, Buffer.from(path)]))
  }
  const ids = insertTracks(
    testDatabase.db,
    paths.map((path) => ({
      path,
      originalPath: path,
      format: 'mp3' as const,
      title: basename(path)
    }))
  )
  return { ids, paths }
}

/** Stands in for the stages that write: renames the file and replaces its content. */
function writingStages(writeMs = 0): Stage[] {
  return [
    {
      name: 'naming',
      phase: 'compute',
      resource: 'cpu',
      dependsOn: [],
      selectable: true,
      timeoutMs: 10_000,
      run: async ({ files }, track) => {
        computeFiles.push(files)
        return { proposal: { fileName: `Renamed ${track.id}.mp3` } }
      }
    },
    {
      name: 'rename',
      phase: 'apply',
      resource: 'io',
      dependsOn: ['naming'],
      selectable: false,
      timeoutMs: 10_000,
      run: async ({ files, signal }, track) => {
        if (!files) throw new Error('an apply stage must be given its files')
        const working = await files.workingPath()
        const moved = await files.move(join(dirname(working), `Renamed ${track.id}.mp3`))
        await files.replaceContent(async (temp, stop) => {
          await writeFile(temp, `first half of ${track.id}`)
          await new Promise((resolve) => setTimeout(resolve, writeMs))
          if (stop.aborted) throw new Error('stopped')
          await writeFile(temp, `tagged content of ${track.id}`)
        })
        if (signal.aborted) throw new Error('stopped')
        return moved.collided ? { proposal: { warnings: ['NAME_COLLISION'] } } : undefined
      }
    }
  ]
}

function orchestrator(stages = writingStages(), files = batchFiles): Orchestrator {
  return createOrchestrator({
    db: testDatabase.db,
    stages,
    limits: () => ({ cpu: 4, gpu: 1, network: 4, claude: 1, io: 2 }),
    listMountedVolumes: () => NO_VOLUMES,
    mode: () => mode,
    batchFiles: files
  })
}

/** Computes a batch for the tracks and approves all of them but `excluded`. */
async function computed(
  run: Orchestrator,
  ids: number[],
  excluded: number[] = []
): Promise<number> {
  // Asking for the stage that writes brings the compute stage it depends on with it.
  const started = run.start({ trackIds: ids, stages: ['rename'] })
  if (!started.ok) throw new Error(`the run did not start: ${started.code}`)
  await run.whenFinished()
  testDatabase.db.update(batchItems).set({ approved: true }).run()
  for (const trackId of excluded) {
    testDatabase.db
      .update(batchItems)
      .set({ excluded: true })
      .where(eq(batchItems.trackId, trackId))
      .run()
  }
  return started.value.batchId
}

async function applied(run: Orchestrator, ids: number[], excluded: number[] = []): Promise<number> {
  const batchId = await computed(run, ids, excluded)
  const applying = await run.applyBatch(batchId)
  if (!applying.ok) throw new Error(`the batch was not applied: ${applying.code}`)
  await run.whenFinished()
  // The backups of earlier batches are deleted right after a batch is applied.
  await vi.waitFor(() => expect(readdirSync(backups).length).toBeLessThanOrEqual(1))
  return batchId
}

function pathOf(trackId: number): string {
  return getTrackById(testDatabase.db, trackId, NO_VOLUMES)?.path ?? ''
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-apply-')))
  library = join(folder, 'Music')
  clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  mode = 'in_place'
  computeFiles = []
  fileOps = createFileOps({ allowedRoots: () => [library, clean, backups] })
  batchFiles = createBatchFiles({
    db: testDatabase.db,
    fileOps,
    folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
    listMountedVolumes: () => NO_VOLUMES
  })
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('a batch applied in place', () => {
  it('leaves the 20 originals in the backup folder, and undo puts all 20 back byte for byte', async () => {
    // Arrange
    const { ids, paths } = addTracks(20)
    const originals = paths.map(sha256)
    const run = orchestrator()

    // Act
    const batchId = await applied(run, ids)
    const backedUp = filesUnder(backups)
    const backupHashes = ids.map((id) => sha256(join(backups, String(batchId), `${id}.mp3`)))
    const written = ids.map((id) => readFileSync(pathOf(id), 'utf8'))
    const undone = await run.undoLast()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('undone')
    expect(backedUp).toHaveLength(20)
    expect(backupHashes).toEqual(originals)
    expect(written).toEqual(ids.map((id) => `tagged content of ${id}`))
    expect(undone).toEqual({ ok: true, value: { batchId, restored: 20, removed: 20 } })
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(library)).toEqual(paths.map((path) => path.slice(folder.length + 1)))
    expect(ids.map(pathOf)).toEqual(paths)
  })

  it('does not touch the file of a track that was taken out of the batch', async () => {
    // Arrange
    const { ids, paths } = addTracks(4)
    const [, excluded] = ids as [number, number]
    const original = sha256(paths[1] as string)
    const run = orchestrator()

    // Act
    const batchId = await applied(run, ids, [excluded])

    // Assert
    expect(sha256(paths[1] as string)).toBe(original)
    expect(pathOf(excluded)).toBe(paths[1])
    expect(listBackups(testDatabase.db, batchId)).toHaveLength(3)
  })

  it('changes no file before the batch is approved, and gives a compute stage no way to', async () => {
    // Arrange
    const { ids, paths } = addTracks(5)
    const originals = paths.map(sha256)
    const run = orchestrator()

    // Act
    const batchId = await computed(run, ids)

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(backups)).toEqual([])
    expect(computeFiles).toEqual([null, null, null, null, null])
  })

  it('keeps only the backups of the last batch, and undo undoes that one', async () => {
    // Arrange
    const { ids } = addTracks(3)
    const run = orchestrator()
    const first = await applied(run, ids)
    const afterFirst = ids.map((id) => sha256(pathOf(id)))
    const namesAfterFirst = ids.map(pathOf)

    // Act
    const second = await applied(run, ids)
    const backedUp = readdirSync(backups)
    const undone = await run.undoLast()

    // Assert
    expect(backedUp).toEqual([String(second)])
    expect(listBackups(testDatabase.db, first)).toEqual([])
    expect(undone).toMatchObject({ ok: true, value: { batchId: second, restored: 3 } })
    expect(ids.map(pathOf)).toEqual(namesAfterFirst)
    expect(ids.map((id) => sha256(pathOf(id)))).toEqual(afterFirst)
  })
})

describe('a batch applied in the clean library', () => {
  it('leaves every original byte-identical, and undo deletes the copies', async () => {
    // Arrange
    mode = 'clean_library'
    const { ids, paths } = addTracks(20)
    const originals = paths.map(sha256)
    const run = orchestrator()

    // Act
    const batchId = await applied(run, ids)
    const afterBatch = paths.map(sha256)
    const copies = filesUnder(clean)
    const undone = await run.undoLast()

    // Assert
    expect(afterBatch).toEqual(originals)
    expect(copies).toEqual(ids.map((id) => `Clean/Inbox/Renamed ${id}.mp3`).sort())
    expect(filesUnder(backups)).toEqual([])
    expect(undone).toEqual({ ok: true, value: { batchId, restored: 0, removed: 20 } })
    expect(filesUnder(clean)).toEqual([])
    expect(paths.map(sha256)).toEqual(originals)
    expect(ids.map(pathOf)).toEqual(paths)
  })
})

describe('an apply phase that is interrupted', () => {
  it('leaves no half-written file when the app is closed in the middle, and goes on at the next start', async () => {
    // Arrange
    const { ids, paths } = addTracks(6)
    const originals = paths.map(sha256)
    const first = orchestrator(writingStages(150))
    const batchId = await computed(first, ids)
    await first.applyBatch(batchId)
    await new Promise((resolve) => setTimeout(resolve, 60))

    // Act: closed while two tracks are being written.
    first.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const midway = filesUnder(library)
    const contents = ids.map((id) => readFileSync(pathOf(id)))
    await batchFiles.removeTempFiles()
    const second = orchestrator(writingStages(0))
    second.recover()
    await second.whenFinished()

    // Assert: when the app closed, every file was whole: the original, or the new
    // content complete. None held half of a write, and no temp file was left.
    expect(midway.some((name) => name.endsWith('.fixlib-tmp'))).toBe(false)
    contents.forEach((content, index) => {
      const hash = createHash('sha256').update(content).digest('hex')
      const whole =
        originals.includes(hash) || content.toString() === `tagged content of ${ids[index]}`
      expect(whole).toBe(true)
    })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('applied')
    expect(ids.map((id) => readFileSync(pathOf(id), 'utf8'))).toEqual(
      ids.map((id) => `tagged content of ${id}`)
    )
    expect(filesUnder(library).some((name) => name.endsWith('.fixlib-tmp'))).toBe(false)
    // And the originals are all still there to go back to.
    await second.undoLast()
    expect(paths.map(sha256)).toEqual(originals)
  })

  it('finds no temp file at the next start after a crash left some behind', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const run = orchestrator()
    await applied(run, ids)
    // What a process that was killed in the middle of a write leaves.
    writeFileSync(join(library, 'Inbox', '.Renamed 1.mp3.fixlib-tmp'), 'half')
    writeFileSync(join(backups, '.2.mp3.fixlib-tmp'), 'half')

    // Act
    const removed = await batchFiles.removeTempFiles()

    // Assert
    expect(removed).toBe(2)
    expect([...filesUnder(library), ...filesUnder(backups)].join()).not.toContain('.fixlib-tmp')
  })

  it('can be undone after it was cancelled halfway', async () => {
    // Arrange
    const { ids, paths } = addTracks(8)
    const originals = paths.map(sha256)
    const run = orchestrator(writingStages(100))
    const batchId = await computed(run, ids)
    await run.applyBatch(batchId)
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Act
    run.cancel()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const undone = await run.undoLast()

    // Assert
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('undone')
    expect(undone.ok).toBe(true)
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(library)).toEqual(paths.map((path) => path.slice(folder.length + 1)))
  })
})

describe('too little free space', () => {
  it('does not start the apply phase, changes nothing, and says what is needed and what is free', async () => {
    // Arrange
    const { ids, paths } = addTracks(5)
    const originals = paths.map(sha256)
    const needed = paths.reduce((sum, path) => sum + readFileSync(path).length, 0)
    const cramped = createBatchFiles({
      db: testDatabase.db,
      fileOps: { ...fileOps, freeBytes: async () => 4096 },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })
    const run = orchestrator(writingStages(), cramped)
    const batchId = await computed(run, ids)

    // Act
    const applying = await run.applyBatch(batchId)
    const space = await cramped.checkSpace(batchId)

    // Assert
    expect(applying).toEqual({ ok: false, code: 'NOT_ENOUGH_SPACE' })
    expect(space).toEqual({ enough: false, neededBytes: needed, freeBytes: 4096 })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('preview')
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(backups)).toEqual([])
    expect(listJobs(testDatabase.db, batchId).filter((job) => job.phase === 'apply')).toMatchObject(
      ids.map(() => ({ status: 'queued', attempts: 0 }))
    )
  })
})

describe('undo and runs', () => {
  it('is refused while a batch is being worked on', async () => {
    // Arrange
    const { ids } = addTracks(4)
    const run = orchestrator(writingStages(200))
    await applied(run, ids)
    const batchId = await computed(run, ids)
    await run.applyBatch(batchId)

    // Act
    const whileApplying = await run.undoLast()
    await run.whenFinished()

    // Assert
    expect(whileApplying).toEqual({ ok: false, code: 'RUN_ACTIVE' })
  })

  it('has nothing to undo before any batch was applied', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const run = orchestrator()
    await computed(run, ids)

    // Act
    const undone = await run.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' })
  })
})
