import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeRekordboxXml } from './rekordbox-xml'
import {
  fileStatesOf,
  findNewestExport,
  parseRekordboxXml,
  pathOfLocation,
  readExportBytes
} from './rekordbox-xml-read'

let folder: string

beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-xml-read-')))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

// An export as Rekordbox 7 writes it, edited by hand: an accented path, a track with a
// grid of three markers and two cues, one without a grid, one that is not a file URL.
const SAMPLE_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.7" Company="AlphaTheta"/>
  <COLLECTION Entries="4">
    <TRACK TrackID="101" Name="Glue" Artist="Bicep" Kind="MP3 File" TotalTime="300" AverageBpm="124.00" Tonality="Am" Location="file://localhost/Volumes/DJ/Music/%C3%9Cnnep/Bicep%20-%20Glue.mp3">
      <TEMPO Inizio="0.025" Bpm="124.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="60.025" Bpm="124.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="120.5" Bpm="126.00" Metro="4/4" Battito="3"/>
      <POSITION_MARK Name="" Type="0" Start="0.025" Num="-1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="61.960" Num="3" Red="239" Green="68" Blue="68"/>
    </TRACK>
    <TRACK TrackID="102" Name="Fresh" Kind="AIFF File" TotalTime="200" AverageBpm="0.00" Location="file://localhost/Users/dj/Music/Fresh%20%26%20New.aiff"/>
    <TRACK TrackID="103" Name="Decomposed" Location="file://localhost/Users/dj/Music/E%CC%81te%CC%81.mp3"/>
    <TRACK TrackID="104" Name="Stream" Location="https://example.com/a.mp3"/>
    <TRACK TrackID="oops" Name="Broken" Location="file://localhost/x.mp3"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Type="0" Name="Sets" Count="1">
        <NODE Name="Friday &amp; more" Type="1" KeyType="0" Entries="2">
          <TRACK Key="102"/>
          <TRACK Key="101"/>
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`

describe('parseRekordboxXml', () => {
  it('reads every track with its grid and cues, keyed by its composed path', () => {
    // Act
    const exported = parseRekordboxXml(SAMPLE_EXPORT)

    // Assert
    expect([...exported.tracks.keys()]).toEqual([
      '/Volumes/DJ/Music/Ünnep/Bicep - Glue.mp3',
      '/Users/dj/Music/Fresh & New.aiff',
      '/Users/dj/Music/Été.mp3'.normalize('NFC')
    ])
    expect(exported.tracks.get('/Volumes/DJ/Music/Ünnep/Bicep - Glue.mp3')).toEqual({
      trackId: 101,
      location: 'file://localhost/Volumes/DJ/Music/%C3%9Cnnep/Bicep%20-%20Glue.mp3',
      path: '/Volumes/DJ/Music/Ünnep/Bicep - Glue.mp3',
      averageBpm: 124,
      tonality: 'Am',
      totalTime: 300,
      tempos: [
        { inizio: 0.025, bpm: 124, metro: '4/4', battito: 1 },
        { inizio: 60.025, bpm: 124, metro: '4/4', battito: 1 },
        { inizio: 120.5, bpm: 126, metro: '4/4', battito: 3 }
      ],
      positionMarks: [
        { name: '', type: 0, start: 0.025, num: -1 },
        { name: 'Drop', type: 0, start: 61.96, num: 3 }
      ]
    })
    expect(exported.tracks.get('/Users/dj/Music/Fresh & New.aiff')?.tempos).toEqual([])
    expect(exported.unplaced.map((track) => track.trackId)).toEqual([104])
    expect(exported.skipped).toBe(1)
  })

  it('reads the playlists as a tree', () => {
    // Act
    const exported = parseRekordboxXml(SAMPLE_EXPORT)

    // Assert
    expect(exported.playlists).toEqual({
      name: 'ROOT',
      kind: 'folder',
      trackIds: [],
      children: [
        {
          name: 'Sets',
          kind: 'folder',
          trackIds: [],
          children: [
            { name: 'Friday & more', kind: 'playlist', trackIds: [102, 101], children: [] }
          ]
        }
      ]
    })
  })

  it('reads back what the app wrote', () => {
    // Act
    const exported = parseRekordboxXml(
      writeRekordboxXml(
        {
          tracks: [
            {
              id: 3,
              name: 'Árvíztűrő',
              artist: null,
              album: null,
              genre: null,
              label: null,
              mix: null,
              year: null,
              comments: null,
              kind: 'MP3 File',
              sizeBytes: null,
              totalTimeSeconds: null,
              bitRateKbps: null,
              sampleRateHz: null,
              averageBpm: null,
              tonality: null,
              path: '/Volumes/DJ/Music/Unsorted/Ünnep - Árvíztűrő #1 100%.mp3',
              tempos: [
                { inizio: 0.025, bpm: 124, metro: '4/4', battito: 1 },
                { inizio: 61.5, bpm: 126.5, metro: '4/4', battito: 3 }
              ],
              cues: []
            }
          ],
          stylePlaylists: [],
          playlists: []
        },
        { appVersion: '0.0.1' }
      )
    )

    // Assert
    expect(exported.tracks.size).toBe(1)
    // The grid goes back as it came: an import keeps Rekordbox's own.
    expect(
      exported.tracks.get('/Volumes/DJ/Music/Unsorted/Ünnep - Árvíztűrő #1 100%.mp3')?.tempos
    ).toEqual([
      { inizio: 0.025, bpm: 124, metro: '4/4', battito: 1 },
      { inizio: 61.5, bpm: 126.5, metro: '4/4', battito: 3 }
    ])
    expect(
      exported.tracks.get('/Volumes/DJ/Music/Unsorted/Ünnep - Árvíztűrő #1 100%.mp3')?.trackId
    ).toBe(3)
  })

  it.each([
    ['a DOCTYPE', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><DJ_PLAYLISTS/>'],
    ['no DJ_PLAYLISTS', '<?xml version="1.0"?><PLAYLIST/>']
  ])('refuses an export with %s', (_what, xml) => {
    // Act
    const read = (): unknown => parseRekordboxXml(xml)

    // Assert
    expect(read).toThrow()
  })
})

describe('findNewestExport', () => {
  it('finds the newest XML of the folder, not the app own, not a hidden one and not a link', async () => {
    // Arrange
    const older = join(folder, 'old.xml')
    const newer = join(folder, 'rekordbox.XML')
    writeFileSync(older, '<a/>')
    writeFileSync(newer, '<b/>')
    writeFileSync(join(folder, 'fixlibrary.xml'), '<c/>')
    writeFileSync(join(folder, '.hidden.xml'), '<d/>')
    symlinkSync(older, join(folder, 'link.xml'))
    const now = Date.now() / 1000
    utimesSync(older, now - 100, now - 100)
    utimesSync(newer, now - 10, now - 10)
    utimesSync(join(folder, 'fixlibrary.xml'), now, now)
    utimesSync(join(folder, '.hidden.xml'), now, now)

    // Act
    const found = await findNewestExport(folder)

    // Assert
    expect(found?.path).toBe(newer)
  })

  it('finds nothing in a folder without an export', async () => {
    // Arrange
    writeFileSync(join(folder, 'fixlibrary.xml'), '<c/>')

    // Act
    const found = await findNewestExport(folder)

    // Assert
    expect(found).toBeNull()
  })
})

describe('fileStatesOf', () => {
  it('tells a file that is there from one that is not, and a folder is no file', async () => {
    // Arrange
    const there = join(folder, 'a.mp3')
    writeFileSync(there, 'x')
    mkdirSync(join(folder, 'folder.mp3'))

    // Act
    const states = await fileStatesOf([
      there,
      join(folder, 'b.mp3'),
      join(folder, 'folder.mp3'),
      join(there, 'inside.mp3')
    ])

    // Assert
    expect([...states.values()]).toEqual(['present', 'absent', 'absent', 'absent'])
  })
})

/** An export of one collection; the tracks given as their TRACK elements. */
function exportOf(tracks: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION>${tracks}</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Name="One" Type="1" KeyType="0" Entries="1"><TRACK Key="1"/></NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>`
}

