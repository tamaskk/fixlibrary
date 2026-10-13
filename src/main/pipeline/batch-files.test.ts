import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteCreatedFile, listBackups, listCreatedFiles, recordCreatedFile } from '../db/backups'
import { createBatch, getBatch, setBatchStatus, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { backups as backupsTable, batchItems } from '../db/schema'
import { finishJob, insertJobs, listJobs } from '../db/jobs'
import { getTrackById, insertTracks, updateTrack } from '../db/tracks'
import { createFileOps, type FileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import { createBatchFiles, type BatchFiles, type TrackFiles } from './batch-files'

const FIXTURE = readFileSync(
  join(import.meta.dirname, '../../../tests/fixtures/synthetic/sine.mp3')
)
const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase
let folder: string
let library: string
let clean: string
let backups: string
let fileOps: FileOps
let files: BatchFiles

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file under a folder, as paths relative to the test folder. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1))
    .sort()
}

/** Adds tracks whose files all differ, so that a mix-up of two files would show. */
function addTracks(count: number, subfolder = ''): { ids: number[]; paths: string[] } {
  const paths = Array.from({ length: count }, (_, index) =>
    join(library, subfolder, `track-${String(index + 1).padStart(2, '0')}.mp3`)
  )
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true })
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

function newBatch(mode: BatchMode, trackIds: number[]): { id: number; mode: BatchMode } {
  const id = createBatch(testDatabase.db, {
    type: 'run',
    mode,
    items: trackIds.map((trackId) => {
      const before: Record<string, unknown> = {
        ...getTrackById(testDatabase.db, trackId, NO_VOLUMES)
      }
      delete before['offline']
      return { trackId, before }
    })
  })
  testDatabase.db.update(batchItems).set({ approved: true }).run()
  return { id, mode }
}

function trackFiles(batch: { id: number; mode: BatchMode }, trackId: number): TrackFiles {
  return files.forTrack(batch, trackId, new AbortController().signal)
}

function pathOf(trackId: number): string {
  return getTrackById(testDatabase.db, trackId, NO_VOLUMES)?.path ?? ''
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-batch-')))
  library = join(folder, 'Music')
  clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  fileOps = createFileOps({ allowedRoots: () => [library, clean, backups] })
  files = createBatchFiles({
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

describe('changing files in place', () => {
  it('backs up every original of a 20-track batch before changing it', async () => {
    // Arrange
    const { ids, paths } = addTracks(20)
    const originals = paths.map(sha256)
    const batch = newBatch('in_place', ids)

    // Act
    for (const id of ids) {
      const track = trackFiles(batch, id)
      await track.move(join(library, 'House', `Renamed ${id}.mp3`))
      await track.replaceContent((temp) => writeFile(temp, `new content of ${id}`))
    }

    // Assert
    expect(filesUnder(backups)).toEqual(
      ids.map((id) => `FixLibrary Backups/${batch.id}/${id}.mp3`).sort()
    )
    expect(ids.map((id) => sha256(join(backups, String(batch.id), `${id}.mp3`)))).toEqual(originals)
    expect(listBackups(testDatabase.db, batch.id)).toHaveLength(20)
    expect(readFileSync(pathOf(ids[0] as number), 'utf8')).toBe(`new content of ${ids[0]}`)
  })

  it('puts all 20 files back byte for byte, removes what the batch made, and restores the tracks', async () => {
    // Arrange
    const { ids, paths } = addTracks(20)
    const originals = paths.map(sha256)
    const batch = newBatch('in_place', ids)
    for (const id of ids) {
      const track = trackFiles(batch, id)
      await track.move(join(library, 'House', `Renamed ${id}.mp3`))
      await track.replaceContent((temp) => writeFile(temp, `new content of ${id}`))
      updateTrack(testDatabase.db, id, { title: 'Written by the batch', bpm: 124 })
    }
    setBatchStatus(testDatabase.db, batch.id, 'applied')

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({
      ok: true,
      value: { batchId: batch.id, restored: 20, removed: 20, left: 0 }
    })
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(library)).toEqual(paths.map((path) => path.slice(folder.length + 1)))
    expect(ids.map(pathOf)).toEqual(paths)
    expect(getTrackById(testDatabase.db, ids[0] as number, NO_VOLUMES)).toMatchObject({
      title: 'track-01.mp3',
      bpm: null
    })
    expect(getBatch(testDatabase.db, batch.id)?.status).toBe('undone')
    expect(files.lastUndoable()).toBeNull()
  })

  it('backs a track up once, as it was before the first change', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const original = sha256(paths[0] as string)
    const batch = newBatch('in_place', ids)

    // Act: two stages of the same track, one after the other.
    await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'first change'))
    await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'second change'))

    // Assert
    expect(filesUnder(backups)).toHaveLength(1)
    expect(sha256(join(backups, String(batch.id), `${id}.mp3`))).toBe(original)
  })

  it('gives a file whose new name is taken the next free name, and says so', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const [first, second] = ids as [number, number]
    const batch = newBatch('in_place', ids)
    const wanted = join(library, 'Artist - Title.mp3')

    // Act
    const one = await trackFiles(batch, first).move(wanted)
    const two = await trackFiles(batch, second).move(wanted)

    // Assert
    expect(one).toEqual({ path: wanted, collided: false })
    expect(two).toEqual({ path: join(library, 'Artist - Title (2).mp3'), collided: true })
    expect(pathOf(second)).toBe(two.path)
  })

  it('keeps a file that only got another letter case when the batch is undone', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const original = sha256(paths[0] as string)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, id).move(join(library, 'TRACK-01.mp3'))

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone.ok).toBe(true)
    expect(readdirSync(library)).toHaveLength(1)
    expect(sha256(paths[0] as string)).toBe(original)
  })

  it('refuses to move a file out of the library', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const batch = newBatch('in_place', ids)

    // Act
    const move = trackFiles(batch, ids[0] as number).move(join(backups, 'stolen.mp3'))

    // Assert
    await expect(move).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(existsSync(paths[0] as string)).toBe(true)
  })

  it('leaves the file as it was when a write is told to stop, with no temp file', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const original = sha256(paths[0] as string)
    const batch = newBatch('in_place', ids)
    const stop = new AbortController()
    const track = files.forTrack(batch, ids[0] as number, stop.signal)

    // Act
    const write = track.replaceContent(async (temp) => {
      await writeFile(temp, 'half written')
      stop.abort()
    })

    // Assert
    await expect(write).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(sha256(paths[0] as string)).toBe(original)
    expect(filesUnder(library)).toHaveLength(1)
  })
})

