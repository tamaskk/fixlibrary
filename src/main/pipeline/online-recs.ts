// Online recommendations (T-038): tracks that are not in the library and fit a
// playlist. Claude names candidates; each is looked for on YouTube and kept only when a
// video of the same name and a track's length is found and the library has no copy.
// A download started from here adds its track to the playlist once its Inbox batch
// was approved.
import { basename, extname } from 'path'
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { appendPlaylistTracks, getPlaylist } from '../db/playlists'
import { getSetting, setSetting } from '../db/settings'
import { listStyles } from '../db/styles'
import { getTrackById, getTracksByIds, listLibraryTracks, type Track } from '../db/tracks'
import type { OnlineRecCandidate, OnlineRecsInput } from '../services/claude-prompts/online-recs'
import { createOnlineRecsTask } from '../services/claude-prompts/online-recs'
import { looksLikeInstructions } from '../services/claude-prompts/style'
import { searchArgs, type YtDlp } from '../services/downloader'
import { similarity } from '../services/lookup/confidence'
import { logger } from '../services/logger'
import type { Claude } from './claude'
import { findLibraryCopy, type Downloads } from './download'
import { isInInbox } from './inbox'
import { readSettings } from './settings'
import { buildProfile, styleScore, weightedScore, type PlaylistProfile } from './similarity'
import { readSearchHits, type DownloadSearchHit } from '@shared/download'
import { isSetAsidePath } from '@shared/duplicates'
import { AppError, type Result } from '@shared/errors'
import {
  MAX_PLAYLIST_TRACKS,
  RECOMMENDATION_COUNT,
  type OnlineRecommendation
} from '@shared/playlists'
import { toOneLine } from '@shared/text'
import { DOWNLOAD_SEARCH_TIMEOUT_MS } from '@shared/timeouts'

const MAX_EXAMPLES = 20
const MIN_TITLE_SIMILARITY = 0.8
const MIN_DURATION_S = 2 * 60
const MAX_DURATION_S = 15 * 60
// YouTube searches at once; each takes a few seconds.
const PARALLEL_SEARCHES = 4
const MAX_SEARCH_LENGTH = 200
// What is not known of a candidate counts as half: neither for it nor against it.
const NEUTRAL = 0.5
const PENDING_KEY = 'pendingPlaylistAdds'
const MAX_PENDING = 200

export interface OnlineRecsDependencies {
  db: AppDatabase
  listMountedVolumes: () => ReadonlySet<string>
  /** Null before Claude was set up. */
  claude: () => Pick<Claude, 'ask'> | null
  ytDlp: Pick<YtDlp, 'json'>
  downloads: () => Pick<Downloads, 'inspect' | 'start'> | null
}

/** Up to 20 tracks spread over the playlist, none whose text reads like it talks to the model. */
export function examplesOf(members: readonly Track[]): Track[] {
  const usable = members.filter(
    (track) =>
      !looksLikeInstructions({
        artist: track.artist,
        title: track.title,
        mix: track.mix,
        label: track.label
      })
  )
  if (usable.length <= MAX_EXAMPLES) return usable
  return Array.from(
    { length: MAX_EXAMPLES },
    (_, index) => usable[Math.floor((index * usable.length) / MAX_EXAMPLES)] as Track
  )
}

/** What a candidate is searched for by: `Artist - Title Mix`. */
export function searchTextOf(candidate: OnlineRecCandidate): string {
  return toOneLine(
    `${candidate.artist} - ${candidate.title}${candidate.mix === null ? '' : ` ${candidate.mix}`}`,
    MAX_SEARCH_LENGTH
  )
}

/**
 * The hit that is the candidate: a title at least 80% alike, read alone or after the
 * uploader (a "Topic" channel names the artist there), and a track's length, 2 to 15
 * minutes. Null when the search found no such video.
 */
export function verifiedHit(
  candidate: OnlineRecCandidate,
  hits: readonly DownloadSearchHit[]
): DownloadSearchHit | null {
  const named = `${candidate.artist} ${candidate.title}`
  const expected = candidate.mix === null ? [named] : [named, `${named} ${candidate.mix}`]
  return (
    hits.find((hit) => {
      if (hit.durationS === null) return false
      if (hit.durationS < MIN_DURATION_S || hit.durationS > MAX_DURATION_S) return false
      const uploader = hit.uploader?.replace(/\s*-\s*Topic$/u, '') ?? null
      const seen = uploader === null ? [hit.title] : [hit.title, `${uploader} ${hit.title}`]
      const best = Math.max(...expected.flatMap((a) => seen.map((b) => similarity(a, b))))
      return best >= MIN_TITLE_SIMILARITY
    }) ?? null
  )
}

/**
 * How well a candidate fits, 0 to 1. Of a Claude candidate only the style is known;
 * tempo, key, energy and mood count as half.
 */
