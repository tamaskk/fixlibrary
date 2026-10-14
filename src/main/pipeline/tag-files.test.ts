// Tag writing from the run to the files on disk: the real naming, tag and rename
// stages, the orchestrator, the preview and the file rules together, with a stand-in
// for the sidecar and files in a temp folder.
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
  symlinkSync,
  writeFileSync
} from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBatchItem, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { getTrackById, insertTracks, type NewTrack, type Track } from '../db/tracks'
import { createFileOps, type FileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import type { PythonBridge } from '../services/python-bridge'
import { AppError } from '@shared/errors'
import type { ProposedFields } from '@shared/preview'
import type { TagFields } from '@shared/rpc'
import { createBatchFiles, type BatchFiles } from './batch-files'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { commitApprovedValues, createPreview, type Preview } from './preview'
import { createEmbedCoverStage } from './stages/cover'
import { createNamingStage } from './stages/naming'
import { createRenameStage } from './stages/rename'
import type { Stage } from './stages/stage'
import { createWriteTagsStage, tagsFor } from './stages/write-tags'

const NO_VOLUMES: ReadonlySet<string> = new Set()
/** What the stand-in sidecar puts at the end of a file: the tags it "wrote". */
const TAGS = '\nTAGS '

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
/** The calls the stand-in sidecar got, with what they came with. */
let calls: { method: string; path: string; hasSignal: boolean }[]
/** What the stand-in does instead of writing, when a test says so. */
let failing: ((dst: string, signal: AbortSignal) => Promise<void>) | null
/** What the lookup stand-in proposes for every track. */
let found: ProposedFields
/** What the cover stand-in proposes for every track. */
let coverFound: ProposedFields

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

/** The tags the stand-in sidecar wrote into a file, or null for a file it never wrote. */
function tagsIn(path: string): TagFields | null {
  const content = readFileSync(path, 'utf8')
  const at = content.lastIndexOf(TAGS)
  return at === -1 ? null : (JSON.parse(content.slice(at + TAGS.length)) as TagFields)
}

/** Stands in for the sidecar: a file "has" the tags that were appended to it last. */
const python: Pick<PythonBridge, 'call'> = {
  call: (async (
    method: string,
    params: { path?: string; src?: string; dst?: string; fields: TagFields },
    options
  ) => {
    const path = params.path ?? params.src ?? ''
    calls.push({ method, path, hasSignal: options?.job?.signal !== undefined })
    if (method === 'tags.would_change') {
      const held = tagsIn(path) ?? {}
      const changed = Object.entries(params.fields).some(
        ([name, value]) => held[name as keyof TagFields] !== value
      )
      return { changed }
    }
    if (method !== 'tags.write' || !params.dst) throw new Error(`unexpected call: ${method}`)
    const signal = options?.job?.signal ?? new AbortController().signal
    if (failing) await failing(params.dst, signal)
    const audio = readFileSync(path, 'utf8').split(TAGS)[0]
    const fields = { ...tagsIn(path), ...params.fields }
    await writeFile(params.dst, `${audio}${TAGS}${JSON.stringify(fields)}`)
    return { written: true }
  }) as PythonBridge['call']
}

function standIn(name: string, fields: () => ProposedFields): Stage {
  return {
    name,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: 10_000,
    run: async () => ({ proposal: { fields: fields() } })
  }
}

function addFile(
  relativePath: string,
  track: Partial<NewTrack> = {}
): { id: number; path: string } {
  const path = join(library, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `the audio of ${relativePath}`)
  const [id] = insertTracks(testDatabase.db, [
    {
      path,
      originalPath: path,
      format: relativePath.endsWith('.wav') ? ('wav' as const) : ('mp3' as const),
      ...track
    }
  ]) as [number]
  return { id, path }
}

function trackOf(id: number): Track {
  const track = getTrackById(testDatabase.db, id, NO_VOLUMES)
  if (!track) throw new Error(`no track ${id}`)
  return track
}

function errorOf(batchId: number, trackId: number): unknown {
  return getBatchItem(testDatabase.db, batchId, trackId)?.error
}

async function computed(ids: number[], stages: string[] = ['naming']): Promise<number> {
  // Asking for the naming brings the lookup, the analysis and the stages that write.
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

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-tags-')))
  library = join(folder, 'Music')
  clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  mode = 'in_place'
  calls = []
  failing = null
  found = {
    artist: { value: 'Ákos', source: 'musicbrainz', confidence: 0.9 },
    title: { value: 'Ilyenek voltunk', source: 'musicbrainz', confidence: 0.9 },
    mix: { value: 'Extended Mix', source: 'musicbrainz', confidence: 0.9 },
    album: { value: 'Új törvény', source: 'musicbrainz', confidence: 0.9 },
    year: { value: 1997, source: 'musicbrainz', confidence: 0.9 }
  }
  coverFound = { cover: { value: COVER, source: 'itunes' } }
  fileOps = createFileOps({ allowedRoots: () => [library, clean, backups] })
  batchFiles = createBatchFiles({
    db: testDatabase.db,
    fileOps,
    folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
    listMountedVolumes: () => NO_VOLUMES
  })
  const stages = [
    standIn('lookup', () => found),
    standIn('bpmKey', () => ({
      bpm: { value: 124, source: 'analysis' },
      key: { value: '11A', source: 'analysis' }
    })),
    standIn('cover', () => coverFound),
    createNamingStage(),
    createWriteTagsStage({ python: () => python }),
    createEmbedCoverStage({ db: testDatabase.db, python: () => python }),
    createRenameStage()
  ]
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
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const NAMED = 'Ákos - Ilyenek voltunk (Extended Mix) [11A F#m - 124].mp3'
const COVER = '0123456789abcdef0123456789abcdef01234567.jpg'

describe('a batch that names files and writes their tags', () => {
  it('writes the tags, gives the file its name, and undo brings back the file as it was', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    const untouched = filesUnder(folder)

    // Act
    await approved(batchId)
    const written = join(library, 'Inbox', NAMED)
    const tags = tagsIn(written)
    const row = trackOf(track.id)
    const files = filesUnder(folder)
    const undone = await preview.undoLast()

    // Assert: nothing changed before the approval.
    expect(untouched).toEqual(['Music/Inbox/download.mp3'])
    // The title carries the mix, the key is the musical one, the tempo a whole number.
    expect(tags).toEqual({
      artist: 'Ákos',
      title: 'Ilyenek voltunk (Extended Mix)',
      album: 'Új törvény',
      year: 1997,
      bpm: 124,
      key: 'F#m'
    })
    expect(files.filter((file) => file.startsWith('Music/'))).toEqual([`Music/Inbox/${NAMED}`])
    expect(files.filter((file) => file.startsWith('FixLibrary Backups/'))).toHaveLength(1)
    // What was written into the file is the track's own now.
    expect(row).toMatchObject({
      path: written,
      artist: 'Ákos',
      title: 'Ilyenek voltunk',
      mix: 'Extended Mix',
      album: 'Új törvény',
      year: 1997,
      bpm: 124,
      camelotKey: '11A'
    })
    // The call that writes can be stopped; the question before it reads only.
    expect(calls.map((call) => [call.method, call.hasSignal])).toEqual([
      ['tags.would_change', false],
      ['tags.write', true]
    ])
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 1, left: 0 } })
    expect(filesUnder(folder)).toEqual(['Music/Inbox/download.mp3'])
    expect(sha256(track.path)).toBe(original)
    expect(trackOf(track.id)).toMatchObject({ path: track.path, artist: null, title: null })
  })

  it('touches no file that says all of it already: no backup, and the batch wrote nothing', async () => {
    // Arrange: a first batch writes and names the file; a second one finds nothing to do.
    const track = addFile('Inbox/download.mp3')
    const first = await computed([track.id])
    await approved(first)
    const before = filesUnder(folder)
    const hash = sha256(trackOf(track.id).path)
    calls = []
    const second = await computed([track.id])

    // Act
    await approved(second)

    // Assert
    expect(filesUnder(folder)).toEqual(before)
    expect(sha256(trackOf(track.id).path)).toBe(hash)
    expect(calls.map((call) => call.method)).toEqual(['tags.would_change'])
    // The batch before it is still the one that undo undoes.
    expect(batchFiles.lastUndoable()).toBe(first)
  })

  it('in the clean library writes into the copy, and leaves the original as it was', async () => {
    // Arrange
    mode = 'clean_library'
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id])

    // Act
    await approved(batchId)

    // Assert
    expect(sha256(track.path)).toBe(original)
    expect(filesUnder(folder)).toEqual([`Clean/Inbox/${NAMED}`, 'Music/Inbox/download.mp3'])
    expect(tagsIn(join(clean, 'Inbox', NAMED))?.title).toBe('Ilyenek voltunk (Extended Mix)')
  })

  it('leaves a WAV without tags, names it all the same, and does not say its row has them', async () => {
    // Arrange
    const wav = addFile('Inbox/download.wav')
    const batchId = await computed([wav.id])

    // Act
    await approved(batchId)

    // Assert
    const named = join(library, 'Inbox', NAMED.replace('.mp3', '.wav'))
    expect(errorOf(batchId, wav.id)).toBeNull()
    expect(trackOf(wav.id).path).toBe(named)
    expect(tagsIn(named)).toBeNull()
    expect(calls).toEqual([])
    // A row never says more than its file: the names stay with the batch.
    expect(trackOf(wav.id)).toMatchObject({ artist: null, title: null, bpm: 124 })
  })

  it('leaves the track knowing the size of the file as it is with its tags', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3', { fileSizeBytes: 26 })
    const batchId = await computed([track.id])

    // Act
    await approved(batchId)

    // Assert: a step that is interrupted later finds the file by this size.
    const row = trackOf(track.id)
    expect(row.fileSizeBytes).toBe(statSync(row.path).size)
    expect(row.fileSizeBytes).not.toBe(26)
  })

  it('does not say of a row what could not be written into its file', async () => {
    // Arrange: a title and a mix that are each a line a tag can hold, and together are not.
    found = {
      artist: { value: 'Bicep', source: 'musicbrainz', confidence: 0.9 },
      title: { value: 'T'.repeat(290), source: 'musicbrainz', confidence: 0.9 },
      mix: { value: 'Extended Mix', source: 'musicbrainz', confidence: 0.9 }
    }
    const track = addFile('Inbox/download.mp3')
    const batchId = await computed([track.id])

    // Act
    await approved(batchId)

    // Assert
    const row = trackOf(track.id)
    expect(tagsIn(row.path)).toEqual({ artist: 'Bicep', bpm: 124, key: 'F#m' })
    expect(row).toMatchObject({ artist: 'Bicep', title: null, mix: null })
  })

  it('writes what the user typed in the preview, not what was proposed', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const batchId = await computed([track.id])
    preview.edit({ batchId, trackId: track.id, field: 'title', value: 'Ilyenek vagyunk' })

    // Act
    await approved(batchId)

    // Assert
    expect(tagsIn(trackOf(track.id).path)?.title).toBe('Ilyenek vagyunk (Extended Mix)')
    expect(trackOf(track.id)).toMatchObject({ title: 'Ilyenek vagyunk', lockedFields: ['title'] })
  })
})