describe('after the app stopped in the middle of the apply phase', () => {
  it('makes the backup beside a file that is in its place without a record, and deletes neither', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const original = sha256(paths[0] as string)
    const batch = newBatch('in_place', ids)
    const inThePlace = join(backups, String(batch.id), `${id}.mp3`)
    mkdirSync(join(backups, String(batch.id)))
    writeFileSync(inThePlace, 'a backup of another database')

    // Act
    await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'changed'))

    // Assert
    const [backup] = listBackups(testDatabase.db, batch.id)
    expect(readFileSync(inThePlace, 'utf8')).toBe('a backup of another database')
    expect(backup?.backupPath).toBe(join(backups, String(batch.id), `${id} (2).mp3`))
    expect(sha256(backup?.backupPath ?? '')).toBe(original)
  })

  it('finds a file that was renamed just before the stop, and goes on with it', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, id).workingPath()
    const renamed = join(library, 'Renamed.mp3')
    // What `move` does up to the point where the app stopped: the name is written
    // down, the file is renamed, the track still names the old path.
    recordCreatedFile(testDatabase.db, { batchId: batch.id, trackId: id, path: renamed })
    renameSync(paths[0] as string, renamed)

    // Act
    const working = await trackFiles(batch, id).workingPath()

    // Assert
    expect(working).toBe(renamed)
    expect(pathOf(id)).toBe(renamed)
    expect(filesUnder(backups)).toHaveLength(1)
  })

  it('removes the temp files that interrupted writes left in every folder of the library', async () => {
    // Arrange
    addTracks(1, 'House')
    writeFileSync(join(library, 'House', '.track-01.mp3.fixlib-tmp'), 'half')
    writeFileSync(join(clean, '.copy.mp3.fixlib-tmp'), 'half')
    writeFileSync(join(backups, '.7.mp3.fixlib-tmp'), 'half')

    // Act
    const removed = await files.removeTempFiles()

    // Assert
    expect(removed).toBe(3)
    expect([...filesUnder(library), ...filesUnder(clean), ...filesUnder(backups)]).toEqual([
      'Music/House/track-01.mp3'
    ])
  })
})

