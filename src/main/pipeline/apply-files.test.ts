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
import { createBatch, getBatch, getBatchItem, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { listJobs } from '../db/jobs'
import { batchItems } from '../db/schema'
import { getTrackById, insertTracks } from '../db/tracks'
import { createFileOps, type FileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import { createBatchFiles, type BatchFiles } from './batch-files'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { commitApprovedValues, createPreview, type Preview } from './preview'
import type { ProposedFields } from '@shared/preview'
import { createDemoStages } from './stages/demo'
import { createNamingStage } from './stages/naming'
import { createRenameStage } from './stages/rename'
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

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

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

/** Stands in for a compute stage that proposes the same fields for every track. */
function standIn(name: string, fields: ProposedFields): Stage {
  return {
    name,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: 10_000,
    run: async () => ({ proposal: { fields } })
  }
}

/** The real naming and rename stages, behind stand-ins for the lookup and the analysis. */
function namingStages(): Stage[] {
  return [
    standIn('lookup', {}),
    standIn('bpmKey', {
      bpm: { value: 124, source: 'analysis' },
      key: { value: '8A', source: 'analysis' }
    }),
    createNamingStage(),
    createRenameStage()
  ]
}

/** Puts a file into the library and makes it a track, stored as a scan stores it: composed. */
function addLibraryFile(
  relativePath: string,
  content: Buffer = FIXTURE
): { id: number; path: string } {
  const path = join(library, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  const stored = path.normalize('NFC')
  const [id] = insertTracks(testDatabase.db, [
    { path: stored, originalPath: stored, format: 'mp3' as const }
  ]) as [number]
  return { id, path }
}

/** Runs the naming for the tracks, approves everything, and waits for the apply phase. */
async function namedAndApplied(run: Orchestrator, ids: number[]): Promise<number> {
  const started = run.start({ trackIds: ids, stages: ['naming'] })
  if (!started.ok) throw new Error(`the run did not start: ${started.code}`)
  await run.whenFinished()
  testDatabase.db.update(batchItems).set({ approved: true }).run()
  const applying = await run.applyBatch(started.value.batchId)
  if (!applying.ok) throw new Error(`the batch was not applied: ${applying.code}`)
  await run.whenFinished()
  return started.value.batchId
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

  it('lets a file move into a folder that exists under a name a new folder could not get', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const original = sha256(paths[0] as string)
    createBatch(testDatabase.db, {
      type: 'run',
      mode: 'in_place',
      items: [{ trackId: id, before: {} }]
    })
    mkdirSync(join(library, 'R.E.M.'))
    const files = batchFiles.forTrack({ id: 1, mode: 'in_place' }, id, new AbortController().signal)

    // Act
    const moved = await files.move(join(library, 'R.E.M.', 'x.mp3'))

    // Assert
    expect(moved).toEqual({ path: join(library, 'R.E.M.', 'x.mp3'), collided: false })
    expect(sha256(moved.path)).toBe(original)
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

describe('other work on the files of the library', () => {
  function orchestratorWhile(busy: () => boolean): Orchestrator {
    return createOrchestrator({
      db: testDatabase.db,
      stages: writingStages(100),
      limits: () => ({ cpu: 4, gpu: 1, network: 4, claude: 1, io: 2 }),
      listMountedVolumes: () => NO_VOLUMES,
      mode: () => mode,
      batchFiles,
      libraryBusy: busy
    })
  }

  it('keeps a batch from being applied or undone while the library is scanned', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    let scanning = false
    const run = orchestratorWhile(() => scanning)
    await applied(run, ids)
    const batchId = await computed(run, ids)
    const changed = ids.map((id) => sha256(pathOf(id)))
    scanning = true

    // Act
    const applying = await run.applyBatch(batchId)
    const undoing = await run.undoLast()

    // Assert
    expect(applying).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(undoing).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(ids.map((id) => sha256(pathOf(id)))).toEqual(changed)
    expect(paths.some((path) => existsSync(path))).toBe(false)
  })

  it('says that files are being changed for as long as the apply phase runs, and not before', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const run = orchestratorWhile(() => false)
    const batchId = await computed(run, ids)
    const beforeApply = run.changingFiles()

    // Act
    await run.applyBatch(batchId)
    const duringApply = run.changingFiles()
    await run.whenFinished()
    await vi.waitFor(() => expect(run.changingFiles()).toBe(false))

    // Assert
    expect(beforeApply).toBe(false)
    expect(duringApply).toBe(true)
  })

  it('keeps the last written batch undoable after a batch that wrote no file', async () => {
    // Arrange
    const { ids, paths } = addTracks(3)
    const originals = paths.map(sha256)
    const run = orchestrator()
    const wrote = await applied(run, ids)
    // Every track taken out: the batch is applied, and writes nothing.
    await applied(run, ids, ids)

    // Act
    const undone = await run.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true, value: { batchId: wrote, restored: 3 } })
    expect(paths.map(sha256)).toEqual(originals)
  })
})

describe('a batch that goes through its preview', () => {
  const mayRename = (): boolean => true

  function previewed(): { run: Orchestrator; preview: Preview } {
    const stages = createDemoStages(1, { mayRename })
    const run = createOrchestrator({
      db: testDatabase.db,
      stages,
      limits: () => ({ cpu: 4, gpu: 1, network: 4, claude: 1, io: 2 }),
      listMountedVolumes: () => NO_VOLUMES,
      mode: () => mode,
      batchFiles,
      onTrackApplied: (batchId, trackId) => commitApprovedValues(testDatabase.db, batchId, trackId)
    })
    const preview = createPreview({
      db: testDatabase.db,
      stages,
      orchestrator: run,
      batchFiles,
      listMountedVolumes: () => NO_VOLUMES
    })
    return { run, preview }
  }

  async function computeAll(run: Orchestrator, ids: number[]): Promise<number> {
    const started = run.start({ trackIds: ids, stages: ['demoAnalyze', 'demoLookup'] })
    if (!started.ok) throw new Error(`the run did not start: ${started.code}`)
    await run.whenFinished()
    return started.value.batchId
  }

  it('changes no file until it is approved, then writes what the preview shows', async () => {
    // Arrange
    const { ids, paths } = addTracks(4)
    const [edited, excluded] = ids as [number, number]
    const originals = paths.map(sha256)
    const { run, preview } = previewed()
    const batchId = await computeAll(run, ids)
    const row = preview.edit({ batchId, trackId: edited, field: 'title', value: 'By Hand' })
    preview.setExcluded({ batchId, trackIds: [excluded], excluded: true })
    const beforeApproval = { files: filesUnder(library), hashes: paths.map(sha256) }

    // Act
    const outcome = await preview.approve(batchId)
    await run.whenFinished()

    // Assert
    expect(row.ok && row.value.cells.fileName.after).toBe('Demo Artist - By Hand.mp3')
    expect(beforeApproval).toEqual({
      files: paths.map((path) => path.slice(folder.length + 1)),
      hashes: originals
    })
    expect(outcome).toEqual({ ok: true, value: { started: true } })
    expect(getBatch(testDatabase.db, batchId)?.status).toBe('applied')
    expect(pathOf(edited)).toBe(join(library, 'Inbox', 'Demo Artist - By Hand.mp3'))
    expect(sha256(pathOf(edited))).toBe(originals[0])
    // The row that was taken out: the same file, the same bytes, the same name.
    expect(pathOf(excluded)).toBe(paths[1])
    expect(sha256(paths[1] as string)).toBe(originals[1])
    expect(filesUnder(library)).toHaveLength(4)
  })

  it('does not write a file name that the preview could not show', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const [tampered, other] = ids as [number, number]
    const { run, preview } = previewed()
    const batchId = await computeAll(run, ids)
    testDatabase.db
      .update(batchItems)
      .set({ after: { fields: { fileName: { value: '../Elsewhere/x.mp3', source: 'lookup' } } } })
      .where(eq(batchItems.trackId, tampered))
      .run()
    const shown = preview.rows({ batchId, offset: 0, limit: 10 })

    // Act
    await preview.approve(batchId)
    await run.whenFinished()

    // Assert: the row showed no new name, and the file kept the one it had.
    const row = shown.ok ? shown.value.rows.find((each) => each.trackId === tampered) : undefined
    expect(row?.cells.fileName.changed).toBe(false)
    expect(pathOf(tampered)).toBe(paths[0])
    expect(pathOf(other)).not.toBe(paths[1])
    expect(filesUnder(folder).some((name) => name.includes('Elsewhere'))).toBe(false)
  })

  it('keeps a title that was set by hand through the next automatic run', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const [edited] = ids as [number]
    const { run, preview } = previewed()
    const first = await computeAll(run, ids)
    preview.edit({ batchId: first, trackId: edited, field: 'title', value: 'By Hand' })
    await preview.approve(first)
    await run.whenFinished()

    // Act
    const second = await computeAll(run, ids)
    const rows = preview.rows({ batchId: second, offset: 0, limit: 10 })

    // Assert
    const row = rows.ok ? rows.value.rows.find((each) => each.trackId === edited) : undefined
    expect(row?.cells.title).toMatchObject({ before: 'By Hand', after: 'By Hand', changed: false })
    expect(row?.cells.fileName.after).toBe('Demo Artist - By Hand.mp3')
  })
})

