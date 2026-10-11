import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { setSetting } from '../db/settings'
import { insertTracks, listTracks, updateTrack, type Track } from '../db/tracks'
import { logger } from '../services/logger'
import { createPythonBridge, type PythonBridge } from '../services/python-bridge'
import { AppError } from '@shared/errors'
import type { ScanProgress } from '@shared/library'
import type { FileTags } from '@shared/rpc'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { createLibraryScanner, type LibraryScanner, type ScanDependencies } from './scanner'

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/synthetic')
const PYTHON_DIR = join(import.meta.dirname, '../../../python')
const PYTHON_PATH = join(PYTHON_DIR, '.venv/bin/python')
const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase
let folder: string
let library: string
let readCalls: string[][]

/** Stands in for the sidecar: every file is readable and tagged after its own name. */
async function fakeReadTags(paths: string[]): Promise<FileTags[]> {
  readCalls.push(paths)
  return paths.map((path) => ({
    path,
    readable: !basename(path).startsWith('broken'),
    durationMs: 200,
    bitrateKbps: 320,
    sampleRateHz: 44_100,
    artist: 'Artist',
    title: basename(path),
    album: null,
    label: null,
    year: 2024,
    hasCover: false
  }))
}

function addFile(relativePath: string, content = 'audio'): string {
  const path = join(library, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function useLibrary(rootFolder: string | null, overrides: object = {}): void {
  setSetting(testDatabase.db, 'library', {
    ...DEFAULT_SETTINGS.library,
    rootFolder,
    ...overrides
  })
}

function scanner(overrides: Partial<ScanDependencies> = {}): LibraryScanner {
  return createLibraryScanner({
    db: testDatabase.db,
    environment: { homeDir: '/Users/dj', cpuCount: 8 },
    readTags: fakeReadTags,
    isEngineAlive: async () => true,
    listMountedVolumes: () => NO_VOLUMES,
    ...overrides
  })
}

function storedTracks(): Track[] {
  return listTracks(testDatabase.db, { limit: 500, offset: 0 }, NO_VOLUMES)
}

function storedNames(): string[] {
  return storedTracks().map((track) => track.path.slice(library.length + 1))
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-scan-')))
  library = join(folder, 'Music')
  mkdirSync(library)
  readCalls = []
  useLibrary(library)
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('scanning a library for the first time', () => {
  it('adds every audio file of the four extensions, in any letter case, from every folder', async () => {
    // Arrange
    addFile('a.mp3')
    addFile('House/b.WAV')
    addFile('House/Deep/c.aif')
    addFile('Techno/d.Aiff')
    addFile('Techno/cover.jpg')
    addFile('notes.txt')

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        found: 4,
        added: 4,
        updated: 0,
        unchanged: 0,
        missing: 0,
        unreadable: 0,
        complete: true
      }
    })
    expect(storedNames()).toEqual(['House/Deep/c.aif', 'House/b.WAV', 'Techno/d.Aiff', 'a.mp3'])
    expect(storedTracks().map((track) => track.format)).toEqual(['aiff', 'wav', 'aiff', 'mp3'])
  })

  it('stores the file state, the tags and the scan status of a track', async () => {
    // Arrange
    const path = addFile('a.mp3', 'twelve bytes')
    utimesSync(path, 1_790_000_000, 1_790_000_000)

    // Act
    await scanner().scan()

    // Assert
    expect(storedTracks()[0]).toMatchObject({
      path,
      originalPath: path,
      fileSizeBytes: 12,
      fileMtimeMs: 1_790_000_000_000,
      fileMissing: false,
      durationMs: 200,
      bitrateKbps: 320,
      sampleRateHz: 44_100,
      artist: 'Artist',
      title: 'a.mp3',
      year: 2024,
      coverStatus: 'missing',
      stageStatus: { scan: 'done' }
    })
  })

  it('leaves out hidden files, AppleDouble files and the system folders of a drive', async () => {
    // Arrange
    addFile('track.mp3')
    addFile('._track.mp3')
    addFile('.hidden.mp3')
    addFile('.Trashes/501/deleted.mp3')
    addFile('.Spotlight-V100/index.mp3')
    addFile('.fseventsd/log.mp3')
    addFile('House/._b.wav')
    addFile('House/.cache/c.mp3')

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { found: 1, added: 1 } })
    expect(storedNames()).toEqual(['track.mp3'])
  })

  it('does not follow a link to a file or to a folder', async () => {
    // Arrange
    addFile('real.mp3')
    const outside = join(folder, 'Elsewhere')
    mkdirSync(outside)
    writeFileSync(join(outside, 'far.mp3'), 'audio')
    symlinkSync(join(outside, 'far.mp3'), join(library, 'link.mp3'))
    symlinkSync(outside, join(library, 'Linked folder'))
    symlinkSync(library, join(library, 'Loop'))

    // Act
    await scanner().scan()

    // Assert
    expect(storedNames()).toEqual(['real.mp3'])
  })

  it('asks for the tags in batches of fifty', async () => {
    // Arrange
    for (let index = 0; index < 120; index += 1) addFile(`${index}.mp3`)

    // Act
    const result = await scanner().scan()

    // Assert
    expect(readCalls.map((paths) => paths.length)).toEqual([50, 50, 20])
    expect(result).toMatchObject({ ok: true, value: { found: 120, added: 120 } })
  })

  it('lists a file that cannot be read, without tags and marked as failed', async () => {
    // Arrange
    addFile('broken.mp3')
    addFile('fine.mp3')

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { added: 2, unreadable: 1 } })
    expect(storedTracks()[0]).toMatchObject({
      coverStatus: 'unknown',
      stageStatus: { scan: 'failed' }
    })
  })

  it('stores a decomposed file name composed, and opens the file by its name on disk', async () => {
    // Arrange
    const decomposed = 'Tűz.mp3'.normalize('NFD')
    addFile(decomposed)

    // Act
    await scanner().scan()
    const again = await scanner().scan()

    // Assert
    expect(storedNames()).toEqual(['Tűz.mp3'.normalize('NFC')])
    expect(existsSync(readCalls[0]?.[0] ?? '')).toBe(true)
    expect(again).toMatchObject({ ok: true, value: { unchanged: 1, added: 0 } })
  })

  it('reports how far it is while it works', async () => {
    // Arrange
    for (let index = 0; index < 60; index += 1) addFile(`${index}.mp3`)
    const progress: ScanProgress[] = []

    // Act
    await scanner({ onProgress: (step) => progress.push(step) }).scan()

    // Assert
    expect(progress).toEqual([
      { phase: 'walking', found: 0 },
      { phase: 'reading', done: 0, total: 60 },
      { phase: 'reading', done: 50, total: 60 },
      { phase: 'reading', done: 60, total: 60 }
    ])
  })
})