describe('a tag write that fails', () => {
  it('leaves the file as it was and takes its backup back, so the batch before it can still be undone', async () => {
    // Arrange: a batch that wrote, and then one whose only write fails.
    const earlier = addFile('Inbox/earlier.mp3')
    const first = await computed([earlier.id])
    await approved(first)
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const second = await computed([track.id])
    failing = async (dst) => {
      await writeFile(dst, 'half a file')
      throw new AppError('PYTHON_ERROR', 'the tags that were written do not read back')
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(second)

    // Assert: unchanged, not renamed either, and nothing kept for it.
    expect(errorOf(second, track.id)).toMatchObject({ stage: 'writeTags', code: 'PYTHON_ERROR' })
    expect(sha256(track.path)).toBe(original)
    expect(filesUnder(library)).toContain('Music/Inbox/download.mp3')
    expect(filesUnder(backups).filter((file) => file.includes(`/${second}/`))).toEqual([])
    expect(batchFiles.lastUndoable()).toBe(first)
    const undone = await preview.undoLast()
    expect(undone).toMatchObject({ ok: true, value: { restored: 1 } })
    expect(filesUnder(library)).toEqual(['Music/Inbox/download.mp3', 'Music/Inbox/earlier.mp3'])
  })

  it('writes down nothing about a write that did not get into place, so undo still knows the copy as its own', async () => {
    // Arrange: in the clean library the copy is written down before the tags are
    // written; then the tag write fails after the sidecar wrote its temp file.
    mode = 'clean_library'
    const track = addFile('Inbox/download.mp3')
    const batchId = await computed([track.id])
    failing = async (dst) => {
      await writeFile(dst, 'a file with tags that never got into place')
      throw new AppError('PYTHON_ERROR', 'failed')
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    await approved(batchId)

    // Act
    const undone = await preview.undoLast()

    // Assert: the copy is removed, not left as a file somebody else had changed.
    expect(undone).toEqual({ ok: true, value: { restored: 0, removed: 1, left: 0 } })
    expect(filesUnder(folder)).toEqual(['Music/Inbox/download.mp3'])
  })

  it('keeps the backup when the file is not what the backup holds any more', async () => {
    // Arrange: the write fails, and another program has changed the file meanwhile.
    const track = addFile('Inbox/download.mp3')
    const batchId = await computed([track.id])
    failing = async () => {
      writeFileSync(track.path, 'changed by another program')
      throw new AppError('PYTHON_ERROR', 'failed')
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: in every doubt the backup stays.
    expect(filesUnder(backups)).toHaveLength(1)
    expect(batchFiles.lastUndoable()).toBe(batchId)
  })

  it('puts nothing in the place of a file that another program changed while the tags were written', async () => {
    // Arrange: the sidecar writes its copy, and meanwhile the file itself changes.
    const track = addFile(`Inbox/${NAMED}`)
    const batchId = await computed([track.id])
    failing = async () => {
      writeFileSync(track.path, 'changed by another program')
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    // Act
    await approved(batchId)

    // Assert: the change is not written over, no temp file stays, the backup does.
    expect(errorOf(batchId, track.id)).toMatchObject({ stage: 'writeTags', code: 'WRITE_FAILED' })
    expect(readFileSync(track.path, 'utf8')).toBe('changed by another program')
    expect(filesUnder(library)).toEqual([`Music/Inbox/${NAMED}`])
    expect(filesUnder(backups)).toHaveLength(1)
  })

  it('leaves the file as it was when the batch is cancelled while the sidecar writes', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    let writing: () => void = () => {}
    const started = new Promise<void>((resolve) => (writing = resolve))
    failing = (dst, signal) =>
      new Promise((_resolve, reject) => {
        void writeFile(dst, 'half a file').then(writing)
        signal.addEventListener('abort', () => reject(new AppError('UNEXPECTED', 'stopped')))
      })

    // Act
    await preview.approve(batchId)
    await started
    run.cancel()
    await batchFiles.settled()

    // Assert
    expect(filesUnder(library)).toEqual(['Music/Inbox/download.mp3'])
    expect(sha256(track.path)).toBe(original)
    expect(filesUnder(backups)).toEqual([])
  })
})

describe('undo after a batch that wrote tags', () => {
  it('does not write the backup over a file that was changed since, where the batch kept its name', async () => {
    // Arrange: the file has its name already, so the batch only writes its tags.
    // Afterwards another program writes into it, as DJ software does.
    const track = addFile(`Inbox/${NAMED}`)
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    await approved(batchId)
    writeFileSync(track.path, 'the tagged file, with cue points another program wrote since')

    // Act
    const undone = await preview.undoLast()

    // Assert: what the file holds now is not lost; the original stands beside it.
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 0, left: 1 } })
    expect(readFileSync(track.path, 'utf8')).toBe(
      'the tagged file, with cue points another program wrote since'
    )
    const restored = join(library, 'Inbox', NAMED.replace('.mp3', ' (2).mp3'))
    expect(sha256(restored)).toBe(original)
    expect(trackOf(track.id).path).toBe(restored)
  })

  it('does not write the backup over a file that was changed since, although the batch wrote nothing down about it', async () => {
    // Arrange: the tag write failed while another program changed the file, so the
    // backup stayed and the batch has no note of the file. Then the file is edited on.
    const track = addFile(`Inbox/${NAMED}`)
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    failing = async () => {
      writeFileSync(track.path, 'changed by another program')
      throw new AppError('PYTHON_ERROR', 'failed')
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    await approved(batchId)
    writeFileSync(track.path, 'changed by another program, and worked on since')

    // Act
    const undone = await preview.undoLast()

    // Assert: the only copy of that work is not lost, and undo says a file stayed.
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 0, left: 1 } })
    expect(readFileSync(track.path, 'utf8')).toBe('changed by another program, and worked on since')
    expect(sha256(join(library, 'Inbox', NAMED.replace('.mp3', ' (2).mp3')))).toBe(original)
  })

  it('undoes the batch although a link stands where a file of it was', async () => {
    // Arrange: after the rename, a link that leads out of the library takes the old name.
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    await approved(batchId)
    const outside = join(folder, 'elsewhere.txt')
    writeFileSync(outside, 'not a file of the library')
    symlinkSync(outside, track.path)

    // Act
    const undone = await preview.undoLast()

    // Assert: the link is a name that is taken; nothing is written through it.
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 1, left: 0 } })
    expect(readFileSync(outside, 'utf8')).toBe('not a file of the library')
    expect(sha256(join(library, 'Inbox', 'download (2).mp3'))).toBe(original)
  })

  it('puts the backup back over the file the batch tagged, where nobody changed it since', async () => {
    // Arrange
    const track = addFile(`Inbox/${NAMED}`)
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    await approved(batchId)

    // Act
    const undone = await preview.undoLast()

    // Assert
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 0, left: 0 } })
    expect(sha256(track.path)).toBe(original)
    expect(filesUnder(library)).toEqual([`Music/Inbox/${NAMED}`])
  })

  it('leaves a file that is not what the batch wrote, and says so', async () => {
    // Arrange: after the batch, another file is saved under the name it gave.
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    await approved(batchId)
    const written = join(library, 'Inbox', NAMED)
    writeFileSync(written, 'another recording, saved under the name the batch gave')

    // Act
    const undone = await preview.undoLast()

    // Assert: the original is back, and the other file is not deleted.
    expect(undone).toEqual({ ok: true, value: { restored: 1, removed: 0, left: 1 } })
    expect(sha256(track.path)).toBe(original)
    expect(readFileSync(written, 'utf8')).toBe(
      'another recording, saved under the name the batch gave'
    )
  })

  it('removes the file the batch wrote although it holds other bytes than its backup', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const batchId = await computed([track.id])
    await approved(batchId)
    const written = join(library, 'Inbox', NAMED)
    const backup = join(folder, filesUnder(backups)[0] ?? '')

    // Act
    const differs = sha256(written) !== sha256(backup)
    const undone = await preview.undoLast()

    // Assert: known by what the batch wrote down about it, not by the backup.
    expect(differs).toBe(true)
    expect(undone).toMatchObject({ ok: true, value: { removed: 1, left: 0 } })
    expect(existsSync(written)).toBe(false)
  })
})

