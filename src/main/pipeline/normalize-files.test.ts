// Normalization from the run to the files on disk: the real loudness, normalize and
// apply stages, the orchestrator, the preview and the file rules together, with a
// stand-in for the sidecar and files in a temp folder.
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
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAnalysis } from '../db/analyses'
import { getBatchItem, type BatchMode } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { getTrackById, insertTracks, type Track } from '../db/tracks'
import { createFileOps } from '../services/file-ops'
import { logger } from '../services/logger'
import type { PythonBridge } from '../services/python-bridge'
import type { PreviewRow, Proposal } from '@shared/preview'
import type { NormalizeApplyPlan } from '@shared/rpc'
import type { Settings } from '@shared/settings'
import { z } from 'zod'
import { createBatchFiles, type BatchFiles, type TrackFiles } from './batch-files'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { commitApprovedValues, createPreview, type Preview } from './preview'
import { createLoudnessStage } from './stages/loudness'
import { createNormalizeFileStage, createNormalizeStage } from './stages/normalize'

const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase
let folder: string
let library: string
let backups: string
let mode: BatchMode
let settings: Settings['loudness']
let batchFiles: BatchFiles
let run: Orchestrator
let preview: Preview
let calls: { method: string; plan?: NormalizeApplyPlan }[]
/** How far from the plan the stand-in lands, in LU. */
let missBy: number

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

/** A file of the stand-in "sounds" as loud as it says: `LUFS -14.3 PEAK -6`. */
function soundOf(path: string): { lufs: number; peak: number } | null {
  const match = /^LUFS (-?[\d.]+) PEAK (-?[\d.]+)/u.exec(readFileSync(path, 'utf8'))
  return match ? { lufs: Number(match[1]), peak: Number(match[2]) } : null
}

const python: Pick<PythonBridge, 'call'> = {
  call: (async (
    method: string,
    params: { path?: string; src?: string; dst?: string; plan?: NormalizeApplyPlan }
  ) => {
    calls.push({ method, ...(params.plan ? { plan: params.plan } : {}) })
    if (method === 'analysis.loudness') {
      const sound = soundOf(params.path ?? '')
      return sound
        ? { status: 'measured', integratedLufs: sound.lufs, truePeakDbtp: sound.peak, lra: 5 }
        : { status: 'unreadable', reason: 'decode' }
    }
    if (method !== 'normalize.apply' || !params.src || !params.dst || !params.plan) {
      throw new Error(`unexpected call: ${method}`)
    }
    const sound = soundOf(params.src)
    if (!sound) throw new Error('no sound')
    const gain = params.plan.kind === 'mp3gain' ? params.plan.steps * 1.5 : params.plan.gainDb
    const lufs = Math.round((sound.lufs + gain + missBy) * 10) / 10
    const peak = Math.round((sound.peak + gain) * 10) / 10
    await writeFile(params.dst, `LUFS ${lufs} PEAK ${peak} normalized`)
    return { written: true }
  }) as PythonBridge['call']
}

function addFile(name: string, lufs: number, peak: number): { id: number; path: string } {
  const path = join(library, name)
  writeFileSync(path, `LUFS ${lufs} PEAK ${peak} original`)
  const [id] = insertTracks(testDatabase.db, [
    {
      path,
      originalPath: path,
      format: name.endsWith('.mp3') ? ('mp3' as const) : ('aiff' as const),
      fileSizeBytes: 100,
      fileMtimeMs: 1
    }
  ]) as [number]
  return { id, path }
}

function trackOf(id: number): Track {
  const track = getTrackById(testDatabase.db, id, NO_VOLUMES)
  if (!track) throw new Error(`no track ${id}`)
  return track
}

async function computed(ids: number[]): Promise<number> {
  const started = run.start({ trackIds: ids, stages: ['normalize'] })
  if (!started.ok) throw new Error(`the run did not start: ${started.code}`)
  await run.whenFinished()
  return started.value.batchId
}

async function approved(batchId: number): Promise<void> {
  const approval = await preview.approve(batchId)
  if (!approval.ok || !approval.value.started) throw new Error('the batch was not applied')
  await run.whenFinished()
}