describe('what the user typed for a track whose file was not written', () => {
  function previewedWith(mayRename: (path: string) => boolean): {
    run: Orchestrator
    preview: Preview
  } {
    const stages = createDemoStages(1, { mayRename })
    const run = createOrchestrator({
      db: testDatabase.db,
      stages,
      limits: () => ({ cpu: 4, gpu: 1, network: 4, claude: 1, io: 2 }),
      listMountedVolumes: () => NO_VOLUMES,
      mode: () => mode,
      batchFiles,
      onTrackApplied: (batchId, trackId) => commitApprovedValues(testDatabase.db, batchId, trackId)
    })
    const preview = createPreview({
      db: testDatabase.db,
      stages,
      orchestrator: run,
      batchFiles,
      listMountedVolumes: () => NO_VOLUMES
    })
    return { run, preview }
  }

  it('stays out of the track and locks nothing, while a track that was written gets both', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const [failing, written] = ids as [number, number]
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { run, preview } = previewedWith((path) => path !== paths[0])
    const started = run.start({ trackIds: ids, stages: ['demoLookup'] })
    await run.whenFinished()
    const batchId = started.ok ? started.value.batchId : -1
    for (const trackId of ids) {
      preview.edit({ batchId, trackId, field: 'title', value: `By Hand ${trackId}` })
    }

    // Act
    await preview.approve(batchId)
    await run.whenFinished()

    // Assert
    const track = (id: number): unknown => getTrackById(testDatabase.db, id, NO_VOLUMES)
    expect(track(failing)).toMatchObject({
      title: 'track-01.mp3',
      lockedFields: [],
      path: paths[0]
    })
    expect(track(written)).toMatchObject({
      title: `By Hand ${written}`,
      lockedFields: ['title']
    })
  })

  it('renames nothing unless it was told which files are generated', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const stages = createDemoStages(1)
    const run = orchestrator(stages)
    const started = run.start({ trackIds: ids, stages: ['demoLookup'] })
    await run.whenFinished()
    testDatabase.db.update(batchItems).set({ approved: true }).run()

    // Act
    await run.applyBatch(started.ok ? started.value.batchId : -1)
    await run.whenFinished()

    // Assert
    expect(filesUnder(library)).toEqual([paths[0]?.slice(folder.length + 1)])
  })
})

