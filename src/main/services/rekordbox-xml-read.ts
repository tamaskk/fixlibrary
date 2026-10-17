// Reading what Rekordbox exported (T-026). The export is untrusted: it is opened
// without following a link, capped in size, has no DOCTYPE of its own, is parsed off
// the main thread (`rekordbox-xml-worker.ts`), and every value is validated.
import { constants } from 'fs'
import { lstat, open, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'
import { REKORDBOX_XML_FILE_NAME } from '@shared/rekordbox'
import { GRID_BOUNDS, gridMarkerSchema } from '@shared/rpc'

/**
 * The largest export read. A 3000-track library with its grids is tens of MB; the
 * parse of a file of tiny elements takes many times its size in memory.
 */
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024

// Read past the bound of a grid, so that a track with too many markers keeps its other
// data and loses only the grid.
const MAX_TEMPO_ITEMS = 100_000

/** One beat marker of Rekordbox's grid, as its export holds it. */
export interface RbTempo {
  /** Where the marker is, in seconds. */
  inizio: number
  bpm: number
  /** The meter, `4/4`. */
  metro: string
  /** Which beat of the bar the marker is on. */
  battito: number
}

/** A cue or a hot cue of the export: `num` -1 is a memory cue, 0–7 hot cues A–H. */
export interface RbPositionMark {
  name: string
  type: number
  start: number
  num: number
}

export interface RbTrack {
  trackId: number
  /** `Location` as it stands in the export. */
  location: string
  /** The absolute path it names, composed (NFC); null when it names no local file. */
  path: string | null
  averageBpm: number | null
  tonality: string | null
  totalTime: number | null
  tempos: RbTempo[]
  positionMarks: RbPositionMark[]
}

export interface RbPlaylistNode {
  name: string
  kind: 'folder' | 'playlist'
  /** The `TrackID`s of a playlist; empty for a folder. */
  trackIds: number[]
  children: RbPlaylistNode[]
}

export interface RekordboxExport {
  /** Every track of the collection, by its composed path. */
  tracks: Map<string, RbTrack>
  /** Tracks whose `Location` names no local file. */
  unplaced: RbTrack[]
  /** `TRACK` elements left out: what they hold is not what Rekordbox writes. */
  skipped: number
  /** The root of the playlists, or null when the export has none. */
  playlists: RbPlaylistNode | null
}

/** A number as an attribute holds it; an empty one is no number. */
const decimal = z.string().trim().min(1).transform(Number).refine(Number.isFinite, 'not a number')
const optionalDecimal = z
  .string()
  .optional()
  .transform((value, context) => {
    if (value === undefined || value.trim() === '') return null
    const number = Number(value)
    if (Number.isFinite(number)) return number
    context.addIssue({ code: 'custom', message: 'not a number' })
    return z.NEVER
  })
const optionalText = z
  .string()
  .max(1000)
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))
const integer = (min: number, max: number): z.ZodType<number, string> =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/u)
    .transform(Number)
    .refine((value) => value >= min && value <= max)

const tempoSchema = z
  .object({
    Inizio: decimal,
    Bpm: decimal,
    Metro: z.string().default('4/4'),
    Battito: integer(1, GRID_BOUNDS.maxBattito)
  })
  .transform((tempo) => ({
    inizio: tempo.Inizio,
    bpm: tempo.Bpm,
    metro: tempo.Metro,
    battito: tempo.Battito
  }))
  .pipe(gridMarkerSchema)

/**
 * The grid of a track, whole or not at all: the app writes the grid back into its own
 * XML, and part of one would move Rekordbox's beats. Without one the track is taken as
 * not analysed, and gets no cues.
 */
function gridOf(items: readonly unknown[]): RbTempo[] {
  const grid = z.array(tempoSchema).max(GRID_BOUNDS.maxMarkers).safeParse(items)
  return grid.success ? grid.data : []
}

const positionMarkSchema = z.object({
  Name: z.string().max(1000).default(''),
  Type: integer(0, 10),
  Start: decimal.refine((value) => value >= 0),
  Num: integer(-1, 15)
})

