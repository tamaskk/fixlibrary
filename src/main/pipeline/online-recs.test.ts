import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { appendPlaylistTracks, createPlaylist, getPlaylist } from '../db/playlists'
import { setSetting } from '../db/settings'
import { addStyle } from '../db/styles'
import { insertTracks, updateTrack } from '../db/tracks'
import type { OnlineRecCandidate } from '../services/claude-prompts/online-recs'
import {
  addDownloadedTracks,
  createOnlineRecs,
  noteInboxTrack,
  notePendingAdd,
  onlineScore,
  verifiedHit,
  videoIdOf,
  type OnlineRecsDependencies
} from './online-recs'
import { buildProfile } from './similarity'
import type { DownloadSearchHit } from '@shared/download'
import { DEFAULT_SETTINGS } from '@shared/settings'

let testDatabase: TestDatabase

function addTrack(path: string, values: Parameters<typeof updateTrack>[2] = {}): number {
  const [id] = insertTracks(testDatabase.db, [{ path, originalPath: path, format: 'mp3' }]) as [
    number
  ]
  updateTrack(testDatabase.db, id, values)
  return id
}

function hit(
  title: string,
  durationS: number | null,
  uploader: string | null = null
): DownloadSearchHit {
  return {
    url: 'https://www.youtube.com/watch?v=abc',
    source: 'youtube',
    title,
    uploader,
    durationS
  }
}

const candidate: OnlineRecCandidate = {
  artist: 'Kerri Chandler',
  title: 'Rain',
  mix: null,
  style: 'Deep House'
}

beforeEach(() => {
  testDatabase = createTestDatabase()
  setSetting(testDatabase.db, 'library', { ...DEFAULT_SETTINGS.library, rootFolder: '/Music' })
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('verifiedHit', () => {
  it('keeps a video of the same name and a track length', () => {
    // Act
    const found = verifiedHit(candidate, [hit('Kerri Chandler - Rain', 420)])

    // Assert
    expect(found?.title).toBe('Kerri Chandler - Rain')
  })

  it('reads the artist from a Topic channel', () => {
    // Act
    const found = verifiedHit(candidate, [hit('Rain', 420, 'Kerri Chandler - Topic')])

    // Assert
    expect(found).not.toBeNull()
  })

  it.each([
    ['another track', hit('Kerri Chandler - Bar A Thym', 420)],
    ['a video that is too short', hit('Kerri Chandler - Rain', 90)],
    ['a video that is too long', hit('Kerri Chandler - Rain', 3600)],
    ['a video of unknown length', hit('Kerri Chandler - Rain', null)]
  ])('drops %s', (_name, given) => {
    // Act
    const found = verifiedHit(candidate, [given])

    // Assert
    expect(found).toBeNull()
  })
})

describe('onlineScore', () => {
  it('counts what is not known of a candidate as half', () => {
    // Arrange
    const profile = buildProfile([
      {
        primaryStyleId: 1,
        secondaryStyleId: null,
        bpm: 122,
        camelotKey: '8A',
        energy: 5,
        moodTags: null
      }
    ])

    // Act
    const sameStyle = onlineScore(profile, 1)
    const otherStyle = onlineScore(profile, 2)
    const noStyle = onlineScore(profile, null)

    // Assert
    expect(sameStyle).toBeCloseTo(0.35 + 0.65 * 0.5)
    expect(otherStyle).toBeCloseTo(0.65 * 0.5)
    expect(noStyle).toBeCloseTo(0.5)
  })
})

describe('videoIdOf', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=../x', null],
    ['not an address', null]
  ])('reads %s as %s', (url, expected) => {
    // Act
    const id = videoIdOf(url)

    // Assert
    expect(id).toBe(expected)
  })
})