describe('a batch that renames files by the naming rule', () => {
  /** Stand-ins for the two stages the naming waits for: no network, no audio. */
  function stagesFor(found: Record<number, ProposedFields> = {}): Stage[] {
    const standIn = (name: string, fields: (trackId: number) => ProposedFields): Stage => ({
      name,
      phase: 'compute',
      resource: 'cpu',
      dependsOn: [],
      selectable: true,
      timeoutMs: 10_000,
      run: async (_context, track) => ({ proposal: { fields: fields(track.id) } })
    })
    return [
      standIn('lookup', (trackId) => found[trackId] ?? {}),
      standIn('bpmKey', () => ({
        bpm: { value: 124, source: 'analysis' },
        key: { value: '8A', source: 'analysis' }
      })),
      createNamingStage(),
      createRenameStage()
    ]
  }

  function named(stages: Stage[]): { run: Orchestrator; preview: Preview } {
    const run = createOrchestrator({
      db: testDatabase.db,
      stages,
      limits: () => ({ cpu: 4, gpu: 1, network: 4, claude: 1, io: 2 }),
      listMountedVolumes: () => NO_VOLUMES,
      mode: () => mode,
      batchFiles,
      onTrackApplied: (batchId, trackId) => commitApprovedValues(testDatabase.db, batchId, trackId)
    })
    const preview = createPreview({
      db: testDatabase.db,
      stages,
      orchestrator: run,
      batchFiles,
      listMountedVolumes: () => NO_VOLUMES
    })
    return { run, preview }
  }

  function addNamed(names: string[]): { ids: number[]; paths: string[] } {
    const paths = names.map((name) => join(library, 'Inbox', name))
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.concat([FIXTURE, Buffer.from(path)]))
    }
    const ids = insertTracks(
      testDatabase.db,
      paths.map((path) => ({ path, originalPath: path, format: 'mp3' as const }))
    )
    return { ids, paths }
  }

  async function computeNames(run: Orchestrator, ids: number[]): Promise<number> {
    // Asking for the naming brings the lookup, the analysis and the rename with it.
    const started = run.start({ trackIds: ids, stages: ['naming'] })
    if (!started.ok) throw new Error(`the run did not start: ${started.code}`)
    await run.whenFinished()
    return started.value.batchId
  }

  it('gives every file its new name with the same bytes, and undo gives the old names back', async () => {
    // Arrange
    const { ids, paths } = addNamed([
      '01. Artist_-_Title (Official Video) [HD].mp3',
      'Ákos - Ilyenek voltunk (Original Mix).mp3',
      'Somebody - Song ft. Guest [FREE DL].mp3'
    ])
    const originals = paths.map(sha256)
    const { run, preview } = named(stagesFor())
    const batchId = await computeNames(run, ids)
    const untouched = { files: filesUnder(library), hashes: paths.map(sha256) }

    // Act
    const approved = await preview.approve(batchId)
    await run.whenFinished()
    const renamed = filesUnder(library)
    const hashes = ids.map((id) => sha256(pathOf(id)))
    const undone = await preview.undoLast()

    // Assert: nothing changed before the approval.
    expect(untouched.hashes).toEqual(originals)
    expect(untouched.files).toEqual(paths.map((path) => path.slice(folder.length + 1)).sort())
    expect(approved).toEqual({ ok: true, value: { started: true } })
    expect(renamed).toEqual([
      'Music/Inbox/Artist - Title [8A Am - 124].mp3',
      'Music/Inbox/Somebody feat. Guest - Song [8A Am - 124].mp3',
      'Music/Inbox/Ákos - Ilyenek voltunk (Original Mix) [8A Am - 124].mp3'
    ])
    // A rename changes no byte of a file.
    expect(hashes).toEqual(originals)
    expect(undone.ok).toBe(true)
    expect(filesUnder(library)).toEqual(untouched.files)
    expect(paths.map(sha256)).toEqual(originals)
    expect(ids.map(pathOf)).toEqual(paths)
  })

  it('writes the name the preview shows after an edit, and no name for a row that was taken out', async () => {
    // Arrange
    const { ids, paths } = addNamed(['Artist - First.mp3', 'Artist - Second.mp3'])
    const [edited, excluded] = ids as [number, number]
    const originals = paths.map(sha256)
    const { run, preview } = named(stagesFor())
    const batchId = await computeNames(run, ids)

    // Act
    const row = preview.edit({ batchId, trackId: edited, field: 'title', value: 'By Hand' })
    preview.edit({ batchId, trackId: edited, field: 'key', value: '11B' })
    preview.setExcluded({ batchId, trackIds: [excluded], excluded: true })
    await preview.approve(batchId)
    await run.whenFinished()

    // Assert
    expect(row.ok && row.value.cells.fileName.after).toBe('Artist - By Hand [8A Am - 124].mp3')
    expect(pathOf(edited)).toBe(join(library, 'Inbox', 'Artist - By Hand [11B A - 124].mp3'))
    expect(sha256(pathOf(edited))).toBe(originals[0])
    expect(pathOf(excluded)).toBe(paths[1])
    expect(sha256(paths[1] as string)).toBe(originals[1])
  })

  it('never writes over a file: two tracks that get one name become two files', async () => {
    // Arrange
    const { ids, paths } = addNamed(['Artist - Title [HD].mp3', 'Artist_-_Title.mp3'])
    const originals = paths.map(sha256)
    const { run, preview } = named(stagesFor())
    const batchId = await computeNames(run, ids)

    // Act
    await preview.approve(batchId)
    await run.whenFinished()

    // Assert
    expect(filesUnder(library)).toEqual([
      'Music/Inbox/Artist - Title [8A Am - 124] (2).mp3',
      'Music/Inbox/Artist - Title [8A Am - 124].mp3'
    ])
    expect(ids.map((id) => sha256(pathOf(id))).sort()).toEqual([...originals].sort())
  })

  it('in the clean library names the copies, and leaves every original as it was', async () => {
    // Arrange
    mode = 'clean_library'
    const { ids, paths } = addNamed(['01. Artist_-_Title (Official Video).mp3'])
    const originals = paths.map(sha256)
    const { run, preview } = named(stagesFor())
    const batchId = await computeNames(run, ids)

    // Act
    await preview.approve(batchId)
    await run.whenFinished()

    // Assert
    expect(filesUnder(library)).toEqual(paths.map((path) => path.slice(folder.length + 1)))
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(clean)).toEqual(['Clean/Inbox/Artist - Title [8A Am - 124].mp3'])
    expect(sha256(pathOf(ids[0] as number))).toBe(originals[0])
  })

  it('names a file by what the lookup found rather than by its old name', async () => {
    // Arrange
    const { ids } = addNamed(['track07.mp3'])
    const [id] = ids as [number]
    const found: Record<number, ProposedFields> = {
      [id]: {
        artist: { value: 'Daft Punk', source: 'musicbrainz', confidence: 0.95 },
        title: { value: 'Around the World (Radio Edit)', source: 'musicbrainz', confidence: 0.95 }
      }
    }
    const { run, preview } = named(stagesFor(found))
    const batchId = await computeNames(run, ids)

    // Act
    await preview.approve(batchId)
    await run.whenFinished()

    // Assert
    expect(basename(pathOf(id))).toBe('Daft Punk - Around the World (Radio Edit) [8A Am - 124].mp3')
  })
})