describe('before the library is scanned after a stop', () => {
  /** What `move` leaves when the app stops right after the rename: the name is noted, the track is not told. */
  async function renamedButNotToldTo(
    mode: BatchMode
  ): Promise<{ id: number; old: string; renamed: string }> {
    const { ids } = addTracks(1)
    const [id] = ids as [number]
    const batch = newBatch(mode, ids)
    // The step that renames was running when the app stopped.
    insertJobs(testDatabase.db, [
      { batchId: batch.id, trackId: id, stage: 'rename', phase: 'apply' }
    ])
    const working = await trackFiles(batch, id).workingPath()
    const renamed = join(dirname(working), 'Renamed.mp3')
    recordCreatedFile(testDatabase.db, { batchId: batch.id, trackId: id, path: renamed })
    renameSync(working, renamed)
    return { id, old: working, renamed }
  }

  it('tells a track where its file is when it was renamed just before the stop', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { id, old, renamed } = await renamedButNotToldTo('in_place')
    const bytes = sha256(renamed)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert: the row names the file, so a scan finds nothing missing and nothing new.
    expect(found).toBe(1)
    expect(pathOf(id)).toBe(renamed)
    expect(existsSync(old)).toBe(false)
    expect(sha256(renamed)).toBe(bytes)
  })

  it('changes nothing for tracks whose files are where the database says', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const batch = newBatch('in_place', ids)
    const [first] = ids as [number]
    await trackFiles(batch, first).move(join(library, 'Inbox', 'Moved.mp3'))
    const before = ids.map(pathOf)
    const tree = filesUnder(folder)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(ids.map(pathOf)).toEqual(before)
    expect(filesUnder(folder)).toEqual(tree)
    expect(paths).toHaveLength(2)
  })

  it('leaves a track alone whose file is under none of the names the batch gave it', async () => {
    // Arrange
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { id, old, renamed } = await renamedButNotToldTo('in_place')
    rmSync(renamed)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(pathOf(id)).toBe(old)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('1 tracks of batch'))
  })

  it.each([
    ['a folder', (path: string) => mkdirSync(path)],
    // To a file inside the library that no track has: only its being a link speaks against it.
    ['a link', (path: string) => symlinkSync(join(library, 'unowned.mp3'), path)]
  ])('does not take %s under the noted name for the file of a track', async (_name, put) => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { id, old, renamed } = await renamedButNotToldTo('in_place')
    rmSync(renamed)
    writeFileSync(join(library, 'unowned.mp3'), FIXTURE)
    put(renamed)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(pathOf(id)).toBe(old)
  })

  it('does not point a track at a file outside the folders of the library', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const batch = newBatch('in_place', ids)
    const outside = join(folder, 'Outside.mp3')
    recordCreatedFile(testDatabase.db, { batchId: batch.id, trackId: id, path: outside })
    renameSync(paths[0] as string, outside)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(pathOf(id)).toBe(paths[0])
  })

  it('does not point a track at a file another track has, in any letter case', async () => {
    // Arrange: a stale note of the first track names what is the second track's file now.
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { ids, paths } = addTracks(2)
    const [first, second] = ids as [number, number]
    const batch = newBatch('in_place', ids)
    const secondPath = paths[1] as string
    recordCreatedFile(testDatabase.db, {
      batchId: batch.id,
      trackId: first,
      path: join(dirname(secondPath), basename(secondPath).toUpperCase())
    })
    rmSync(paths[0] as string)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(pathOf(first)).toBe(paths[0])
    expect(pathOf(second)).toBe(secondPath)
  })

  it('leaves a track alone whose step had ended, whatever sits under a name it once had', async () => {
    // Arrange: a batch that named a file twice and finished. Later the file is
    // deleted outside the app and another file is put under the first of its names.
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { ids } = addTracks(1)
    const [id] = ids as [number]
    const batch = newBatch('in_place', ids)
    insertJobs(testDatabase.db, [
      { batchId: batch.id, trackId: id, stage: 'rename', phase: 'apply' }
    ])
    const first = (await trackFiles(batch, id).move(join(library, 'Inbox', 'First.mp3'))).path
    const second = (await trackFiles(batch, id).move(join(library, 'Inbox', 'Second.mp3'))).path
    const [job] = listJobs(testDatabase.db, batch.id)
    finishJob(testDatabase.db, job?.id ?? 0, { status: 'done' })
    rmSync(second)
    writeFileSync(first, FIXTURE)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert: the file under the old name is not the track's, and stays out of undo's reach.
    expect(found).toBe(0)
    expect(pathOf(id)).toBe(second)
    expect(warned).not.toHaveBeenCalled()
  })

  it('does not take a file of another size under the noted name', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { id, old, renamed } = await renamedButNotToldTo('in_place')
    updateTrack(testDatabase.db, id, { fileSizeBytes: statSync(renamed).size })
    writeFileSync(renamed, 'another file, put there since')

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(pathOf(id)).toBe(old)
  })

  it('finds the copy of a track in the clean library that was renamed just before the stop', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { id, renamed } = await renamedButNotToldTo('clean_library')

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(1)
    expect(pathOf(id)).toBe(renamed)
    expect(renamed.startsWith(clean)).toBe(true)
  })

  it('says in one line how many tracks it did not find, and fails on anything else', async () => {
    // Arrange
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const first = await renamedButNotToldTo('in_place')
    rmSync(first.renamed)

    const failing = createBatchFiles({
      db: testDatabase.db,
      fileOps: {
        ...fileOps,
        isRegularFile: async () => {
          throw new TypeError('The database connection is not open')
        }
      },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })

    // Act
    const found = await files.reconcileInterrupted()
    const afterClose = failing.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
    expect(warned).toHaveBeenCalledTimes(1)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('1 tracks of batch'))
    // An error that says nothing about a file is not "not found": the pass fails, and
    // the scan with it.
    await expect(afterClose).rejects.toThrow('not open')
  })

  it('does nothing when no batch has written a file', async () => {
    // Arrange
    addTracks(2)

    // Act
    const found = await files.reconcileInterrupted()

    // Assert
    expect(found).toBe(0)
  })
})