describe('the folder a file is moved into', () => {
  it('is judged as it is on disk: a link into a hidden folder is refused', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    mkdirSync(join(library, '.Trashes'))
    symlinkSync(join(library, '.Trashes'), join(library, 'Sorted'))
    const batchId = await computed([track.id])
    const files = batchFiles.forTrack({ id: batchId, mode }, track.id, new AbortController().signal)

    // Act
    const moved = files.move(join(library, 'Sorted', basename(track.path)))

    // Assert
    await expect(moved).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(readdirSync(join(library, '.Trashes'))).toEqual([])
    expect(existsSync(track.path)).toBe(true)
  })
})

describe('a copy that was set aside as a duplicate', () => {
  it('gets no tags and costs no backup', async () => {
    // Arrange: the file is in `_Duplicates` by the time the tags would be written.
    const aside = addFile('_Duplicates/glue.mp3', { artist: 'Bicep', title: 'Glue' })
    const original = sha256(aside.path)
    const stage = createWriteTagsStage({ python: () => python })
    const files = batchFiles.forTrack(
      { id: 1, mode: 'in_place' },
      aside.id,
      new AbortController().signal
    )

    // Act
    await stage.run({ files, proposal: {} } as Parameters<Stage['run']>[0], trackOf(aside.id))

    // Assert
    expect(calls).toEqual([])
    expect(sha256(aside.path)).toBe(original)
    expect(filesUnder(backups)).toEqual([])
  })
})

