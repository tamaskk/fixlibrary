import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { XMLParser } from 'fast-xml-parser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { cues, playlists, playlistTracks } from '../db/schema'
import { setSetting } from '../db/settings'
import { listStyles, replaceStyles } from '../db/styles'
import { insertTracks, type NewTrack } from '../db/tracks'
import { logger } from '../services/logger'
import { DEFAULT_SETTINGS, DEFAULT_STYLES } from '@shared/settings'
import { exportRekordboxXml, type RekordboxExportDependencies } from './rekordbox-export'

let testDatabase: TestDatabase
let home: string
let mounted: Set<string>
let busy: boolean

function styleId(name: string): number {
  const style = listStyles(testDatabase.db).find((each) => each.name === name)
  if (!style) throw new Error(`no style ${name}`)
  return style.id
}

function addTrack(path: string, track: Partial<NewTrack> = {}): number {
  const [id] = insertTracks(testDatabase.db, [
    { path, originalPath: path, format: 'mp3', ...track }
  ]) as [number]
  return id
}

function dependencies(): RekordboxExportDependencies {
  return {
    db: testDatabase.db,
    environment: { homeDir: home, cpuCount: 4 },
    listMountedVolumes: () => mounted,
    appVersion: '0.0.1',
    isBusy: () => busy,
    now: () => 1_700_000_000_000
  }
}

interface ParsedXml {
  DJ_PLAYLISTS: {
    COLLECTION: { Entries: string; TRACK?: Record<string, unknown>[] }
    PLAYLISTS: { NODE: { NODE: Record<string, unknown>[] }[] }
  }
}