describe('a batch that has nothing to change for a track', () => {
  const addFile = (name: string, content?: Buffer): { id: number; path: string } =>
    addLibraryFile(join('Inbox', name), content)

  it('writes nothing, makes no backup, and leaves the batch before it undoable', async () => {
    // Arrange
    const run = orchestrator(namingStages())
    const { id, path: old } = addFile('01. Artist_-_Title [HD].mp3')
    const original = sha256(old)
    const first = await namedAndApplied(run, [id])
    const renamed = pathOf(id)
    const backedUp = filesUnder(backups)

    // Act: the same again, with nothing left to rename.
    await namedAndApplied(run, [id])
    const stillUndoable = batchFiles.lastUndoable()
    const undone = await run.undoLast()

    // Assert
    expect(basename(renamed)).toBe('Artist - Title [8A Am - 124].mp3')
    expect(backedUp).toHaveLength(1)
    // The second batch made no backup of its own, and did not take the first one's away.
    expect(filesUnder(backups)).toEqual([])
    expect(stillUndoable).toBe(first)
    expect(undone).toMatchObject({ ok: true, value: { batchId: first } })
    expect(pathOf(id)).toBe(old)
    expect(sha256(old)).toBe(original)
    expect(filesUnder(library)).toEqual(['Music/Inbox/01. Artist_-_Title [HD].mp3'])
  })

  it('does the same for a file that keeps the (2) of a collision, its plain name still being taken', async () => {
    // Arrange: two files that get one name, so the second ends up with ` (2)`.
    const run = orchestrator(namingStages())
    const one = addFile('Artist - Title [HD].mp3', Buffer.concat([FIXTURE, Buffer.from('one')]))
    const two = addFile('Artist_-_Title.mp3', Buffer.concat([FIXTURE, Buffer.from('two')]))
    const first = await namedAndApplied(run, [one.id, two.id])
    const afterFirst = filesUnder(library)

    // Act
    await namedAndApplied(run, [one.id, two.id])

    // Assert
    expect(afterFirst).toEqual([
      'Music/Inbox/Artist - Title [8A Am - 124] (2).mp3',
      'Music/Inbox/Artist - Title [8A Am - 124].mp3'
    ])
    expect(filesUnder(library)).toEqual(afterFirst)
    expect(batchFiles.lastUndoable()).toBe(first)
  })

  it('fails a track whose file is gone, instead of calling it done', async () => {
    // Arrange
    const run = orchestrator(namingStages())
    const { id, path } = addFile('Artist - Title [8A Am - 124].mp3')
    const started = run.start({ trackIds: [id], stages: ['naming'] })
    if (!started.ok) throw new Error('the run did not start')
    await run.whenFinished()
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    rmSync(path)

    // Act
    await run.applyBatch(started.value.batchId)
    await run.whenFinished()

    // Assert
    expect(getBatchItem(testDatabase.db, started.value.batchId, id)?.error).toMatchObject({
      stage: 'rename',
      code: 'FILE_UNREADABLE'
    })
  })

  it('in the clean library still gives a track its copy, so that the clean library is whole', async () => {
    // Arrange
    mode = 'clean_library'
    const run = orchestrator(namingStages())
    const { id, path } = addFile('Artist - Title [8A Am - 124].mp3')
    const original = sha256(path)

    // Act
    await namedAndApplied(run, [id])

    // Assert
    expect(filesUnder(clean)).toEqual(['Clean/Inbox/Artist - Title [8A Am - 124].mp3'])
    expect(pathOf(id)).toBe(join(clean, 'Inbox', 'Artist - Title [8A Am - 124].mp3'))
    expect(sha256(pathOf(id))).toBe(original)
    expect(sha256(path)).toBe(original)
  })
})