describe('scanning again', () => {
  it('reads nothing when no file has changed', async () => {
    // Arrange
    addFile('a.mp3')
    addFile('House/b.wav')
    await scanner().scan()
    readCalls = []

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        found: 2,
        added: 0,
        updated: 0,
        unchanged: 2,
        missing: 0,
        unreadable: 0,
        complete: true
      }
    })
    expect(readCalls).toEqual([])
  })

  it('reads only the new file and the file whose size or time changed', async () => {
    // Arrange
    addFile('same.mp3')
    const grown = addFile('grown.mp3')
    const touched = addFile('touched.mp3')
    await scanner().scan()
    readCalls = []
    appendFileSync(grown, 'more')
    utimesSync(touched, 1_800_000_000, 1_800_000_000)
    const added = addFile('new.mp3')

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({
      ok: true,
      value: { found: 4, added: 1, updated: 2, unchanged: 1 }
    })
    expect(readCalls.flat().sort()).toEqual([grown, added, touched].sort())
    expect(storedTracks()).toHaveLength(4)
  })

  it('keeps what other stages recorded about a file that changed', async () => {
    // Arrange
    const path = addFile('a.mp3')
    await scanner().scan()
    const id = storedTracks()[0]?.id as number
    updateTrack(testDatabase.db, id, { bpm: 124, stageStatus: { scan: 'done', bpmKey: 'done' } })
    appendFileSync(path, 'more')

    // Act
    await scanner().scan()

    // Assert
    expect(storedTracks()[0]).toMatchObject({
      id,
      bpm: 124,
      stageStatus: { scan: 'done', bpmKey: 'done' }
    })
  })

  it('marks a track whose file is gone as missing, keeps its row, and finds it again', async () => {
    // Arrange
    const path = addFile('a.mp3')
    addFile('b.mp3')
    await scanner().scan()
    rmSync(path)

    // Act
    const afterRemoval = await scanner().scan()
    const missing = storedTracks().map((track) => track.fileMissing)
    addFile('a.mp3')
    await scanner().scan()
    const afterReturn = storedTracks().map((track) => track.fileMissing)

    // Assert
    expect(afterRemoval).toMatchObject({ ok: true, value: { found: 1, missing: 1 } })
    expect(missing).toEqual([true, false])
    expect(afterReturn).toEqual([false, false])
    expect(storedTracks()).toHaveLength(2)
  })

  it('tries a file again that could not be read, although the file has not changed', async () => {
    // Arrange
    addFile('fine.mp3')
    addFile('flaky.mp3')
    const failing = async (paths: string[]): Promise<FileTags[]> =>
      (await fakeReadTags(paths)).map((tags) =>
        basename(tags.path) === 'flaky.mp3' ? { ...tags, readable: false } : tags
      )
    await scanner({ readTags: failing }).scan()
    readCalls = []

    // Act
    const result = await scanner().scan()

    // Assert
    expect(readCalls).toEqual([[join(library, 'flaky.mp3')]])
    expect(result).toMatchObject({ ok: true, value: { updated: 1, unchanged: 1, unreadable: 0 } })
    expect(storedTracks().map((track) => track.stageStatus)).toEqual([
      { scan: 'done' },
      { scan: 'done' }
    ])
  })

  it('does not report a file as changed that is tried again and still cannot be read', async () => {
    // Arrange
    addFile('broken.mp3')
    addFile('fine.mp3')
    await scanner().scan()

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({
      ok: true,
      value: { added: 0, updated: 0, unchanged: 2, unreadable: 1 }
    })
  })

  it('marks nothing missing when a library that had tracks shows no file at all', async () => {
    // Arrange
    const path = addFile('a.mp3')
    await scanner().scan()
    rmSync(path)

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { found: 0, missing: 0, complete: false } })
    expect(storedTracks().map((track) => track.fileMissing)).toEqual([false])
  })

  it('does not take the original of a track for a new track when the track works on a copy', async () => {
    // Arrange
    const original = addFile('a.mp3')
    await scanner().scan()
    const id = storedTracks()[0]?.id as number
    // What clean library mode does: the track points at its copy, outside the library.
    updateTrack(testDatabase.db, id, { path: join(folder, 'Clean', 'a.mp3') })
    readCalls = []

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { found: 1, added: 0, unchanged: 1 } })
    expect(readCalls).toEqual([])
    expect(storedTracks()).toMatchObject([{ id, originalPath: original }])
  })

  it('leaves the tracks of another folder alone', async () => {
    // Arrange
    insertTracks(testDatabase.db, [
      { path: '/Volumes/Old drive/x.mp3', originalPath: '/Volumes/Old drive/x.mp3', format: 'mp3' }
    ])
    addFile('a.mp3')

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { missing: 0 } })
    expect(storedTracks().map((track) => track.fileMissing)).toEqual([false, false])
  })
})