function rowOf(batchId: number, trackId: number): PreviewRow | undefined {
  const page = preview.rows({ batchId, offset: 0, limit: 10 })
  return page.ok ? page.value.rows.find((row) => row.trackId === trackId) : undefined
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-normalize-')))
  library = join(folder, 'Music')
  const clean = join(folder, 'Clean')
  backups = join(folder, 'FixLibrary Backups')
  for (const each of [library, clean, backups]) mkdirSync(each)
  mode = 'in_place'
  settings = { targetLufs: -11, method: 'lossless' }
  calls = []
  missBy = 0
  const fileOps = createFileOps({ allowedRoots: () => [library, clean, backups] })
  batchFiles = createBatchFiles({
    db: testDatabase.db,
    fileOps,
    folders: () => ({ libraryRoot: library, cleanLibraryFolder: clean, backupFolder: backups }),
    listMountedVolumes: () => NO_VOLUMES
  })
  const dependencies = {
    db: testDatabase.db,
    python: () => python,
    loudnessSettings: () => settings
  }
  const stages = [
    createLoudnessStage(dependencies),
    createNormalizeStage(dependencies),
    createNormalizeFileStage(dependencies)
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

describe('a batch that normalizes the loudness', () => {
  it('shows the plan, writes the gain in steps on approval, and undo brings the file back', async () => {
    // Arrange
    const track = addFile('quiet.mp3', -14.3, -6)
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    const untouched = filesUnder(folder)
    const row = rowOf(batchId, track.id)

    // Act
    await approved(batchId)
    const normalized = readFileSync(track.path, 'utf8')
    const measured = trackOf(track.id)
    const undone = await preview.undoLast()

    // Assert: the preview, before anything was written.
    expect(untouched).toEqual(['Music/quiet.mp3'])
    expect(row?.cells.lufs).toMatchObject({ before: -14.3, after: -11.3, changed: true })
    expect(row?.cells.truePeak).toMatchObject({ before: -6, after: -3 })
    expect(row?.cells.gain).toMatchObject({ before: null, after: 3 })
    expect(row?.normalization).toEqual({
      kind: 'mp3gain',
      action: 'apply',
      neededGainDb: null,
      possibleGainDb: null
    })
    // The file, its backup, and the measure after it.
    expect(calls.filter((call) => call.method === 'normalize.apply')).toEqual([
      { method: 'normalize.apply', plan: { kind: 'mp3gain', steps: 2 } }
    ])
    expect(normalized).toBe('LUFS -11.3 PEAK -3 normalized')
    expect(measured).toMatchObject({ lufs: -11.3, truePeakDbtp: -3 })
    expect(getBatchItem(testDatabase.db, batchId, track.id)?.error).toBeNull()
    expect(undone).toMatchObject({ ok: true, value: { restored: 1 } })
    expect(sha256(track.path)).toBe(original)
    // Measured before the batch began, the track was not: it is measured again next time.
    expect(trackOf(track.id)).toMatchObject({ lufs: null, truePeakDbtp: null })
    expect(getAnalysis(testDatabase.db, track.id, 'loudness', z.unknown())?.result).toMatchObject({
      integratedLufs: -11.3,
      fileMtimeMs: null
    })
  })

  it('skips a quiet track that would clip, touches no file, and says what it needed', async () => {
    // Arrange
    const track = addFile('peaky.aiff', -16, -0.3)
    const original = sha256(track.path)
    const batchId = await computed([track.id])
    const row = rowOf(batchId, track.id)

    // Act
    await approved(batchId)

    // Assert
    expect(row?.warnings).toEqual(['CANNOT_NORMALIZE'])
    expect(row?.normalization).toEqual({
      kind: 'pcm',
      action: 'skip',
      neededGainDb: 5,
      possibleGainDb: 0
    })
    expect(row?.cells.lufs).toMatchObject({ before: -16, after: -16, changed: false })
    expect(calls.map((call) => call.method)).toEqual(['analysis.loudness'])
    expect(sha256(track.path)).toBe(original)
    expect(filesUnder(backups)).toEqual([])
  })

  it('applies the exact gain to an AIFF and lowers a loud MP3 by encoding it again', async () => {
    // Arrange
    settings = { targetLufs: -8, method: 'exact' }
    const aiff = addFile('a.aiff', -10.4, -4)
    const mp3 = addFile('b.mp3', -6.5, 0.8)
    const batchId = await computed([aiff.id, mp3.id])

    // Act
    await approved(batchId)

    // Assert
    const plans = calls.flatMap((call) => (call.plan ? [call.plan] : []))
    expect(plans).toEqual(
      expect.arrayContaining([
        { kind: 'pcm', gainDb: 2.4 },
        { kind: 'reencode', gainDb: -1.5 }
      ])
    )
    expect(trackOf(aiff.id)).toMatchObject({ lufs: -8, truePeakDbtp: -1.6 })
    expect(trackOf(mp3.id)).toMatchObject({ lufs: -8, truePeakDbtp: -0.7 })
  })

  it('does not apply the gain a second time when the step is run again on a resume', async () => {
    // Arrange: the gain is in the file, and the app stopped before the step was done.
    const track = addFile('quiet.mp3', -14.3, -6)
    const batchId = await computed([track.id])
    await approved(batchId)
    const written = readFileSync(track.path, 'utf8')
    calls = []
    const files = {
      ensureCleanCopy: async () => ({ collided: false }),
      workingPath: async () => track.path,
      replaceContent: async () => {
        throw new Error('the file must not be written again')
      }
    } as unknown as TrackFiles
    const stage = createNormalizeFileStage({
      db: testDatabase.db,
      python: () => python,
      loudnessSettings: () => settings
    })
    const proposal = getBatchItem(testDatabase.db, batchId, track.id)?.after as Proposal &
      Record<string, unknown>

    // Act
    await stage.run(
      { signal: new AbortController().signal, batchId, files, proposal },
      trackOf(track.id)
    )

    // Assert
    expect(calls.map((call) => call.method)).toEqual(['analysis.loudness'])
    expect(readFileSync(track.path, 'utf8')).toBe(written)
  })

  it('fails a track measured off its plan afterwards, and keeps what was written', async () => {
    // Arrange
    missBy = 1.2
    const track = addFile('quiet.mp3', -14.3, -6)
    const batchId = await computed([track.id])

    // Act
    await approved(batchId)

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, track.id)?.error).toMatchObject({
      stage: 'normalizeFile',
      code: 'OFF_TARGET'
    })
    expect(readFileSync(track.path, 'utf8')).toBe('LUFS -10.1 PEAK -3 normalized')
    expect(trackOf(track.id).lufs).toBe(-10.1)
    expect(filesUnder(backups)).toHaveLength(1)
  })

  it('fails a file that cannot be measured as unreadable, and goes on with the others', async () => {
    // Arrange
    const broken = addFile('broken.mp3', -14, -6)
    writeFileSync(broken.path, 'no sound here')
    const fine = addFile('fine.mp3', -11, -3)

    // Act
    const batchId = await computed([broken.id, fine.id])

    // Assert
    expect(getBatchItem(testDatabase.db, batchId, broken.id)?.error).toMatchObject({
      stage: 'loudness',
      code: 'FILE_UNREADABLE'
    })
    expect(rowOf(batchId, fine.id)?.normalization).toMatchObject({ action: 'none' })
  })

  it('does not measure a file again while it is the one that was measured', async () => {
    // Arrange
    const track = addFile('quiet.mp3', -14.3, -6)
    const first = await computed([track.id])
    preview.discard(first)
    calls = []

    // Act
    const batchId = await computed([track.id])

    // Assert
    expect(calls).toEqual([])
    expect(rowOf(batchId, track.id)?.cells.lufs).toMatchObject({ before: -14.3, after: -11.3 })
    expect(getAnalysis(testDatabase.db, track.id, 'loudness', z.unknown())?.result).toMatchObject({
      integratedLufs: -14.3,
      fileSizeBytes: 100,
      fileMtimeMs: 1
    })
  })
})