describe('parseRekordboxXml, item by item', () => {
  it('drops the whole grid of a track with a marker that is not what Rekordbox writes, and keeps its cues', () => {
    // Arrange
    const xml = exportOf(
      '<TRACK TrackID="1" Location="file://localhost/a.mp3"><TEMPO Inizio="" Bpm="120" Metro="4/4" Battito="1"/><TEMPO Inizio="1.5" Bpm="120" Metro="4/4" Battito="99"/><TEMPO Inizio="2" Bpm="120" Metro="4/4" Battito="2"/><POSITION_MARK Name="A" Type="0" Start="2" Num="0"/></TRACK>' +
        '<TRACK TrackID="2" Location="file://localhost/b.mp3"><TEMPO Inizio="0" Bpm="128" Metro="4/4" Battito="1"/></TRACK>'
    )

    // Act
    const exported = parseRekordboxXml(xml)

    // Assert
    expect(exported.tracks.get('/a.mp3')?.tempos).toEqual([])
    expect(exported.tracks.get('/a.mp3')?.positionMarks).toEqual([
      { name: 'A', type: 0, start: 2, num: 0 }
    ])
    expect(exported.tracks.get('/b.mp3')?.tempos).toHaveLength(1)
    expect(exported.playlists?.children).toEqual([
      { name: 'One', kind: 'playlist', trackIds: [1], children: [] }
    ])
  })

  it.each([
    ['a tempo below 20', '<TEMPO Inizio="0" Bpm="19.9" Metro="4/4" Battito="1"/>'],
    ['a tempo above 999', '<TEMPO Inizio="0" Bpm="999.5" Metro="4/4" Battito="1"/>'],
    ['a marker past two hours', '<TEMPO Inizio="7200.5" Bpm="120" Metro="4/4" Battito="1"/>'],
    ['more than 4000 markers', '<TEMPO Inizio="0" Bpm="120" Metro="4/4" Battito="1"/>'.repeat(4001)]
  ])('has no grid for a track with %s', (_, tempos) => {
    // Arrange
    const xml = exportOf(`<TRACK TrackID="1" Location="file://localhost/a.mp3">${tempos}</TRACK>`)

    // Act
    const exported = parseRekordboxXml(xml)

    // Assert
    expect(exported.tracks.get('/a.mp3')?.tempos).toEqual([])
  })

  it('keeps the entry with a grid of two that name one file', () => {
    // Arrange
    const xml = exportOf(
      '<TRACK TrackID="1" Location="file://localhost/a.mp3"><TEMPO Inizio="0" Bpm="120" Metro="4/4" Battito="1"/></TRACK>' +
        '<TRACK TrackID="2" Location="file://localhost/a.mp3"/>'
    )

    // Act
    const exported = parseRekordboxXml(xml)

    // Assert
    expect(exported.tracks.get('/a.mp3')?.trackId).toBe(1)
  })
})