describe('names that are there already', () => {
  it.each([
    ['ends in a dot', 'R.E.M.'],
    ['is stored decomposed', 'Va\u0301logata\u0301s'],
    ['holds a character a new name may not', 'What? Why'],
    ['starts with a space', ' Odd Folder']
  ])('renames a file in a folder whose own name %s', async (_name, folderName) => {
    // Arrange: a folder as a real library has them. The rule for new names is not for it.
    const run = orchestrator(namingStages())
    const old = join(library, folderName, '01. Artist_-_Title [HD].mp3')
    mkdirSync(dirname(old), { recursive: true })
    writeFileSync(old, FIXTURE)
    // As a scan stores it: the path composed.
    const stored = old.normalize('NFC')
    const [id] = insertTracks(testDatabase.db, [
      { path: stored, originalPath: stored, format: 'mp3' as const }
    ]) as [number]
    const original = sha256(old)

    // Act
    const batchId = await namedAndApplied(run, [id])

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, id)?.error).toBeNull()
    expect(readdirSync(dirname(old))).toEqual(['Artist - Title [8A Am - 124].mp3'])
    expect(sha256(join(dirname(old), 'Artist - Title [8A Am - 124].mp3'))).toBe(original)
  })

  it('gives (2) to a file whose wanted name another file has under a decomposed spelling', async () => {
    // Arrange: a file that is no track of the library has the name, stored decomposed.
    const run = orchestrator(namingStages())
    const folderPath = join(library, 'Inbox')
    mkdirSync(folderPath, { recursive: true })
    const occupant = join(folderPath, 'A\u0301kos - Dal [8A Am - 124].mp3')
    writeFileSync(occupant, 'not ours')
    const old = join(folderPath, 'Ákos_-_Dal.mp3')
    writeFileSync(old, FIXTURE)
    const [id] = insertTracks(testDatabase.db, [
      { path: old, originalPath: old, format: 'mp3' as const }
    ]) as [number]

    // Act
    const batchId = await namedAndApplied(run, [id])

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, id)?.error).toBeNull()
    expect(basename(pathOf(id))).toBe('Ákos - Dal [8A Am - 124] (2).mp3')
    expect(sha256(pathOf(id))).toBe(sha256Of(FIXTURE))
    // The file that had the name is as it was.
    expect(readFileSync(occupant, 'utf8')).toBe('not ours')
  })

  it('still refuses a new name the rule refuses, and a move out of the library', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const files = batchFiles.forTrack({ id: 1, mode: 'in_place' }, id, new AbortController().signal)
    createBatch(testDatabase.db, {
      type: 'run',
      mode: 'in_place',
      items: [{ trackId: id, before: {} }]
    })

    mkdirSync(join(library, '.Trashes'))
    mkdirSync(join(library, 'Zero\u200dWidth'))
    const cleanFiles = batchFiles.forTrack(
      { id: 1, mode: 'clean_library' },
      id,
      new AbortController().signal
    )

    // Act
    const asked = await Promise.all(
      ['../x.mp3', 'Sub/x.mp3', '/etc/x.mp3', 'x.txt', 'a:b.mp3'].flatMap((name) => [
        files.wouldMove(name).catch((error: unknown) => error),
        // Also where the answer would otherwise be "a copy is made".
        cleanFiles.wouldMove(name).catch((error: unknown) => error)
      ])
    )
    // Asking costs nothing, whatever the answer.
    const afterAsking = { clean: filesUnder(clean), backups: filesUnder(backups) }
    const intoHidden = files
      .move(join(library, '.Trashes', 'x.mp3'))
      .catch((error: unknown) => error)
    const intoInvisible = files
      .move(join(library, 'Zero\u200dWidth', 'x.mp3'))
      .catch((error: unknown) => error)
    const hidden = files.wouldMove('.hidden.mp3').catch((error: unknown) => error)
    const outside = files.move(join(folder, 'Elsewhere', 'x.mp3')).catch((error: unknown) => error)
    const newFolder = files
      .move(join(library, 'Bad:Folder', 'x.mp3'))
      .catch((error: unknown) => error)

    // Assert
    for (const answer of asked) expect(answer).toMatchObject({ code: 'INVALID_INPUT' })
    // A folder the file is not in may not be hidden or hold an invisible character,
    // whether it exists or not.
    expect(await intoHidden).toMatchObject({ code: 'INVALID_INPUT' })
    expect(await intoInvisible).toMatchObject({ code: 'INVALID_INPUT' })
    expect(afterAsking).toEqual({ clean: [], backups: [] })
    expect(await hidden).toMatchObject({ code: 'INVALID_INPUT' })
    expect(await outside).toMatchObject({ code: 'INVALID_INPUT' })
    // A folder that does not exist yet is a new name, and is checked as one.
    expect(await newFolder).toMatchObject({ code: 'INVALID_INPUT' })
    expect(filesUnder(library)).toEqual(paths.map((path) => path.slice(folder.length + 1)))
  })
})