describe('working in the clean library', () => {
  it('never changes an original: the work happens on a copy in the same place under the clean library', async () => {
    // Arrange
    const { ids, paths } = addTracks(5, 'House/Deep')
    const originals = paths.map(sha256)
    const batch = newBatch('clean_library', ids)

    // Act
    for (const id of ids) {
      const track = trackFiles(batch, id)
      await track.replaceContent((temp) => writeFile(temp, `new content of ${id}`))
      await track.move(join(clean, 'Sorted', `Renamed ${id}.mp3`))
    }

    // Assert
    expect(paths.map(sha256)).toEqual(originals)
    expect(filesUnder(library)).toHaveLength(5)
    expect(filesUnder(clean)).toEqual(ids.map((id) => `Clean/Sorted/Renamed ${id}.mp3`).sort())
    expect(filesUnder(backups)).toEqual([])
    const first = getTrackById(testDatabase.db, ids[0] as number, NO_VOLUMES)
    expect(first).toMatchObject({
      path: join(clean, 'Sorted', `Renamed ${ids[0]}.mp3`),
      originalPath: paths[0]
    })
  })

  it('copies a track to the same relative place before the first change', async () => {
    // Arrange
    const { ids } = addTracks(1, 'House/Deep')
    const batch = newBatch('clean_library', ids)

    // Act
    const working = await trackFiles(batch, ids[0] as number).workingPath()

    // Assert
    expect(working).toBe(join(clean, 'House', 'Deep', 'track-01.mp3'))
  })

  it('deletes the copies when the batch is undone, and points the tracks at their originals again', async () => {
    // Arrange
    const { ids, paths } = addTracks(3, 'House')
    const originals = paths.map(sha256)
    const batch = newBatch('clean_library', ids)
    for (const id of ids) {
      await trackFiles(batch, id).move(join(clean, 'Sorted', `Renamed ${id}.mp3`))
    }

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true, value: { restored: 0, removed: 3, left: 0 } })
    expect(filesUnder(clean)).toEqual([])
    expect(readdirSync(clean)).toEqual([])
    expect(paths.map(sha256)).toEqual(originals)
    expect(ids.map(pathOf)).toEqual(paths)
  })

  it('backs up a copy that an earlier batch made, so that the next batch can be undone too', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const [id] = ids as [number]
    const first = newBatch('clean_library', ids)
    await trackFiles(first, id).replaceContent((temp) => writeFile(temp, 'after the first batch'))
    setBatchStatus(testDatabase.db, first.id, 'applied')
    const copy = pathOf(id)
    const second = newBatch('clean_library', ids)

    // Act
    await trackFiles(second, id).replaceContent((temp) => writeFile(temp, 'after the second'))
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true, value: { batchId: second.id, restored: 1 } })
    expect(readFileSync(copy, 'utf8')).toBe('after the first batch')
    expect(pathOf(id)).toBe(copy)
  })

  it('takes over a copy that was made just before the app stopped, without making a second one', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const batch = newBatch('clean_library', ids)
    const copy = await trackFiles(batch, id).workingPath()
    // As if the app had stopped after the copy and before the track was updated.
    updateTrack(testDatabase.db, id, { path: paths[0] as string })

    // Act
    const working = await trackFiles(batch, id).workingPath()

    // Assert
    expect(working).toBe(copy)
    expect(filesUnder(clean)).toHaveLength(1)
  })
})

describe('undo', () => {
  it('has nothing to undo while no batch has changed a file', async () => {
    // Arrange
    const { ids } = addTracks(1)
    newBatch('in_place', ids)

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' })
    expect(files.lastUndoable()).toBeNull()
  })

  it('undoes a batch that was cancelled halfway, for the tracks it had got to', async () => {
    // Arrange
    const { ids, paths } = addTracks(4)
    const originals = paths.map(sha256)
    const batch = newBatch('in_place', ids)
    for (const id of ids.slice(0, 2)) {
      await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'changed'))
    }
    setBatchStatus(testDatabase.db, batch.id, 'cancelled')

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true, value: { restored: 2 } })
    expect(paths.map(sha256)).toEqual(originals)
  })

  it('cannot be asked for twice', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, ids[0] as number).replaceContent((temp) => writeFile(temp, 'changed'))
    await files.undoLast()

    // Act
    const again = await files.undoLast()

    // Assert
    expect(again).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' })
  })

  it('changes nothing when a backup is gone', async () => {
    // Arrange
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { ids } = addTracks(2)
    const [first, second] = ids as [number, number]
    const batch = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, `changed ${id}`))
    }
    rmSync(join(backups, String(batch.id), `${second}.mp3`))

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'WRITE_FAILED' })
    expect(readFileSync(pathOf(first), 'utf8')).toBe(`changed ${first}`)
    expect(getBatch(testDatabase.db, batch.id)?.status).not.toBe('undone')
  })

  it('leaves a track of the batch alone whose file the batch never touched', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const [touched, untouched] = ids as [number, number]
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, touched).replaceContent((temp) => writeFile(temp, 'changed'))
    // Changed since for a reason of its own, such as a rescan.
    updateTrack(testDatabase.db, untouched, { title: 'Read by a later scan' })

    // Act
    await files.undoLast()

    // Assert
    expect(getTrackById(testDatabase.db, untouched, NO_VOLUMES)?.title).toBe('Read by a later scan')
  })
})

