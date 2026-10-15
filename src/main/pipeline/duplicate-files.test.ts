// Duplicates from the run to the files on disk: the real stages that find them and
// set them aside, the orchestrator, the preview and the file rules together, with a
// stand-in for the lookup and files in a temp folder.
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBatchItem, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import {
  countTracks,
  getTrackById,
  insertTracks,
  listTracks,
  updateTrack,
  type NewTrack
} from '../db/tracks'
import { setSetting } from '../db/settings'
import { createFileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import { readProposal, type ProposedFields } from '@shared/preview'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { createBatchFiles, type BatchFiles } from './batch-files'
import { resolveRunTargets } from './library'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { createPreview, type Preview } from './preview'
import { createLibraryScanner } from './scanner'
import { createDuplicatesStage } from './stages/duplicates'
import { createNamingStage } from './stages/naming'
import { createRenameStage } from './stages/rename'
import { createSetAsideStage } from './stages/set-aside'
import type { Stage } from './stages/stage'

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
let batchFiles: BatchFiles
let run: Orchestrator
let preview: Preview

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

function standIn(name: string, fields: ProposedFields = {}): Stage {
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

/** Puts a file into the library and makes it a track; `Bicep - Glue`, 5 minutes, unless told otherwise. */
function addCopy(
  relativePath: string,
  track: Partial<NewTrack> = {}
): { id: number; path: string } {
  const path = join(library, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  // Every file differs, so that two files that were mixed up would show.
  writeFileSync(path, Buffer.concat([FIXTURE, Buffer.from(relativePath)]))
  const [id] = insertTracks(testDatabase.db, [
    {
      path,
      originalPath: path,
      format: 'mp3' as const,
      artist: 'Bicep',
      title: 'Glue',
      durationMs: 300_000,
      bitrateKbps: 320,
      ...track
    }
  ]) as [number]
  return { id, path }
}

function pathOf(trackId: number): string {
  return getTrackById(testDatabase.db, trackId, NO_VOLUMES)?.path ?? ''
}

function warningsOf(batchId: number, trackId: number): string[] {
  return readProposal(getBatchItem(testDatabase.db, batchId, trackId)?.after).warnings ?? []
}

/** Looks for duplicates among the tracks and waits for the preview. */
async function searched(ids: number[], stages: string[] = ['duplicates']): Promise<number> {
  // Asking for the search brings the lookup and the stage that sets aside with it.
  const started = run.start({ trackIds: ids, stages })
  if (!started.ok) throw new Error(`the run did not start: ${started.code}`)
  await run.whenFinished()
  return started.value.batchId
}

async function approved(batchId: number): Promise<void> {
  const approval = await preview.approve(batchId)
  if (!approval.ok || !approval.value.started) throw new Error('the batch was not applied')
  await run.whenFinished()
}

function build(stages: Stage[]): void {
  run = createOrchestrator({
    db: testDatabase.db,
    stages,
    limits: () => ({ cpu: 4, gpu: 1, network: 4, claude: 1, io: 2 }),
    listMountedVolumes: () => NO_VOLUMES,
    mode: () => mode,
    batchFiles
  })
  preview = createPreview({
    db: testDatabase.db,
    stages,
    orchestrator: run,
    batchFiles,
    listMountedVolumes: () => NO_VOLUMES
  })
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-duplicates-')))
  library = join(folder, 'Music')
  clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  mode = 'in_place'
  batchFiles = createBatchFiles({
    db: testDatabase.db,
    fileOps: createFileOps({ allowedRoots: () => [library, clean, backups] }),
    folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
    listMountedVolumes: () => NO_VOLUMES
  })
  build([standIn('lookup'), createDuplicatesStage({ db: testDatabase.db }), createSetAsideStage()])
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('a batch that looks for duplicates', () => {
  it('opens its preview with the groups in it, and has changed no file', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff', bitrateKbps: 1411 })
    const other = addCopy('Inbox/Bicep - Apricots.mp3', { title: 'Apricots' })
    const before = filesUnder(library)

    // Act
    const batchId = await searched([mp3.id, aiff.id, other.id])
    const state = preview.state()
    const groups = preview.duplicates(batchId)

    // Assert
    expect(state.batch).toMatchObject({ id: batchId, findsDuplicates: true })
    expect(groups).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          artist: 'Bicep',
          title: 'Glue',
          members: [
            expect.objectContaining({ trackId: mp3.id, keep: false, suggested: false }),
            expect.objectContaining({ trackId: aiff.id, keep: true, suggested: true })
          ]
        })
      ]
    })
    expect([mp3, aiff, other].map(({ id }) => warningsOf(batchId, id))).toEqual([
      ['DUPLICATE'],
      ['DUPLICATE'],
      []
    ])
    expect(filesUnder(library)).toEqual(before)
    expect(filesUnder(backups)).toEqual([])
  })

  it('after approval has the copies that are not kept in _Duplicates, byte for byte, and deletes none', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const low = addCopy('Old/glue.mp3', { bitrateKbps: 128 })
    const other = addCopy('Inbox/Bicep - Apricots.mp3', { title: 'Apricots' })
    const all = [mp3, aiff, low, other]
    const hashes = all.map(({ path }) => sha256(path))
    const batchId = await searched(all.map(({ id }) => id))

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual([
      'Music/Albums/Isles/02 Glue.aiff',
      'Music/Inbox/Bicep - Apricots.mp3',
      'Music/_Duplicates/Bicep - Glue.mp3',
      'Music/_Duplicates/glue.mp3'
    ])
    // Every file is still there, under the track it belongs to, with its bytes.
    expect(all.map(({ id }) => sha256(pathOf(id)))).toEqual(hashes)
    expect(pathOf(aiff.id)).toBe(aiff.path)
    expect(pathOf(other.id)).toBe(other.path)
  })

  it('leaves what was set aside out of the Library list and out of the next run', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])

    // Act
    await approved(batchId)
    const listed = listTracks(testDatabase.db, { limit: 100, offset: 0 }, NO_VOLUMES)
    const targets = resolveRunTargets(
      testDatabase.db,
      { scope: 'library', stages: ['duplicates'] },
      NO_VOLUMES,
      ['duplicates']
    )
    const again = run.start({ trackIds: [mp3.id], stages: ['duplicates'] })

    // Assert
    expect(listed.map((track) => track.id)).toEqual([aiff.id])
    expect(countTracks(testDatabase.db)).toBe(1)
    expect(targets).toMatchObject({ ok: true, value: { trackIds: [aiff.id] } })
    // Asked for by its id all the same: it is no track of the library any more.
    expect(again).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('puts every file back where it was when the batch is undone', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const before = filesUnder(library)
    const hashes = [mp3, aiff].map(({ path }) => sha256(path))
    const batchId = await searched([mp3.id, aiff.id])
    await approved(batchId)

    // Act
    const undone = await preview.undoLast()

    // Assert
    expect(undone.ok).toBe(true)
    expect(filesUnder(library)).toEqual(before)
    expect([mp3, aiff].map(({ path }) => sha256(path))).toEqual(hashes)
    expect([mp3, aiff].map(({ id }) => pathOf(id))).toEqual([mp3.path, aiff.path])
    // The folder the batch made goes with what was in it.
    expect(existsSync(join(library, '_Duplicates'))).toBe(false)
    expect(countTracks(testDatabase.db)).toBe(2)
  })

  it('keeps the copy the user picked instead of the one it proposed', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])

    // Act
    const picked = preview.keepDuplicate({ batchId, trackId: mp3.id })
    await approved(batchId)

    // Assert
    expect(picked).toMatchObject({
      ok: true,
      value: [
        {
          members: [
            { trackId: mp3.id, keep: true },
            { trackId: aiff.id, keep: false }
          ]
        }
      ]
    })
    expect(filesUnder(library)).toEqual([
      'Music/Inbox/Bicep - Glue.mp3',
      'Music/_Duplicates/02 Glue.aiff'
    ])
  })

  it('refuses a choice for another batch, for a track in no group, and one that is no choice', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const other = addCopy('Inbox/Bicep - Apricots.mp3', { title: 'Apricots' })
    const batchId = await searched([mp3.id, aiff.id, other.id])

    // Act
    const answers = [
      preview.keepDuplicate({ batchId: batchId + 1, trackId: mp3.id }),
      preview.keepDuplicate({ batchId, trackId: other.id }),
      preview.keepDuplicate({ batchId, trackId: mp3.id, path: '/etc/passwd' }),
      preview.keepDuplicate(null),
      preview.duplicates(batchId + 1)
    ]

    // Assert
    expect(answers.map((answer) => answer.ok)).toEqual([false, false, false, false, false])
    expect(preview.duplicates(batchId)).toMatchObject({
      ok: true,
      value: [{ members: [{ keep: false }, { keep: true }] }]
    })
  })

  it('does not move a copy the user took out of the batch', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const low = addCopy('Old/glue.mp3', { bitrateKbps: 128 })
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, low.id, aiff.id])
    preview.setExcluded({ batchId, trackIds: [low.id], excluded: true })

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual([
      'Music/Albums/Isles/02 Glue.aiff',
      'Music/Old/glue.mp3',
      'Music/_Duplicates/Bicep - Glue.mp3'
    ])
  })

  it('never writes over a file: two copies of one name become two files in _Duplicates', async () => {
    // Arrange
    const first = addCopy('Inbox/glue.mp3', { bitrateKbps: 128 })
    const second = addCopy('Old/glue.mp3', { bitrateKbps: 192 })
    const kept = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const hashes = [first, second].map(({ path }) => sha256(path)).sort()
    const batchId = await searched([first.id, second.id, kept.id])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual([
      'Music/Albums/Isles/02 Glue.aiff',
      'Music/_Duplicates/glue (2).mp3',
      'Music/_Duplicates/glue.mp3'
    ])
    expect([first, second].map(({ id }) => sha256(pathOf(id))).sort()).toEqual(hashes)
  })

  it('leaves a file that is in _Duplicates already where it is', async () => {
    // Arrange: a file somebody put there by hand, and a file of the same name.
    const stray = join(library, '_Duplicates', 'Bicep - Glue.mp3')
    mkdirSync(dirname(stray))
    writeFileSync(stray, 'put here by hand')
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])

    // Act
    await approved(batchId)

    // Assert
    expect(readFileSync(stray, 'utf8')).toBe('put here by hand')
    expect(pathOf(mp3.id)).toBe(join(library, '_Duplicates', 'Bicep - Glue (2).mp3'))
  })

  it('does not set a copy aside when the copy that was to be kept is gone from the library', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])
    // Deleted by hand after the preview was made: no scan has noticed yet.
    rmSync(aiff.path)
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: the only copy left stays where the library shows it.
    expect(pathOf(mp3.id)).toBe(mp3.path)
    expect(existsSync(join(library, '_Duplicates'))).toBe(false)
    expect(getBatchItem(testDatabase.db, batchId, mp3.id)?.error).toMatchObject({
      stage: 'setAside',
      code: 'FILE_UNREADABLE'
    })
  })

  it('does not follow a _Duplicates that is a link to another folder of the library', async () => {
    // Arrange
    mkdirSync(join(library, 'Albums'))
    symlinkSync(join(library, 'Albums'), join(library, '_Duplicates'))
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert
    expect(pathOf(mp3.id)).toBe(mp3.path)
    expect(existsSync(mp3.path)).toBe(true)
    // Nothing arrived in the folder the link points to.
    expect(readdirSync(join(library, 'Albums'))).toEqual(['Isles'])
    // And no backup was made for a file that was not moved: the batch wrote nothing.
    expect(filesUnder(backups)).toEqual([])
    expect(batchFiles.lastUndoable()).toBeNull()
    expect(getBatchItem(testDatabase.db, batchId, mp3.id)?.error).toMatchObject({
      stage: 'setAside'
    })
  })

  it.each([
    ['a file', (path: string) => writeFileSync(path, 'not a folder')],
    ['a link to nowhere', (path: string) => symlinkSync(join(library, 'Gone'), path)]
  ])('moves nothing when _Duplicates is %s', async (_name, make) => {
    // Arrange
    make(join(library, '_Duplicates'))
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert
    expect(pathOf(mp3.id)).toBe(mp3.path)
    expect(existsSync(mp3.path)).toBe(true)
    expect(getBatchItem(testDatabase.db, batchId, mp3.id)?.error).toMatchObject({
      stage: 'setAside',
      code: 'WRITE_FAILED'
    })
    expect(filesUnder(backups)).toEqual([])
  })

  it('does not write over another file that came to stand at the old place, when the batch is undone', async () => {
    // Arrange: a copy is set aside and deleted by hand; another file is saved where
    // it was, and the track is told it is there, as a scan could tell it.
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const original = sha256(mp3.path)
    await approved(await searched([mp3.id, aiff.id]))
    rmSync(pathOf(mp3.id))
    writeFileSync(mp3.path, 'another recording altogether')
    updateTrack(testDatabase.db, mp3.id, { path: mp3.path })

    // Act
    const undone = await preview.undoLast()

    // Assert: both files are there, the other one untouched, the original beside it.
    expect(undone.ok).toBe(true)
    expect(readFileSync(mp3.path, 'utf8')).toBe('another recording altogether')
    expect(pathOf(mp3.id)).toBe(join(library, 'Inbox', 'Bicep - Glue (2).mp3'))
    expect(sha256(pathOf(mp3.id))).toBe(original)
  })

  it('does not delete another file that was put into _Duplicates under the name of the copy, when the batch is undone', async () => {
    // Arrange: the copy that was set aside is deleted by hand, as the app leaves to
    // the user, and another file is put there under the same name.
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const original = sha256(mp3.path)
    await approved(await searched([mp3.id, aiff.id]))
    const aside = pathOf(mp3.id)
    rmSync(aside)
    writeFileSync(aside, 'another file the user keeps here')

    // Act
    const undone = await preview.undoLast()

    // Assert: the original is back in the library, and the user's file is still there.
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 0, left: 1 } })
    expect(readFileSync(aside, 'utf8')).toBe('another file the user keeps here')
    expect(sha256(mp3.path)).toBe(original)
  })

  it('does not write over a file of the very same size at the old place either', async () => {
    // Arrange: as above, but the other file is as big as the original, to the byte.
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const original = readFileSync(mp3.path)
    await approved(await searched([mp3.id, aiff.id]))
    rmSync(pathOf(mp3.id))
    const other = Buffer.from(original)
    other.fill(7, 0, 64)
    writeFileSync(mp3.path, other)
    const otherHash = sha256(mp3.path)

    // Act
    const undone = await preview.undoLast()

    // Assert
    expect(undone.ok).toBe(true)
    expect(sha256(mp3.path)).toBe(otherHash)
    expect(pathOf(mp3.id)).toBe(join(library, 'Inbox', 'Bicep - Glue (2).mp3'))
    expect(readFileSync(pathOf(mp3.id)).equals(original)).toBe(true)
  })

  it('does not write over the file of another track whose name differs only in letter case', async () => {
    // Arrange: the copy is gone from _Duplicates, and a new track has its old name in capitals.
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const original = readFileSync(mp3.path)
    await approved(await searched([mp3.id, aiff.id]))
    rmSync(pathOf(mp3.id))
    const shouted = join(library, 'Inbox', 'BICEP - GLUE.MP3')
    const other = Buffer.from(original)
    other.fill(7, 0, 64)
    writeFileSync(shouted, other)
    insertTracks(testDatabase.db, [{ path: shouted, originalPath: shouted, format: 'mp3' }])

    // Act
    const undone = await preview.undoLast()

    // Assert: the other track's file holds what it held.
    expect(undone.ok).toBe(true)
    expect(readFileSync(shouted).equals(other)).toBe(true)
    expect(readFileSync(pathOf(mp3.id)).equals(original)).toBe(true)
    expect(pathOf(mp3.id)).not.toBe(shouted)
  })

  it('finishes an undo that stopped half way, also when the library was scanned in between', async () => {
    // Arrange: two copies are set aside; the undo puts one back and fails on the other.
    const first = addCopy('Inbox/Bicep - Glue.mp3', { bitrateKbps: 192 })
    const second = addCopy('Old/glue.mp3', { bitrateKbps: 128 })
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const before = filesUnder(library)
    const hashes = [first, second, aiff].map(({ path }) => sha256(path))
    await approved(await searched([first.id, second.id, aiff.id]))
    const real = createFileOps({ allowedRoots: () => [library, clean, backups] })
    let restores = 0
    const flaky = createBatchFiles({
      db: testDatabase.db,
      fileOps: {
        ...real,
        restore: async (from, to) => {
          restores += 1
          if (restores === 2) throw new Error('EIO: the drive went away')
          return real.restore(from, to)
        }
      },
      folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
      listMountedVolumes: () => NO_VOLUMES
    })
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    setSetting(testDatabase.db, 'library', {
      ...DEFAULT_SETTINGS.library,
      rootFolder: library,
      cleanLibraryFolder: clean,
      backupFolder: backups
    })
    const scanner = createLibraryScanner({
      db: testDatabase.db,
      environment: { homeDir: '/Users/dj', cpuCount: 8 },
      readTags: async (paths) =>
        paths.map((path) => ({
          path,
          readable: true,
          durationMs: 300_000,
          bitrateKbps: 320,
          sampleRateHz: 44_100,
          artist: null,
          title: null,
          album: null,
          label: null,
          year: null,
          genre: null,
          hasCover: false
        })),
      isEngineAlive: async () => true,
      listMountedVolumes: () => NO_VOLUMES,
      knownFiles: () => batchFiles.restoredOriginals()
    })

    // Act
    const stopped = await flaky.undoLast()
    const scan = await scanner.scan()
    const undone = await preview.undoLast()

    // Assert: the file that was put back is no new track, and the second undo ends
    // with the library as it was, without a second copy of anything.
    expect(stopped.ok).toBe(false)
    expect(scan).toMatchObject({ ok: true, value: { added: 0 } })
    expect(undone.ok).toBe(true)
    expect(filesUnder(library)).toEqual(before)
    expect([first, second, aiff].map(({ path }) => sha256(path))).toEqual(hashes)
    expect([first, second, aiff].map(({ id }) => pathOf(id))).toEqual([
      first.path,
      second.path,
      aiff.path
    ])
    expect(countTracks(testDatabase.db)).toBe(3)
  })

  it('makes no backup for a copy whose name cannot be given in _Duplicates', async () => {
    // Arrange: a colon in a name is what a slash typed in Finder becomes.
    const odd = addCopy('Inbox/Bicep - Glue 1:2.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([odd.id, aiff.id])
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: refused before anything was copied, so the batch wrote nothing.
    expect(getBatchItem(testDatabase.db, batchId, odd.id)?.error).toMatchObject({
      stage: 'setAside',
      code: 'INVALID_INPUT'
    })
    expect(existsSync(odd.path)).toBe(true)
    expect(filesUnder(backups)).toEqual([])
    expect(batchFiles.lastUndoable()).toBeNull()
  })

  it('says so when the copy in the clean library had to take a number', async () => {
    // Arrange: a file of that name is in the clean library already.
    mode = 'clean_library'
    mkdirSync(join(clean, 'Inbox'))
    writeFileSync(join(clean, 'Inbox', 'Bicep - Apricots.mp3'), 'there before')
    const other = addCopy('Inbox/Bicep - Apricots.mp3', { title: 'Apricots' })
    const batchId = await searched([other.id])

    // Act
    await approved(batchId)

    // Assert
    expect(pathOf(other.id)).toBe(join(clean, 'Inbox', 'Bicep - Apricots (2).mp3'))
    expect(warningsOf(batchId, other.id)).toContain('NAME_COLLISION')
    expect(readFileSync(join(clean, 'Inbox', 'Bicep - Apricots.mp3'), 'utf8')).toBe('there before')
  })

  it('uses a _duplicates folder that is there in another letter case', async () => {
    // Arrange
    mkdirSync(join(library, '_duplicates'))
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const hash = sha256(mp3.path)
    const batchId = await searched([mp3.id, aiff.id])

    // Act
    await approved(batchId)

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, mp3.id)?.error).toBeNull()
    expect(sha256(pathOf(mp3.id))).toBe(hash)
    expect(existsSync(mp3.path)).toBe(false)
  })

  it('gives a number to a copy whose name a track still has that was deleted from _Duplicates by hand', async () => {
    // Arrange: a copy is set aside, and then deleted by the user, as the app leaves to them.
    const old = addCopy('Old/glue.mp3', { bitrateKbps: 128 })
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    await approved(await searched([old.id, aiff.id]))
    rmSync(pathOf(old.id))
    const again = addCopy('Inbox/glue.mp3', { bitrateKbps: 192 })
    const hash = sha256(again.path)
    const batchId = await searched([again.id, aiff.id])

    // Act
    await approved(batchId)

    // Assert: not the name of the row that is still there, and no failure.
    expect(getBatchItem(testDatabase.db, batchId, again.id)?.error).toBeNull()
    expect(pathOf(again.id)).toBe(join(library, '_Duplicates', 'glue (2).mp3'))
    expect(sha256(pathOf(again.id))).toBe(hash)
    expect(warningsOf(batchId, again.id)).toContain('NAME_COLLISION')
  })

  it('says so when the name was taken in _Duplicates and the copy got a number', async () => {
    // Arrange
    const first = addCopy('Inbox/glue.mp3', { bitrateKbps: 128 })
    const second = addCopy('Old/glue.mp3', { bitrateKbps: 192 })
    const kept = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([first.id, second.id, kept.id])

    // Act
    await approved(batchId)

    // Assert
    const numbered = [first, second].find(({ id }) => pathOf(id).endsWith('glue (2).mp3'))
    expect(numbered).toBeDefined()
    expect(warningsOf(batchId, numbered?.id ?? -1)).toContain('NAME_COLLISION')
  })

  it('sets aside into a folder right under the library only: a path is refused, and nothing moves', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])
    const before = filesUnder(folder)
    const files = batchFiles.forTrack(
      { id: batchId, mode: 'in_place' },
      mp3.id,
      new AbortController().signal
    )

    // Act
    const refused = await Promise.allSettled(
      ['../Elsewhere', 'a/b', '.hidden', '..', ''].map((name) => files.setAside(name, aiff.id))
    )

    // Assert
    expect(refused.map((each) => each.status)).toEqual(Array(5).fill('rejected'))
    expect(filesUnder(folder)).toEqual(before)
    expect(pathOf(mp3.id)).toBe(mp3.path)
  })

  it('in the clean library sets the copy aside there, and leaves every original as it was', async () => {
    // Arrange
    mode = 'clean_library'
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const other = addCopy('Inbox/Bicep - Apricots.mp3', { title: 'Apricots' })
    const all = [mp3, aiff, other]
    const before = filesUnder(library)
    const hashes = all.map(({ path }) => sha256(path))
    const batchId = await searched(all.map(({ id }) => id))

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(before)
    expect(all.map(({ path }) => sha256(path))).toEqual(hashes)
    expect(filesUnder(clean)).toEqual([
      'Clean/Albums/Isles/02 Glue.aiff',
      'Clean/Inbox/Bicep - Apricots.mp3',
      'Clean/_Duplicates/Bicep - Glue.mp3'
    ])
    expect(all.map(({ id }) => sha256(pathOf(id)))).toEqual(hashes)
  })

  it('groups again after a name was changed in the preview', async () => {
    // Arrange
    const mp3 = addCopy('Inbox/Bicep - Glue.mp3')
    const aiff = addCopy('Albums/Isles/02 Glue.aiff', { format: 'aiff' })
    const batchId = await searched([mp3.id, aiff.id])

    // Act
    const edited = preview.edit({ batchId, trackId: mp3.id, field: 'mix', value: 'Hammer Remix' })
    const groups = preview.duplicates(batchId)
    await approved(batchId)

    // Assert: the row that comes back is the row after the groups were made again.
    expect(edited).toMatchObject({ ok: true, value: { warnings: [] } })
    expect(groups).toEqual({ ok: true, value: [] })
    expect(warningsOf(batchId, aiff.id)).toEqual([])
    expect(filesUnder(library)).toEqual([
      'Music/Albums/Isles/02 Glue.aiff',
      'Music/Inbox/Bicep - Glue.mp3'
    ])
  })
})

