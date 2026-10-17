import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { insertTracks, listLibraryTracks, type Track } from '../db/tracks'
import { YtDlpError, type YtDlp } from '../services/downloader'
import type { DownloadInfo, DownloadItem } from '@shared/download'
import { createDownloads, findLibraryCopy, findThumbnail, type Downloads } from './download'

const ADDRESS = 'https://www.youtube.com/watch?v=aaaaaaaaaaa'

let testDatabase: TestDatabase
let folder: string

beforeEach(() => {
  testDatabase = createTestDatabase()
  folder = mkdtempSync(join(tmpdir(), 'fixlibrary-download-'))
})

afterEach(() => {
  testDatabase.cleanup()
  rmSync(folder, { recursive: true, force: true })
})

function libraryWith(
  rows: { artist: string; title: string; mix?: string; durationMs: number }[]
): Track[] {
  insertTracks(
    testDatabase.db,
    rows.map((row, index) => ({
      path: `/Music/House/${index}.mp3`,
      originalPath: `/Music/House/${index}.mp3`,
      format: 'mp3',
      ...row
    }))
  )
  return listLibraryTracks(testDatabase.db, new Set())
}

function info(
  title: string,
  durationS: number | null,
  uploader: string | null = null
): DownloadInfo {
  return { url: ADDRESS, source: 'youtube', title, uploader, durationS, bitrateKbps: 160 }
}

describe('findLibraryCopy', () => {
  it('finds the track the title names, junk of the video left out', () => {
    // Arrange
    const tracks = libraryWith([
      { artist: 'Bicep', title: 'Glue', durationMs: 269_000 },
      { artist: 'Bicep', title: 'Apricots', durationMs: 300_000 }
    ])

    // Act
    const copy = findLibraryCopy(info('Bicep - Glue (Official Video)', 270), tracks)

    // Assert
    expect(copy?.title).toBe('Glue')
  })

  it('takes the uploader as the artist when the title names none', () => {
    // Arrange
    const tracks = libraryWith([{ artist: 'Bicep', title: 'Glue', durationMs: 270_000 }])

    // Act
    const copy = findLibraryCopy(info('Glue', 270, 'BICEP'), tracks)

    // Assert
    expect(copy?.artist).toBe('Bicep')
  })

  it('finds nothing for another mix or another length', () => {
    // Arrange
    const tracks = libraryWith([{ artist: 'Bicep', title: 'Glue', durationMs: 270_000 }])

    // Act
    const remix = findLibraryCopy(info('Bicep - Glue (Extended Mix)', 270), tracks)
    const longer = findLibraryCopy(info('Bicep - Glue', 290), tracks)

    // Assert
    expect(remix).toBeNull()
    expect(longer).toBeNull()
  })
})

/** A yt-dlp whose downloads end only when the test says so. */
function fakeYtDlp(
  answer: unknown = {
    id: 'aaaaaaaaaaa',
    title: 'Artist - Title',
    duration: 200,
    formats: [{ abr: 160, acodec: 'opus', vcodec: 'none' }]
  }
): YtDlp & {
  started: string[]
  finish: (url: string, failure?: YtDlpError) => void
} {
  const waiting = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>()
  const started: string[] = []
  return {
    started,
    json: async () => answer,
    run: (args, options) =>
      new Promise<void>((resolve, reject) => {
        const url = args.at(-1) ?? ''
        started.push(url)
        options.onLine('[download]  50.0% of 1MiB')
        waiting.set(url, { resolve, reject })
      }),
    finish(url, failure) {
      const run = waiting.get(url)
      if (failure) run?.reject(failure)
      else run?.resolve()
    }
  }
}

function downloadsWith(
  ytDlp: YtDlp,
  libraryRoot: string | null = folder
): { downloads: Downloads; changes: DownloadItem[][] } {
  const changes: DownloadItem[][] = []
  const downloads = createDownloads({
    ytDlp,
    folders: () => ({
      libraryRoot,
      temp: join(folder, 'app/tmp'),
      thumbnails: join(folder, 'app/thumbs')
    }),
    ffmpeg: () => '/bin/ffmpeg',
    libraryTracks: () => listLibraryTracks(testDatabase.db, new Set()),
    onChange: (items) => changes.push(items)
  })
  return { downloads, changes }
}