describe('the backups of earlier batches', () => {
  it('are deleted once a later batch is applied, with their records; the newest stay', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const older = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(older, id).replaceContent((temp) => writeFile(temp, 'first batch'))
    }
    setBatchStatus(testDatabase.db, older.id, 'applied')
    const newer = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(newer, id).replaceContent((temp) => writeFile(temp, 'second batch'))
    }

    // Act
    await files.pruneOlderBackups(newer.id)

    // Assert
    expect(filesUnder(backups)).toEqual(
      ids.map((id) => `FixLibrary Backups/${newer.id}/${id}.mp3`).sort()
    )
    expect(readdirSync(backups)).toEqual([String(newer.id)])
    expect(listBackups(testDatabase.db, older.id)).toEqual([])
    expect(listCreatedFiles(testDatabase.db, older.id)).toEqual([])
    expect(files.lastUndoable()).toBe(newer.id)
  })
})

describe('checking the free space', () => {
  it('needs room for a backup of every track the batch will write, and no other', async () => {
    // Arrange
    const { ids, paths } = addTracks(4)
    const [first, , excluded, unapproved] = ids as [number, number, number, number]
    const batch = newBatch('in_place', ids)
    testDatabase.db
      .update(batchItems)
      .set({ excluded: true })
      .where(eq(batchItems.trackId, excluded))
      .run()
    testDatabase.db
      .update(batchItems)
      .set({ approved: false })
      .where(eq(batchItems.trackId, unapproved))
      .run()
    // Backed up already, before the batch was interrupted.
    await trackFiles(batch, first).workingPath()

    // Act
    const space = await files.checkSpace(batch.id)

    // Assert
    expect(space.enough).toBe(true)
    expect(space.neededBytes).toBe(readFileSync(paths[1] as string).length)
    expect(space.freeBytes).toBeGreaterThan(space.neededBytes)
  })

  it('says that the copies of a clean library batch do not fit, with what is needed and what is free', async () => {
    // Arrange
    const { ids, paths } = addTracks(3)
    const batch = newBatch('clean_library', ids)
    const needed = paths.reduce((sum, path) => sum + readFileSync(path).length, 0)
    const tight = createBatchFiles({
      db: testDatabase.db,
      fileOps: { ...fileOps, freeBytes: async () => needed + 1000 },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })

    // Act
    const space = await tight.checkSpace(batch.id)

    // Assert: the copies alone would fit, but a volume is not filled to the last byte.
    expect(space).toEqual({ enough: false, neededBytes: needed, freeBytes: needed + 1000 })
  })

  it('needs nothing for a batch that writes no track', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const batch = newBatch('in_place', ids)
    testDatabase.db.update(batchItems).set({ approved: false }).run()

    // Act
    const space = await files.checkSpace(batch.id)

    // Assert
    expect(space).toEqual({ enough: true, neededBytes: 0, freeBytes: 0 })
  })
})

describe('two tracks that want one name', () => {
  it('both keep their file when they are renamed at the same time', async () => {
    // Arrange
    const { ids, paths } = addTracks(8)
    const originals = paths.map(sha256).sort()
    const batch = newBatch('in_place', ids)
    const wanted = join(library, 'House', 'Same Name.mp3')

    // Act
    const moved = await Promise.all(ids.map((id) => trackFiles(batch, id).move(wanted)))

    // Assert
    expect(new Set(moved.map((each) => each.path)).size).toBe(8)
    expect(moved.filter((each) => each.collided)).toHaveLength(7)
    expect(filesUnder(library)).toHaveLength(8)
    expect(ids.map((id) => sha256(pathOf(id))).sort()).toEqual(originals)
  })

  it('get their own files back when the batch swapped their names', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const [first, second] = ids as [number, number]
    const [firstPath, secondPath] = paths as [string, string]
    const originals = paths.map(sha256)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, first).move(join(library, 'aside.mp3'))
    await trackFiles(batch, second).move(firstPath)
    await trackFiles(batch, first).move(secondPath)

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true })
    expect(paths.map(sha256)).toEqual(originals)
    expect(ids.map(pathOf)).toEqual(paths)
    expect(filesUnder(library)).toHaveLength(2)
  })
})