function readXml(path: string): ParsedXml {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => ['TRACK', 'NODE', 'POSITION_MARK'].includes(name)
  }).parse(readFileSync(path, 'utf8')) as ParsedXml
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'error').mockImplementation(() => {})
  testDatabase = createTestDatabase()
  replaceStyles(testDatabase.db, DEFAULT_STYLES)
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-export-')))
  mounted = new Set(['DJ'])
  busy = false
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('exportRekordboxXml', () => {
  it('writes every track of the library into the default folder, and leaves out what Rekordbox cannot find', async () => {
    // Arrange
    const kept = addTrack('/Volumes/DJ/Music/Tech House/a.mp3', {
      title: 'Glue',
      mix: 'Original Mix',
      artist: 'Bicep',
      primaryStyleId: styleId('Tech House'),
      secondaryStyleId: styleId('Afro House'),
      energy: 7,
      bpm: 124,
      musicalKey: 'Am',
      durationMs: 299_600,
      fileSizeBytes: 9_000_000,
      bitrateKbps: 320,
      sampleRateHz: 44_100
    })
    addTrack('/Volumes/DJ/Music/_Duplicates/a.mp3')
    addTrack('/Volumes/Gone/Music/b.mp3')
    addTrack('/Volumes/DJ/Music/c.mp3', { fileMissing: true })

    // Act
    const written = await exportRekordboxXml(dependencies())

    // Assert
    const path = join(home, 'Documents', 'FixLibrary', 'fixlibrary.xml')
    expect(written).toEqual({
      ok: true,
      value: { path, tracks: 1, skipped: 2, writtenAt: 1_700_000_000_000 }
    })
    const xml = readXml(path)
    expect(xml.DJ_PLAYLISTS.COLLECTION.Entries).toBe('1')
    expect(xml.DJ_PLAYLISTS.COLLECTION.TRACK?.[0]).toMatchObject({
      TrackID: String(kept),
      Name: 'Glue (Original Mix)',
      Mix: 'Original Mix',
      Genre: 'Tech House',
      Comments: 'E7 | Afro House',
      Kind: 'MP3 File',
      TotalTime: '300',
      AverageBpm: '124.00',
      Tonality: 'Am',
      Location: 'file://localhost/Volumes/DJ/Music/Tech%20House/a.mp3'
    })
  })

  it('makes a playlist of each style and puts the user playlists into "Playlists", without left-out tracks', async () => {
    // Arrange
    const tech = addTrack('/Music/a.mp3', { primaryStyleId: styleId('Tech House') })
    const none = addTrack('/Music/b.mp3')
    const aside = addTrack('/Music/_Duplicates/b.mp3')
    const [list] = testDatabase.db
      .insert(playlists)
      .values({ name: 'Warm-up' })
      .returning({ id: playlists.id })
      .all()
    testDatabase.db
      .insert(playlistTracks)
      .values([
        { playlistId: list?.id ?? 0, trackId: none, position: 0 },
        { playlistId: list?.id ?? 0, trackId: aside, position: 1 },
        { playlistId: list?.id ?? 0, trackId: tech, position: 2 }
      ])
      .run()

    // Act
    const written = await exportRekordboxXml(dependencies())

    // Assert
    if (!written.ok) throw new Error(written.code)
    const nodes = readXml(written.value.path).DJ_PLAYLISTS.PLAYLISTS.NODE[0]?.NODE ?? []
    expect(nodes.map((node) => node['Name'])).toEqual([
      ...DEFAULT_STYLES.map((style) => style.name),
      'Playlists'
    ])
    expect(nodes.find((node) => node['Name'] === 'Tech House')).toMatchObject({
      Entries: '1',
      TRACK: [{ Key: String(tech) }]
    })
    expect(nodes.at(-1)).toMatchObject({
      NODE: [
        { Name: 'Warm-up', Entries: '2', TRACK: [{ Key: String(none) }, { Key: String(tech) }] }
      ]
    })
  })

  it('writes the hot cues in the colors of the Settings, named by the cue or by its slot', async () => {
    // Arrange
    const id = addTrack('/Music/a.mp3')
    setSetting(testDatabase.db, 'hotCues', [
      { name: 'Intro', color: '#102030' },
      ...DEFAULT_SETTINGS.hotCues.slice(1)
    ])
    testDatabase.db
      .insert(cues)
      .values([
        { trackId: id, slot: 1, positionMs: 1_250, name: '', color: '#000000' },
        { trackId: id, slot: 8, positionMs: 180_000, name: 'Last drop', color: '#000000' }
      ])
      .run()

    // Act
    const written = await exportRekordboxXml(dependencies())

    // Assert
    if (!written.ok) throw new Error(written.code)
    expect(
      readXml(written.value.path).DJ_PLAYLISTS.COLLECTION.TRACK?.[0]?.['POSITION_MARK']
    ).toEqual([
      { Name: 'Intro', Type: '0', Start: '1.250', Num: '0', Red: '16', Green: '32', Blue: '48' },
      {
        Name: 'Last drop',
        Type: '0',
        Start: '180.000',
        Num: '7',
        Red: '236',
        Green: '72',
        Blue: '153'
      }
    ])
  })

  it('writes nothing while files of the library are being changed or scanned', async () => {
    // Arrange
    busy = true

    // Act
    const written = await exportRekordboxXml(dependencies())

    // Assert
    expect(written).toEqual({ ok: false, code: 'RUN_ACTIVE' })
    expect(existsSync(join(home, 'Documents'))).toBe(false)
  })

  it('does not make a chosen folder that is gone, and says the XML was not written', async () => {
    // Arrange
    const chosen = join(home, 'Gone', 'XML')
    setSetting(testDatabase.db, 'rekordbox', {
      ...DEFAULT_SETTINGS.rekordbox,
      generatedXmlFolder: chosen
    })

    // Act
    const written = await exportRekordboxXml(dependencies())

    // Assert
    expect(written).toEqual({ ok: false, code: 'WRITE_FAILED' })
    expect(existsSync(join(home, 'Gone'))).toBe(false)
  })

  it('writes into the folder the user chose', async () => {
    // Arrange
    const chosen = join(home, 'Rekordbox')
    mkdirSync(chosen)
    setSetting(testDatabase.db, 'rekordbox', {
      ...DEFAULT_SETTINGS.rekordbox,
      generatedXmlFolder: chosen
    })

    // Act
    const written = await exportRekordboxXml(dependencies())

    // Assert
    expect(written).toMatchObject({
      ok: true,
      value: { path: join(chosen, 'fixlibrary.xml'), tracks: 0 }
    })
  })
})
