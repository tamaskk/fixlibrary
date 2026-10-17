// Downloads (T-034): what an address is before it is downloaded (its bitrate, and a
// track of the library it may be a copy of), and the line of downloads, two at a
// time. The finished MP3 lands in `<library root>/Inbox`, where the Inbox watcher
// (T-035) takes it up; nothing here touches a file of the library.
import { chmod, lstat, mkdir, stat } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type { Track } from '../db/tracks'
import { logger } from '../services/logger'
import { downloadArgs, infoArgs, searchArgs, YtDlpError, type YtDlp } from '../services/downloader'
import {
  addressOf,
  downloadSearchSchema,
  isLowBitrate,
  MAX_DOWNLOADS,
  MAX_PARALLEL_DOWNLOADS,
  readInfo,
  readProgressLine,
  readSearchHits,
  searchTermOf,
  type DownloadFailure,
  type DownloadInfo,
  type DownloadInspection,
  type DownloadItem,
  type DownloadSearchHit
} from '@shared/download'
import type { ErrorCode, Result } from '@shared/errors'
import { INBOX_FOLDER_NAME } from '@shared/settings'
import { toOneLine } from '@shared/text'
import {
  DOWNLOAD_INFO_TIMEOUT_MS,
  DOWNLOAD_SEARCH_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS
} from '@shared/timeouts'
import { findDuplicateGroups, type DuplicateCandidate } from './duplicates'
import { cleanNames, parseFileName } from './naming'

// Not a track id: the address asked about, among the tracks of the library.
const ASKED = 0
// Addresses asked about and not downloaded yet, the oldest forgotten first.
const MAX_INSPECTED = 100
// Questions to yt-dlp (what an address is, a search) running at once.
const MAX_PARALLEL_QUESTIONS = 2
const MAX_NAME_LENGTH = 200

/**
 * The address as a track of the library would be named: `Artist - Title (Mix)` read
 * from its title, cleaned like the naming cleans; the uploader is the artist where
 * the title names none.
 */
export function candidateOf(info: DownloadInfo): DuplicateCandidate {
  const parsed = parseFileName(info.title)
  const names = cleanNames({ ...parsed, artist: parsed.artist ?? info.uploader })
  return {
    trackId: ASKED,
    acoustId: null,
    ...names,
    durationMs: info.durationS === null ? null : Math.round(info.durationS * 1000),
    format: 'mp3',
    bitrateKbps: info.bitrateKbps
  }
}

/**
 * A track of the library that is the same recording by the rule of the duplicates
 * (T-017): the same names once normalized, lengths 2 s apart at most.
 */
export function findLibraryCopy(info: DownloadInfo, tracks: readonly Track[]): Track | null {
  const candidates: DuplicateCandidate[] = [
    candidateOf(info),
    ...tracks.map((track) => ({
      trackId: track.id,
      // Only the names: the address has no fingerprint before it is downloaded.
      acoustId: null,
      ...cleanNames({ artist: track.artist, title: track.title, mix: track.mix }),
      durationMs: track.durationMs,
      format: track.format,
      bitrateKbps: track.bitrateKbps
    }))
  ]
  const group = findDuplicateGroups(candidates).find((ids) => ids.includes(ASKED))
  const copyId = group?.find((id) => id !== ASKED)
  return tracks.find((track) => track.id === copyId) ?? null
}

// yt-dlp names the files of a download by the id of the track on its service.
const SERVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const THUMBNAIL_EXTENSIONS = ['.jpg', '.webp', '.png']

/**
 * The thumbnail a download left for a track that is still in the Inbox under the name
 * yt-dlp gave it, or null. A file someone copied into the Inbox has none, unless its
 * name is the id of a download.
 */
export async function findThumbnail(
  trackPath: string,
  libraryRoot: string | null,
  thumbnails: string
): Promise<string | null> {
  if (libraryRoot === null) return null
  const inbox = join(libraryRoot, INBOX_FOLDER_NAME).normalize('NFC')
  if (dirname(trackPath).normalize('NFC') !== inbox) return null
  const id = basename(trackPath, extname(trackPath))
  if (!SERVICE_ID.test(id)) return null
  for (const extension of THUMBNAIL_EXTENSIONS) {
    const path = join(thumbnails, `${id}${extension}`)
    const found = await lstat(path).catch(() => null)
    if (found?.isFile()) return path
  }
  return null
}