describe('a move that must not happen', () => {
  it.each([
    ['a name that is not an audio file', 'Renamed.txt'],
    ['a name that starts with a dot', '.Renamed.mp3'],
    ['a name with a control character', 'Re\u0000named.mp3'],
    ['a folder that ends with a dot', 'House./Renamed.mp3']
  ])('refuses %s, and leaves the file where it was', async (_what, name) => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const batch = newBatch('in_place', ids)

    // Act
    const moving = trackFiles(batch, ids[0] as number).move(join(library, name))

    // Assert
    await expect(moving).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(filesUnder(library)).toEqual(['Music/track-01.mp3'])
    expect(pathOf(ids[0] as number)).toBe(paths[0])
  })

  it('renames nothing for a stage that was told to stop', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const batch = newBatch('in_place', ids)
    const stopped = new AbortController()
    const track = files.forTrack(batch, ids[0] as number, stopped.signal)
    await track.workingPath()
    stopped.abort()

    // Act
    const moving = track.move(join(library, 'Renamed.mp3'))

    // Assert
    await expect(moving).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(pathOf(ids[0] as number)).toBe(paths[0])
    expect(listCreatedFiles(testDatabase.db, batch.id)).toEqual([])
  })

  it('leaves no note of a file that was not created after all', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const batch = newBatch('in_place', ids)
    const failing = createBatchFiles({
      db: testDatabase.db,
      fileOps: { ...fileOps, move: () => Promise.reject(new Error('the disk said no')) },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })
    const track = failing.forTrack(batch, ids[0] as number, new AbortController().signal)

    // Act
    const moving = track.move(join(library, 'Renamed.mp3'))

    // Assert
    await expect(moving).rejects.toThrow('the disk said no')
    expect(listCreatedFiles(testDatabase.db, batch.id)).toEqual([])
  })

  it('changes a file no further once its backup is gone', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const id = ids[0] as number
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'first change'))
    rmSync(join(backups, String(batch.id), `${id}.mp3`))

    // Act: as after a restart, when the track is taken up again.
    const changing = trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'second'))

    // Assert
    await expect(changing).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(readFileSync(pathOf(id), 'utf8')).toBe('first change')
  })
})

describe('an undo that must take nothing away', () => {
  it('puts the original under a free name when another file has its old name now', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const id = ids[0] as number
    const old = paths[0] as string
    const original = sha256(old)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, id).move(join(library, 'House', 'Renamed.mp3'))
    // Put there by the user after the batch: not ours to replace.
    writeFileSync(old, 'a file of the user')

    // Act
    const undone = await files.undoLast()

    // Assert
    const restored = join(library, 'track-01 (2).mp3')
    expect(undone).toMatchObject({ ok: true, value: { restored: 1 } })
    expect(readFileSync(old, 'utf8')).toBe('a file of the user')
    expect(sha256(restored)).toBe(original)
    expect(pathOf(id)).toBe(restored)
  })

  it('does not delete a file at a name the batch once used, when the track is not there', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const id = ids[0] as number
    const batch = newBatch('in_place', ids)
    const passed = join(library, 'House', 'First Name.mp3')
    await trackFiles(batch, id).move(passed)
    await trackFiles(batch, id).move(join(library, 'House', 'Second Name.mp3'))
    writeFileSync(passed, 'a file of the user')

    // Act
    await files.undoLast()

    // Assert
    expect(readFileSync(passed, 'utf8')).toBe('a file of the user')
  })

  it('is refused, with nothing changed, when a backup record points outside the backup folder', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const batch = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, `changed ${id}`))
    }
    const outside = join(clean, 'not a backup.mp3')
    writeFileSync(outside, 'something else')
    testDatabase.db
      .update(backupsTable)
      .set({ backupPath: outside })
      .where(eq(backupsTable.trackId, ids[1] as number))
      .run()
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'WRITE_FAILED' })
    expect(ids.map((id) => readFileSync(pathOf(id), 'utf8'))).toEqual(
      ids.map((id) => `changed ${id}`)
    )
    expect(getBatch(testDatabase.db, batch.id)?.status).not.toBe('undone')
  })

  it('is refused when the record of a copied track names a place outside the library', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const batch = newBatch('clean_library', ids)
    await trackFiles(batch, ids[0] as number).workingPath()
    testDatabase.db
      .update(batchItems)
      .set({ before: { path: join(folder, 'elsewhere.mp3'), title: 'x' } })
      .run()
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'WRITE_FAILED' })
    expect(filesUnder(clean)).toEqual(['Clean/track-01.mp3'])
  })

  it('works from a record that an older version wrote with fewer fields', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const original = sha256(paths[0] as string)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, ids[0] as number).move(join(library, 'Renamed.mp3'))
    testDatabase.db
      .update(batchItems)
      .set({ before: { path: paths[0], title: 'Old Title' } })
      .run()

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true })
    expect(sha256(paths[0] as string)).toBe(original)
    expect(getTrackById(testDatabase.db, ids[0] as number, NO_VOLUMES)).toMatchObject({
      path: paths[0],
      title: 'Old Title'
    })
  })

  it('gives up the batch that waits for approval: its proposals were made for other files', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, ids[0] as number).move(join(library, 'Renamed.mp3'))
    setBatchStatus(testDatabase.db, batch.id, 'applied')
    const waiting = newBatch('in_place', ids)
    setBatchStatus(testDatabase.db, waiting.id, 'preview')

    // Act
    await files.undoLast()

    // Assert
    expect(getBatch(testDatabase.db, waiting.id)?.status).toBe('cancelled')
  })
})

describe('a batch that wrote no file', () => {
  it('leaves the backups of the last batch that did, which stays the one to undo', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const originals = paths.map(sha256)
    const wrote = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(wrote, id).replaceContent((temp) => writeFile(temp, `changed ${id}`))
    }
    setBatchStatus(testDatabase.db, wrote.id, 'applied')
    const wroteNothing = newBatch('in_place', ids)
    setBatchStatus(testDatabase.db, wroteNothing.id, 'applied')

    // Act
    await files.pruneOlderBackups(wroteNothing.id)
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true, value: { batchId: wrote.id, restored: 2 } })
    expect(paths.map(sha256)).toEqual(originals)
  })
})

