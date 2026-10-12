import { describe, expect, it } from 'vitest'
import { MAX_FILE_NAME_LENGTH, unusableNameReason } from '@shared/file-names'
import { isJunkBracket } from '@shared/junk-patterns'
import {
  cleanNames,
  formatFileName,
  isBuiltFileName,
  MAX_FILE_NAME_BYTES,
  parseFileName,
  removeJunk,
  type FileNameParts
} from './naming'

const ANALYSED = { camelot: '8A', bpm: 124, energy: 7 }

/** The file name the app gives a file that is named `fileName` and has no tags. */
function renamed(fileName: string, analysis: Partial<FileNameParts> = ANALYSED): string | null {
  const extension = /\.[^.]+$/.exec(fileName)?.[0] ?? ''
  return formatFileName({
    camelot: null,
    bpm: null,
    energy: null,
    ...analysis,
    ...cleanNames(parseFileName(fileName)),
    extension
  })
}

describe('a file name, cleaned and formatted', () => {
  // Input file name, and the name it gets with the key 8A, 124 BPM and energy 7.
  it.each([
    // The cases of the task.
    ['01. Artist_-_Title (Official Video) [HD].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (feat. X).mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Original Mix).mp3', 'Artist - Title (Original Mix) [8A Am - 124 - E7].mp3'],
    ['Artist - Title (X Remix).mp3', 'Artist - Title (X Remix) [8A Am - 124 - E7].mp3'],
    ['Ákos - Ilyenek voltunk.mp3', 'Ákos - Ilyenek voltunk [8A Am - 124 - E7].mp3'],
    ['AC:DC - Back in Black.mp3', 'AC-DC - Back in Black [8A Am - 124 - E7].mp3'],
    // The usual patterns of a file name.
    ['Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['01 Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['1. Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['12) Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['07 - Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist_-_Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Some_Artist_-_Some_Title.wav', 'Some Artist - Some Title [8A Am - 124 - E7].wav'],
    ['A1 Artist - Title.aiff', 'Artist - Title [8A Am - 124 - E7].aiff'],
    ['B2 Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist – Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist  -  Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Just A Title.mp3', 'Just A Title [8A Am - 124 - E7].mp3'],
    ['track_07.mp3', 'track 07 [8A Am - 124 - E7].mp3'],
    ['Artist - Title - Live at Home.mp3', 'Artist - Title - Live at Home [8A Am - 124 - E7].mp3'],
    ['01.Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['01 - Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['7 - Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    // A file the app named before gets the same name again, not a second bracket.
    ['Artist - Title [8A Am - 124 - E7].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Dub) [11B A - 128].mp3', 'Artist - Title (Dub) [8A Am - 124 - E7].mp3'],
    ['Artist - Title [12A Dbm].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [8A Am].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [8A Am - 124] (2).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Mix) (Mix).mp3', 'Artist - Title (Mix) [8A Am - 124 - E7].mp3'],
    ['Daft\u00a0Punk - One\u2003More.mp3', 'Daft Punk - One More [8A Am - 124 - E7].mp3'],
    ['Artist - Acid Trax [303].mp3', 'Artist - Acid Trax [303] [8A Am - 124 - E7].mp3'],
    [
      'Artist - Title [2F#m - 99 - E10].mp3',
      'Artist - Title [2F#m - 99 - E10] [8A Am - 124 - E7].mp3'
    ],
    [
      'Artist - Title [Remastered 2019].mp3',
      'Artist - Title (Remastered 2019) [8A Am - 124 - E7].mp3'
    ],
    ['Artist - Title [1999].mp3', 'Artist - Title [1999] [8A Am - 124 - E7].mp3'],
    // Numbers that are names, not track numbers.
    ['311 - Amber.mp3', '311 - Amber [8A Am - 124 - E7].mp3'],
    ['112 - Peaches & Cream.mp3', '112 - Peaches & Cream [8A Am - 124 - E7].mp3'],
    ['50.Cent - In Da Club.mp3', '50.Cent - In Da Club [8A Am - 124 - E7].mp3'],
    ['1.FC Köln - Hymne.mp3', '1.FC Köln - Hymne [8A Am - 124 - E7].mp3'],
    ['3.14 Pi.mp3', '3.14 Pi [8A Am - 124 - E7].mp3'],
    ['7 - Seven.mp3', '7 - Seven [8A Am - 124 - E7].mp3'],
    ['50 Cent - In Da Club.mp3', '50 Cent - In Da Club [8A Am - 124 - E7].mp3'],
    ['2 Unlimited - No Limit.mp3', '2 Unlimited - No Limit [8A Am - 124 - E7].mp3'],
    ['808 State - Pacific.mp3', '808 State - Pacific [8A Am - 124 - E7].mp3'],
    ['U2 - One.mp3', 'U2 - One [8A Am - 124 - E7].mp3'],
    ['B2B.mp3', 'B2B [8A Am - 124 - E7].mp3'],
    ['A1 Steak Sauce.mp3', 'A1 Steak Sauce [8A Am - 124 - E7].mp3'],
    ['99 Luftballons.mp3', '99 Luftballons [8A Am - 124 - E7].mp3'],
    // Junk in brackets.
    ['Artist - Title (Official Music Video).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Official Audio).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Official Visualizer).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Visualizer).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Lyric Video).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Official Lyric Video).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Lyrics).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Audio).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Premiere).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [HQ].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [4K].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [320kbps].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [320 kbps].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [OUT NOW].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Free Download).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [Free Download].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [FREE DL].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (official video) (HD).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['ARTIST - TITLE (OFFICIAL VIDEO).mp3', 'ARTIST - TITLE [8A Am - 124 - E7].mp3'],
    [
      'Artist - Title (Extended Mix) [Free Download].mp3',
      'Artist - Title (Extended Mix) [8A Am - 124 - E7].mp3'
    ],
    // Web addresses.
    ['Artist - Title www.djsite.com.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [mp3site.net].mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (https://example.org/x).mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    ['djpool.com - Artist - Title.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    // What looks like junk and is not.
    ['Artist - Audio.mp3', 'Artist - Audio [8A Am - 124 - E7].mp3'],
    ['Artist - Lyrics to Go.mp3', 'Artist - Lyrics to Go [8A Am - 124 - E7].mp3'],
    ['Artist - Free Download.mp3', 'Artist - Free Download [8A Am - 124 - E7].mp3'],
    ['Artist - HD Dreams.mp3', 'Artist - HD Dreams [8A Am - 124 - E7].mp3'],
    [
      'Artist - Title (Audio Bullys Remix).mp3',
      'Artist - Title (Audio Bullys Remix) [8A Am - 124 - E7].mp3'
    ],
    ['Artist - Title (Part 2).mp3', 'Artist - Title (Part 2) [8A Am - 124 - E7].mp3'],
    ['Artist - Premiere.mp3', 'Artist - Premiere [8A Am - 124 - E7].mp3'],
    ['Artist - Mr. Compton.mp3', 'Artist - Mr. Compton [8A Am - 124 - E7].mp3'],
    // Mixes.
    ['Artist - Title (Extended Mix).mp3', 'Artist - Title (Extended Mix) [8A Am - 124 - E7].mp3'],
    ['Artist - Title [Radio Edit].mp3', 'Artist - Title (Radio Edit) [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Âme Remix).mp3', 'Artist - Title (Âme Remix) [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Dub).mp3', 'Artist - Title (Dub) [8A Am - 124 - E7].mp3'],
    ['Artist - Title (VIP).mp3', 'Artist - Title (VIP) [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Instrumental).mp3', 'Artist - Title (Instrumental) [8A Am - 124 - E7].mp3'],
    [
      'Artist - Title (Part 2) (Club Mix).mp3',
      'Artist - Title (Part 2) (Club Mix) [8A Am - 124 - E7].mp3'
    ],
    ['Artist - Title (2019 Remaster).mp3', 'Artist - Title (2019 Remaster) [8A Am - 124 - E7].mp3'],
    // Guests.
    ['Artist - Title ft. X.mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    // Without a dot and without brackets the word may be a word of the title.
    ['Artist - Title ft X.mp3', 'Artist - Title ft X [8A Am - 124 - E7].mp3'],
    ['Artist - Title feat X.mp3', 'Artist - Title feat X [8A Am - 124 - E7].mp3'],
    ['Artist - Title feat. X.mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    [
      'Artist - Song feat. X - Radio Edit.mp3',
      'Artist feat. X - Song - Radio Edit [8A Am - 124 - E7].mp3'
    ],
    ['Artist - Trip to Ft Lauderdale.mp3', 'Artist - Trip to Ft Lauderdale [8A Am - 124 - E7].mp3'],
    ['Artist - The Feat of Strength.mp3', 'Artist - The Feat of Strength [8A Am - 124 - E7].mp3'],
    // A guest is known by its whole name, not by letters the artist happens to hold.
    ['Fred Again - Delilah (feat. Ed).mp3', 'Fred Again feat. Ed - Delilah [8A Am - 124 - E7].mp3'],
    ['Alan & Al - Song (feat. Al).mp3', 'Alan & Al - Song [8A Am - 124 - E7].mp3'],
    ['Artist - Title featuring X.mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title (Feat. X).mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    ['Artist - Title [ft. X & Y].mp3', 'Artist feat. X & Y - Title [8A Am - 124 - E7].mp3'],
    ['Artist ft. X - Title.mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    ['Artist Featuring X - Title.mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    ['Artist feat. X - Title (feat. X).mp3', 'Artist feat. X - Title [8A Am - 124 - E7].mp3'],
    [
      'Artist - Title (feat. X) (Extended Mix).mp3',
      'Artist feat. X - Title (Extended Mix) [8A Am - 124 - E7].mp3'
    ],
    [
      'Artist - Title feat. X (Y Remix).mp3',
      'Artist feat. X - Title (Y Remix) [8A Am - 124 - E7].mp3'
    ],
    [
      'Artist - Title (feat. X) (feat. Y).mp3',
      'Artist feat. X feat. Y - Title [8A Am - 124 - E7].mp3'
    ],
    // The word as part of a name.
    ['Ft Lauderdale - Sunrise.mp3', 'Ft Lauderdale - Sunrise [8A Am - 124 - E7].mp3'],
    ['The Feat - Song.mp3', 'The Feat - Song [8A Am - 124 - E7].mp3'],
    ['Artist - 6 ft Under.mp3', 'Artist - 6 ft Under [8A Am - 124 - E7].mp3'],
    ['Daft Punk - Aerodynamic.mp3', 'Daft Punk - Aerodynamic [8A Am - 124 - E7].mp3'],
    ['Artist - Left Behind.mp3', 'Artist - Left Behind [8A Am - 124 - E7].mp3'],
    ['Artist - Soft Featherbed.mp3', 'Artist - Soft Featherbed [8A Am - 124 - E7].mp3'],
    // What a file system refuses.
    ['Artist - What Is Love?.mp3', 'Artist - What Is Love [8A Am - 124 - E7].mp3'],
    ['Artist - 12" Mix Thing.mp3', "Artist - 12' Mix Thing [8A Am - 124 - E7].mp3"],
    ['Artist - A*B<C>D|E.mp3', 'Artist - A-B-C-D-E [8A Am - 124 - E7].mp3'],
    ['.hidden - Title.mp3', 'hidden - Title [8A Am - 124 - E7].mp3'],
    ['Artist - 👨\u200d👩\u200d👧 Family.mp3', 'Artist - 👨👩👧 Family [8A Am - 124 - E7].mp3'],
    ['Artist - Half\ud800Char.mp3', 'Artist - HalfChar [8A Am - 124 - E7].mp3'],
    ['Artist - Blank\u2800\u115f\ufe0fTitle.mp3', 'Artist - BlankTitle [8A Am - 124 - E7].mp3'],
    ['Artist - Title\u202e.mp3', 'Artist - Title [8A Am - 124 - E7].mp3'],
    // Everything at once.
    [
      '03. Dj_Name_ft._MC_Guest_-_Big_Tune_(Original_Mix)_[FREE_DOWNLOAD]_www.site.com.mp3',
      'Dj Name feat. MC Guest - Big Tune (Original Mix) [8A Am - 124 - E7].mp3'
    ],
    [
      'A2 Ákos_-_Szindbád_dala_(Official_Audio)_[HQ].wav',
      'Ákos - Szindbád dala [8A Am - 124 - E7].wav'
    ]
  ])('%s  →  %s', (fileName, expected) => {
    // Act
    const name = renamed(fileName)

    // Assert
    expect(name).toBe(expected)
    expect(unusableNameReason(name ?? '', 'file')).toBeNull()
  })
})

describe('a file the app has named', () => {
  // Every name the first table expects, and a few more shapes of it.
  const built = [
    'Artist - Title [8A Am - 124 - E7].mp3',
    'Artist feat. X - Title (Extended Mix) [8A Am - 124 - E7].mp3',
    'Artist feat. X feat. Y - Title [8A Am - 124 - E7].mp3',
    'Artist - Title (Part 2) (Club Mix) [8A Am - 124 - E7].mp3',
    'Artist - Title - Live at Home [8A Am - 124 - E7].mp3',
    'Artist - Title [2F#m - 99 - E10] [8A Am - 124 - E7].mp3',
    'Artist - Acid Trax [303] [8A Am - 124 - E7].mp3',
    'Artist - Title ft X [8A Am - 124 - E7].mp3',
    'Ákos - Szindbád dala [8A Am - 124 - E7].wav',
    'Just A Title [8A Am - 124 - E7].mp3',
    "Artist - 12' Mix Thing [8A Am - 124 - E7].mp3",
    '50 Cent - In Da Club [8A Am - 124 - E7].mp3',
    '311 - Amber [8A Am - 124 - E7].mp3',
    'Ft Lauderdale - Sunrise [8A Am - 124 - E7].mp3'
  ]

  it.each(built)('keeps its name when it is named again: %s', (name) => {
    expect(renamed(name)).toBe(name)
  })

  it.each(built)('gets only its new analysis when that has changed: %s', (name) => {
    const again = renamed(name, { camelot: '11B', bpm: 128, energy: null })

    expect(again).toBe(name.replace('[8A Am - 124 - E7]', '[11B A - 128]'))
  })

  it('keeps its name without a key as well, where it has no bracketed part', () => {
    const first = renamed('01. Artist_-_Title [HD].mp3', { camelot: null, bpm: 124, energy: 7 })

    expect(first).toBe('Artist - Title.mp3')
    expect(renamed(first as string, { camelot: null, bpm: 124, energy: 7 })).toBe(first)
  })
})

describe('formatFileName', () => {
  const names = { artist: 'Artist', title: 'Title', mix: 'Extended Mix', extension: '.mp3' }

  it.each([
    [
      { camelot: '8A', bpm: 124, energy: 7 },
      'Artist - Title (Extended Mix) [8A Am - 124 - E7].mp3'
    ],
    // The energy joins the name once it is known.
    [{ camelot: '8A', bpm: 124, energy: null }, 'Artist - Title (Extended Mix) [8A Am - 124].mp3'],
    [
      { camelot: '11B', bpm: 123.6, energy: 10 },
      'Artist - Title (Extended Mix) [11B A - 124 - E10].mp3'
    ],
    // Without a key there is no bracketed part at all: it always starts with one.
    [{ camelot: null, bpm: 124, energy: 7 }, 'Artist - Title (Extended Mix).mp3'],
    [{ camelot: '12A', bpm: null, energy: null }, 'Artist - Title (Extended Mix) [12A Dbm].mp3'],
    [{ camelot: null, bpm: null, energy: null }, 'Artist - Title (Extended Mix).mp3'],
    [{ camelot: 'nonsense', bpm: 124, energy: null }, 'Artist - Title (Extended Mix).mp3'],
    // A row of the database can hold anything: only a real tempo and energy are written.
    [{ camelot: '8A', bpm: Number.NaN, energy: 7.5 }, 'Artist - Title (Extended Mix) [8A Am].mp3'],
    [{ camelot: '8A', bpm: Infinity, energy: 0 }, 'Artist - Title (Extended Mix) [8A Am].mp3'],
    [{ camelot: null, bpm: -5, energy: 11 }, 'Artist - Title (Extended Mix).mp3']
  ])('writes the analysis it has: %j', (analysis, expected) => {
    expect(formatFileName({ ...names, ...analysis })).toBe(expected)
  })

  it('names a track without an artist by its title, and one without both not at all', () => {
    const analysis = { camelot: '8A', bpm: 124, energy: null, mix: null, extension: '.mp3' }

    expect(formatFileName({ ...analysis, artist: null, title: 'Title' })).toBe(
      'Title [8A Am - 124].mp3'
    )
    expect(formatFileName({ ...analysis, artist: 'Artist', title: null })).toBe(
      'Artist [8A Am - 124].mp3'
    )
    expect(formatFileName({ ...analysis, artist: null, title: null })).toBeNull()
    expect(formatFileName({ ...analysis, artist: ' ', title: '?' })).toBeNull()
  })

  it('writes the name composed, whatever form it was given in', () => {
    const decomposed = 'Ákos'

    const name = formatFileName({ ...names, ...ANALYSED, artist: decomposed })

    expect(name).toBe('Ákos - Title (Extended Mix) [8A Am - 124 - E7].mp3')
    expect(name).toBe(name?.normalize('NFC'))
  })

  it('shortens the title of a name that is too long, and keeps the bracketed part', () => {
    const title = 'Nagyon hosszú cím '.repeat(30)

    const name = formatFileName({ ...names, ...ANALYSED, title }) as string

    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    expect(name.startsWith('Artist - Nagyon hosszú cím Nagyon')).toBe(true)
    expect(name.endsWith(' (Extended Mix) [8A Am - 124 - E7].mp3')).toBe(true)
    expect(unusableNameReason(name, 'file')).toBeNull()
  })

  it('counts the length in bytes: a name of accented letters is cut sooner', () => {
    const plain = formatFileName({ ...names, ...ANALYSED, title: 'a'.repeat(400) }) as string
    const accented = formatFileName({ ...names, ...ANALYSED, title: 'ű'.repeat(400) }) as string

    // Plain letters run into the limit of characters first, accented ones into that of bytes.
    expect(plain).toHaveLength(MAX_FILE_NAME_LENGTH)
    expect(Buffer.byteLength(accented, 'utf8')).toBeGreaterThan(MAX_FILE_NAME_BYTES - 2)
    expect(Buffer.byteLength(accented, 'utf8')).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    expect(Array.from(accented).length).toBeLessThan(Array.from(plain).length)
  })

  it('is done at once with names far longer than a name can be', () => {
    const started = performance.now()

    const name = formatFileName({
      ...names,
      ...ANALYSED,
      artist: 'a'.repeat(100_000),
      title: 'ű'.repeat(100_000)
    }) as string

    expect(performance.now() - started).toBeLessThan(1000)
    expect(name.endsWith(' (Extended Mix) [8A Am - 124 - E7].mp3')).toBe(true)
  })

  it('never cuts a character in two', () => {
    const name = formatFileName({ ...names, ...ANALYSED, title: '🎧'.repeat(200) }) as string

    expect(name).toBe(name.toWellFormed())
    expect(name.endsWith(' (Extended Mix) [8A Am - 124 - E7].mp3')).toBe(true)
  })

  it('cuts a mix by its bytes too, and still names the file', () => {
    const name = formatFileName({ ...names, ...ANALYSED, mix: '混'.repeat(80) }) as string

    expect(name).toMatch(/^Artist - Title \(混+\) \[8A Am - 124 - E7\]\.mp3$/)
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
  })

  it('is done at once with a name of combining marks without end', () => {
    const marks = `a${'\u0301\u0327'.repeat(100_000)}`
    const started = performance.now()

    const name = formatFileName({ ...names, ...ANALYSED, artist: marks, title: marks, mix: marks })

    expect(performance.now() - started).toBeLessThan(1000)
    expect(name === null || isBuiltFileName(name)).toBe(true)
  })

  it('cuts a mix that is no mix name, so that the names keep their room', () => {
    const name = formatFileName({
      ...names,
      ...ANALYSED,
      mix: 'Very Long Remix '.repeat(40)
    }) as string

    expect(name.startsWith('Artist - Title (Very Long Remix')).toBe(true)
    expect(name.endsWith(') [8A Am - 124 - E7].mp3')).toBe(true)
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThan(150)
  })

  it('shortens the artist as well when the title alone is not enough', () => {
    const name = formatFileName({
      ...names,
      ...ANALYSED,
      artist: 'Előadó '.repeat(80),
      title: 'T'
    }) as string

    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES)
    expect(name.endsWith(' - T (Extended Mix) [8A Am - 124 - E7].mp3')).toBe(true)
  })
})

describe('isBuiltFileName', () => {
  it('accepts every name the format builds', () => {
    const built = formatFileName({
      ...ANALYSED,
      artist: 'Ákos ft. "X"',
      title: 'Mi? / Ki: *',
      mix: 'Dub',
      extension: '.aiff'
    })

    expect(built).toBe("Ákos ft. 'X' - Mi - Ki- - (Dub) [8A Am - 124 - E7].aiff")
    expect(isBuiltFileName(built ?? '')).toBe(true)
  })

  it.each([
    'a/b.mp3',
    '.a.mp3',
    'a.txt',
    'a?.mp3',
    'a|b.mp3',
    ' a.mp3',
    'a\u200d.mp3',
    `${'a'.repeat(230)}.mp3`
  ])('refuses %j', (name) => {
    expect(isBuiltFileName(name)).toBe(false)
  })

  it('refuses a space that is not the plain one', () => {
    expect(isBuiltFileName('Daft\u00a0Punk.mp3')).toBe(false)
    expect(isBuiltFileName('Daft\u3000Punk.mp3')).toBe(false)
    expect(isBuiltFileName('Daft Punk.mp3')).toBe(true)
  })
})

describe('cleanNames', () => {
  it('cleans the names a lookup or a tag gave, not only a file name', () => {
    const cleaned = cleanNames({
      artist: 'Daft Punk Ft. Pharrell Williams',
      title: 'Get Lucky (Radio Edit) [Official Audio]',
      mix: null
    })

    expect(cleaned).toEqual({
      artist: 'Daft Punk feat. Pharrell Williams',
      title: 'Get Lucky',
      mix: 'Radio Edit'
    })
  })

  it('keeps a mix that is known already, and takes its double out of the title', () => {
    const cleaned = cleanNames({ artist: 'A', title: 'T (Extended Mix)', mix: '(Extended Mix)' })

    expect(cleaned).toEqual({ artist: 'A', title: 'T', mix: 'Extended Mix' })
  })

  it('takes what the app wrote into a file name out of a title tag as well', () => {
    const cleaned = cleanNames({ artist: 'A', title: 'T [8A Am - 124 - E7]', mix: null })

    expect(cleaned).toEqual({ artist: 'A', title: 'T', mix: null })
  })

  it('leaves another version in the title when the mix is known already', () => {
    const cleaned = cleanNames({ artist: 'A', title: 'T (Radio Edit)', mix: 'Extended Mix' })

    expect(cleaned).toEqual({ artist: 'A', title: 'T (Radio Edit)', mix: 'Extended Mix' })
  })

  it('takes the last version named in a title as the mix, and keeps the others in the title', () => {
    const cleaned = cleanNames({ artist: 'A', title: 'T (Joe Remix) [Radio Edit]', mix: null })

    expect(cleaned).toEqual({ artist: 'A', title: 'T (Joe Remix)', mix: 'Radio Edit' })
    expect(cleanNames(cleaned)).toEqual(cleaned)
  })

  it.each([
    [
      ['title'],
      { artist: 'A ft B', title: 'Song (Original Mix) (feat. X) [HD]', mix: null },
      { artist: 'A feat. B', title: 'Song (Original Mix) (feat. X) [HD]', mix: null }
    ],
    [
      ['mix'],
      { artist: 'A', title: 'Song (Radio Edit)', mix: 'Dub' },
      { artist: 'A', title: 'Song (Radio Edit)', mix: 'Dub' }
    ],
    [
      ['artist'],
      { artist: 'A ft B [HD]', title: 'Song (feat. X) (Dub)', mix: null },
      { artist: 'A ft B [HD]', title: 'Song (feat. X)', mix: 'Dub' }
    ],
    [
      ['artist', 'title', 'mix'],
      { artist: 'www.a.com', title: '(Audio)', mix: '[HD]' },
      { artist: 'www.a.com', title: '(Audio)', mix: '[HD]' }
    ]
  ] as const)(
    'gives back a name in keep %j as it was, and takes nothing out of it',
    (keep, given, expected) => {
      expect(cleanNames(given, { keep })).toEqual(expected)
    }
  )

  it('is the same the second time, whatever it was given', () => {
    const given = [
      { artist: 'A ft B', title: 'T (Remix) (Dub)', mix: null },
      { artist: null, title: 'T (feat. X) (feat. Y) [Edit]', mix: null },
      { artist: 'A', title: 'T (Remix (Dub))', mix: null },
      { artist: 'A Featuring B', title: 'T ft. C (Official Video)', mix: '(Extended Mix)' }
    ]

    for (const names of given) {
      const once = cleanNames(names)

      expect(cleanNames(once)).toEqual(once)
    }
  })

  it('is done at once with text made to keep it busy', () => {
    const spaces = ' '.repeat(50_000)
    const hostile = [
      `12${spaces}-${spaces}`,
      `(feat${spaces}${'x'.repeat(50_000)}`,
      `${'a'.repeat(100_000)}!`,
      'a.'.repeat(50_000),
      '('.repeat(50_000),
      ' ft '.repeat(20_000)
    ]
    const started = performance.now()

    for (const text of hostile) {
      cleanNames({ artist: text, title: text, mix: text })
      parseFileName(`${text}.mp3`)
    }

    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('names a track by its guest when it has no artist', () => {
    expect(cleanNames({ artist: null, title: 'Title (feat. X)', mix: null })).toEqual({
      artist: 'X',
      title: 'Title',
      mix: null
    })
  })

  it('gives back nothing for names that were only junk', () => {
    expect(
      cleanNames({ artist: 'www.site.com', title: '[HD] (Official Video)', mix: null })
    ).toEqual({
      artist: null,
      title: null,
      mix: null
    })
  })

  it('changes nothing in names that are clean, and is the same the second time', () => {
    const clean = { artist: 'Ákos feat. Valaki', title: 'Cím (2. rész)', mix: 'Original Mix' }

    expect(cleanNames(clean)).toEqual(clean)
    expect(cleanNames(cleanNames(clean))).toEqual(clean)
  })
})

describe('isJunkBracket', () => {
  it.each([
    'Official Video',
    ' official  music video ',
    'HD',
    '4k',
    '128kbps',
    'Out Now',
    'Free DL'
  ])('throws out %j', (content) => {
    expect(isJunkBracket(content)).toBe(true)
  })

  it.each(['Original Mix', 'Audio Bullys Remix', 'Video Games', 'HD Remix', 'Part 2', 'Live', ''])(
    'keeps %j',
    (content) => {
      expect(isJunkBracket(content)).toBe(false)
    }
  )
})

describe('removeJunk', () => {
  it('leaves no empty brackets, double spaces or dangling dashes behind', () => {
    expect(removeJunk('Title  (Official Video)  [HD] - ')).toBe('Title')
    expect(removeJunk('( ) Title [ ]')).toBe('Title')
  })
})