describe('a batch that found covers', () => {
  it('embeds the cover alone when nothing else was asked for, and undo takes it out again', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['cover'])

    // Act
    await approved(batchId)
    const tags = tagsIn(track.path)
    const row = trackOf(track.id)
    const undone = await preview.undoLast()

    // Assert
    expect(tags).toEqual({ cover: COVER })
    expect(row.coverStatus).toBe('embedded')
    expect(calls.map((call) => call.method)).toEqual(['tags.would_change', 'tags.write'])
    expect(undone).toMatchObject({ ok: true, value: { restored: 1 } })
    expect(sha256(track.path)).toBe(original)
  })

  it('embeds the cover with the tags in one write when the tags are written too', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const batchId = await computed([track.id], ['naming', 'cover'])

    // Act
    await approved(batchId)

    // Assert
    expect(tagsIn(join(library, 'Inbox', NAMED))).toMatchObject({
      artist: 'Ákos',
      cover: COVER
    })
    // The cover went in with the tags: the file is not asked about again.
    expect(calls.map((call) => call.method)).toEqual(['tags.would_change', 'tags.write'])
    expect(filesUnder(backups)).toHaveLength(1)
  })

  it('in the clean library writes the cover with the tags into the copy once, and leaves the original', async () => {
    // Arrange
    mode = 'clean_library'
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['naming', 'cover'])

    // Act
    await approved(batchId)

    // Assert
    expect(calls.filter((call) => call.method === 'tags.write')).toHaveLength(1)
    expect(sha256(track.path)).toBe(original)
    expect(tagsIn(join(clean, 'Inbox', NAMED))).toMatchObject({ cover: COVER })
  })

  it('in the clean library embeds a cover alone into the copy, and leaves the original', async () => {
    // Arrange
    mode = 'clean_library'
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['cover'])

    // Act
    await approved(batchId)

    // Assert
    expect(sha256(track.path)).toBe(original)
    expect(tagsIn(join(clean, 'Inbox', 'download.mp3'))).toEqual({ cover: COVER })
    expect(filesUnder(backups)).toEqual([])
  })

  it('leaves the file as it was when the cover cannot be written, and keeps no backup', async () => {
    // Arrange
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['cover'])
    failing = async () => {
      throw new AppError('PYTHON_ERROR', 'tags.write: refused')
    }

    // Act
    await approved(batchId)

    // Assert
    expect(sha256(track.path)).toBe(original)
    expect(errorOf(batchId, track.id)).toMatchObject({ code: 'PYTHON_ERROR' })
    expect(trackOf(track.id).coverStatus).not.toBe('embedded')
    expect(filesUnder(backups)).toEqual([])
  })

  it('touches no file when no cover was found', async () => {
    // Arrange
    coverFound = {}
    const track = addFile('Inbox/download.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['cover'])

    // Act
    await approved(batchId)

    // Assert
    expect(calls).toEqual([])
    expect(sha256(track.path)).toBe(original)
    expect(trackOf(track.id).coverStatus).not.toBe('embedded')
    expect(filesUnder(backups)).toEqual([])
  })

  it('embeds no cover into a WAV', async () => {
    // Arrange
    const track = addFile('Inbox/download.wav')
    const batchId = await computed([track.id], ['cover'])

    // Act
    await approved(batchId)

    // Assert
    expect(calls).toEqual([])
    expect(trackOf(track.id).coverStatus).not.toBe('embedded')
  })
})

