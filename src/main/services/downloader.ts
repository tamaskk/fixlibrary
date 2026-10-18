// The one place that runs yt-dlp for downloads (T-034): the arguments it is given and
// the process it runs in. yt-dlp is a module of the sidecar's interpreter
// (`binaries.ts`), started on its own for each call with an argument array, an
// environment of nothing but a PATH of system folders, and a time limit.
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import type { ToolCommand } from './binaries'
import { createLineReader } from './line-reader'
import { failureOf, type DownloadFailure } from '@shared/download'

// Whatever the user or the system configured for yt-dlp has no say: no config file,
// no plugin from the user's folders (`--ignore-config` leaves those on), and no
// extractor but YouTube's and SoundCloud's, so no address falls through to the
// generic one, which follows a page anywhere. Nothing is cached between calls. The
// file's time is now, not the upload's: a scan reads it.
const COMMON_ARGS = [
  '--ignore-config',
  '--no-plugin-dirs',
  '--use-extractors',
  'youtube.*,soundcloud.*',
  '--no-cache-dir',
  '--encoding',
  'utf-8',
  '--socket-timeout',
  '30',
  '--no-mtime'
]

// An answer of `-J` for one video is about 100 KB; captions can make it some MB.
const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_LINE_LENGTH = 4096
// The end of what yt-dlp wrote to its error output, to tell why it failed.
const KEPT_ERROR_LINES = 40

/** What one address is: the answer of `yt-dlp -J`, for one track only. */
export function infoArgs(url: string): string[] {
  return [...COMMON_ARGS, '-J', '--no-playlist', '--', url]
}

/** A search of a service (`ytsearch10:…`), its hits listed, not resolved. */
export function searchArgs(term: string): string[] {
  return [...COMMON_ARGS, '-J', '--flat-playlist', '--', term]
}

export interface DownloadTarget {
  url: string
  /** `<library root>/Inbox`: where the finished MP3 goes. */
  inbox: string
  /** A folder of the app's own for what yt-dlp writes on the way, so the Inbox only ever gets a finished file. */
  temp: string
  /** A folder of the app's own for the thumbnail, the cover of last resort. */
  thumbnails: string
  ffmpeg: string
}

/**
 * One track as an MP3 of 320 kbps, named by its id on the service. The title is read
 * as `Artist - Title` into the tags where it says so; otherwise the service's artist
 * or uploader is the artist.
 */
export function downloadArgs(target: DownloadTarget): string[] {
  return [
    ...COMMON_ARGS,
    '--no-playlist',
    '--no-overwrites',
    '-f',
    'bestaudio/best',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '320K',
    '--ffmpeg-location',
    target.ffmpeg,
    '--embed-metadata',
    '--parse-metadata',
    'title:%(artist)s - %(title)s',
    '--write-thumbnail',
    '--newline',
    '-P',
    `home:${target.inbox}`,
    '-P',
    `temp:${target.temp}`,
    '-P',
    `thumbnail:${target.thumbnails}`,
    '-o',
    '%(id)s.%(ext)s',
    '--',
    target.url
  ]
}

/** Why a call of yt-dlp gave no result. Carries no text of yt-dlp's. */
export class YtDlpError extends Error {
  constructor(readonly failure: DownloadFailure) {
    super(`yt-dlp failed: ${failure}`)
    this.name = 'YtDlpError'
  }
}

export interface YtDlpCallOptions {
  signal?: AbortSignal
  timeoutMs: number
}

export interface YtDlp {
  /** The JSON yt-dlp prints for these arguments. Rejects with a `YtDlpError`. */
  json: (args: readonly string[], options: YtDlpCallOptions) => Promise<unknown>
  /** Runs yt-dlp, handing each line it prints to `onLine`. Rejects with a `YtDlpError`. */
  run: (
    args: readonly string[],
    options: YtDlpCallOptions & { onLine: (line: string) => void }
  ) => Promise<void>
}

/** `command` is asked at every call: null when this installation has no yt-dlp. */
export function createYtDlp(command: () => ToolCommand | null): YtDlp {
  function call(
    args: readonly string[],
    options: YtDlpCallOptions & { onLine?: (line: string) => void; keepOutput: boolean }
  ): Promise<string> {
    const tool = command()
    if (tool === null) return Promise.reject(new YtDlpError('missing'))
    if (options.signal?.aborted) return Promise.reject(new YtDlpError('failed'))

    return new Promise((resolve, reject) => {
      const child = spawn(tool.command, [...tool.args, ...args], {
        env: { PATH: '/usr/bin:/bin' },
        cwd: tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a stop also ends the ffmpeg it started.
        detached: true
      })
      const errorLines: string[] = []
      const output: Buffer[] = []
      let outputBytes = 0
      let failure: DownloadFailure | null = null

      const stop = (why: DownloadFailure): void => {
        failure ??= why
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Gone already.
        }
      }
      const timer = setTimeout(() => stop('timeout'), options.timeoutMs)
      const onAbort = (): void => stop('failed')
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const readLine = options.onLine
        ? createLineReader({
            maxLineLength: MAX_LINE_LENGTH,
            onLine: options.onLine,
            onOverflow: () => undefined
          })
        : null
      child.stdout.on('data', (chunk: Buffer) => {
        readLine?.(chunk)
        if (!options.keepOutput) return
        outputBytes += chunk.length
        if (outputBytes > MAX_JSON_BYTES) stop('failed')
        else output.push(chunk)
      })
      child.stderr.on(
        'data',
        createLineReader({
          maxLineLength: MAX_LINE_LENGTH,
          onLine: (line) => {
            errorLines.push(line)
            if (errorLines.length > KEPT_ERROR_LINES) errorLines.shift()
          },
          onOverflow: () => undefined
        })
      )
      const finish = (error: YtDlpError | null): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(Buffer.concat(output).toString('utf8'))
      }
      child.on('error', () => finish(new YtDlpError(failure ?? 'missing')))
      child.on('close', (code) => {
        if (failure !== null) finish(new YtDlpError(failure))
        else if (code !== 0) finish(new YtDlpError(failureOf(errorLines)))
        else finish(null)
      })
    })
  }

  return {
    async json(args, options) {
      const text = await call(args, { ...options, keepOutput: true })
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new YtDlpError('failed')
      }
    },
    async run(args, options) {
      await call(args, { ...options, keepOutput: false })
    }
  }
}