describe('a library whose folder is spelled differently in the settings', () => {
  it('still copies a track to the same relative place under the clean library', async () => {
    // Arrange
    const respelled = join(folder, 'MUSIC')
    // Only where the disk takes both spellings for one folder.
    if (!existsSync(respelled)) return
    const { ids } = addTracks(1, 'House/Deep')
    const batch = newBatch('clean_library', ids)
    const spelled = createBatchFiles({
      db: testDatabase.db,
      fileOps: createFileOps({ allowedRoots: () => [respelled, clean, backups] }),
      folders: () => ({ libraryRoot: respelled, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })

    // Act
    const working = await spelled
      .forTrack(batch, ids[0] as number, new AbortController().signal)
      .workingPath()

    // Assert
    expect(working).toBe(join(clean, 'House', 'Deep', 'track-01.mp3'))
  })
})

describe('an undo that would lose the last copy of a file', () => {
  it('is refused when a track that was renamed in place has no backup record any more', async () => {
    // Arrange: as after the backups of the batch were only partly deleted.
    const { ids } = addTracks(2)
    const batch = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(batch, id).move(join(library, 'House', `Renamed ${id}.mp3`))
    }
    const renamed = ids.map((id) => sha256(pathOf(id)))
    testDatabase.db
      .delete(backupsTable)
      .where(eq(backupsTable.trackId, ids[0] as number))
      .run()
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'WRITE_FAILED' })
    expect(ids.map((id) => sha256(pathOf(id)))).toEqual(renamed)
  })

  it('keeps the copy in the clean library when the original is not there any more', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const batch = newBatch('clean_library', ids)
    for (const id of ids) await trackFiles(batch, id).workingPath()
    const copies = ids.map(pathOf)
    const kept = sha256(copies[0] as string)
    // The user has the clean copy now, and removed the original.
    rmSync(paths[0] as string)
    vi.spyOn(logger, 'warn').mockImplementation(() => {})

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true, value: { removed: 1 } })
    expect(sha256(copies[0] as string)).toBe(kept)
    expect(ids.map(pathOf)).toEqual([copies[0], paths[1]])
  })

  it('makes no second copy of an original that an undo had put back before it stopped', async () => {
    // Arrange
    const { ids, paths } = addTracks(1)
    const id = ids[0] as number
    const old = paths[0] as string
    const original = sha256(old)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, id).move(join(library, 'House', 'Renamed.mp3'))
    // What an undo leaves that stopped before the database was told.
    await fileOps.restore(join(backups, String(batch.id), `${id}.mp3`), old)
    rmSync(pathOf(id))

    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true })
    expect(filesUnder(library)).toEqual(['Music/track-01.mp3'])
    expect(sha256(old)).toBe(original)
    expect(pathOf(id)).toBe(old)
  })

  it('deletes the backups it has put back, with their records', async () => {
    // Arrange
    const { ids } = addTracks(2)
    const batch = newBatch('in_place', ids)
    for (const id of ids) {
      await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, `changed ${id}`))
    }

    // Act
    await files.undoLast()

    // Assert
    expect(filesUnder(backups)).toEqual([])
    expect(listBackups(testDatabase.db, batch.id)).toEqual([])
  })
})

describe('records that name the wrong file', () => {
  it('do not get a library file deleted as the backup of an older batch', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const older = newBatch('in_place', [ids[0] as number])
    await trackFiles(older, ids[0] as number).replaceContent((temp) => writeFile(temp, 'x'))
    setBatchStatus(testDatabase.db, older.id, 'applied')
    testDatabase.db.update(backupsTable).set({ backupPath: paths[1] }).run()
    const newer = newBatch('in_place', [ids[0] as number])
    await trackFiles(newer, ids[0] as number).replaceContent((temp) => writeFile(temp, 'y'))
    setBatchStatus(testDatabase.db, newer.id, 'applied')
    const untouched = sha256(paths[1] as string)
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await files.pruneOlderBackups(newer.id)

    // Assert
    expect(sha256(paths[1] as string)).toBe(untouched)
    expect(listBackups(testDatabase.db, older.id)).toHaveLength(1)
  })

  it('do not let a file take the name of a track whose file is missing', async () => {
    // Arrange
    const { ids, paths } = addTracks(2)
    const batch = newBatch('in_place', [ids[0] as number])
    rmSync(paths[1] as string)

    // Act
    const moving = trackFiles(batch, ids[0] as number).move(paths[1] as string)

    // Assert
    await expect(moving).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(pathOf(ids[0] as number)).toBe(paths[0])
    expect(existsSync(paths[1] as string)).toBe(false)
    expect(listCreatedFiles(testDatabase.db, batch.id)).toEqual([])
  })

  it("know a name that passed from one track to another in a batch as the second track's", async () => {
    // Arrange
    const { ids } = addTracks(2)
    const [first, second] = ids as [number, number]
    const batch = newBatch('in_place', ids)
    const shared = join(library, 'House', 'Shared.mp3')
    await trackFiles(batch, first).move(shared)
    await trackFiles(batch, first).move(join(library, 'House', 'Other.mp3'))

    // Act
    await trackFiles(batch, second).move(shared)

    // Assert
    const note = listCreatedFiles(testDatabase.db, batch.id).find((file) => file.path === shared)
    expect(note?.trackId).toBe(second)
  })
})