/**
 * Makes a folder of the app's own, or checks the one that is there: a folder, not a
 * link, of this user, readable by no one else. As the covers folder is checked.
 */
async function ensureOwnFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const stats = await lstat(folder)
  if (!stats.isDirectory()) throw new Error('a folder of the app is not a folder')
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error('a folder of the app belongs to another user')
  }
  if ((stats.mode & 0o077) !== 0) await chmod(folder, 0o700)
}

const FAILURE_CODES: Readonly<Record<DownloadFailure, ErrorCode>> = {
  extract: 'DOWNLOAD_EXTRACT_FAILED',
  failed: 'DOWNLOAD_FAILED',
  timeout: 'DOWNLOAD_FAILED',
  missing: 'TOOL_MISSING'
}

export interface DownloadFolders {
  /** The library folder, or null while none is chosen. */
  libraryRoot: string | null
  /** Folders of the app's own: what yt-dlp writes on the way, and the thumbnails. */
  temp: string
  thumbnails: string
}

export interface DownloadDependencies {
  ytDlp: YtDlp
  folders: () => DownloadFolders
  /** The app's ffmpeg, or null when this installation has none. */
  ffmpeg: () => string | null
  /** The tracks a download is compared with. */
  libraryTracks: () => readonly Track[]
  /** Called whenever a download changes; may be called very often. */
  onChange: (items: DownloadItem[]) => void
}

export interface Downloads {
  inspect: (text: unknown) => Promise<Result<DownloadInspection>>
  /** Puts an address that was inspected in line. Resolves with the whole list. */
  start: (text: unknown) => Result<DownloadItem[]>
  search: (request: unknown) => Promise<Result<DownloadSearchHit[]>>
  list: () => DownloadItem[]
  /** Quitting: every running download is stopped. */
  stopAll: () => void
}

interface Entry {
  item: DownloadItem
  url: string
}

