// Sorting files into style folders, from the run to the files on disk: the real
// organize stages, the orchestrator, the preview and the file rules together, with a
// stand-in for the style decision and the sidecar, and files in a temp folder.
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
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBatch, getBatchItem, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { listStyles, replaceStyles } from '../db/styles'
import { getTrackById, insertTracks, type NewTrack, type Track } from '../db/tracks'
import { createFileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import type { PythonBridge } from '../services/python-bridge'
import { readProposal, type ProposedFields } from '@shared/preview'
import type { TagFields } from '@shared/rpc'
import { DEFAULT_STYLES, MAX_STYLES, UNSORTED_STYLE_NAME } from '@shared/settings'
import { styles as stylesTable } from '../db/schema'
import { createBatchFiles, type BatchFiles } from './batch-files'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { commitApprovedValues, createPreview, type Preview } from './preview'
import { createDuplicatesStage } from './stages/duplicates'
import { createNamingStage } from './stages/naming'
import { createOrganizeFileStage, createOrganizeStage } from './stages/organize'
import { createRenameStage } from './stages/rename'
import { createSetAsideStage } from './stages/set-aside'
import type { Stage } from './stages/stage'

const NO_VOLUMES: ReadonlySet<string> = new Set()
/** What the stand-in sidecar puts at the end of a file: the tags it "wrote". */
const TAGS = '\nTAGS '

let testDatabase: TestDatabase
let folder: string
let library: string
let clean: string
let backups: string
let mode: BatchMode
let batchFiles: BatchFiles
let run: Orchestrator
let preview: Preview
/** What the style stand-in proposes for every track. */
let decided: ProposedFields
/** What the style stand-in keeps next to its proposal, track by track: a new style. */
let decidedStyle: (trackId: number) => unknown

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort()
}

function tagsIn(path: string): TagFields | null {
  const content = readFileSync(path, 'utf8')
  const at = content.lastIndexOf(TAGS)
  return at === -1 ? null : (JSON.parse(content.slice(at + TAGS.length)) as TagFields)
}

/** Stands in for the sidecar: a file "has" the tags that were appended to it last. */
const python: Pick<PythonBridge, 'call'> = {
  call: (async (
    method: string,
    params: { path?: string; src?: string; dst?: string; fields: TagFields }
  ) => {
    const path = params.path ?? params.src ?? ''
    if (method === 'tags.would_change') {
      const held = tagsIn(path) ?? {}
      return {
        changed: Object.entries(params.fields).some(
          ([name, value]) => held[name as keyof TagFields] !== value
        )
      }
    }
    if (method !== 'tags.write' || !params.dst) throw new Error(`unexpected call: ${method}`)
    const audio = readFileSync(path, 'utf8').split(TAGS)[0]
    await writeFile(
      params.dst,
      `${audio}${TAGS}${JSON.stringify({ ...tagsIn(path), ...params.fields })}`
    )
    return { written: true }
  }) as PythonBridge['call']
}

function styleId(name: string): number {
  const style = listStyles(testDatabase.db).find((each) => each.name === name)
  if (!style) throw new Error(`no style ${name}`)
  return style.id
}

function addFile(
  relativePath: string,
  track: Partial<NewTrack> = {}
): { id: number; path: string } {
  const path = join(library, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `the audio of ${relativePath}`)
  const [id] = insertTracks(testDatabase.db, [
    { path, originalPath: path, format: 'mp3', ...track }
  ]) as [number]
  return { id, path }
}

function trackOf(id: number): Track {
  const track = getTrackById(testDatabase.db, id, NO_VOLUMES)
  if (!track) throw new Error(`no track ${id}`)
  return track
}

