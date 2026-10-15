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
import { join } from 'path'
import { XMLParser } from 'fast-xml-parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  locationOf,
  saveRekordboxXml,
  writeRekordboxXml,
  type RekordboxCollection,
  type XmlTrack
} from './rekordbox-xml'

let folder: string

beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-xml-')))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function track(id: number, overrides: Partial<XmlTrack> = {}): XmlTrack {
  return {
    id,
    name: `Track ${id} (Original Mix)`,
    artist: 'Bicep',
    album: 'Isles',
    genre: 'Melodic House',
    label: 'Ninja Tune',
    mix: 'Original Mix',
    year: 2021,
    comments: 'E7 | Afro House',
    kind: 'MP3 File',
    sizeBytes: 12_345_678,
    totalTimeSeconds: 300,
    bitRateKbps: 320,
    sampleRateHz: 44_100,
    averageBpm: 124,
    tonality: 'Am',
    path: `/Volumes/DJ/Music/Melodic House/Bicep - Track ${id}.mp3`,
    cues: [],
    ...overrides
  }
}

const FIVE_TRACKS: RekordboxCollection = {
  tracks: [
    track(1, {
      cues: [
        { num: 0, name: 'Start', startSeconds: 0.5, color: '#22c55e' },
        { num: 3, name: 'Drop 1', startSeconds: 61.9375, color: '#ef4444' }
      ]
    }),
    track(2, { kind: 'AIFF File', genre: 'Tech House', averageBpm: 127.5 }),
    track(3, {
      name: 'Árvíztűrő tükörfúrógép',
      artist: 'Ünnep & "Barátok" <live>',
      path: '/Volumes/DJ/Music/Unsorted/Ünnep - Árvíztűrő #1 100%.mp3'
    }),
    track(4, {
      artist: null,
      album: null,
      label: null,
      mix: null,
      year: null,
      comments: null,
      averageBpm: null,
      tonality: null,
      sizeBytes: null,
      totalTimeSeconds: null,
      bitRateKbps: null,
      sampleRateHz: null
    }),
    track(5, { kind: 'WAV File', comments: 'E5' })
  ],
  stylePlaylists: [
    { name: 'Melodic House', trackIds: [1, 3] },
    { name: 'Tech House', trackIds: [2] },
    { name: 'Unsorted', trackIds: [] }
  ],
  playlists: [{ name: 'Friday warm-up', trackIds: [5, 1] }]
}

function parse(xml: string): Record<string, unknown> {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => ['TRACK', 'NODE', 'POSITION_MARK'].includes(name),
    parseAttributeValue: false
  }).parse(xml) as Record<string, unknown>
}