export function onlineScore(profile: PlaylistProfile, styleId: number | null): number {
  const style =
    styleId === null
      ? NEUTRAL
      : profile.styles.reduce(
          (sum, pair) =>
            sum +
            pair.share * styleScore({ primaryStyleId: styleId, secondaryStyleId: null }, pair),
          0
        )
  return weightedScore({ style, bpm: NEUTRAL, key: NEUTRAL, energy: NEUTRAL, mood: NEUTRAL })
}

/** Runs `work` on every item, `limit` at a time, keeping the order of the items. */
async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** The id YouTube names a video by in its address, which yt-dlp names the file by. */
export function videoIdOf(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('v')
    return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}

const pendingSchema = z
  .array(
    z.object({
      videoId: z.string(),
      playlistId: z.number().int(),
      /** Set once the download is a track of the Inbox. */
      trackId: z.number().int().nullable()
    })
  )
  .catch([])
type PendingAdd = z.output<typeof pendingSchema>[number]

function readPending(db: AppDatabase): PendingAdd[] {
  return getSetting(db, PENDING_KEY, pendingSchema) ?? []
}

/** Notes that the download of this video should join this playlist once approved. */
export function notePendingAdd(db: AppDatabase, videoId: string, playlistId: number): void {
  const pending = readPending(db).filter(
    (entry) => !(entry.videoId === videoId && entry.playlistId === playlistId)
  )
  pending.push({ videoId, playlistId, trackId: null })
  setSetting(db, PENDING_KEY, pending.slice(-MAX_PENDING))
}

/** The Inbox file of a download became a track: yt-dlp named the file by the video id. */
export function noteInboxTrack(db: AppDatabase, path: string, trackId: number): void {
  const videoId = basename(path, extname(path))
  const pending = readPending(db)
  if (!pending.some((entry) => entry.videoId === videoId && entry.trackId === null)) return
  setSetting(
    db,
    PENDING_KEY,
    pending.map((entry) =>
      entry.videoId === videoId && entry.trackId === null ? { ...entry, trackId } : entry
    )
  )
}

/**
 * Adds the downloaded tracks whose Inbox batch was approved, which moved them out of
 * the Inbox, at the end of their playlists. A track that is gone or was set aside as
 * a duplicate is dropped; one still in the Inbox waits.
 */
export function addDownloadedTracks(
  db: AppDatabase,
  listMountedVolumes: () => ReadonlySet<string>
): void {
  const pending = readPending(db)
  if (!pending.some((entry) => entry.trackId !== null)) return
  const root = readSettings(db).library.rootFolder
  const mounted = listMountedVolumes()
  const kept: PendingAdd[] = []
  for (const entry of pending) {
    if (entry.trackId === null) {
      kept.push(entry)
      continue
    }
    const track = getTrackById(db, entry.trackId, mounted)
    if (track === undefined || isSetAsidePath(track.path)) continue
    if (track.offline || isInInbox(track.path, root)) {
      kept.push(entry)
      continue
    }
    const playlist = getPlaylist(db, entry.playlistId)
    if (
      playlist !== undefined &&
      !playlist.trackIds.includes(track.id) &&
      playlist.trackIds.length < MAX_PLAYLIST_TRACKS
    ) {
      appendPlaylistTracks(db, playlist.id, [track.id])
    }
  }
  if (kept.length !== pending.length) setSetting(db, PENDING_KEY, kept)
}

export interface OnlineRecs {
  /** The last recommendations of this playlist in this session, or null. */
  last: (playlistId: number) => OnlineRecommendation[] | null
  /** Asks Claude and checks its candidates; one playlist at a time. */
  request: (playlistId: number) => Promise<Result<OnlineRecommendation[]>>
  /** Downloads a recommendation into the Inbox; its track joins the playlist after approval. */
  download: (playlistId: number, url: string) => Promise<Result<null>>
  stop: () => void
}