describe('createDownloads', () => {
  it('says what an address is: its bitrate, and the track it may be a copy of', async () => {
    // Arrange
    libraryWith([{ artist: 'Artist', title: 'Title', durationMs: 200_000 }])
    const { downloads } = downloadsWith(
      fakeYtDlp({
        id: 'a',
        title: 'Artist - Title',
        duration: 200,
        formats: [{ abr: 96, acodec: 'mp3', vcodec: 'none' }]
      })
    )

    // Act
    const inspected = await downloads.inspect(ADDRESS)

    // Assert
    expect(inspected).toMatchObject({
      ok: true,
      value: { bitrateKbps: 96, lowBitrate: true, duplicate: { title: 'Title', fileName: '0.mp3' } }
    })
  })

  it('refuses an address of another service and one that names a playlist', async () => {
    // Arrange
    const { downloads } = downloadsWith(fakeYtDlp({ _type: 'playlist', id: 'p', entries: [] }))

    // Act
    const elsewhere = await downloads.inspect('https://example.com/a')
    const playlist = await downloads.inspect(ADDRESS)

    // Assert
    expect(elsewhere).toEqual({ ok: false, code: 'DOWNLOAD_UNSUPPORTED' })
    expect(playlist).toEqual({ ok: false, code: 'DOWNLOAD_PLAYLIST' })
  })

  it('suggests an update when yt-dlp cannot read the page', async () => {
    // Arrange
    const ytDlp = fakeYtDlp()
    ytDlp.json = () => Promise.reject(new YtDlpError('extract'))
    const { downloads } = downloadsWith(ytDlp)

    // Act
    const inspected = await downloads.inspect(ADDRESS)

    // Assert
    expect(inspected).toEqual({ ok: false, code: 'DOWNLOAD_EXTRACT_FAILED' })
  })

  it('downloads only an address that was asked about first', () => {
    // Arrange
    const { downloads } = downloadsWith(fakeYtDlp())

    // Act
    const started = downloads.start(ADDRESS)

    // Assert
    expect(started).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('downloads two at a time and starts the next when one ends', async () => {
    // Arrange
    const ytDlp = fakeYtDlp()
    const { downloads } = downloadsWith(ytDlp)
    const addresses = [1, 2, 3, 4, 5].map((n) => `https://www.youtube.com/watch?v=video${n}`)
    for (const address of addresses) {
      await downloads.inspect(address)
      downloads.start(address)
    }
    await vi.waitFor(() => expect(ytDlp.started).toHaveLength(2))

    // Act
    const before = [...ytDlp.started]
    ytDlp.finish(addresses[0] ?? '')
    await vi.waitFor(() => expect(ytDlp.started).toHaveLength(3))

    // Assert
    // The folders are made first, so two downloads may start in either order.
    expect([...before].sort()).toEqual(addresses.slice(0, 2))
    expect([...ytDlp.started].sort()).toEqual(addresses.slice(0, 3))
    expect(downloads.list().map((item) => item.state)).toEqual([
      'done',
      'downloading',
      'downloading',
      'queued',
      'queued'
    ])
  })

  it('makes the Inbox inside the library and shows a failure by its kind', async () => {
    // Arrange
    const ytDlp = fakeYtDlp()
    const { downloads } = downloadsWith(ytDlp)
    await downloads.inspect(ADDRESS)
    downloads.start(ADDRESS)
    await vi.waitFor(() => expect(ytDlp.started).toHaveLength(1))

    // Act
    ytDlp.finish(ADDRESS, new YtDlpError('extract'))
    await vi.waitFor(() => expect(downloads.list()[0]?.state).toBe('failed'))

    // Assert
    expect(statSync(join(folder, 'Inbox')).isDirectory()).toBe(true)
    expect(downloads.list()).toEqual([
      expect.objectContaining({ state: 'failed', failure: 'extract', percent: null })
    ])
  })

  it('stops what runs at quitting, and starts nothing of what waits in line', async () => {
    // Arrange
    const ytDlp = fakeYtDlp()
    const aborted: string[] = []
    const run = ytDlp.run
    ytDlp.run = (args, options) => {
      options.signal?.addEventListener('abort', () => {
        aborted.push(args.at(-1) ?? '')
        ytDlp.finish(args.at(-1) ?? '', new YtDlpError('failed'))
      })
      return run(args, options)
    }
    const { downloads } = downloadsWith(ytDlp)
    const addresses = [1, 2, 3].map((n) => `https://www.youtube.com/watch?v=video${n}`)
    for (const address of addresses) {
      await downloads.inspect(address)
      downloads.start(address)
    }
    await vi.waitFor(() => expect(ytDlp.started).toHaveLength(2))

    // Act
    downloads.stopAll()
    await vi.waitFor(() =>
      expect(downloads.list().every((item) => item.state === 'failed')).toBe(true)
    )

    // Assert
    expect([...aborted].sort()).toEqual(addresses.slice(0, 2))
    expect(ytDlp.started).toHaveLength(2)
    expect(downloads.list().map((item) => item.state)).toEqual(['failed', 'failed', 'failed'])
  })

  it('downloads nothing into an Inbox that is a link', async () => {
    // Arrange
    const elsewhere = join(folder, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(folder, 'Inbox'))
    const ytDlp = fakeYtDlp()
    const { downloads } = downloadsWith(ytDlp)
    await downloads.inspect(ADDRESS)

    // Act
    downloads.start(ADDRESS)
    await vi.waitFor(() => expect(downloads.list()[0]?.state).toBe('failed'))

    // Assert
    expect(ytDlp.started).toEqual([])
    expect(downloads.list()[0]?.state).toBe('failed')
  })

  it('makes no library folder when the library is not there', async () => {
    // Arrange
    const ytDlp = fakeYtDlp()
    const { downloads } = downloadsWith(ytDlp, join(folder, 'unplugged'))
    await downloads.inspect(ADDRESS)

    // Act
    downloads.start(ADDRESS)
    await vi.waitFor(() => expect(downloads.list()[0]?.state).toBe('failed'))

    // Assert
    expect(ytDlp.started).toEqual([])
    expect(downloads.list()[0]?.state).toBe('failed')
  })

  it('refuses to download without a library', async () => {
    // Arrange
    const { downloads } = downloadsWith(fakeYtDlp(), null)
    await downloads.inspect(ADDRESS)

    // Act
    const started = downloads.start(ADDRESS)

    // Assert
    expect(started).toEqual({ ok: false, code: 'LIBRARY_NOT_SET' })
  })

  it('searches a service', async () => {
    // Arrange
    const { downloads } = downloadsWith(
      fakeYtDlp({ entries: [{ id: 'x', title: 'Hit', url: 'https://www.youtube.com/watch?v=x' }] })
    )

    // Act
    const hits = await downloads.search({ source: 'youtube', query: 'hit' })
    const empty = await downloads.search({ source: 'youtube', query: '  ' })

    // Assert
    expect(hits).toMatchObject({ ok: true, value: [{ title: 'Hit' }] })
    expect(empty).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('findThumbnail', () => {
  it('finds the thumbnail of a download that is still in the Inbox', async () => {
    // Arrange
    const thumbnails = join(folder, 'thumbs')
    mkdirSync(thumbnails)
    writeFileSync(join(thumbnails, 'aaaaaaaaaaa.webp'), 'x')

    // Act
    const found = await findThumbnail(join(folder, 'Inbox/aaaaaaaaaaa.mp3'), folder, thumbnails)
    const renamed = await findThumbnail(
      join(folder, 'Inbox/Artist - Title.mp3'),
      folder,
      thumbnails
    )
    const elsewhere = await findThumbnail(join(folder, 'House/aaaaaaaaaaa.mp3'), folder, thumbnails)

    // Assert
    expect(found).toBe(join(thumbnails, 'aaaaaaaaaaa.webp'))
    expect(renamed).toBeNull()
    expect(elsewhere).toBeNull()
  })
})
