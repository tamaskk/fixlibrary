// A conversion from the run to the files on disk: the real stages, the orchestrator,
// the preview and the file rules together, with a stand-in for the sidecar and files
// in a temp folder.
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBatchItem, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { getTrackById, insertTracks, type NewTrack } from '../db/tracks'
import { createFileOps, type FileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import type { PythonBridge } from '../services/python-bridge'
import { AppError } from '@shared/errors'
import { readProposal, type ProposedFields } from '@shared/preview'
import { createBatchFiles, type BatchFiles } from './batch-files'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { commitApprovedValues, createPreview, type Preview } from './preview'
import { createConvertFileStage, createConvertStage } from './stages/convert'
import { createDuplicatesStage } from './stages/duplicates'
import { createNamingStage } from './stages/naming'
import { createRenameStage } from './stages/rename'
import { createSetAsideStage } from './stages/set-aside'
import type { Stage } from './stages/stage'

const NO_VOLUMES: ReadonlySet<string> = new Set()
/** What the stand-in sidecar writes: told apart from every source by its first bytes. */
const AIFF_OF = 'FORM....AIFF of '

let testDatabase: TestDatabase
let folder: string
let library: string
let clean: string
let backups: string
let mode: BatchMode
let fileOps: FileOps
let batchFiles: BatchFiles
let run: Orchestrator
let preview: Preview
/** The files the stand-in sidecar was asked to convert, and where it was to write. */
let calls: { src: string; dst: string }[]
/** What the stand-in does instead of converting, when a test says so. */
let sidecar: ((src: string, dst: string, signal: AbortSignal) => Promise<void>) | null

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

/** Stands in for the sidecar: writes a file that names its source, as an AIFF of 48 kHz and 24 bit. */
const python: Pick<PythonBridge, 'call'> = {
  call: (async (method: string, params: { src: string; dst: string }, options) => {
    if (method !== 'convert.wav_to_aiff') throw new Error(`unexpected call: ${method}`)
    calls.push({ src: params.src, dst: params.dst })
    const signal = options?.job?.signal ?? new AbortController().signal
    if (sidecar) await sidecar(params.src, params.dst, signal)
    else await writeFile(params.dst, AIFF_OF + readFileSync(params.src, 'utf8'))
    return {
      sampleRateHz: 48_000,
      bitDepth: 24,
      channels: 2,
      durationMs: 2000,
      converted: true,
      tagsLost: []
    }
  }) as PythonBridge['call']
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

/** Puts a file into the library and makes it a track; a 96 kHz WAV unless told otherwise. */
function addFile(
  relativePath: string,
  track: Partial<NewTrack> = {}
): { id: number; path: string } {
  const path = join(library, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `the samples of ${relativePath}`)
  const [id] = insertTracks(testDatabase.db, [
    {
      path,
      originalPath: path,
      format: relativePath.endsWith('.wav') ? ('wav' as const) : ('mp3' as const),
      sampleRateHz: 96_000,
      bitrateKbps: 4608,
      durationMs: 2000,
      ...track
    }
  ]) as [number]
  return { id, path }
}

function trackOf(id: number): NonNullable<ReturnType<typeof getTrackById>> {
  const track = getTrackById(testDatabase.db, id, NO_VOLUMES)
  if (!track) throw new Error(`no track ${id}`)
  return track
}

function errorOf(batchId: number, trackId: number): unknown {
  return getBatchItem(testDatabase.db, batchId, trackId)?.error
}

function warningsOf(batchId: number, trackId: number): string[] {
  return readProposal(getBatchItem(testDatabase.db, batchId, trackId)?.after).warnings ?? []
}

async function computed(ids: number[], stages: string[] = ['convert']): Promise<number> {
  // Asking for the conversion brings the stage that does it with it.
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
    batchFiles,
    onTrackApplied: (batchId, trackId) => commitApprovedValues(testDatabase.db, batchId, trackId)
  })
  preview = createPreview({
    db: testDatabase.db,
    stages,
    orchestrator: run,
    batchFiles,
    listMountedVolumes: () => NO_VOLUMES
  })
}

