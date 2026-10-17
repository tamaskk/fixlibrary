// Downloading single tracks from YouTube and SoundCloud with yt-dlp (T-034): the
// addresses the app accepts, what it reads of yt-dlp's answers, and what the page is
// shown of a download. Everything yt-dlp prints is untrusted text.
import { z } from 'zod'
import { toOneLine } from './text'

export const DOWNLOAD_SOURCES = ['youtube', 'soundcloud'] as const
export type DownloadSource = (typeof DOWNLOAD_SOURCES)[number]

/** Below this bitrate the user is asked before a download starts. */
export const LOW_BITRATE_KBPS = 128
/** Downloads that run at the same time; the others wait in line. */
export const MAX_PARALLEL_DOWNLOADS = 2
export const SEARCH_RESULT_COUNT = 10
export const MAX_URL_LENGTH = 2000
export const MAX_SEARCH_QUERY_LENGTH = 200
/** Downloads the list holds, finished ones included; a page cannot queue more. */
export const MAX_DOWNLOADS = 50

const MAX_TEXT_LENGTH = 300

// Only the services the app downloads from, by the hosts their addresses use.
const HOST_SOURCES: Readonly<Record<string, DownloadSource>> = {
  'youtube.com': 'youtube',
  'www.youtube.com': 'youtube',
  'm.youtube.com': 'youtube',
  'music.youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'soundcloud.com': 'soundcloud',
  'www.soundcloud.com': 'soundcloud',
  'm.soundcloud.com': 'soundcloud',
  'on.soundcloud.com': 'soundcloud',
  // What a SoundCloud search names a track by.
  'api.soundcloud.com': 'soundcloud'
}

export interface DownloadAddress {
  /** The address as the app passes it to yt-dlp: https, no credentials, no port. */
  url: string
  source: DownloadSource
}

/** The address and its service, or null for anything the app does not download from. */
export function addressOf(text: string): DownloadAddress | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  const source = HOST_SOURCES[url.hostname]
  if (source === undefined) return null
  url.protocol = 'https:'
  return { url: url.href, source }
}

const text = z
  .string()
  .transform((value) => toOneLine(value, MAX_TEXT_LENGTH))
  .nullish()
  .catch(null)
const seconds = z.number().nonnegative().nullish().catch(null)

const formatSchema = z.object({
  abr: z.number().positive().nullish().catch(null),
  acodec: z.string().nullish().catch(null),
  vcodec: z.string().nullish().catch(null)
})

const infoSchema = z.object({
  _type: z.string().optional(),
  entries: z.unknown().optional(),
  id: z.string().min(1).max(200),
  title: text,
  uploader: text,
  duration: seconds,
  abr: z.number().positive().nullish().catch(null),
  formats: z.array(z.unknown()).max(2000).nullish().catch(null)
})

export interface DownloadInfo extends DownloadAddress {
  title: string
  uploader: string | null
  durationS: number | null
  /** Of the best audio the service offers, or null when it does not say. */
  bitrateKbps: number | null
}

/** The best audio bitrate a list of formats offers: audio-only formats first. */
export function bestAudioKbps(formats: readonly unknown[]): number | null {
  const audio = formats.flatMap((format) => {
    const parsed = formatSchema.safeParse(format)
    if (!parsed.success || !parsed.data.abr) return []
    const { acodec, vcodec, abr } = parsed.data
    if (acodec === 'none') return []
    return [{ abr, audioOnly: vcodec === 'none' }]
  })
  const preferred = audio.some((format) => format.audioOnly)
    ? audio.filter((format) => format.audioOnly)
    : audio
  if (preferred.length === 0) return null
  return Math.round(Math.max(...preferred.map((format) => format.abr)))
}

/**
 * What `yt-dlp -J` says of one address, `playlist` when it names more than one
 * track (a playlist, a set, a profile), or null when the answer is not usable.
 */
export function readInfo(
  json: unknown,
  address: DownloadAddress
): DownloadInfo | 'playlist' | null {
  const parsed = infoSchema.safeParse(json)
  if (!parsed.success) return null
  const info = parsed.data
  if (info._type === 'playlist' || info._type === 'multi_video' || info.entries !== undefined) {
    return 'playlist'
  }
  const fromFormats = info.formats ? bestAudioKbps(info.formats) : null
  return {
    ...address,
    title: info.title ?? info.id,
    uploader: info.uploader ?? null,
    durationS: info.duration ?? null,
    bitrateKbps: fromFormats ?? (info.abr ? Math.round(info.abr) : null)
  }
}