describe('writeRekordboxXml', () => {
  it('writes the collection, the style playlists and the Playlists folder of five tracks', () => {
    // Act
    const xml = writeRekordboxXml(FIVE_TRACKS, { appVersion: '0.0.1' })

    // Assert
    expect(xml).toMatchSnapshot()
  })

  it('puts every style right under the root and the user playlists into "Playlists"', () => {
    // Act
    const xml = parse(writeRekordboxXml(FIVE_TRACKS, { appVersion: '0.0.1' }))

    // Assert
    const root = (xml['DJ_PLAYLISTS'] as { PLAYLISTS: { NODE: Record<string, unknown>[] } })
      .PLAYLISTS.NODE[0] as {
      Name: string
      Type: string
      Count: string
      NODE: Record<string, unknown>[]
    }
    expect(root).toMatchObject({ Name: 'ROOT', Type: '0', Count: '4' })
    expect(root.NODE.map((node) => [node['Name'], node['Type']])).toEqual([
      ['Melodic House', '1'],
      ['Tech House', '1'],
      ['Unsorted', '1'],
      ['Playlists', '0']
    ])
    expect(root.NODE[0]).toMatchObject({
      KeyType: '0',
      Entries: '2',
      TRACK: [{ Key: '1' }, { Key: '3' }]
    })
    expect(root.NODE[3]).toMatchObject({
      Count: '1',
      NODE: [
        { Name: 'Friday warm-up', Type: '1', Entries: '2', TRACK: [{ Key: '5' }, { Key: '1' }] }
      ]
    })
  })

  it('escapes text, and leaves out what XML cannot hold and what is not known', () => {
    // Arrange
    const collection: RekordboxCollection = {
      tracks: [track(7, { name: 'Bad\u0001 name\u0000', comments: null, year: null })],
      stylePlaylists: [],
      playlists: []
    }

    // Act
    const xml = writeRekordboxXml(collection, { appVersion: '1.2.3' })

    // Assert
    const parsed = parse(xml) as {
      DJ_PLAYLISTS: { COLLECTION: { TRACK: Record<string, string>[] } }
    }
    const element = parsed.DJ_PLAYLISTS.COLLECTION.TRACK[0]
    expect(element?.['Name']).toBe('Bad name')
    expect(element).not.toHaveProperty('Comments')
    expect(element).not.toHaveProperty('Year')
    expect([...xml].some((character) => character.charCodeAt(0) < 0x09)).toBe(false)
  })

  it('names a hot cue A to H by Num 0 to 7, with its color as red, green and blue', () => {
    // Act
    const parsed = parse(writeRekordboxXml(FIVE_TRACKS, { appVersion: '0.0.1' })) as {
      DJ_PLAYLISTS: { COLLECTION: { TRACK: { POSITION_MARK?: Record<string, string>[] }[] } }
    }

    // Assert
    expect(parsed.DJ_PLAYLISTS.COLLECTION.TRACK[0]?.POSITION_MARK).toEqual([
      { Name: 'Start', Type: '0', Start: '0.500', Num: '0', Red: '34', Green: '197', Blue: '94' },
      { Name: 'Drop 1', Type: '0', Start: '61.938', Num: '3', Red: '239', Green: '68', Blue: '68' }
    ])
  })
})