function folders(): Parameters<typeof createBatchFiles>[0]['folders'] {
  return () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups })
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-convert-')))
  library = join(folder, 'Music')
  clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  mode = 'in_place'
  calls = []
  sidecar = null
  fileOps = createFileOps({ allowedRoots: () => [library, clean, backups] })
  batchFiles = createBatchFiles({
    db: testDatabase.db,
    fileOps,
    folders: folders(),
    listMountedVolumes: () => NO_VOLUMES
  })
  build([createConvertStage(), createConvertFileStage({ python: () => python })])
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('a batch that converts WAV files', () => {
  it('shows the new name in its preview, and has changed no file', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const mp3 = addFile('Inbox/Bicep - Apricots.mp3')
    const before = filesUnder(folder)

    // Act
    const batchId = await computed([wav.id, mp3.id])
    const rows = preview.rows({ batchId, offset: 0, limit: 10 })

    // Assert
    expect(rows.ok && rows.value.rows.map((row) => row.cells.fileName)).toEqual([
      {
        before: 'Bicep - Glue.wav',
        after: 'Bicep - Glue.aiff',
        changed: true,
        source: 'conversion',
        confidence: null
      },
      expect.objectContaining({ after: 'Bicep - Apricots.mp3', changed: false })
    ])
    expect(calls).toEqual([])
    expect(filesUnder(folder)).toEqual(before)
  })

  it('in place puts the AIFF where the WAV was, keeps the WAV in the backup folder, and undo brings it back', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const original = sha256(wav.path)
    const batchId = await computed([wav.id])

    // Act
    await approved(batchId)
    const after = { files: filesUnder(folder), track: trackOf(wav.id) }
    const content = readFileSync(after.track.path, 'utf8')
    const backup = after.files.find((file) => file.startsWith('FixLibrary Backups/')) ?? ''
    const backupHash = sha256(join(folder, backup))
    const undone = await preview.undoLast()

    // Assert: one file in the library, an AIFF of what the WAV held.
    expect(after.files).toEqual([backup, 'Music/Inbox/Bicep - Glue.aiff'])
    expect(content).toBe(`${AIFF_OF}the samples of Inbox/Bicep - Glue.wav`)
    expect(backupHash).toBe(original)
    expect(after.track).toMatchObject({
      path: join(library, 'Inbox', 'Bicep - Glue.aiff'),
      format: 'aiff',
      sampleRateHz: 48_000,
      bitrateKbps: 2304,
      durationMs: 2000
    })
    // The sidecar read the WAV and wrote a temp file of the app, never a final name.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.src).toBe(wav.path)
    expect(basename(calls[0]?.dst ?? '')).toMatch(/^\.Bicep - Glue\.aiff\.[0-9a-f]{8}\.fixlib-tmp$/)
    // Undo: the WAV is back, byte for byte, the AIFF is gone, and the track says so.
    expect(undone.ok).toBe(true)
    expect(filesUnder(folder)).toEqual(['Music/Inbox/Bicep - Glue.wav'])
    expect(sha256(wav.path)).toBe(original)
    expect(trackOf(wav.id)).toMatchObject({ path: wav.path, format: 'wav', sampleRateHz: 96_000 })
  })

  it('in the clean library converts the copy, and leaves the original as it was', async () => {
    // Arrange
    mode = 'clean_library'
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const mp3 = addFile('Inbox/Bicep - Apricots.mp3')
    const hashes = [wav, mp3].map(({ path }) => sha256(path))
    const batchId = await computed([wav.id, mp3.id])

    // Act
    await approved(batchId)
    const converted = filesUnder(folder)
    const undone = await preview.undoLast()

    // Assert
    expect(converted).toEqual([
      'Clean/Inbox/Bicep - Apricots.mp3',
      'Clean/Inbox/Bicep - Glue.aiff',
      'Music/Inbox/Bicep - Apricots.mp3',
      'Music/Inbox/Bicep - Glue.wav'
    ])
    expect([wav, mp3].map(({ path }) => sha256(path))).toEqual(hashes)
    expect(undone.ok).toBe(true)
    expect(filesUnder(folder)).toEqual([
      'Music/Inbox/Bicep - Apricots.mp3',
      'Music/Inbox/Bicep - Glue.wav'
    ])
    expect(trackOf(wav.id)).toMatchObject({ path: wav.path, format: 'wav' })
  })

  it('does nothing to a track that is no WAV: no backup, and the batch wrote nothing', async () => {
    // Arrange
    const mp3 = addFile('Inbox/Bicep - Apricots.mp3')
    const aiff = addFile('Inbox/Bicep - Atlas.aiff', { format: 'aiff' })
    const before = filesUnder(folder)
    const batchId = await computed([mp3.id, aiff.id])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(folder)).toEqual(before)
    expect(calls).toEqual([])
    expect(batchFiles.lastUndoable()).toBeNull()
  })

  it('leaves the WAV as it was when the conversion fails, with nothing half done beside it', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const original = sha256(wav.path)
    const batchId = await computed([wav.id])
    sidecar = async (_src, dst) => {
      await writeFile(dst, 'half an AIFF')
      throw new AppError('PYTHON_ERROR', 'the result does not match its source')
    }

    // Act
    await approved(batchId)

    // Assert
    expect(errorOf(batchId, wav.id)).toMatchObject({ stage: 'convertFile', code: 'PYTHON_ERROR' })
    expect(filesUnder(library)).toEqual(['Music/Inbox/Bicep - Glue.wav'])
    expect(sha256(wav.path)).toBe(original)
    expect(trackOf(wav.id)).toMatchObject({ path: wav.path, format: 'wav', sampleRateHz: 96_000 })
  })

  it('never writes over a file: an AIFF of that name stays, and the new one gets a number', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const taken = join(library, 'Inbox', 'Bicep - Glue.aiff')
    writeFileSync(taken, 'there before')
    const batchId = await computed([wav.id])

    // Act
    await approved(batchId)

    // Assert
    expect(readFileSync(taken, 'utf8')).toBe('there before')
    expect(trackOf(wav.id).path).toBe(join(library, 'Inbox', 'Bicep - Glue (2).aiff'))
    expect(filesUnder(library)).toEqual([
      'Music/Inbox/Bicep - Glue (2).aiff',
      'Music/Inbox/Bicep - Glue.aiff'
    ])
    expect(warningsOf(batchId, wav.id)).toContain('NAME_COLLISION')
  })

  it('makes no backup for a WAV whose name cannot be given anew', async () => {
    // Arrange: a colon in a name is what a slash typed in Finder becomes.
    const odd = addFile('Inbox/Bicep - Glue 1:2.wav')
    const batchId = await computed([odd.id])
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert
    expect(errorOf(batchId, odd.id)).toMatchObject({ stage: 'convertFile', code: 'INVALID_INPUT' })
    expect(filesUnder(folder)).toEqual(['Music/Inbox/Bicep - Glue 1:2.wav'])
    expect(calls).toEqual([])
    expect(batchFiles.lastUndoable()).toBeNull()
  })

  it('leaves no AIFF and no temp file when the batch is cancelled while the sidecar works', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const original = sha256(wav.path)
    const batchId = await computed([wav.id])
    let working: () => void = () => {}
    const started = new Promise<void>((resolve) => (working = resolve))
    sidecar = (_src, dst, signal) =>
      new Promise((_resolve, reject) => {
        void writeFile(dst, 'half an AIFF').then(working)
        signal.addEventListener('abort', () => reject(new AppError('UNEXPECTED', 'stopped')))
      })

    // Act
    const approval = await preview.approve(batchId)
    await started
    run.cancel()
    await batchFiles.settled()

    // Assert: the WAV is in the library as it was; the backup that was made stays.
    expect(approval.ok).toBe(true)
    expect(filesUnder(library)).toEqual(['Music/Inbox/Bicep - Glue.wav'])
    expect(sha256(wav.path)).toBe(original)
    expect(trackOf(wav.id)).toMatchObject({ path: wav.path, format: 'wav' })
  })
})