const trackSchema = z.object({
  TrackID: integer(1, Number.MAX_SAFE_INTEGER),
  Location: z.string().max(10_000),
  AverageBpm: optionalDecimal,
  Tonality: optionalText,
  TotalTime: optionalDecimal,
  // Item by item below: one odd marker must not cost the track its grid.
  TEMPO: z.array(z.unknown()).max(MAX_TEMPO_ITEMS).default([]),
  POSITION_MARK: z.array(z.unknown()).max(1000).default([])
})

/**
 * The absolute path a `Location` names, composed (NFC) as the app keeps paths; null
 * when it names no local file. Rekordbox writes `file://localhost/...` and does not
 * escape every character a URL would (`#`, `?`, a lone `%`), so the path is taken as
 * it stands and only its escapes are decoded.
 */
export function pathOfLocation(location: string): string | null {
  const match = /^file:\/\/(?:localhost)?(\/.*)$/iu.exec(location)
  const encoded = match?.[1]
  if (encoded === undefined) return null
  let path: string
  try {
    path = decodeURIComponent(encoded)
  } catch {
    // A `%` that starts no escape is a `%` of the name.
    path = encoded.replace(/%([0-9a-f]{2})/giu, (escape, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return code < 0x80 ? String.fromCharCode(code) : escape
    })
  }
  if (path.includes('\0') || path.split('/').includes('..')) return null
  return path.normalize('NFC')
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

type RawNode = Record<string, unknown>

function playlistNodeOf(raw: RawNode, depth: number): RbPlaylistNode | null {
  // A tree deeper than any library has is no export of Rekordbox.
  if (depth > 64) return null
  const name = typeof raw['Name'] === 'string' ? raw['Name'].slice(0, 1000) : ''
  if (raw['Type'] === '0') {
    return {
      name,
      kind: 'folder',
      trackIds: [],
      children: asArray(raw['NODE']).flatMap((child) =>
        typeof child === 'object' && child !== null
          ? (playlistNodeOf(child as RawNode, depth + 1) ?? [])
          : []
      )
    }
  }
  const trackIds = asArray(raw['TRACK']).flatMap((entry) => {
    const key = integer(1, Number.MAX_SAFE_INTEGER).safeParse((entry as RawNode | null)?.['Key'])
    return key.success ? [key.data] : []
  })
  return { name, kind: 'playlist', trackIds, children: [] }
}

/**
 * Reads an export of Rekordbox: its tracks, with their grids and cues, and its
 * playlists. A track whose attributes are not what Rekordbox writes is left out and
 * counted; a marker or a cue that is not is left out of its track. An export that is
 * not one at all is refused. Of two tracks at one path, the one with a grid is kept.
 */
export function parseRekordboxXml(xml: string): RekordboxExport {
  // No entities of its own: the export of Rekordbox has none, and one may expand.
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('the export declares a DOCTYPE')
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    isArray: (name) => ['TRACK', 'TEMPO', 'POSITION_MARK', 'NODE'].includes(name)
  })
  const document = parser.parse(xml) as RawNode
  const root = document['DJ_PLAYLISTS'] as RawNode | undefined
  if (typeof root !== 'object' || root === null) throw new Error('no DJ_PLAYLISTS element')
  const collection = root['COLLECTION'] as RawNode | undefined

  const tracks = new Map<string, RbTrack>()
  const unplaced: RbTrack[] = []
  let skipped = 0
  for (const raw of asArray(collection?.['TRACK'])) {
    const parsed = trackSchema.safeParse(raw)
    if (!parsed.success) {
      skipped += 1
      continue
    }
    const { data } = parsed
    const track: RbTrack = {
      trackId: data.TrackID,
      location: data.Location,
      path: pathOfLocation(data.Location),
      averageBpm: data.AverageBpm,
      tonality: data.Tonality,
      totalTime: data.TotalTime,
      tempos: gridOf(data.TEMPO),
      positionMarks: data.POSITION_MARK.flatMap((item) => {
        const mark = positionMarkSchema.safeParse(item)
        return mark.success
          ? [
              {
                name: mark.data.Name,
                type: mark.data.Type,
                start: mark.data.Start,
                num: mark.data.Num
              }
            ]
          : []
      })
    }
    if (track.path === null) {
      unplaced.push(track)
      continue
    }
    const other = tracks.get(track.path)
    if (!other || (other.tempos.length === 0 && track.tempos.length > 0)) {
      tracks.set(track.path, track)
    }
  }

  const nodes = asArray((root['PLAYLISTS'] as RawNode | undefined)?.['NODE'])
  const first = nodes[0]
  const playlists =
    typeof first === 'object' && first !== null ? playlistNodeOf(first as RawNode, 0) : null
  return { tracks, unplaced, skipped, playlists }
}