describe('a scan that cannot run or has to stop', () => {
  it('refuses to run while no library folder is chosen', async () => {
    // Arrange
    useLibrary(null)

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'LIBRARY_NOT_SET' })
  })

  it('reports a library folder that is not there, and marks nothing missing', async () => {
    // Arrange
    addFile('a.mp3')
    await scanner().scan()
    rmSync(library, { recursive: true })

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'LIBRARY_UNAVAILABLE' })
    expect(storedTracks().map((track) => track.fileMissing)).toEqual([false])
  })

  it('stops with an error when the drive goes away while it reads, keeping what it had', async () => {
    // Arrange
    for (let index = 0; index < 120; index += 1) addFile(`${index}.mp3`)
    const readTags = async (paths: string[]): Promise<FileTags[]> => {
      if (readCalls.length === 1) {
        rmSync(library, { recursive: true })
        throw new AppError('TIMEOUT', 'the drive is gone')
      }
      return fakeReadTags(paths)
    }

    // Act
    const result = await scanner({ readTags }).scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'LIBRARY_UNAVAILABLE' })
    expect(storedTracks()).toHaveLength(50)
    expect(storedTracks().some((track) => track.fileMissing)).toBe(false)
  })

  it('does not mark tracks missing when the drive goes away after the last batch', async () => {
    // Arrange
    addFile('a.mp3')
    await scanner().scan()
    addFile('b.mp3')
    const readTags = async (paths: string[]): Promise<FileTags[]> => {
      const tags = await fakeReadTags(paths)
      rmSync(library, { recursive: true })
      return tags
    }

    // Act
    const result = await scanner({ readTags }).scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'LIBRARY_UNAVAILABLE' })
    expect(storedTracks().map((track) => track.fileMissing)).toEqual([false, false])
  })

  it('does not scan a folder left behind under /Volumes by a drive that is not mounted', async () => {
    // Arrange
    addFile('a.mp3')
    await scanner().scan()
    rmSync(join(library, 'a.mp3'))
    const onDrive = { resolvePath: async () => '/Volumes/DJ SSD/Music' }

    // Act
    const unmounted = await scanner(onDrive).scan()

    // Assert
    expect(unmounted).toEqual({ ok: false, code: 'LIBRARY_UNAVAILABLE' })
    expect(storedTracks().map((track) => track.fileMissing)).toEqual([false])
  })

  it('records the one file that fails its batch as unreadable and reads the rest', async () => {
    // Arrange
    for (let index = 0; index < 60; index += 1) addFile(`${index}.mp3`)
    addFile('poison.mp3')
    const readTags = async (paths: string[]): Promise<FileTags[]> => {
      if (paths.some((path) => basename(path) === 'poison.mp3')) {
        throw new AppError('PYTHON_ERROR', 'tags.read: OverflowError')
      }
      return fakeReadTags(paths)
    }

    // Act
    const result = await scanner({ readTags }).scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { found: 61, added: 61, unreadable: 1 } })
    expect(
      storedTracks()
        .filter((track) => track.stageStatus.scan === 'failed')
        .map((track) => basename(track.path))
    ).toEqual(['poison.mp3'])
  })

  it('ends the scan when a read fails and the audio engine does not answer', async () => {
    // Arrange
    for (let index = 0; index < 120; index += 1) addFile(`${index}.mp3`)
    let calls = 0
    const readTags = async (): Promise<FileTags[]> => {
      calls += 1
      throw new AppError('TIMEOUT', 'tags.read: no answer')
    }

    // Act
    const result = await scanner({ readTags, isEngineAlive: async () => false }).scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(calls).toBe(2)
    expect(storedTracks()).toEqual([])
  })

  it('records a file that crashes the engine as unreadable, even when it is alone in its batch', async () => {
    // Arrange
    addFile('poison.mp3')
    const readTags = async (): Promise<FileTags[]> => {
      throw new AppError('PYTHON_CRASHED', 'tags.read: the sidecar exited')
    }

    // Act
    const result = await scanner({ readTags }).scan()
    const again = await scanner().scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { added: 1, unreadable: 1 } })
    expect(again).toMatchObject({ ok: true, value: { updated: 1, unreadable: 0 } })
  })

  it('does not try a file again that ran out of time, until the file changes', async () => {
    // Arrange
    addFile('fine.mp3')
    const slow = addFile('slow.mp3')
    const readTags = async (paths: string[]): Promise<FileTags[]> => {
      if (paths.includes(slow)) throw new AppError('TIMEOUT', 'tags.read: no answer')
      return fakeReadTags(paths)
    }
    const first = await scanner({ readTags }).scan()
    readCalls = []

    // Act
    const second = await scanner().scan()
    appendFileSync(slow, 'changed')
    const third = await scanner().scan()

    // Assert
    expect(first).toMatchObject({ ok: true, value: { added: 2, unreadable: 1 } })
    expect(second).toMatchObject({ ok: true, value: { unchanged: 2, updated: 0 } })
    expect(readCalls).toEqual([[slow]])
    expect(third).toMatchObject({ ok: true, value: { updated: 1 } })
    expect(storedTracks().map((track) => track.stageStatus.scan)).toEqual(['done', 'done'])
  })

  it('treats one entry that breaks the contract as an unreadable file, not as a failed batch', async () => {
    // Arrange
    addFile('click.wav')
    addFile('fine.mp3')
    const readTags = async (paths: string[]): Promise<unknown[]> =>
      (await fakeReadTags(paths)).map((tags) =>
        basename(tags.path) === 'click.wav' ? { ...tags, durationMs: 0 } : tags
      )

    // Act
    const result = await scanner({ readTags }).scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { added: 2, unreadable: 1 } })
    expect(storedTracks().map((track) => track.stageStatus.scan)).toEqual(['failed', 'done'])
    expect(readCalls).toHaveLength(1)
  })

  it('reports that the audio engine stopped, with the code of that failure', async () => {
    // Arrange
    addFile('a.mp3')
    const readTags = async (): Promise<FileTags[]> => {
      throw new AppError('PYTHON_CRASHED', 'tags.read: the sidecar exited')
    }

    // Act
    const result = await scanner({ readTags, isEngineAlive: async () => false }).scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'PYTHON_CRASHED' })
    expect(storedTracks()).toEqual([])
  })

  it('refuses an answer that is not about the files it asked for', async () => {
    // Arrange
    addFile('a.mp3')
    const readTags = async (paths: string[]): Promise<FileTags[]> =>
      (await fakeReadTags(paths)).map((tags) => ({ ...tags, path: '/etc/passwd' }))

    // Act
    const result = await scanner({ readTags }).scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'PYTHON_ERROR' })
    expect(storedTracks()).toEqual([])
  })

  it('refuses a library that is the home folder', async () => {
    // Arrange
    addFile('a.mp3')

    // Act
    const result = await scanner({ environment: { homeDir: library, cpuCount: 8 } }).scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'LIBRARY_ROOT_UNSUITABLE' })
    expect(readCalls).toEqual([])
  })

  it('refuses a library that has come to contain its backup folder', async () => {
    // Arrange
    addFile('a.mp3')
    useLibrary(library, { backupFolder: join(library, 'Backups') })

    // Act
    const result = await scanner().scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'LIBRARY_ROOT_UNSUITABLE' })
  })

  it('skips a folder it may not read, and then marks nothing missing', async () => {
    // Arrange
    addFile('a.mp3')
    addFile('Locked/b.mp3')
    await scanner().scan()
    const locked = join(library, 'Locked')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    chmodSync(locked, 0o000)

    // Act
    const result = await scanner()
      .scan()
      .finally(() => chmodSync(locked, 0o755))

    // Assert
    expect(result).toMatchObject({ ok: true, value: { found: 1, missing: 0 } })
    expect(storedTracks().map((track) => track.fileMissing)).toEqual([false, false])
  })
})