describe('the WAV that a conversion removes', () => {
  it('stays when it is not what its backup holds any more', async () => {
    // Arrange: backed up by a first attempt, then changed by another program.
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    const signal = new AbortController().signal
    await batchFiles.forTrack({ id: batchId, mode }, wav.id, signal).workingPath()
    writeFileSync(wav.path, 'edited since the backup was made')
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: nothing was converted, and the change is still there.
    expect(errorOf(batchId, wav.id)).toMatchObject({ stage: 'convertFile', code: 'WRITE_FAILED' })
    expect(readFileSync(wav.path, 'utf8')).toBe('edited since the backup was made')
    expect(filesUnder(library)).toEqual(['Music/Inbox/Bicep - Glue.wav'])
    expect(calls).toEqual([])
  })

  it('stays when it was changed while it was being converted, and the AIFF is not put in place', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    sidecar = async (src, dst) => {
      await writeFile(dst, AIFF_OF + readFileSync(src, 'utf8'))
      writeFileSync(src, 'changed while the sidecar worked')
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: an AIFF of the old content would have taken the place of the new one.
    expect(errorOf(batchId, wav.id)).toMatchObject({ stage: 'convertFile', code: 'WRITE_FAILED' })
    expect(readFileSync(wav.path, 'utf8')).toBe('changed while the sidecar worked')
    expect(filesUnder(library)).toEqual(['Music/Inbox/Bicep - Glue.wav'])
    expect(trackOf(wav.id)).toMatchObject({ path: wav.path, format: 'wav' })
  })

  it('in the clean library stays when the original it was copied from is gone', async () => {
    // Arrange: the copy is made, and then the original is deleted by hand.
    mode = 'clean_library'
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    const signal = new AbortController().signal
    await batchFiles.forTrack({ id: batchId, mode }, wav.id, signal).ensureCleanCopy()
    rmSync(wav.path)
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: the copy is the last WAV there is, and it is not removed.
    expect(errorOf(batchId, wav.id)).toMatchObject({ stage: 'convertFile', code: 'WRITE_FAILED' })
    expect(filesUnder(folder)).toEqual(['Clean/Inbox/Bicep - Glue.wav'])
    expect(calls).toEqual([])
  })

  it('stays beside the AIFF when it was changed in the moment before it was to go', async () => {
    // Arrange: file rules that let another program in while the new file gets its name.
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    const late = createBatchFiles({
      db: testDatabase.db,
      fileOps: {
        ...fileOps,
        create: async (target, write, signal, naming) => {
          await fileOps.create(target, write, signal, naming)
          writeFileSync(wav.path, 'changed after it was read and before it was removed')
        }
      },
      folders: folders(),
      listMountedVolumes: () => NO_VOLUMES
    })

    // Act
    const converted = await late
      .forTrack({ id: batchId, mode }, wav.id, new AbortController().signal)
      .convertTo({ extension: '.aiff', format: 'aiff' }, async (source, temp) => {
        await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
      })

    // Assert: both files, and the change is not lost.
    expect(converted.path).toBe(join(library, 'Inbox', 'Bicep - Glue.aiff'))
    expect(readFileSync(wav.path, 'utf8')).toBe(
      'changed after it was read and before it was removed'
    )
    expect(filesUnder(library)).toEqual([
      'Music/Inbox/Bicep - Glue.aiff',
      'Music/Inbox/Bicep - Glue.wav'
    ])
  })

  it('leaves the track knowing the size of the AIFF, which a later step finds the file by', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav', { fileSizeBytes: 31 })
    const batchId = await computed([wav.id])

    // Act
    await approved(batchId)

    // Assert
    const track = trackOf(wav.id)
    expect(track.fileSizeBytes).toBe(statSync(track.path).size)
    expect(track.fileSizeBytes).not.toBe(31)
  })
})

