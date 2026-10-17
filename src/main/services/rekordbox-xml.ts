// The Rekordbox XML (T-025): the collection, its playlists and its hot cues as the
// DJ_PLAYLISTS format Rekordbox imports, and the one place that file is written. The
// serializer escapes every value; nothing is put together from string templates.
import { randomUUID } from 'crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { XMLBuilder } from 'fast-xml-parser'
import { AppError } from '@shared/errors'
import { REKORDBOX_XML_FILE_NAME } from '@shared/rekordbox'

/** The kinds of file Rekordbox names in `Kind`. */
export type XmlTrackKind = 'MP3 File' | 'AIFF File' | 'WAV File'

/** A hot cue: `Num` 0 is A, 7 is H. */
export interface XmlCue {
  num: number
  name: string
  startSeconds: number
  /** `#rrggbb`. */
  color: string
}

/** One track of the collection, as the XML holds it. A null leaves the attribute out. */
export interface XmlTrack {
  /** The track's id in the app's database: stable, so a second import updates the first. */
  id: number
  /** The title with its mix, as the tag holds it. */
  name: string
  artist: string | null
  album: string | null
  genre: string | null
  label: string | null
  mix: string | null
  year: number | null
  comments: string | null
  kind: XmlTrackKind
  sizeBytes: number | null
  totalTimeSeconds: number | null
  bitRateKbps: number | null
  sampleRateHz: number | null
  averageBpm: number | null
  /** The key in musical notation, `Am`. */
  tonality: string | null
  /** The absolute path of the file. */
  path: string
  /** Rekordbox's own grid, as its export had it: written back so an import keeps it. */
  tempos: readonly XmlTempo[]
  cues: readonly XmlCue[]
}

/** A beat marker of Rekordbox's grid. */
export interface XmlTempo {
  inizio: number
  bpm: number
  metro: string
  battito: number
}

export interface XmlPlaylist {
  name: string
  /** Ids of tracks of the collection, in order. */
  trackIds: readonly number[]
}

export interface RekordboxCollection {
  tracks: readonly XmlTrack[]
  /** One playlist per style, right under the root. */
  stylePlaylists: readonly XmlPlaylist[]
  /** The user's playlists, in the folder "Playlists". */
  playlists: readonly XmlPlaylist[]
}

export interface RekordboxXmlOptions {
  appVersion: string
}

/** The folder of the user's playlists, under the root. */
export const PLAYLISTS_FOLDER_NAME = 'Playlists'

// XML 1.0 has no place for these, not even escaped; a tag may hold them. Spelled as
// escapes in a string: the characters themselves would be invisible here.
const NOT_IN_XML = new RegExp(
  String.raw`[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{fffe}\u{ffff}]|[\u{d800}-\u{dbff}](?![\u{dc00}-\u{dfff}])|(?<![\u{d800}-\u{dbff}])[\u{dc00}-\u{dfff}]`,
  'gu'
)

function xmlText(value: string): string {
  return value.replace(NOT_IN_XML, '')
}

/**
 * Where Rekordbox finds a file: `file://localhost` and the path as a file URL spells
 * it, so a space is `%20` and an accented letter its UTF-8 bytes in percent signs.
 */
export function locationOf(path: string): string {
  return `file://localhost${pathToFileURL(path).href.slice('file://'.length)}`
}

/** The red, green and blue of `#rrggbb`, 0–255 each. */
function rgbOf(color: string): { Red: number; Green: number; Blue: number } {
  const value = Number.parseInt(color.slice(1), 16)
  return { Red: (value >> 16) & 0xff, Green: (value >> 8) & 0xff, Blue: value & 0xff }
}

type Attributes = Record<string, string | number>

/** The attributes of an element: a null leaves one out, text is made fit for XML. */
function attributes(values: Record<string, string | number | null>): Attributes {
  const kept: Attributes = {}
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue
    kept[`@_${name}`] = typeof value === 'string' ? xmlText(value) : value
  }
  return kept
}

function trackElement(track: XmlTrack): Record<string, unknown> {
  return {
    ...attributes({
      TrackID: track.id,
      Name: track.name,
      Artist: track.artist,
      Album: track.album,
      Genre: track.genre,
      Kind: track.kind,
      Size: track.sizeBytes,
      TotalTime: track.totalTimeSeconds,
      Year: track.year,
      AverageBpm: track.averageBpm === null ? null : track.averageBpm.toFixed(2),
      BitRate: track.bitRateKbps,
      SampleRate: track.sampleRateHz,
      Comments: track.comments,
      Label: track.label,
      Mix: track.mix,
      Tonality: track.tonality,
      Location: locationOf(track.path)
    }),
    // As Rekordbox writes them: the time to the millisecond, the tempo to two places.
    ...(track.tempos.length > 0
      ? {
          TEMPO: track.tempos.map((tempo) =>
            attributes({
              Inizio: tempo.inizio.toFixed(3),
              Bpm: tempo.bpm.toFixed(2),
              Metro: tempo.metro,
              Battito: tempo.battito
            })
          )
        }
      : {}),
    ...(track.cues.length > 0
      ? {
          POSITION_MARK: track.cues.map((cue) =>
            attributes({
              Name: cue.name,
              Type: 0,
              Start: cue.startSeconds.toFixed(3),
              Num: cue.num,
              ...rgbOf(cue.color)
            })
          )
        }
      : {})
  }
}