describe('one scan at a time', () => {
  it('answers a second request with the result of the scan that is running', async () => {
    // Arrange
    addFile('a.mp3')
    const library = scanner()

    // Act
    const first = library.scan()
    const second = library.scan()
    const runningMeanwhile = library.isRunning()
    const results = await Promise.all([first, second])

    // Assert
    expect(runningMeanwhile).toBe(true)
    expect(results[0]).toBe(results[1])
    expect(readCalls).toHaveLength(1)
    expect(library.isRunning()).toBe(false)
  })
})

describe.skipIf(!existsSync(PYTHON_PATH))('scanning with the real sidecar', () => {
  let bridge: PythonBridge

  beforeEach(() => {
    bridge = createPythonBridge({
      pythonPath: PYTHON_PATH,
      cwd: PYTHON_DIR,
      logDir: join(folder, 'logs'),
      log: () => {},
      onSidecarOutput: () => {}
    })
    bridge.start()
  })

  afterEach(async () => {
    await bridge.stop()
  })

  it('reads real MP3, WAV and AIFF files and lists a damaged one without tags', async () => {
    // Arrange
    for (const name of ['sine.mp3', 'sine.wav', 'sine.aiff']) {
      copyFileSync(join(FIXTURES, name), join(library, name))
    }
    addFile('damaged.mp3', 'not audio at all')
    const readTags = async (paths: string[]): Promise<unknown[]> =>
      (await bridge.call('tags.read', { paths })).files

    // Act
    const result = await scanner({ readTags }).scan()

    // Assert
    expect(result).toMatchObject({ ok: true, value: { added: 4, unreadable: 1 } })
    expect(
      storedTracks().map((track) => [basename(track.path), track.sampleRateHz, track.bitrateKbps])
    ).toEqual([
      ['damaged.mp3', null, null],
      ['sine.aiff', 44_100, 706],
      ['sine.mp3', 44_100, 320],
      ['sine.wav', 44_100, 706]
    ])
  })
})

describe('a scan while a batch changes files', () => {
  it('does not start: it would take half-renamed files for missing and new tracks', async () => {
    // Arrange
    writeFileSync(join(library, 'a.mp3'), 'a')
    const scans = scanner({ isChangingFiles: () => true })

    // Act
    const result = await scans.scan()

    // Assert
    expect(result).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(scans.isRunning()).toBe(false)
    expect(readCalls).toEqual([])
  })
})

describe('a field the user set by hand', () => {
  it('keeps its value when the file changes and is scanned again', async () => {
    // Arrange
    const path = addFile('a.mp3')
    const scans = scanner()
    await scans.scan()
    const [track] = storedTracks()
    updateTrack(testDatabase.db, track?.id ?? -1, { title: 'By Hand', lockedFields: ['title'] })
    writeFileSync(path, 'audio that was changed by another program')

    // Act
    const result = await scans.scan()

    // Assert
    expect(result.ok && result.value.updated).toBe(1)
    // The title is the user's; the artist, which is not locked, follows the file.
    expect(storedTracks()[0]).toMatchObject({ title: 'By Hand', artist: 'Artist' })
  })
})