describe('pathOfLocation', () => {
  it.each([
    ['file://localhost/Music/a%20b.mp3', '/Music/a b.mp3'],
    ['file:///Music/a.mp3', '/Music/a.mp3'],
    ['FILE://LOCALHOST/Music/a.mp3', '/Music/a.mp3'],
    ['file://localhost/Music/#1 hit?.mp3', '/Music/#1 hit?.mp3'],
    ['file://localhost/Music/100%25 and 50% off.mp3', '/Music/100% and 50% off.mp3'],
    ['file://localhost/Music/E%CC%81.mp3', '/Music/É.mp3'],
    ['file://localhost/Music/../etc/passwd', null],
    ['file://localhost/Music/a%00.mp3', null],
    ['file://server/Music/a.mp3', null],
    ['https://example.com/a.mp3', null]
  ])('reads %s as %s', (location, path) => {
    // Act
    const read = pathOfLocation(location)

    // Assert
    expect(read).toBe(path)
  })
})

describe('readExportBytes', () => {
  it('reads a plain file', async () => {
    // Arrange
    writeFileSync(join(folder, 'a.xml'), '<x/>')

    // Act
    const bytes = await readExportBytes(join(folder, 'a.xml'))

    // Assert
    expect(bytes.toString('utf8')).toBe('<x/>')
  })

  it.each([
    [
      'a file over the cap',
      (): string => {
        writeFileSync(join(folder, 'big.xml'), 'x'.repeat(101))
        return join(folder, 'big.xml')
      }
    ],
    [
      'a link',
      (): string => {
        writeFileSync(join(folder, 'a.xml'), '<x/>')
        symlinkSync(join(folder, 'a.xml'), join(folder, 'link.xml'))
        return join(folder, 'link.xml')
      }
    ],
    [
      'a pipe that never ends',
      (): string => {
        execFileSync('mkfifo', [join(folder, 'pipe.xml')])
        return join(folder, 'pipe.xml')
      }
    ]
  ])('refuses %s', async (_what, arrange) => {
    // Arrange
    const path = arrange()

    // Act
    const read = readExportBytes(path, 100)

    // Assert
    await expect(read).rejects.toThrow()
  })
})