function playlistNode(playlist: XmlPlaylist): Record<string, unknown> {
  return {
    ...attributes({ Name: playlist.name, Type: 1, KeyType: 0, Entries: playlist.trackIds.length }),
    ...(playlist.trackIds.length > 0
      ? { TRACK: playlist.trackIds.map((id) => attributes({ Key: id })) }
      : {})
  }
}

function folderNode(
  name: string,
  children: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return {
    ...attributes({ Type: 0, Name: name, Count: children.length }),
    ...(children.length > 0 ? { NODE: children } : {})
  }
}

/**
 * The playlists with names no sibling has, letter case aside: Rekordbox may merge two
 * of one name on import. A name that is taken gets ` (2)`, ` (3)` and so on.
 */
function withUniqueNames(
  playlists: readonly XmlPlaylist[],
  reserved: readonly string[]
): XmlPlaylist[] {
  const key = (name: string): string => xmlText(name).toLocaleLowerCase('en')
  const taken = new Set(reserved.map(key))
  return playlists.map((playlist) => {
    let name = playlist.name
    for (let number = 2; taken.has(key(name)); number += 1) name = `${playlist.name} (${number})`
    taken.add(key(name))
    return { ...playlist, name }
  })
}

/**
 * The XML Rekordbox imports: the collection, then under the root one playlist per
 * style and the folder "Playlists" with the user's playlists. A playlist names its
 * tracks by `TrackID` (`KeyType="0"`).
 */
export function writeRekordboxXml(
  collection: RekordboxCollection,
  options: RekordboxXmlOptions
): string {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    // Said, not left to the default: tag text and paths must never end an attribute.
    processEntities: true
  })
  // The folder "Playlists" keeps its name; a style of that name gives way.
  const styles = withUniqueNames(collection.stylePlaylists, [PLAYLISTS_FOLDER_NAME])
  const root = folderNode('ROOT', [
    ...styles.map(playlistNode),
    folderNode(PLAYLISTS_FOLDER_NAME, withUniqueNames(collection.playlists, []).map(playlistNode))
  ])
  const body = builder.build({
    DJ_PLAYLISTS: {
      ...attributes({ Version: '1.0.0' }),
      PRODUCT: attributes({
        Name: 'FixLibrary',
        Version: options.appVersion,
        Company: 'FixLibrary'
      }),
      COLLECTION: {
        ...attributes({ Entries: collection.tracks.length }),
        ...(collection.tracks.length > 0 ? { TRACK: collection.tracks.map(trackElement) } : {})
      },
      PLAYLISTS: { NODE: root }
    }
  }) as string
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`
}

// The name of a temp file of this writer, and nothing else: what a stop left is
// removed by it, and only that.
const TEMP_NAME = new RegExp(
  String.raw`^\.${REKORDBOX_XML_FILE_NAME.replace('.', '\\.')}\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.fixlib-tmp$`,
  'u'
)

/** Removes the temp files of writes a stop of the app cut short: plain files only. */
async function removeLeftTempFiles(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [])
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue
    const path = join(folder, name)
    const found = await lstat(path).catch(() => null)
    if (found?.isFile()) await rm(path, { force: true }).catch(() => undefined)
  }
}

/**
 * Writes the XML into its folder under its fixed name, whole or not at all: into a
 * new temp file next to it, flushed to the disk, then renamed over the old one.
 * Makes the folder only when told to (the app's own default folder): a folder on a
 * drive that is not connected must not be made on the startup disk instead.
 * `stillValid` is asked right before the rename: when it says no, the XML is not put
 * in place (`RUN_ACTIVE`). Returns the path of the XML.
 */
export async function saveRekordboxXml(
  folder: string,
  xml: string,
  options: { createFolder: boolean; stillValid?: () => boolean }
): Promise<string> {
  if (options.createFolder) await mkdir(folder, { recursive: true })
  await removeLeftTempFiles(folder)
  const target = join(folder, REKORDBOX_XML_FILE_NAME)
  const temp = join(folder, `.${REKORDBOX_XML_FILE_NAME}.${randomUUID()}.fixlib-tmp`)
  let created = false
  try {
    // A new file of its own: never one that is there, nor what a link points at.
    const handle = await open(temp, 'wx', 0o644)
    created = true
    try {
      await handle.writeFile(xml, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options.stillValid && !options.stillValid()) {
      throw new AppError('RUN_ACTIVE', 'the library changed while the XML was written')
    }
    await rename(temp, target)
  } catch (error) {
    // Only the file this call made; a failure to remove it must not hide why.
    if (created) await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}

/** When the XML the app writes in this folder was last changed, or null when it is not there. */
export async function xmlModifiedAt(folder: string): Promise<number | null> {
  const found = await lstat(join(folder, REKORDBOX_XML_FILE_NAME)).catch(() => null)
  return found?.isFile() ? found.mtimeMs : null
}