describe('work on a file that nobody waits for any more', () => {
  it('is still counted until it has ended', async () => {
    // Arrange
    const { ids } = addTracks(1)
    const batch = newBatch('in_place', ids)
    let finish: () => void = () => {}
    const writing = trackFiles(batch, ids[0] as number).replaceContent(async (temp) => {
      await writeFile(temp, 'changed')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await vi.waitFor(() => expect(finish).not.toHaveLength(0))

    // Act
    const whileWriting = files.busy()
    let settled = false
    const waiting = files.settled().then(() => {
      settled = true
    })
    const settledEarly = settled
    finish()
    await writing
    await waiting

    // Assert
    expect(whileWriting).toBe(true)
    expect(settledEarly).toBe(false)
    expect(files.busy()).toBe(false)
  })
})

describe('the note about a file a batch created', () => {
  it('is kept in the composed spelling, however the path was spelled when it was noted', () => {
    // Arrange
    const [id] = insertTracks(testDatabase.db, [
      { path: '/Music/a.mp3', originalPath: '/Music/a.mp3', format: 'mp3' as const }
    ]) as [number]
    const batchId = createBatch(testDatabase.db, {
      type: 'run',
      mode: 'clean_library',
      items: [{ trackId: id, before: {} }]
    })
    const decomposed = '/Clean/Válogatás/Ákos.mp3'

    // Act
    recordCreatedFile(testDatabase.db, { batchId, trackId: id, path: decomposed })
    const noted = listCreatedFiles(testDatabase.db, batchId).map((file) => file.path)
    deleteCreatedFile(testDatabase.db, batchId, decomposed)

    // Assert
    expect(noted).toEqual([decomposed.normalize('NFC')])
    expect(listCreatedFiles(testDatabase.db, batchId)).toEqual([])
  })
})

describe('work on files that quitting waits for', () => {
  /** File rules whose `restore` stands still until the test lets it go. */
  function holdingRestore(): { held: BatchFiles; release: () => void; reached: Promise<void> } {
    let release: () => void = () => {}
    let arrive: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      arrive = resolve
    })
    const held = createBatchFiles({
      db: testDatabase.db,
      fileOps: {
        ...fileOps,
        restore: async (...given) => {
          arrive()
          await gate
          return fileOps.restore(...given)
        }
      },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })
    return { held, release, reached }
  }

  it('counts an undo from its start to its end, and says that it is an undo', async () => {
    // Arrange: a batch that changed a file, and an undo that is held in the middle.
    const { ids, paths } = addTracks(1)
    const [id] = ids as [number]
    const original = sha256(paths[0] as string)
    const batch = newBatch('in_place', ids)
    await trackFiles(batch, id).replaceContent((temp) => writeFile(temp, 'changed'))
    const { held, release, reached } = holdingRestore()
    let settled = false

    // Act
    const undo = held.undoLast()
    await reached
    void held.settled().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const during = { busy: held.busy(), undoing: held.undoing(), settled }
    release()
    const undone = await undo
    await held.settled()

    // Assert
    expect(during).toEqual({ busy: true, undoing: true, settled: false })
    expect(undone).toMatchObject({ ok: true })
    expect({ busy: held.busy(), undoing: held.undoing() }).toEqual({ busy: false, undoing: false })
    expect(sha256(paths[0] as string)).toBe(original)
  })

  it('counts an undo that has nothing to undo out again', async () => {
    // Act
    const undone = await files.undoLast()

    // Assert
    expect(undone).toEqual({ ok: false, code: 'NOTHING_TO_UNDO' })
    expect({ busy: files.busy(), undoing: files.undoing() }).toEqual({
      busy: false,
      undoing: false
    })
  })

  it('counts the deletion of older backups, which is no undo', async () => {
    // Arrange: two batches that each changed a file.
    const { ids } = addTracks(2)
    const [first, second] = ids as [number, number]
    const older = newBatch('in_place', [first])
    await trackFiles(older, first).replaceContent((temp) => writeFile(temp, 'one'))
    const newer = newBatch('in_place', [second])
    await trackFiles(newer, second).replaceContent((temp) => writeFile(temp, 'two'))

    // Act
    const pruning = files.pruneOlderBackups(newer.id)
    const during = { busy: files.busy(), undoing: files.undoing() }
    await pruning

    // Assert
    expect(during).toEqual({ busy: true, undoing: false })
    expect(files.busy()).toBe(false)
    expect(listBackups(testDatabase.db, older.id)).toEqual([])
    expect(listBackups(testDatabase.db, newer.id)).toHaveLength(1)
  })
})
