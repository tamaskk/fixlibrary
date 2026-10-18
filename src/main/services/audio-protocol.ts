// The `fixlib-audio:` protocol (T-030): how the sandboxed renderer plays a track. The
// page names a track by its id, `fixlib-audio://track/<id>`, never by a path; the main
// process looks the file up and serves it with byte ranges, so the player can seek.
import { timingSafeEqual } from 'crypto'
import { constants } from 'fs'
import { open, type FileHandle } from 'fs/promises'
import { extname } from 'path'
import { aiffLayoutOf, rangeOf, readWavRange, wavSizeOf, type AiffLayout } from './audio-stream'

export const AUDIO_SCHEME = 'fixlib-audio'

/** The address the page plays a track from. */
export function audioUrlOf(trackId: number): string {
  return `${AUDIO_SCHEME}://track/${trackId}`
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aif': 'audio/wav',
  '.aiff': 'audio/wav'
}
// What is read at a time while a response is sent.
const PIECE_BYTES = 256 * 1024
const TRACK_URL = /^fixlib-audio:\/\/track\/([1-9][0-9]{0,15})(?:\?read=([0-9a-f]{32}))?$/u
// No link anywhere in the path (macOS `O_NOFOLLOW_ANY`, which Node does not name), and
// no wait on a file that is no file: a FIFO put in a track's place would hold a thread
// of the file system forever.
// The two are refused together (EINVAL): the one that covers the whole path, where there is one.
const NO_LINKS = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_LINKS
// A player seeks by asking anew: the oldest of more streams than this is ended, and one
// that is not read for this long lets its file go, so no drive is kept busy by a pause.
const MAX_OPEN_STREAMS = 8
const IDLE_CLOSE_MS = 30_000

export interface AudioProtocolDependencies {
  /** The file of a track the page may play, or null: unknown, offline, missing or set aside. */
  pathOfTrack: (trackId: number) => string | null
  /**
   * The origin of the app's own page, as its requests name it (`null` for the page of a
   * packaged app, which is a file). Only it may read the audio through Web Audio (T-033).
   */
  appOrigin: () => string | null
  /**
   * The token of this launch the app's page puts in the address to read the samples
   * (`?read=`): the origin alone is `null` for every opaque document, not only the app's.
   */
  readToken: string
}

/**
 * The headers that let the app's own page, and no other, read the audio it plays: the
 * origin of its requests, and the token of this launch in the address.
 */
function corsHeadersOf(
  request: Request,
  token: string | undefined,
  dependencies: Pick<AudioProtocolDependencies, 'appOrigin' | 'readToken'>
): Record<string, string> {
  const origin = request.headers.get('origin')
  const appOrigin = dependencies.appOrigin()
  const allowed =
    origin !== null &&
    appOrigin !== null &&
    origin === appOrigin &&
    token !== undefined &&
    timingSafeEqual(Buffer.from(token), Buffer.from(dependencies.readToken))
  return allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' }
}

/** The origin a request of the app's page names, from the address the page was loaded from. */
export function originOfRendererUrl(entryUrl: string | null): string | null {
  if (entryUrl === null) return null
  try {
    const url = new URL(entryUrl)
    // A page loaded from a file has an opaque origin, which its requests call `null`.
    return url.protocol === 'file:' ? 'null' : url.origin
  } catch {
    return null
  }
}

function refuse(status: number): Response {
  return new Response(null, { status })
}

/** The streams that hold a file open, oldest first: each can be ended from outside. */
const openStreams = new Set<{ end: () => void }>()

/** How many responses hold a file open now. */
export function openAudioStreamCount(): number {
  return openStreams.size
}

/** A body that reads `start` to `end` of the audio piece by piece, and lets the file go at its end. */
function bodyOf(
  file: FileHandle,
  layout: AiffLayout | null,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  let at = start
  let ended = false
  let idle: NodeJS.Timeout | null = null
  const entry = {
    end: () => {
      if (ended) return
      ended = true
      if (idle) clearTimeout(idle)
      openStreams.delete(entry)
      void file.close().catch(() => {})
    }
  }
  const touch = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(entry.end, IDLE_CLOSE_MS)
  }
  openStreams.add(entry)
  if (openStreams.size > MAX_OPEN_STREAMS) openStreams.values().next().value?.end()
  touch()
  return new ReadableStream({
    async pull(controller) {
      try {
        if (ended || at > end) {
          entry.end()
          controller.close()
          return
        }
        touch()
        const last = Math.min(end, at + PIECE_BYTES - 1)
        let piece: Buffer
        if (layout) {
          piece = await readWavRange(file, layout, at, last)
        } else {
          piece = Buffer.alloc(last - at + 1)
          const { bytesRead } = await file.read(piece, 0, piece.length, at)
          piece = piece.subarray(0, bytesRead)
        }
        if (piece.length === 0) {
          entry.end()
          controller.close()
          return
        }
        at += piece.length
        controller.enqueue(new Uint8Array(piece))
      } catch (error) {
        const wasEnded = ended
        entry.end()
        // A stream ended from outside reads no more: that is its end, not an error.
        if (wasEnded) controller.close()
        else controller.error(error)
      }
    },
    cancel() {
      entry.end()
    }
  })
}

/** Answers one request of the protocol. */
export function createAudioHandler(
  dependencies: AudioProtocolDependencies
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405)
    const match = TRACK_URL.exec(request.url)
    if (!match) return refuse(404)
    const path = dependencies.pathOfTrack(Number(match[1]))
    const type = path === null ? undefined : CONTENT_TYPES[extname(path).toLowerCase()]
    if (path === null || type === undefined) return refuse(404)
    let file: FileHandle
    try {
      // The file itself, never what a link at its place points to.
      file = await open(path, OPEN_FLAGS)
    } catch {
      return refuse(404)
    }
    try {
      const stats = await file.stat()
      if (!stats.isFile()) throw new Error('not a file')
      const isAiff = type === 'audio/wav' && !path.toLowerCase().endsWith('.wav')
      const layout = isAiff ? await aiffLayoutOf(file, stats.size) : null
      if (isAiff && !layout) throw new Error('not an AIFF the app plays')
      const size = layout ? wavSizeOf(layout) : stats.size
      const range = rangeOf(request.headers.get('range'), size)
      if (range === 'invalid') {
        await file.close()
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const { start, end } = range ?? { start: 0, end: size - 1 }
      const headers: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeadersOf(request, match[2], dependencies)
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      if (request.method === 'HEAD' || size === 0) {
        await file.close()
        return new Response(null, { status: range ? 206 : 200, headers })
      }
      return new Response(bodyOf(file, layout, start, end), {
        status: range ? 206 : 200,
        headers
      })
    } catch {
      await file.close().catch(() => {})
      return refuse(404)
    }
  }
}