describe('recommending online', () => {
  function dependencies(
    candidates: OnlineRecCandidate[],
    hits: Record<string, { title: string; duration: number }>
  ): OnlineRecsDependencies & {
    inspect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
  } {
    const inspect = vi.fn(async () => ({ ok: true }))
    const start = vi.fn(() => ({ ok: true, value: [] }))
    return {
      db: testDatabase.db,
      listMountedVolumes: () => new Set(),
      claude: () => ({ ask: vi.fn(async () => ({ candidates })) }) as never,
      ytDlp: {
        json: vi.fn(async (args: readonly string[]) => {
          const term = (args.at(-1) ?? '').replace('ytsearch1:', '')
          const found = hits[term]
          return {
            entries:
              found === undefined
                ? []
                : [
                    {
                      id: term.length.toString(),
                      title: found.title,
                      duration: found.duration,
                      url: `https://www.youtube.com/watch?v=v${Object.keys(hits).indexOf(term)}`
                    }
                  ]
          }
        })
      },
      downloads: () => ({ inspect, start }) as never,
      inspect,
      start
    }
  }

  it('shows only checked candidates the library has not, the best fitting first', async () => {
    // Arrange
    const house = addStyle(testDatabase.db, 'Deep House', '#ffffff')?.id ?? null
    addStyle(testDatabase.db, 'Techno', '#000000')
    const playlistId = createPlaylist(testDatabase.db, 'Sunset')
    const member = addTrack('/Music/a.mp3', { artist: 'A', title: 'B', primaryStyleId: house })
    addTrack('/Music/owned.mp3', { artist: 'Owned', title: 'Track', durationMs: 400_000 })
    appendPlaylistTracks(testDatabase.db, playlistId, [member])
    const deps = dependencies(
      [
        { artist: 'Techno', title: 'One', mix: null, style: 'Techno' },
        { artist: 'Owned', title: 'Track', mix: null, style: 'Deep House' },
        { artist: 'Made', title: 'Up', mix: null, style: 'Deep House' },
        { artist: 'Deep', title: 'One', mix: 'Dub', style: 'deep house' }
      ],
      {
        'Techno - One': { title: 'Techno - One', duration: 400 },
        'Owned - Track': { title: 'Owned - Track', duration: 400 },
        'Deep - One Dub': { title: 'Deep - One (Dub)', duration: 400 }
      }
    )
    const onlineRecs = createOnlineRecs(deps)

    // Act
    const result = await onlineRecs.request(playlistId)

    // Assert
    expect(result.ok && result.value.map((rec) => `${rec.artist} - ${rec.title}`)).toEqual([
      'Deep - One',
      'Techno - One'
    ])
    expect(result.ok && result.value[0]?.styleName).toBe('Deep House')
    expect(onlineRecs.last(playlistId)).toEqual(result.ok ? result.value : null)
  })

  it('downloads only an address it recommended for that playlist, and notes the playlist', async () => {
    // Arrange
    const playlistId = createPlaylist(testDatabase.db, 'Sunset')
    appendPlaylistTracks(testDatabase.db, playlistId, [addTrack('/Music/a.mp3')])
    const deps = dependencies([{ artist: 'X', title: 'Y', mix: null, style: null }], {
      'X - Y': { title: 'X - Y', duration: 300 }
    })
    const onlineRecs = createOnlineRecs(deps)
    const result = await onlineRecs.request(playlistId)
    const url = result.ok ? (result.value[0]?.url ?? '') : ''

    // Act
    const refused = await onlineRecs.download(playlistId, 'https://www.youtube.com/watch?v=zzz')
    const started = await onlineRecs.download(playlistId, url)

    // Assert
    expect(refused).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(started).toEqual({ ok: true, value: null })
    expect(deps.start).toHaveBeenCalledWith(url)
  })
})

describe('adding a downloaded track after approval', () => {
  it('adds it at the end once its batch moved it out of the Inbox', () => {
    // Arrange
    const playlistId = createPlaylist(testDatabase.db, 'Sunset')
    appendPlaylistTracks(testDatabase.db, playlistId, [addTrack('/Music/a.mp3')])
    notePendingAdd(testDatabase.db, 'vid1', playlistId)
    const track = addTrack('/Music/Inbox/vid1.mp3')
    noteInboxTrack(testDatabase.db, '/Music/Inbox/vid1.mp3', track)

    // Act
    addDownloadedTracks(testDatabase.db, () => new Set())
    const whileInInbox = getPlaylist(testDatabase.db, playlistId)?.trackIds.length
    updateTrack(testDatabase.db, track, { path: '/Music/Deep House/X - Y.mp3' })
    addDownloadedTracks(testDatabase.db, () => new Set())
    addDownloadedTracks(testDatabase.db, () => new Set())

    // Assert
    expect(whileInInbox).toBe(1)
    expect(getPlaylist(testDatabase.db, playlistId)?.trackIds.at(-1)).toBe(track)
    expect(getPlaylist(testDatabase.db, playlistId)?.trackIds).toHaveLength(2)
  })

  it('drops a download that was set aside as a duplicate', () => {
    // Arrange
    const playlistId = createPlaylist(testDatabase.db, 'Sunset')
    notePendingAdd(testDatabase.db, 'vid2', playlistId)
    const track = addTrack('/Music/Inbox/vid2.mp3')
    noteInboxTrack(testDatabase.db, '/Music/Inbox/vid2.mp3', track)
    updateTrack(testDatabase.db, track, { path: '/Music/_Duplicates/vid2.mp3' })

    // Act
    addDownloadedTracks(testDatabase.db, () => new Set())

    // Assert
    expect(getPlaylist(testDatabase.db, playlistId)?.trackIds).toEqual([])
  })
})