/** True when the user must be asked before this download starts. */
export function isLowBitrate(info: Pick<DownloadInfo, 'bitrateKbps'>): boolean {
  return info.bitrateKbps !== null && info.bitrateKbps < LOW_BITRATE_KBPS
}

export interface DownloadSearchHit extends DownloadAddress {
  title: string
  uploader: string | null
  durationS: number | null
}

const searchEntrySchema = z.object({
  id: z.string().min(1).max(200),
  title: text,
  uploader: text,
  channel: text,
  duration: seconds,
  url: z.string().nullish().catch(null),
  webpage_url: z.string().nullish().catch(null)
})

/** The search term yt-dlp takes for a service: `ytsearch10:<query>`. */
export function searchTermOf(source: DownloadSource, query: string): string {
  const prefix = source === 'youtube' ? 'ytsearch' : 'scsearch'
  return `${prefix}${SEARCH_RESULT_COUNT}:${toOneLine(query, MAX_SEARCH_QUERY_LENGTH)}`
}

/** The hits of `yt-dlp -J --flat-playlist <term>`; a hit of another service is left out. */
export function readSearchHits(json: unknown, source: DownloadSource): DownloadSearchHit[] {
  const parsed = z.object({ entries: z.array(z.unknown()).max(100) }).safeParse(json)
  if (!parsed.success) return []
  return parsed.data.entries
    .flatMap((entry) => {
      const hit = searchEntrySchema.safeParse(entry)
      if (!hit.success) return []
      const { id, title, uploader, channel, duration, url, webpage_url } = hit.data
      const address = addressOf(webpage_url ?? url ?? '')
      if (address === null || address.source !== source) return []
      return [
        {
          ...address,
          title: title ?? id,
          uploader: uploader ?? channel ?? null,
          durationS: duration ?? null
        }
      ]
    })
    .slice(0, SEARCH_RESULT_COUNT)
}

export type DownloadStep = { kind: 'download'; percent: number } | { kind: 'convert' }

/** What one line of `yt-dlp --newline` says about how far a download is. */
export function readProgressLine(line: string): DownloadStep | null {
  const download = /^\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line)
  if (download) {
    const percent = Number(download[1])
    return percent <= 100 ? { kind: 'download', percent } : null
  }
  return /^\[ExtractAudio\]/.test(line) ? { kind: 'convert' } : null
}

export const DOWNLOAD_FAILURES = ['extract', 'failed', 'timeout', 'missing'] as const
/**
 * `extract`: yt-dlp could not read the service's page, which a newer yt-dlp usually
 * can (task 43); `missing`: this installation has no yt-dlp.
 */
export type DownloadFailure = (typeof DOWNLOAD_FAILURES)[number]

// What yt-dlp says when the service changed under it, not when the track is gone.
const EXTRACT_FAILURE =
  /unable to extract|unable to download (?:api|webpage|json)|nsig extraction failed|signature extraction failed|requested format is not available|sign in to confirm|player response/i

/** Why a download failed, from the lines yt-dlp wrote to its error output. */
export function failureOf(errorLines: readonly string[]): DownloadFailure {
  return errorLines.some((line) => /^ERROR:/.test(line) && EXTRACT_FAILURE.test(line))
    ? 'extract'
    : 'failed'
}

export const DOWNLOAD_STATES = ['queued', 'downloading', 'converting', 'done', 'failed'] as const
export type DownloadState = (typeof DOWNLOAD_STATES)[number]

export interface DownloadItem {
  id: number
  title: string
  source: DownloadSource
  state: DownloadState
  /** Of the download itself; null before it starts and while the file is converted. */
  percent: number | null
  failure: DownloadFailure | null
}

export interface DownloadInspection extends DownloadInfo {
  lowBitrate: boolean
  /** A track of the library that seems to be this one, by its names and length. */
  duplicate: {
    trackId: number
    artist: string | null
    title: string | null
    fileName: string
  } | null
}

export const downloadUrlSchema = z.string().min(1).max(MAX_URL_LENGTH)

export const downloadSearchSchema = z.strictObject({
  source: z.enum(DOWNLOAD_SOURCES),
  query: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH)
})
export type DownloadSearch = z.input<typeof downloadSearchSchema>