describe('tagsFor', () => {
  const track = (changes: Partial<Track> = {}): Track =>
    ({ ...trackOf(addFile(`Inbox/${Math.random()}.mp3`).id), ...changes }) as Track

  it("takes what the batch proposes, and the track's own value where it proposes none", () => {
    // Arrange
    const own = track({ artist: 'Bicep', title: 'Glue', label: 'Ninja Tune', bpm: 127.6 })

    // Act
    const fields = tagsFor(own, {
      fields: {
        title: { value: 'Apricots', source: 'manual' },
        key: { value: '8A', source: 'analysis' }
      }
    })

    // Assert
    expect(fields).toEqual({
      artist: 'Bicep',
      title: 'Apricots',
      label: 'Ninja Tune',
      bpm: 128,
      key: 'Am'
    })
  })

  it("keeps the track's own value in a locked field, unless the user typed another in this preview", () => {
    // Arrange
    const own = track({ artist: 'Bicep', title: 'Glue', lockedFields: ['artist', 'title'] })

    // Act
    const fields = tagsFor(own, {
      fields: {
        artist: { value: 'Somebody Else', source: 'musicbrainz', confidence: 0.9 },
        title: { value: 'Apricots', source: 'manual' }
      }
    })

    // Assert
    expect(fields).toEqual({ artist: 'Bicep', title: 'Apricots' })
  })

  it('does not say the mix twice in a title that names it already', () => {
    // Act
    const fields = tagsFor(track({ artist: 'Bicep' }), {
      fields: {
        title: { value: 'Glue (Club Mix)', source: 'manual' },
        mix: { value: 'Club Mix', source: 'musicbrainz' }
      }
    })

    // Assert
    expect(fields.title).toBe('Glue (Club Mix)')
  })

  it('takes the cover the batch found', () => {
    // Act
    const fields = tagsFor(track({ artist: 'Bicep' }), {
      fields: { cover: { value: COVER, source: 'coverartarchive' } }
    })

    // Assert
    expect(fields).toEqual({ artist: 'Bicep', cover: COVER })
  })

  it('writes nothing for what is not known, and never takes a tag away', () => {
    // Act
    const fields = tagsFor(track(), { fields: { artist: { value: null, source: 'manual' } } })

    // Assert
    expect(fields).toEqual({})
  })

  it('leaves out a value a tag cannot hold, and keeps the others', () => {
    // Arrange: a title from an old row with a character that turns the reading around.
    const own = track({ artist: 'Bicep', title: 'Glue \u202e evil', year: 99 })

    // Act
    const fields = tagsFor(own, {})

    // Assert
    expect(fields).toEqual({ artist: 'Bicep' })
  })
})