describe('what a batch leaves behind', () => {
  it('in the clean library, undo removes the copy of a track whose folder is stored decomposed', async () => {
    // Arrange: a folder as an older disk hands it over, its accents apart from its letters.
    mode = 'clean_library'
    const run = orchestrator(namingStages())
    const { id, path } = addLibraryFile(join('Válogatás', '01. Artist_-_Title [HD].mp3'))
    const original = sha256(path)
    await namedAndApplied(run, [id])
    const copied = filesUnder(clean)

    // Act
    const undone = await run.undoLast()

    // Assert
    expect(copied).toHaveLength(1)
    expect(basename(copied[0] as string)).toBe('Artist - Title [8A Am - 124].mp3')
    expect(undone).toMatchObject({ ok: true, value: { removed: 1 } })
    // Nothing of the batch is left in the clean library, and the track is the original again.
    expect(filesUnder(clean)).toEqual([])
    expect(pathOf(id)).toBe(path.normalize('NFC'))
    expect(sha256(path)).toBe(original)
  })

  it('keeps the backup of a track whose rename failed on disk, with the file as it was', async () => {
    // Arrange: a rename that the disk refuses, after the track was backed up for it.
    const { id, path } = addLibraryFile(join('Inbox', 'Other_-_Song.mp3'))
    const original = sha256(path)
    const failing = createBatchFiles({
      db: testDatabase.db,
      fileOps: {
        ...fileOps,
        move: async () => {
          throw new Error('EACCES: the disk refused the rename')
        }
      },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    const batchId = await namedAndApplied(orchestrator(namingStages(), failing), [id])
    const kept = listBackups(testDatabase.db, batchId)
    // Read before the undo, which removes a backup once it has put it back.
    const keptBytes = kept.map((backup) => sha256(backup.backupPath))
    const undone = await orchestrator(namingStages()).undoLast()

    // Assert: the track failed and its file is untouched.
    expect(getBatchItem(testDatabase.db, batchId, id)?.error).toMatchObject({ stage: 'rename' })
    expect(sha256(path)).toBe(original)
    // A backup is never taken away because a change failed: nothing here can know
    // that the file is still as it was. The batch counts as one that wrote.
    expect(keptBytes).toEqual([original])
    expect(undone).toMatchObject({ ok: true })
    expect(pathOf(id)).toBe(path)
    expect(sha256(path)).toBe(original)
  })

  it('keeps the backup an earlier step of the batch made when a later change fails', async () => {
    // Arrange: a stage that renames, then fails to write the content.
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const original = sha256(paths[0] as string)
    const run = orchestrator([
      standIn('naming', {}),
      {
        name: 'rename',
        phase: 'apply',
        resource: 'io',
        dependsOn: ['naming'],
        selectable: false,
        timeoutMs: 10_000,
        run: async ({ files }) => {
          if (!files) throw new Error('an apply stage must be given its files')
          const working = await files.workingPath()
          await files.move(join(dirname(working), 'Renamed.mp3'))
          await files.replaceContent(async () => {
            throw new Error('the writer failed')
          })
        }
      }
    ])
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    const started = run.start({ trackIds: ids, stages: ['rename'] })
    if (!started.ok) throw new Error('the run did not start')
    await run.whenFinished()
    testDatabase.db.update(batchItems).set({ approved: true }).run()
    await run.applyBatch(started.value.batchId)
    await run.whenFinished()
    const undone = await run.undoLast()

    // Assert: the file was renamed, so its backup is what undo needs.
    expect(undone).toMatchObject({ ok: true })
    expect(pathOf(id)).toBe(paths[0])
    expect(sha256(paths[0] as string)).toBe(original)
  })

  it('reports a name collision when the copy in the clean library had to take (2)', async () => {
    // Arrange: a file that is no track already sits where the copy belongs.
    mode = 'clean_library'
    const run = orchestrator(namingStages())
    const { id, path } = addLibraryFile(join('Inbox', 'Artist - Title [8A Am - 124].mp3'))
    const occupant = join(clean, 'Inbox', 'Artist - Title [8A Am - 124].mp3')
    mkdirSync(dirname(occupant), { recursive: true })
    writeFileSync(occupant, 'not ours')

    // Act
    const batchId = await namedAndApplied(run, [id])

    // Assert
    expect(basename(pathOf(id))).toBe('Artist - Title [8A Am - 124] (2).mp3')
    expect(sha256(pathOf(id))).toBe(sha256(path))
    expect(readFileSync(occupant, 'utf8')).toBe('not ours')
    expect(getBatchItem(testDatabase.db, batchId, id)?.after).toMatchObject({
      warnings: ['NAME_COLLISION']
    })
  })

  it('does not give a file the name of another track in another letter case', async () => {
    // Arrange: a track whose file is gone still has its name, and that name is its own.
    const owned = join(library, 'Inbox', 'ARTIST - Title [8A Am - 124].mp3')
    insertTracks(testDatabase.db, [{ path: owned, originalPath: owned, format: 'mp3' as const }])
    const { id, path } = addLibraryFile(join('Inbox', 'Artist_-_Title.mp3'))
    const original = sha256(path)

    // Act
    const batchId = await namedAndApplied(orchestrator(namingStages()), [id])

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, id)?.error).toMatchObject({
      stage: 'rename',
      code: 'WRITE_FAILED'
    })
    expect(pathOf(id)).toBe(path)
    expect(sha256(path)).toBe(original)
    // Asked before anything was saved: the track cost no backup.
    expect(filesUnder(backups)).toEqual([])
  })

  it('in the clean library copies a track that gets no new name at all', async () => {
    // Arrange: nothing to name the file by, so the naming proposes no name.
    mode = 'clean_library'
    const run = orchestrator(namingStages())
    const { id, path } = addLibraryFile(join('Inbox', '___.mp3'))
    const original = sha256(path)

    // Act
    const batchId = await namedAndApplied(run, [id])

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, id)?.error).toBeNull()
    expect(filesUnder(clean)).toEqual(['Clean/Inbox/___.mp3'])
    expect(pathOf(id)).toBe(join(clean, 'Inbox', '___.mp3'))
    expect(sha256(pathOf(id))).toBe(original)
    expect(sha256(path)).toBe(original)
  })

  it('in place makes nothing for a track that gets no new name', async () => {
    // Arrange
    const run = orchestrator(namingStages())
    const { id, path } = addLibraryFile(join('Inbox', '___.mp3'))

    // Act
    await namedAndApplied(run, [id])

    // Assert
    expect(pathOf(id)).toBe(path)
    expect(filesUnder(backups)).toEqual([])
    expect(batchFiles.lastUndoable()).toBeNull()
  })
})