describe('the name a conversion is writing its file for', () => {
  it('is not given to another track meanwhile, and undo takes back both', async () => {
    // Arrange: a WAV that takes long to convert, and an AIFF that is to get its name.
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const other = addFile('Inbox/download.aiff', { format: 'aiff' })
    const before = filesUnder(library)
    const hashes = [wav, other].map(({ path }) => sha256(path))
    const batchId = await computed([wav.id, other.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let writing: () => void = () => {}
    const started = new Promise<void>((resolve) => (writing = resolve))
    const wanted = join(library, 'Inbox', 'Bicep - Glue.aiff')

    // Act
    const converting = batchFiles
      .forTrack(batch, wav.id, signal)
      .convertTo({ extension: '.aiff', format: 'aiff' }, async (source, temp) => {
        writing()
        await gate
        await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
      })
    await started
    const moved = await batchFiles.forTrack(batch, other.id, signal).move(wanted)
    release()
    const converted = await converting
    const undone = await batchFiles.undoLast()

    // Assert: the conversion got the name it had taken; the other file a number.
    expect(converted).toEqual({ path: wanted, collided: false })
    expect(moved).toEqual({ path: join(library, 'Inbox', 'Bicep - Glue (2).aiff'), collided: true })
    expect(undone.ok).toBe(true)
    expect(filesUnder(library)).toEqual(before)
    expect([wav, other].map(({ path }) => sha256(path))).toEqual(hashes)
  })

  it('is not given to the copy another track gets in the clean library either', async () => {
    // Arrange: a WAV and an AIFF of one name in one folder, which is common.
    mode = 'clean_library'
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const aiff = addFile('Inbox/Bicep - Glue.aiff', { format: 'aiff' })
    const before = filesUnder(folder)
    const batchId = await computed([wav.id, aiff.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let writing: () => void = () => {}
    const started = new Promise<void>((resolve) => (writing = resolve))

    // Act
    const converting = batchFiles
      .forTrack(batch, wav.id, signal)
      .convertTo({ extension: '.aiff', format: 'aiff' }, async (source, temp) => {
        writing()
        await gate
        await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
      })
    await started
    const copy = await batchFiles.forTrack(batch, aiff.id, signal).ensureCleanCopy()
    release()
    const converted = await converting
    const undone = await batchFiles.undoLast()

    // Assert: the conversion kept its name, the copy took a number, undo removes both.
    expect(converted).toEqual({ path: join(clean, 'Inbox', 'Bicep - Glue.aiff'), collided: false })
    expect(copy).toEqual({ collided: true })
    expect(undone.ok).toBe(true)
    expect(filesUnder(folder)).toEqual(before)
  })

  it('is free again when the conversion fails, and the note of another track about it stays', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const other = addFile('Inbox/download.aiff', { format: 'aiff' })
    const before = filesUnder(library)
    const batchId = await computed([wav.id, other.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    const wanted = join(library, 'Inbox', 'Bicep - Glue.aiff')

    // Act
    const failed = batchFiles
      .forTrack(batch, wav.id, signal)
      .convertTo({ extension: '.aiff', format: 'aiff' }, async () => {
        throw new AppError('PYTHON_ERROR', 'the result does not match its source')
      })
    await expect(failed).rejects.toMatchObject({ code: 'PYTHON_ERROR' })
    const moved = await batchFiles.forTrack(batch, other.id, signal).move(wanted)
    const undone = await batchFiles.undoLast()

    // Assert: the other track has the name now, and undo knows the file as its own.
    expect(moved).toEqual({ path: wanted, collided: false })
    expect(undone.ok).toBe(true)
    expect(filesUnder(library)).toEqual(before)
  })
})

describe('a conversion that was stopped between its two last steps', () => {
  /** File rules whose first removal of a file fails, as when the app is ended there. */
  function stopsBeforeRemoving(): BatchFiles {
    let failed = false
    return createBatchFiles({
      db: testDatabase.db,
      fileOps: {
        ...fileOps,
        remove: async (path) => {
          if (!failed && path.endsWith('.wav')) {
            failed = true
            throw new Error('the app was ended here')
          }
          return fileOps.remove(path)
        }
      },
      folders: folders(),
      listMountedVolumes: () => NO_VOLUMES
    })
  }

  it.each<BatchMode>(['in_place', 'clean_library'])(
    'is finished by the next attempt without converting again (%s)',
    async (batchMode) => {
      // Arrange: the AIFF is in place and the track points at it; the old WAV is still there.
      mode = batchMode
      const wav = addFile('Inbox/Bicep - Glue.wav')
      const original = sha256(wav.path)
      const batchId = await computed([wav.id])
      const batch = { id: batchId, mode }
      const signal = new AbortController().signal
      const write = async (source: string, temp: string): Promise<void> => {
        calls.push({ src: source, dst: temp })
        await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
      }
      const first = stopsBeforeRemoving()
        .forTrack(batch, wav.id, signal)
        .convertTo({ extension: '.aiff', format: 'aiff' }, write)
      await expect(first).rejects.toThrow('the app was ended here')
      const root = mode === 'in_place' ? 'Music' : 'Clean'
      const between = filesUnder(join(folder, root))

      // Act
      const again = await batchFiles
        .forTrack(batch, wav.id, signal)
        .convertTo({ extension: '.aiff', format: 'aiff' }, write)
      const undone = await batchFiles.undoLast()

      // Assert: two files in between, each what its name says; then only the AIFF.
      expect(between).toEqual([`${root}/Inbox/Bicep - Glue.aiff`, `${root}/Inbox/Bicep - Glue.wav`])
      expect(again).toEqual({
        path: join(folder, root, 'Inbox', 'Bicep - Glue.aiff'),
        collided: false
      })
      expect(calls).toHaveLength(1)
      expect(undone.ok).toBe(true)
      expect(filesUnder(folder)).toEqual(['Music/Inbox/Bicep - Glue.wav'])
      expect(sha256(wav.path)).toBe(original)
    }
  )

  it('in the clean library does not remove another file that was saved under the name of the old copy', async () => {
    // Arrange: stopped as above; then the copy of the WAV is written over by hand.
    mode = 'clean_library'
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    const write = async (source: string, temp: string): Promise<void> => {
      await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
    }
    const target = { extension: '.aiff', format: 'aiff' } as const
    await expect(
      stopsBeforeRemoving().forTrack(batch, wav.id, signal).convertTo(target, write)
    ).rejects.toThrow()
    const copy = join(clean, 'Inbox', 'Bicep - Glue.wav')
    writeFileSync(copy, 'another recording, saved under the name of the copy')

    // Act
    await batchFiles.forTrack(batch, wav.id, signal).convertTo(target, write)

    // Assert
    expect(readFileSync(copy, 'utf8')).toBe('another recording, saved under the name of the copy')
  })

  it('in the clean library keeps the old copy when the original it was made of is gone', async () => {
    // Arrange: stopped as above; then the original is deleted from the library.
    mode = 'clean_library'
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    const write = async (source: string, temp: string): Promise<void> => {
      await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
    }
    const target = { extension: '.aiff', format: 'aiff' } as const
    await expect(
      stopsBeforeRemoving().forTrack(batch, wav.id, signal).convertTo(target, write)
    ).rejects.toThrow()
    rmSync(wav.path)

    // Act
    await batchFiles.forTrack(batch, wav.id, signal).convertTo(target, write)

    // Assert: the copy is the last WAV there is.
    expect(filesUnder(folder)).toEqual([
      'Clean/Inbox/Bicep - Glue.aiff',
      'Clean/Inbox/Bicep - Glue.wav'
    ])
  })

  it('finds the old file also when the new one had to take a number', async () => {
    // Arrange: an AIFF of the plain name is there, so the conversion makes `(2)`.
    const wav = addFile('Inbox/Bicep - Glue.wav')
    writeFileSync(join(library, 'Inbox', 'Bicep - Glue.aiff'), 'there before')
    const batchId = await computed([wav.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    const write = async (source: string, temp: string): Promise<void> => {
      await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
    }
    const target = { extension: '.aiff', format: 'aiff' } as const
    await expect(
      stopsBeforeRemoving().forTrack(batch, wav.id, signal).convertTo(target, write)
    ).rejects.toThrow()

    // Act
    await batchFiles.forTrack(batch, wav.id, signal).convertTo(target, write)

    // Assert: the WAV that was left is gone, and nothing else is.
    expect(filesUnder(library)).toEqual([
      'Music/Inbox/Bicep - Glue (2).aiff',
      'Music/Inbox/Bicep - Glue.aiff'
    ])
  })

  it('does not remove a file at the old place that is not the old file', async () => {
    // Arrange: as above, but before the next attempt another file is saved under the old name.
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id])
    const batch = { id: batchId, mode }
    const signal = new AbortController().signal
    const write = async (source: string, temp: string): Promise<void> => {
      await writeFile(temp, AIFF_OF + readFileSync(source, 'utf8'))
    }
    const target = { extension: '.aiff', format: 'aiff' } as const
    await expect(
      stopsBeforeRemoving().forTrack(batch, wav.id, signal).convertTo(target, write)
    ).rejects.toThrow()
    writeFileSync(wav.path, 'another recording, saved under the old name')

    // Act
    await batchFiles.forTrack(batch, wav.id, signal).convertTo(target, write)

    // Assert
    expect(readFileSync(wav.path, 'utf8')).toBe('another recording, saved under the old name')
  })
})

describe('a batch that converts, names and looks for duplicates at once', () => {
  beforeEach(() => {
    build([
      standIn('lookup'),
      standIn('bpmKey', {
        bpm: { value: 124, source: 'analysis' },
        key: { value: '8A', source: 'analysis' }
      }),
      createConvertStage(),
      createNamingStage(),
      createDuplicatesStage({ db: testDatabase.db }),
      createConvertFileStage({ python: () => python }),
      createRenameStage(),
      createSetAsideStage()
    ])
  })

  it('proposes a name that ends as the file will, and gives it to the AIFF', async () => {
    // Arrange
    const wav = addFile('Inbox/01. Bicep_-_Glue (Official Video).wav')
    const mp3 = addFile('Inbox/Bicep - Apricots.mp3')
    const batchId = await computed([wav.id, mp3.id], ['convert', 'naming'])
    const rows = preview.rows({ batchId, offset: 0, limit: 10 })

    // Act
    await approved(batchId)

    // Assert
    expect(rows.ok && rows.value.rows.map((row) => row.cells.fileName.after)).toEqual([
      'Bicep - Glue [8A Am - 124].aiff',
      'Bicep - Apricots [8A Am - 124].mp3'
    ])
    expect([errorOf(batchId, wav.id), errorOf(batchId, mp3.id)]).toEqual([null, null])
    expect(filesUnder(library)).toEqual([
      'Music/Inbox/Bicep - Apricots [8A Am - 124].mp3',
      'Music/Inbox/Bicep - Glue [8A Am - 124].aiff'
    ])
    expect(trackOf(wav.id).format).toBe('aiff')
  })

  it('keeps the extension of the conversion when a name is edited in the preview', async () => {
    // Arrange
    const wav = addFile('Inbox/Bicep - Glue.wav')
    const batchId = await computed([wav.id], ['convert', 'naming'])

    // Act
    const edited = preview.edit({ batchId, trackId: wav.id, field: 'title', value: 'Apricots' })

    // Assert
    expect(edited.ok && edited.value.cells.fileName.after).toBe(
      'Bicep - Apricots [8A Am - 124].aiff'
    )
  })

  it('converts a copy that is not kept before it is set aside, so _Duplicates holds an AIFF', async () => {
    // Arrange: two copies of one track; the longer one stays.
    const shorter = addFile('Inbox/Bicep - Glue.wav', { artist: 'Bicep', title: 'Glue' })
    const longer = addFile('Old/Bicep - Glue.wav', {
      artist: 'Bicep',
      title: 'Glue',
      durationMs: 2500
    })
    const batchId = await computed([shorter.id, longer.id], ['convert', 'duplicates'])

    // Act
    await approved(batchId)

    // Assert
    expect([errorOf(batchId, shorter.id), errorOf(batchId, longer.id)]).toEqual([null, null])
    expect(filesUnder(library)).toEqual([
      'Music/Old/Bicep - Glue.aiff',
      'Music/_Duplicates/Bicep - Glue.aiff'
    ])
  })
})