describe('a batch that names the files and looks for duplicates', () => {
  beforeEach(() => {
    build([
      standIn('lookup'),
      standIn('bpmKey', {
        bpm: { value: 124, source: 'analysis' },
        key: { value: '8A', source: 'analysis' }
      }),
      createNamingStage(),
      createDuplicatesStage({ db: testDatabase.db }),
      createRenameStage(),
      createSetAsideStage()
    ])
  })

  it('names the copy that is kept, and sets the other aside before it is named, so the kept one gets the plain name', async () => {
    // Arrange: the mix is in the title of one and in the tag of the other.
    const tagged = addCopy('Inbox/a.mp3', { title: 'Glue (Extended Mix)', bitrateKbps: 192 })
    const kept = addCopy('Inbox/b.mp3', { mix: 'Extended Mix' })
    const radio = addCopy('Inbox/c.mp3', { title: 'Glue (Radio Edit)' })
    const all = [tagged, kept, radio]
    const hashes = all.map(({ path }) => sha256(path))
    const batchId = await searched(
      all.map(({ id }) => id),
      ['naming', 'duplicates']
    )

    // Act
    await approved(batchId)

    // Assert
    const files = filesUnder(library)
    expect(files).toHaveLength(3)
    expect(files).toContain('Music/Inbox/Bicep - Glue (Extended Mix) [8A Am - 124].mp3')
    expect(files).toContain('Music/Inbox/Bicep - Glue (Radio Edit) [8A Am - 124].mp3')
    expect(pathOf(kept.id)).toBe(
      join(library, 'Inbox', 'Bicep - Glue (Extended Mix) [8A Am - 124].mp3')
    )
    expect(pathOf(tagged.id)).toBe(
      join(library, '_Duplicates', 'Bicep - Glue (Extended Mix) [8A Am - 124].mp3')
    )
    expect(all.map(({ id }) => sha256(pathOf(id)))).toEqual(hashes)
  })
  it('names a copy among what was set aside although a track that was deleted there still has the name', async () => {
    // Arrange: the first batch sets a copy aside under its new name; the user deletes it.
    const first = addCopy('Inbox/a.mp3', { mix: 'Extended Mix', bitrateKbps: 192 })
    const kept = addCopy('Inbox/b.mp3', { mix: 'Extended Mix' })
    await approved(await searched([first.id, kept.id], ['naming', 'duplicates']))
    rmSync(pathOf(first.id))
    const again = addCopy('Inbox/download again.mp3', { mix: 'Extended Mix', bitrateKbps: 128 })
    const hash = sha256(again.path)
    const batchId = await searched([again.id, kept.id], ['naming', 'duplicates'])

    // Act
    await approved(batchId)

    // Assert: the next number, no failure, the same bytes.
    expect(getBatchItem(testDatabase.db, batchId, again.id)?.error).toBeNull()
    expect(pathOf(again.id)).toBe(
      join(library, '_Duplicates', 'Bicep - Glue (Extended Mix) [8A Am - 124] (2).mp3')
    )
    expect(sha256(pathOf(again.id))).toBe(hash)
  })

  it('does the same in the clean library, where both steps start from one copy', async () => {
    // Arrange
    mode = 'clean_library'
    const tagged = addCopy('Inbox/a.mp3', { title: 'Glue (Extended Mix)', bitrateKbps: 192 })
    const kept = addCopy('Inbox/b.mp3', { mix: 'Extended Mix' })
    const all = [tagged, kept]
    const before = filesUnder(library)
    const hashes = all.map(({ path }) => sha256(path))
    const batchId = await searched(
      all.map(({ id }) => id),
      ['naming', 'duplicates']
    )

    // Act
    await approved(batchId)

    // Assert: neither step failed for a file the other had moved meanwhile.
    expect(all.map(({ id }) => getBatchItem(testDatabase.db, batchId, id)?.error)).toEqual([
      null,
      null
    ])
    expect(filesUnder(library)).toEqual(before)
    expect(filesUnder(clean)).toEqual([
      'Clean/Inbox/Bicep - Glue (Extended Mix) [8A Am - 124].mp3',
      'Clean/_Duplicates/Bicep - Glue (Extended Mix) [8A Am - 124].mp3'
    ])
    expect(all.map(({ id }) => sha256(pathOf(id)))).toEqual(hashes)
  })
})