export function createOnlineRecs(dependencies: OnlineRecsDependencies): OnlineRecs {
  const { db } = dependencies
  const kept = new Map<number, OnlineRecommendation[]>()
  let running: AbortController | null = null

  async function verify(
    candidate: OnlineRecCandidate,
    signal: AbortSignal
  ): Promise<DownloadSearchHit | null> {
    try {
      const answer = await dependencies.ytDlp.json(
        searchArgs(`ytsearch1:${searchTextOf(candidate)}`),
        { signal, timeoutMs: DOWNLOAD_SEARCH_TIMEOUT_MS }
      )
      return verifiedHit(candidate, readSearchHits(answer, 'youtube'))
    } catch (error) {
      // One search that fails drops its candidate, not the rest.
      logger.warn(`An online recommendation could not be checked: ${String(error)}`)
      return null
    }
  }

  async function recommend(
    playlistId: number,
    signal: AbortSignal
  ): Promise<Result<OnlineRecommendation[]>> {
    const playlist = getPlaylist(db, playlistId)
    if (playlist === undefined) return { ok: false, code: 'INVALID_INPUT' }
    const mounted = dependencies.listMountedVolumes()
    const members = getTracksByIds(db, playlist.trackIds, mounted)
    if (members.length === 0) return { ok: true, value: [] }
    const styles = listStyles(db)
    const styleName = new Map(styles.map((style) => [style.id, style.name]))
    const styleId = new Map(styles.map((style) => [style.name.toLowerCase(), style.id]))
    const profile = buildProfile(members)
    const input: OnlineRecsInput = {
      styles: [...profile.styles]
        .sort((a, b) => b.share - a.share)
        .flatMap((pair) => {
          const name = pair.primaryStyleId === null ? undefined : styleName.get(pair.primaryStyleId)
          return name === undefined ? [] : [{ name, share: Math.round(pair.share * 100) / 100 }]
        }),
      bpm: profile.bpm === null ? null : Math.round(profile.bpm),
      keys: profile.keys,
      energy: profile.energy === null ? null : Math.round(profile.energy * 10) / 10,
      moods: profile.moods,
      examples: examplesOf(members).map((track) => ({
        artist: track.artist,
        title: track.title,
        mix: track.mix,
        style: track.primaryStyleId === null ? null : (styleName.get(track.primaryStyleId) ?? null),
        bpm: track.bpm === null ? null : Math.round(track.bpm),
        key: track.camelotKey
      }))
    }
    const claude = dependencies.claude()
    if (claude === null) return { ok: false, code: 'CLAUDE_FAILED' }
    let candidates: OnlineRecCandidate[]
    try {
      const answer = await claude.ask(
        createOnlineRecsTask(styles.map((style) => style.name)),
        input,
        signal
      )
      candidates = answer.candidates
    } catch (error) {
      if (error instanceof AppError) return { ok: false, code: error.code }
      throw error
    }
    const hits = await eachLimited(candidates, PARALLEL_SEARCHES, (candidate) =>
      signal.aborted ? Promise.resolve(null) : verify(candidate, signal)
    )
    const library = listLibraryTracks(db, mounted)
    const seen = new Set<string>()
    const found = candidates.flatMap((candidate, rank) => {
      const hit = hits[rank]
      if (hit === null || hit === undefined || seen.has(hit.url)) return []
      seen.add(hit.url)
      // The name rule of the duplicates (T-017), with the length of the video.
      const copy = findLibraryCopy(
        {
          url: hit.url,
          source: 'youtube',
          title: `${candidate.artist} - ${candidate.title}${candidate.mix === null ? '' : ` (${candidate.mix})`}`,
          uploader: null,
          durationS: hit.durationS,
          bitrateKbps: null
        },
        library
      )
      if (copy !== null) return []
      const id = candidate.style === null ? undefined : styleId.get(candidate.style.toLowerCase())
      return [
        {
          rank,
          recommendation: {
            artist: candidate.artist,
            title: candidate.title,
            mix: candidate.mix,
            styleName: id === undefined ? null : (styleName.get(id) ?? null),
            source: 'claude' as const,
            url: hit.url,
            videoTitle: hit.title,
            durationS: hit.durationS as number,
            score: onlineScore(profile, id ?? null)
          }
        }
      ]
    })
    return {
      ok: true,
      value: found
        .sort((a, b) => b.recommendation.score - a.recommendation.score || a.rank - b.rank)
        .slice(0, RECOMMENDATION_COUNT)
        .map(({ recommendation }) => recommendation)
    }
  }

  return {
    last: (playlistId) => kept.get(playlistId) ?? null,

    async request(playlistId) {
      if (running !== null) return { ok: false, code: 'RUN_ACTIVE' }
      const controller = new AbortController()
      running = controller
      try {
        const result = await recommend(playlistId, controller.signal)
        if (result.ok) kept.set(playlistId, result.value)
        return result
      } finally {
        running = null
      }
    },

    async download(playlistId, url) {
      const known = kept.get(playlistId)?.some((recommendation) => recommendation.url === url)
      const videoId = videoIdOf(url)
      const downloads = dependencies.downloads()
      // Only an address this playlist was recommended: the page names it, main checked it.
      if (!known || videoId === null || downloads === null) {
        return { ok: false, code: 'INVALID_INPUT' }
      }
      const inspected = await downloads.inspect(url)
      if (!inspected.ok) return inspected
      const started = downloads.start(url)
      if (!started.ok) return started
      notePendingAdd(db, videoId, playlistId)
      return { ok: true, value: null }
    },

    stop() {
      running?.abort()
    }
  }
}