export function createDownloads(dependencies: DownloadDependencies): Downloads {
  const entries: Entry[] = []
  const inspected = new Map<string, DownloadInfo>()
  const running = new Map<number, AbortController>()
  let nextId = 1
  let questions = 0
  let stopped = false
  // Questions to yt-dlp that are under way, so that quitting can stop them too.
  const asking = new Set<AbortController>()

  const list = (): DownloadItem[] => entries.map(({ item }) => ({ ...item }))
  const changed = (): void => dependencies.onChange(list())

  /** Runs one question to yt-dlp, if there is room for it. */
  async function ask<T>(question: (signal: AbortSignal) => Promise<Result<T>>): Promise<Result<T>> {
    if (stopped || questions >= MAX_PARALLEL_QUESTIONS) return { ok: false, code: 'RUN_ACTIVE' }
    questions += 1
    const controller = new AbortController()
    asking.add(controller)
    try {
      return await question(controller.signal)
    } catch (error) {
      if (error instanceof YtDlpError) return { ok: false, code: FAILURE_CODES[error.failure] }
      throw error
    } finally {
      questions -= 1
      asking.delete(controller)
    }
  }

  async function download(entry: Entry, signal: AbortSignal): Promise<void> {
    const { libraryRoot, temp, thumbnails } = dependencies.folders()
    const ffmpeg = dependencies.ffmpeg()
    if (libraryRoot === null) throw new YtDlpError('failed')
    if (ffmpeg === null) throw new YtDlpError('missing')
    // The Inbox is made inside the library, never the library itself: a drive that
    // is not there must not get a folder in its place.
    if (!(await stat(libraryRoot)).isDirectory()) throw new YtDlpError('failed')
    const inbox = join(libraryRoot, INBOX_FOLDER_NAME)
    await mkdir(inbox, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    // A link or a file in the place of the Inbox would send the MP3 out of the library.
    const made = await lstat(inbox)
    if (!made.isDirectory() || made.isSymbolicLink()) {
      logger.warn('The Inbox is not a folder of the library; nothing is downloaded')
      throw new YtDlpError('failed')
    }
    await ensureOwnFolder(temp)
    await ensureOwnFolder(thumbnails)
    await dependencies.ytDlp.run(
      downloadArgs({ url: entry.url, inbox, temp, thumbnails, ffmpeg }),
      {
        signal,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        onLine: (line) => {
          const step = readProgressLine(line)
          if (step === null) return
          entry.item.state = step.kind === 'download' ? 'downloading' : 'converting'
          entry.item.percent = step.kind === 'download' ? step.percent : null
          changed()
        }
      }
    )
  }

  function pump(): void {
    if (stopped) return
    for (const entry of entries) {
      if (running.size >= MAX_PARALLEL_DOWNLOADS) return
      if (entry.item.state !== 'queued') continue
      const controller = new AbortController()
      running.set(entry.item.id, controller)
      entry.item.state = 'downloading'
      changed()
      void download(entry, controller.signal)
        .then(
          () => {
            entry.item.state = 'done'
            entry.item.percent = 100
          },
          (error: unknown) => {
            entry.item.state = 'failed'
            entry.item.percent = null
            entry.item.failure = error instanceof YtDlpError ? error.failure : 'failed'
            if (!(error instanceof YtDlpError)) {
              logger.error(`Download ${entry.item.id} failed`, error)
            } else {
              logger.warn(`Download ${entry.item.id} failed: ${error.failure}`)
            }
          }
        )
        .finally(() => {
          running.delete(entry.item.id)
          changed()
          pump()
        })
    }
  }

  return {
    inspect: (text) =>
      ask(async (signal) => {
        const address = typeof text === 'string' ? addressOf(text) : null
        if (address === null) return { ok: false, code: 'DOWNLOAD_UNSUPPORTED' }
        const answer = await dependencies.ytDlp.json(infoArgs(address.url), {
          signal,
          timeoutMs: DOWNLOAD_INFO_TIMEOUT_MS
        })
        const info = readInfo(answer, address)
        if (info === 'playlist') return { ok: false, code: 'DOWNLOAD_PLAYLIST' }
        if (info === null) return { ok: false, code: 'DOWNLOAD_FAILED' }
        inspected.delete(info.url)
        inspected.set(info.url, info)
        for (const url of inspected.keys()) {
          if (inspected.size <= MAX_INSPECTED) break
          inspected.delete(url)
        }
        const copy = findLibraryCopy(info, dependencies.libraryTracks())
        return {
          ok: true,
          value: {
            ...info,
            lowBitrate: isLowBitrate(info),
            duplicate:
              copy === null
                ? null
                : {
                    trackId: copy.id,
                    artist: copy.artist,
                    title: copy.title,
                    fileName: toOneLine(basename(copy.path), MAX_NAME_LENGTH)
                  }
          }
        }
      }),

    start(text) {
      const address = typeof text === 'string' ? addressOf(text) : null
      // Only what was asked about first: the page has shown its bitrate and its copy.
      const info = address === null ? undefined : inspected.get(address.url)
      if (info === undefined) return { ok: false, code: 'INVALID_INPUT' }
      if (dependencies.folders().libraryRoot === null) {
        return { ok: false, code: 'LIBRARY_NOT_SET' }
      }
      const waiting = entries.some(
        (entry) =>
          entry.url === info.url && entry.item.state !== 'done' && entry.item.state !== 'failed'
      )
      if (!waiting) {
        if (entries.length >= MAX_DOWNLOADS) {
          const finished = entries.findIndex(
            ({ item }) => item.state === 'done' || item.state === 'failed'
          )
          if (finished === -1) return { ok: false, code: 'RUN_ACTIVE' }
          entries.splice(finished, 1)
        }
        entries.push({
          url: info.url,
          item: {
            id: nextId++,
            title: info.title,
            source: info.source,
            state: 'queued',
            percent: null,
            failure: null
          }
        })
        inspected.delete(info.url)
        pump()
        changed()
      }
      return { ok: true, value: list() }
    },

    search: (request) =>
      ask(async (signal) => {
        const parsed = downloadSearchSchema.safeParse(request)
        if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
        const { source, query } = parsed.data
        const answer = await dependencies.ytDlp.json(searchArgs(searchTermOf(source, query)), {
          signal,
          timeoutMs: DOWNLOAD_SEARCH_TIMEOUT_MS
        })
        return { ok: true, value: readSearchHits(answer, source) }
      }),

    list,

    stopAll() {
      // Nothing starts after this, not even what waits in line.
      stopped = true
      for (const { item } of entries) {
        if (item.state === 'queued') {
          item.state = 'failed'
          item.failure = 'failed'
        }
      }
      for (const controller of [...running.values(), ...asking]) controller.abort()
    }
  }
}