describe('names and escaping', () => {
  it('gives a playlist whose name a sibling has the next free name, and keeps the folder "Playlists"', () => {
    // Arrange
    const collection: RekordboxCollection = {
      tracks: [],
      stylePlaylists: [
        { name: 'Playlists', trackIds: [] },
        { name: 'Tech House', trackIds: [] }
      ],
      playlists: [
        { name: 'Warm-up', trackIds: [] },
        { name: 'warm-up', trackIds: [] },
        { name: 'Tech House', trackIds: [] }
      ]
    }

    // Act
    const parsed = parse(writeRekordboxXml(collection, { appVersion: '0.0.1' })) as {
      DJ_PLAYLISTS: {
        PLAYLISTS: { NODE: { NODE: { Name: string; NODE?: { Name: string }[] }[] }[] }
      }
    }

    // Assert
    const root = parsed.DJ_PLAYLISTS.PLAYLISTS.NODE[0]?.NODE ?? []
    expect(root.map((node) => node.Name)).toEqual(['Playlists (2)', 'Tech House', 'Playlists'])
    expect(root[2]?.NODE?.map((node) => node.Name)).toEqual([
      'Warm-up',
      'warm-up (2)',
      'Tech House'
    ])
  })

  it('escapes both quotes, so tag text never ends an attribute', () => {
    // Act
    const xml = writeRekordboxXml(
      {
        tracks: [track(1, { artist: `x" Location="file://evil`, album: "it's" })],
        stylePlaylists: [],
        playlists: []
      },
      { appVersion: '0.0.1' }
    )

    // Assert
    expect(xml).toContain('Artist="x&quot; Location=&quot;file://evil"')
    expect(xml).toContain('Album="it&apos;s"')
    expect(xml.match(/ Location="/gu)).toHaveLength(1)
  })
})

describe('locationOf', () => {
  it.each([
    ['/Users/dj/Music/a.mp3', 'file://localhost/Users/dj/Music/a.mp3'],
    [
      '/Volumes/DJ USB/Tech House/a b.mp3',
      'file://localhost/Volumes/DJ%20USB/Tech%20House/a%20b.mp3'
    ],
    [
      '/Music/Ünnep/Árvíztűrő.mp3',
      'file://localhost/Music/%C3%9Cnnep/%C3%81rv%C3%ADzt%C5%B1r%C5%91.mp3'
    ],
    ['/Music/#1 100% ?.mp3', 'file://localhost/Music/%231%20100%25%20%3F.mp3'],
    ['/Music/R&B/a (Remix).mp3', 'file://localhost/Music/R&B/a%20(Remix).mp3']
  ])('spells %s as %s', (path, location) => {
    // Act
    const spelled = locationOf(path)

    // Assert
    expect(spelled).toBe(location)
  })

  it('is escaped in the XML where a character has to be', () => {
    // Act
    const xml = writeRekordboxXml(
      { tracks: [track(1, { path: '/Music/R&B/a.mp3' })], stylePlaylists: [], playlists: [] },
      { appVersion: '0.0.1' }
    )

    // Assert
    expect(xml).toContain('Location="file://localhost/Music/R&amp;B/a.mp3"')
  })
})

describe('saveRekordboxXml', () => {
  it('replaces the XML whole and leaves no temp file', async () => {
    // Arrange
    writeFileSync(join(folder, 'fixlibrary.xml'), 'old')

    // Act
    const path = await saveRekordboxXml(folder, '<new/>', { createFolder: false })

    // Assert
    expect(path).toBe(join(folder, 'fixlibrary.xml'))
    expect(readFileSync(path, 'utf8')).toBe('<new/>')
    expect(readdirSync(folder)).toEqual(['fixlibrary.xml'])
  })

  it('replaces a link at its name and leaves what the link points at alone', async () => {
    // Arrange
    const other = join(folder, 'other.txt')
    writeFileSync(other, 'mine')
    symlinkSync(other, join(folder, 'fixlibrary.xml'))

    // Act
    await saveRekordboxXml(folder, '<new/>', { createFolder: false })

    // Assert
    expect(readFileSync(other, 'utf8')).toBe('mine')
    expect(readFileSync(join(folder, 'fixlibrary.xml'), 'utf8')).toBe('<new/>')
  })

  it('makes its own folder only when told to', async () => {
    // Arrange
    const missing = join(folder, 'Documents', 'FixLibrary')

    // Act
    const refused = saveRekordboxXml(missing, '<x/>', { createFolder: false })

    // Assert
    await expect(refused).rejects.toThrow()
    expect(existsSync(missing)).toBe(false)
    await saveRekordboxXml(missing, '<x/>', { createFolder: true })
    expect(readFileSync(join(missing, 'fixlibrary.xml'), 'utf8')).toBe('<x/>')
  })

  it('puts nothing in place when the library changed meanwhile, and keeps the old XML', async () => {
    // Arrange
    writeFileSync(join(folder, 'fixlibrary.xml'), 'old')

    // Act
    const refused = saveRekordboxXml(folder, '<new/>', {
      createFolder: false,
      stillValid: () => false
    })

    // Assert
    await expect(refused).rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    expect(readFileSync(join(folder, 'fixlibrary.xml'), 'utf8')).toBe('old')
    expect(readdirSync(folder)).toEqual(['fixlibrary.xml'])
  })

  it('fails on a folder at its name and leaves no temp file', async () => {
    // Arrange
    mkdirSync(join(folder, 'fixlibrary.xml'))

    // Act
    const refused = saveRekordboxXml(folder, '<x/>', { createFolder: false })

    // Assert
    await expect(refused).rejects.toThrow()
    expect(readdirSync(folder)).toEqual(['fixlibrary.xml'])
  })

  it('removes the temp files an interrupted write left, and nothing else', async () => {
    // Arrange
    const left = '.fixlibrary.xml.0f8b7c1e-2d3a-4b5c-9d8e-1f2a3b4c5d6e.fixlib-tmp'
    const alike = '.fixlibrary.xml.mine.fixlib-tmp'
    writeFileSync(join(folder, left), 'half')
    writeFileSync(join(folder, alike), 'mine')
    writeFileSync(join(folder, 'notes.txt'), 'mine')

    // Act
    await saveRekordboxXml(folder, '<x/>', { createFolder: false })

    // Assert
    expect(readdirSync(folder).sort()).toEqual([alike, 'fixlibrary.xml', 'notes.txt'])
  })
})