async function computed(ids: number[], stages: string[] = ['organize']): Promise<number> {
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
  replaceStyles(testDatabase.db, DEFAULT_STYLES)
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-organize-')))
  library = join(folder, 'Music')
  clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  mode = 'in_place'
  decided = {
    styleId: { value: styleId('Tech House'), source: 'claude', confidence: 0.9 },
    secondaryStyleId: { value: styleId('Afro House'), source: 'claude', confidence: 0.9 }
  }
  decidedStyle = () => undefined
  const fileOps = createFileOps({ allowedRoots: () => [library, clean, backups] })
  batchFiles = createBatchFiles({
    db: testDatabase.db,
    fileOps,
    folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
    listMountedVolumes: () => NO_VOLUMES
  })
  const styleStandIn: Stage = {
    name: 'style',
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: 10_000,
    run: async (_context, track) => ({
      proposal: { fields: decided, style: decidedStyle(track.id) }
    })
  }
  const nothing = (name: string): Stage => ({ ...styleStandIn, name, run: async () => undefined })
  const dependencies = { db: testDatabase.db, python: () => python }
  const stages = [
    nothing('lookup'),
    nothing('bpmKey'),
    styleStandIn,
    createNamingStage(),
    createDuplicatesStage({ db: testDatabase.db }),
    createOrganizeStage(dependencies),
    createRenameStage(),
    createOrganizeFileStage(dependencies),
    createSetAsideStage()
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

describe('a batch that sorts files into style folders', () => {
  it('moves each file into its style folder, tags it, and removes the folders it emptied', async () => {
    // Arrange
    const first = addFile('Old/Deep/a.mp3', { energy: 7 })
    writeFileSync(join(library, 'Old', 'Deep', '.DS_Store'), 'finder')
    const second = addFile('Mixed/b.mp3')
    writeFileSync(join(library, 'Mixed', 'notes.txt'), 'mine')
    const batchId = await computed([first.id, second.id], ['style', 'organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['Mixed/notes.txt', 'Tech House/a.mp3', 'Tech House/b.mp3'])
    expect(tagsIn(join(library, 'Tech House', 'a.mp3'))).toEqual({
      genre: 'Tech House',
      comment: 'E7 | Afro House'
    })
    expect(tagsIn(join(library, 'Tech House', 'b.mp3'))).toEqual({
      genre: 'Tech House',
      comment: 'Afro House'
    })
    expect(existsSync(join(library, 'Old'))).toBe(false)
    expect(trackOf(first.id)).toMatchObject({
      path: join(library, 'Tech House', 'a.mp3'),
      primaryStyleId: styleId('Tech House'),
      secondaryStyleId: styleId('Afro House')
    })
  })

  it('shows the folder each file goes into, and follows a style changed in the preview', async () => {
    // Arrange
    const track = addFile('Old/a.mp3')
    const batchId = await computed([track.id], ['style', 'organize'])

    // Act
    const before = await preview.rows({ batchId, offset: 0, limit: 10 })
    const edited = await preview.edit({
      batchId,
      trackId: track.id,
      field: 'styleId',
      value: styleId('Melodic House')
    })

    // Assert
    expect(before.ok && before.value.rows[0]?.cells.folder).toMatchObject({
      before: 'Old',
      after: 'Tech House',
      changed: true
    })
    expect(edited.ok && edited.value.cells.folder.after).toBe('Melodic House')
  })

  it('puts a track without a style into Unsorted, with no comment', async () => {
    // Arrange
    decided = {}
    const track = addFile('Old/a.mp3')
    const batchId = await computed([track.id])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['Unsorted/a.mp3'])
    expect(tagsIn(join(library, 'Unsorted', 'a.mp3'))).toEqual({ genre: 'Unsorted' })
  })

  it('leaves a style folder that it empties', async () => {
    // Arrange
    const track = addFile('Afro House/a.mp3', { primaryStyleId: styleId('Afro House') })
    const batchId = await computed([track.id], ['style', 'organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(existsSync(join(library, 'Afro House'))).toBe(true)
    expect(filesUnder(library)).toEqual(['Tech House/a.mp3'])
  })

  it('moves nothing that is in its style folder already, and writes no tag that is there', async () => {
    // Arrange
    const track = addFile('Tech House/a.mp3')
    const first = await computed([track.id], ['style', 'organize'])
    await approved(first)
    const hash = sha256(join(library, 'Tech House', 'a.mp3'))

    // Act
    const second = await computed([track.id], ['style', 'organize'])
    await approved(second)

    // Assert
    expect(filesUnder(library)).toEqual(['Tech House/a.mp3'])
    expect(sha256(join(library, 'Tech House', 'a.mp3'))).toBe(hash)
    expect(batchFiles.lastUndoable()).toBe(first)
  })

  it('in the clean library sorts the copies and leaves the originals and no empty folder', async () => {
    // Arrange
    mode = 'clean_library'
    const track = addFile('Old/Deep/a.mp3')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['style', 'organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(sha256(track.path)).toBe(original)
    expect(filesUnder(library)).toEqual(['Old/Deep/a.mp3'])
    expect(filesUnder(clean)).toEqual(['Tech House/a.mp3'])
    expect(readdirSync(clean)).toEqual(['Tech House'])
  })

  it('puts every file back where it was on undo, byte for byte, the old folders too', async () => {
    // Arrange
    const track = addFile('Old/Deep/a.mp3', { energy: 5 })
    writeFileSync(join(library, 'Old', 'Deep', '.DS_Store'), 'finder')
    const original = sha256(track.path)
    const batchId = await computed([track.id], ['style', 'organize'])
    await approved(batchId)

    // Act
    const undone = await preview.undoLast()

    // Assert
    expect(undone).toMatchObject({ ok: true })
    expect(filesUnder(library)).toEqual(['Old/Deep/a.mp3'])
    expect(sha256(track.path)).toBe(original)
    expect(existsSync(join(library, 'Tech House'))).toBe(false)
    expect(trackOf(track.id).path).toBe(track.path)
  })

  it('moves no copy that was set aside as a duplicate', async () => {
    // Arrange
    const track = addFile('_Duplicates/a.mp3')

    // Act
    const started = run.start({ trackIds: [track.id], stages: ['organize'] })

    // Assert
    expect(started.ok).toBe(false)
    expect(filesUnder(library)).toEqual(['_Duplicates/a.mp3'])
  })

  it('gives a file whose name is taken in its style folder the next free name, and says so', async () => {
    // Arrange
    mkdirSync(join(library, 'Tech House'))
    writeFileSync(join(library, 'Tech House', 'a.mp3'), 'another file')
    const track = addFile('Old/a.mp3')
    const batchId = await computed([track.id], ['style', 'organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['Tech House/a (2).mp3', 'Tech House/a.mp3'])
    expect(readFileSync(join(library, 'Tech House', 'a.mp3'), 'utf8')).toBe('another file')
    expect(
      readProposal(getBatchItem(testDatabase.db, batchId, track.id)?.after).warnings
    ).toContain('NAME_COLLISION')
  })

  it('moves a file into the style the user chose in the preview, and tags it so', async () => {
    // Arrange
    const track = addFile('Old/a.mp3')
    const batchId = await computed([track.id], ['style', 'organize'])
    await preview.edit({
      batchId,
      trackId: track.id,
      field: 'styleId',
      value: styleId('Melodic House')
    })

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['Melodic House/a.mp3'])
    expect(tagsIn(join(library, 'Melodic House', 'a.mp3'))?.genre).toBe('Melodic House')
    expect(trackOf(track.id)).toMatchObject({
      primaryStyleId: styleId('Melodic House'),
      genre: 'Melodic House'
    })
  })

  it('renames a file and moves it into its style folder in one batch', async () => {
    // Arrange
    const track = addFile('Old/x.mp3', { artist: 'Bicep', title: 'Glue' })
    const batchId = await computed([track.id], ['style', 'naming', 'organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['Tech House/Bicep - Glue.mp3'])
    expect(trackOf(track.id).path).toBe(join(library, 'Tech House', 'Bicep - Glue.mp3'))
  })

  it('sets the copy of a duplicate aside instead of sorting it, and sorts the one it keeps', async () => {
    // Arrange
    const kept = addFile('Inbox/Bicep - Glue.mp3', {
      artist: 'Bicep',
      title: 'Glue',
      durationMs: 300_000,
      bitrateKbps: 320
    })
    const copy = addFile('Old/glue.mp3', {
      artist: 'Bicep',
      title: 'Glue',
      durationMs: 300_000,
      bitrateKbps: 128
    })
    const batchId = await computed([kept.id, copy.id], ['style', 'duplicates', 'organize'])
    const rows = await preview.rows({ batchId, offset: 0, limit: 10 })

    // Act
    await approved(batchId)

    // Assert
    const folderOf = (trackId: number): unknown =>
      rows.ok && rows.value.rows.find((row) => row.trackId === trackId)?.cells.folder.changed
    expect(folderOf(kept.id)).toBe(true)
    expect(folderOf(copy.id)).toBe(false)
    expect(filesUnder(library)).toEqual(['Tech House/Bicep - Glue.mp3', '_Duplicates/glue.mp3'])
  })

  it('leaves the Inbox that it empties, Finder data and all', async () => {
    // Arrange
    const track = addFile('Inbox/a.mp3')
    writeFileSync(join(library, 'Inbox', '.DS_Store'), 'finder')
    const batchId = await computed([track.id], ['style', 'organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['Inbox/.DS_Store', 'Tech House/a.mp3'])
  })

  it('never moves a file into a folder of the app', async () => {
    // Arrange
    const track = addFile('Old/a.mp3')
    const batchId = await computed([track.id], ['style', 'organize'])
    const batch = getBatch(testDatabase.db, batchId)
    if (!batch) throw new Error('no batch')
    const files = batchFiles.forTrack(batch, track.id, new AbortController().signal)

    // Act
    const moved = files.organize('_duplicates', [])

    // Assert
    await expect(moved).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(filesUnder(library)).toEqual(['Old/a.mp3'])
    expect(filesUnder(backups)).toEqual([])
  })

  it('names the folder of a style saved with a slash safely, and keeps it when it empties', async () => {
    // Arrange
    testDatabase.db
      .insert(stylesTable)
      .values({ name: 'R&B/Soul', color: '#123456', isHouse: false, sortOrder: 99 })
      .run()
    const soul = addFile('R&B-Soul/a.mp3', { primaryStyleId: styleId('R&B/Soul') })
    const other = addFile('Old/b.mp3')
    decided = {}
    const batchId = await computed([soul.id, other.id], ['organize'])

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual(['R&B-Soul/a.mp3', 'Unsorted/b.mp3'])
    expect(tagsIn(join(library, 'R&B-Soul', 'a.mp3'))?.genre).toBe('R&B/Soul')
  })

  it('sorts a track whose new style the full list cannot take into Unsorted, as the list keeps it', async () => {
    // Arrange
    const extra = Array.from({ length: MAX_STYLES - DEFAULT_STYLES.length }, (_, at) => ({
      name: `Style ${at + 1}`,
      color: '#123456',
      isHouse: false
    }))
    replaceStyles(testDatabase.db, [
      ...listStyles(testDatabase.db).filter((style) => style.name !== UNSORTED_STYLE_NAME),
      ...extra,
      ...listStyles(testDatabase.db).filter((style) => style.name === UNSORTED_STYLE_NAME)
    ])
    decided = { styleId: { value: null, source: 'claude', confidence: 0.9 } }
    decidedStyle = () => ({ newPrimary: 'Deep Tech', newColor: '#2a6f97', sources: [] })
    const track = addFile('Old/a.mp3')
    const batchId = await computed([track.id], ['style', 'organize'])
    const rows = await preview.rows({ batchId, offset: 0, limit: 10 })

    // Act
    await approved(batchId)

    // Assert
    expect(rows.ok && rows.value.rows[0]?.cells.folder.after).toBe(UNSORTED_STYLE_NAME)
    expect(filesUnder(library)).toEqual(['Unsorted/a.mp3'])
    expect(tagsIn(join(library, 'Unsorted', 'a.mp3'))?.genre).toBe(UNSORTED_STYLE_NAME)
    expect(listStyles(testDatabase.db)).toHaveLength(MAX_STYLES)
    expect(trackOf(track.id).primaryStyleId).toBe(styleId(UNSORTED_STYLE_NAME))
  })

  it('creates the first five new styles a batch names, folders and all, and sorts the sixth into Unsorted', async () => {
    // Arrange
    const names = ['Deep Tech', 'Minimal', 'Progressive', 'Electro', 'Breaks', 'Dub Techno']
    const tracks = names.map((_, at) => addFile(`Old/${at}.mp3`))
    decided = { styleId: { value: null, source: 'claude', confidence: 0.9 } }
    decidedStyle = (trackId) => ({
      newPrimary: names[tracks.findIndex((track) => track.id === trackId)],
      newColor: '#2a6f97',
      sources: []
    })
    const batchId = await computed(
      tracks.map((track) => track.id),
      ['style', 'organize']
    )

    // Act
    await approved(batchId)

    // Assert
    expect(filesUnder(library)).toEqual([
      'Breaks/4.mp3',
      'Deep Tech/0.mp3',
      'Electro/3.mp3',
      'Minimal/1.mp3',
      'Progressive/2.mp3',
      'Unsorted/5.mp3'
    ])
    expect(trackOf(tracks[0]?.id ?? 0).primaryStyleId).toBe(styleId('Deep Tech'))
  })
})