/** Parses the bytes of an export in this thread: for tests, and inside the worker. */
export function parseRekordboxBytes(bytes: Uint8Array): RekordboxExport {
  return parseRekordboxXml(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  )
}

export interface ExportFile {
  path: string
  /** When it was last changed, in ms since the epoch. */
  modifiedAt: number
}

/**
 * The newest `.xml` in the folder Rekordbox exports to, other than the one the app
 * writes; null when there is none. Plain files only: a link is not followed.
 */
export async function findNewestExport(folder: string): Promise<ExportFile | null> {
  const names = await readdir(folder)
  let newest: ExportFile | null = null
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.xml') || name.startsWith('.')) continue
    if (name === REKORDBOX_XML_FILE_NAME) continue
    const path = join(folder, name)
    const found = await lstat(path).catch(() => null)
    if (!found?.isFile()) continue
    if (newest === null || found.mtimeMs > newest.modifiedAt) {
      newest = { path, modifiedAt: found.mtimeMs }
    }
  }
  return newest
}

/**
 * The bytes of an export: opened once, without following a link and without waiting
 * on what is no plain file, checked as it is open, and never more than the cap read.
 */
export async function readExportBytes(
  path: string,
  maxBytes: number = MAX_EXPORT_BYTES
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const found = await handle.stat()
    if (!found.isFile()) throw new Error('the export is not a plain file')
    if (found.size > maxBytes) throw new Error('the export is too large')
    // One byte more than allowed tells a file that grew after it was looked at.
    const buffer = Buffer.alloc(Math.min(found.size, maxBytes) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes || length > found.size)
      throw new Error('the export changed while it was read')
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

export interface WorkerLimits {
  timeoutMs: number
  maxHeapMb: number
}

const DEFAULT_WORKER_LIMITS: WorkerLimits = { timeoutMs: 60_000, maxHeapMb: 1024 }

/**
 * Parses an export in a worker thread of its own, so that neither its time nor its
 * memory is the main process's: a parse that runs out of either ends the worker, not
 * the app. `workerPath` is the built `rekordbox-xml-worker`.
 */
export function parseExportInWorker(
  workerPath: string,
  bytes: Buffer,
  limits: WorkerLimits = DEFAULT_WORKER_LIMITS
): Promise<RekordboxExport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: bytes,
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb }
    })
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      outcome()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('the export took too long to read'))),
      limits.timeoutMs
    )
    worker.once('message', (exported: RekordboxExport) => finish(() => resolve(exported)))
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`the export reader stopped (${code})`)))
    )
  })
}

/** Is there a plain file at the path? Only "not there" is no; any other failure is unknown. */
export type FileState = 'present' | 'absent' | 'unknown'

/**
 * Of these paths, which have a file (a link counts by what it points at), which have
 * none, and which could not be told. A few at a time: an external drive answers
 * slowly, but thousands at once is no help.
 */
export async function fileStatesOf(paths: readonly string[]): Promise<Map<string, FileState>> {
  const states = new Map<string, FileState>()
  for (let start = 0; start < paths.length; start += 32) {
    const chunk = paths.slice(start, start + 32)
    const found = await Promise.all(
      chunk.map((path) =>
        stat(path).then(
          (entry): FileState => (entry.isFile() ? 'present' : 'absent'),
          (error: NodeJS.ErrnoException): FileState =>
            error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'absent' : 'unknown'
        )
      )
    )
    chunk.forEach((path, index) => states.set(path, found[index] ?? 'unknown'))
  }
  return states
}
