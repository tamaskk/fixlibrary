import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAnalysis, saveAnalysis } from '../db/analyses'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { setSetting } from '../db/settings'
import { insertTracks, type NewTrack } from '../db/tracks'
import { logger } from '../services/logger'
import { locationOf } from '../services/rekordbox-xml'
import { DEFAULT_SETTINGS } from '@shared/settings'
import {
  rbGridSchema,
  readRekordboxExport,
  type RekordboxImportDependencies
} from './rekordbox-import'

let testDatabase: TestDatabase
let folder: string
let library: string
let exports: string
let busy: boolean

function addFile(
  relativePath: string,
  track: Partial<NewTrack> = {}
): { id: number; path: string } {
  const path = join(library, relativePath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'audio')
  const [id] = insertTracks(testDatabase.db, [
    { path, originalPath: path, format: 'mp3', ...track }
  ]) as [number]
  return { id, path }
}

/** An export of Rekordbox with these tracks: a path, and its grid as `Inizio` seconds. */
function writeExport(name: string, tracks: { path: string; grid?: number[] }[]): string {
  const elements = tracks.map(({ path, grid = [] }, index) => {
    const tempos = grid
      .map((inizio) => `<TEMPO Inizio="${inizio}" Bpm="124.00" Metro="4/4" Battito="1"/>`)
      .join('')
    return `<TRACK TrackID="${index + 1}" Name="t" Location="${locationOf(path).replace(/&/gu, '&amp;')}">${tempos}</TRACK>`
  })
  const path = join(exports, name)
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="${tracks.length}">${elements.join('')}</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="0"/></PLAYLISTS></DJ_PLAYLISTS>`
  )
  return path
}

function dependencies(): RekordboxImportDependencies {
  return {
    db: testDatabase.db,
    environment: { homeDir: folder, cpuCount: 4 },
    listMountedVolumes: () => new Set(),
    isBusy: () => busy,
    now: () => 1_800_000_000_000
  }
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-import-')))
  library = join(folder, 'Music')
  exports = join(folder, 'Exports')
  mkdirSync(library)
  mkdirSync(exports)
  setSetting(testDatabase.db, 'rekordbox', {
    ...DEFAULT_SETTINGS.rekordbox,
    exportedXmlFolder: exports
  })
  busy = false
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('readRekordboxExport', () => {
  it('keeps the grid of each track of the library, and lists what is missing or not analysed', async () => {
    // Arrange
    const accented = addFile('Ünnep/Árvíztűrő & társai.mp3')
    const plain = addFile('Tech House/b.mp3')
    const notExported = addFile('c.mp3')
    const exportedAt = Date.parse('2026-10-15T10:00:00Z')
    const path = writeExport('rekordbox.xml', [
      // Rekordbox may spell a path decomposed; the app keeps it composed.
      { path: accented.path.normalize('NFD'), grid: [0.025, 60.025] },
      { path: plain.path },
      { path: join(library, 'old name.mp3'), grid: [0.1] }
    ])
    utimesSync(path, exportedAt / 1000, exportedAt / 1000)

    // Act
    const read = await readRekordboxExport(dependencies())

    // Assert
    expect(read).toEqual({
      ok: true,
      value: {
        fileName: 'rekordbox.xml',
        exportedAt,
        tracks: 3,
        skipped: 0,
        matched: 2,
        notInExport: { count: 1, items: [{ trackId: notExported.id, path: notExported.path }] },
        missingFiles: { count: 1, items: [join(library, 'old name.mp3')] },
        unavailable: 0,
        unchecked: 0,
        unanalysed: { count: 1, items: [{ trackId: plain.id, path: plain.path }] }
      }
    })
    expect(getAnalysis(testDatabase.db, accented.id, 'rb_grid', rbGridSchema)).toEqual({
      result: {
        tempos: [
          { inizio: 0.025, bpm: 124, metro: '4/4', battito: 1 },
          { inizio: 60.025, bpm: 124, metro: '4/4', battito: 1 }
        ],
        exportedAt,
        readAt: 1_800_000_000_000
      },
      analyzerVersion: 'rekordbox-xml'
    })
  })

  it('drops the old grid of a track Rekordbox now has without one, and keeps that of one it lacks', async () => {
    // Arrange
    const reanalysed = addFile('a.mp3')
    const absent = addFile('b.mp3')
    const old = {
      tempos: [{ inizio: 0, bpm: 120, metro: '4/4', battito: 1 }],
      exportedAt: 1,
      readAt: 2
    }
    for (const { id } of [reanalysed, absent]) {
      saveAnalysis(testDatabase.db, {
        trackId: id,
        type: 'rb_grid',
        result: old,
        analyzerVersion: 'rekordbox-xml'
      })
    }
    writeExport('rekordbox.xml', [{ path: reanalysed.path }])

    // Act
    await readRekordboxExport(dependencies())

    // Assert
    expect(getAnalysis(testDatabase.db, reanalysed.id, 'rb_grid', rbGridSchema)).toBeUndefined()
    expect(getAnalysis(testDatabase.db, absent.id, 'rb_grid', rbGridSchema)?.result).toEqual(old)
  })

  it('reads the newest export, never the XML the app wrote', async () => {
    // Arrange
    const track = addFile('a.mp3')
    const now = Date.now() / 1000
    utimesSync(writeExport('old.xml', [{ path: track.path }]), now - 100, now - 100)
    utimesSync(writeExport('new.xml', []), now - 10, now - 10)
    utimesSync(writeExport('fixlibrary.xml', [{ path: track.path }]), now, now)

    // Act
    const read = await readRekordboxExport(dependencies())

    // Assert
    expect(read).toMatchObject({ ok: true, value: { fileName: 'new.xml', matched: 0 } })
  })

  it.each([
    ['there is no export', (): void => {}, 'XML_NOT_FOUND'],
    [
      'the export is no Rekordbox XML',
      (): void => writeFileSync(join(exports, 'x.xml'), '<html/>'),
      'XML_UNREADABLE'
    ],
    [
      'the export declares entities',
      (): void =>
        writeFileSync(
          join(exports, 'x.xml'),
          '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY b "c">]><DJ_PLAYLISTS/>'
        ),
      'XML_UNREADABLE'
    ]
  ])('says so when %s', async (_what, arrange, code) => {
    // Arrange
    arrange()

    // Act
    const read = await readRekordboxExport(dependencies())

    // Assert
    expect(read).toEqual({ ok: false, code })
  })

  it('reads nothing while files of the library are being changed or scanned', async () => {
    // Arrange
    const track = addFile('a.mp3')
    writeExport('rekordbox.xml', [{ path: track.path, grid: [0] }])
    busy = true

    // Act
    const read = await readRekordboxExport(dependencies())

    // Assert
    expect(read).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(getAnalysis(testDatabase.db, track.id, 'rb_grid', rbGridSchema)).toBeUndefined()
  })

  it('does not call an entry on a drive that is not connected missing, nor look at one in a network folder', async () => {
    // Arrange
    writeExport('rekordbox.xml', [
      { path: '/Volumes/Gone Drive/Music/a.mp3', grid: [0] },
      { path: '/Network/Servers/host/Music/b.mp3' },
      { path: '/net/host/Music/c.mp3' },
      { path: join(library, 'here.mp3') }
    ])

    // Act
    const read = await readRekordboxExport(dependencies())

    // Assert
    expect(read).toMatchObject({
      ok: true,
      value: {
        tracks: 4,
        unavailable: 1,
        unchecked: 2,
        missingFiles: { count: 1, items: [join(library, 'here.mp3')] }
      }
    })
  })

  it('sends at most 200 entries of a list, with the count of all, and its text on one line', async () => {
    // Arrange
    const tracks = Array.from({ length: 205 }, (_, index) => ({
      path: join(library, `gone ${index}\u202e.mp3`)
    }))
    writeExport('rekordbox.xml', tracks)

    // Act
    const read = await readRekordboxExport(dependencies())

    // Assert
    if (!read.ok) throw new Error(read.code)
    expect(read.value.missingFiles.count).toBe(205)
    expect(read.value.missingFiles.items).toHaveLength(200)
    expect(read.value.missingFiles.items[0]).toBe(join(library, 'gone 0 .mp3'))
  })

  it('reads an export through the parser it is given, and says so when that fails', async () => {
    // Arrange
    writeExport('rekordbox.xml', [])
    const parseExport = vi.fn(async () => {
      throw new Error('the worker ran out of memory')
    })

    // Act
    const read = await readRekordboxExport({ ...dependencies(), parseExport })

    // Assert
    expect(parseExport).toHaveBeenCalledOnce()
    expect(read).toEqual({ ok: false, code: 'XML_UNREADABLE' })
  })
})
