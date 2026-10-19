// Playlists and the tracks of the library that fit them (T-037). The page asks for one
// playlist at a time; what it holds and what is recommended for it is worked out here.
import { basename } from 'path'
import {
  appendPlaylistTracks,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  removePlaylistTrack,
  renamePlaylist,
  swapPlaylistTracks
} from '../db/playlists'
import type { AppDatabase } from '../db/connection'
import { listStyles } from '../db/styles'
import { getTracksByIds, listLibraryTracks, type Track } from '../db/tracks'
import { addDownloadedTracks } from './online-recs'
import { buildProfile, profileSimilarity } from './similarity'
import { isSetAsidePath } from '@shared/duplicates'
import type { Result } from '@shared/errors'
import {
  MAX_PLAYLIST_TRACKS,
  MAX_PLAYLISTS,
  RECOMMENDATION_COUNT,
  type PlaylistAction,
  type PlaylistEditResult,
  type PlaylistSummary,
  type PlaylistTrackItem,
  type PlaylistView
} from '@shared/playlists'
import { toOneLine } from '@shared/text'

// As long as a file name can be on macOS.
const MAX_NAME_LENGTH = 255

export interface PlaylistDependencies {
  db: AppDatabase
  /** The volumes that are mounted now, for which tracks can be played. */
  listMountedVolumes: () => ReadonlySet<string>
}

export function listPlaylistSummaries(dependencies: PlaylistDependencies): PlaylistSummary[] {
  // A download approved since the last listing joins its playlist now (T-038).
  addDownloadedTracks(dependencies.db, dependencies.listMountedVolumes)
  return listPlaylists(dependencies.db)
}

export function itemOf(track: Track, styles: ReadonlyMap<number, string>): PlaylistTrackItem {
  return {
    trackId: track.id,
    // For display only: a file name may hold characters that turn the reading around.
    fileName: toOneLine(basename(track.path), MAX_NAME_LENGTH),
    artist: track.artist,
    title: track.title,
    bpm: track.bpm,
    camelotKey: track.camelotKey,
    energy: track.energy,
    styleName: track.primaryStyleId === null ? null : (styles.get(track.primaryStyleId) ?? null),
    durationMs: track.durationMs,
    // A copy set aside as a duplicate is not played: the audio protocol refuses it.
    unavailable: track.offline || track.fileMissing || isSetAsidePath(track.path)
  }
}

/**
 * Up to ten tracks of the library that fit the playlist as a whole, the best first:
 * none it holds, no copy set aside as a duplicate, none that cannot be played now.
 * Nothing for an empty playlist, which has no profile to fit.
 */
export function recommendFor(
  members: readonly Track[],
  library: readonly Track[]
): { track: Track; score: number }[] {
  if (members.length === 0) return []
  const profile = buildProfile(members)
  const held = new Set(members.map((track) => track.id))
  return library
    .filter((track) => !held.has(track.id) && !track.offline && !track.fileMissing)
    .map((track) => ({ track, score: profileSimilarity(profile, track) }))
    .sort((a, b) => b.score - a.score || a.track.id - b.track.id)
    .slice(0, RECOMMENDATION_COUNT)
}

/**
 * One playlist as the page shows it, or null when there is no such playlist. The
 * recommendations read the whole library; `recommend: false` leaves them out (null) for
 * an edit that cannot change them.
 */
export function playlistView(
  dependencies: PlaylistDependencies,
  playlistId: number,
  { recommend = true }: { recommend?: boolean } = {}
): PlaylistView | null {
  const { db } = dependencies
  addDownloadedTracks(db, dependencies.listMountedVolumes)
  const playlist = getPlaylist(db, playlistId)
  if (!playlist) return null
  const mounted = dependencies.listMountedVolumes()
  const byId = new Map(getTracksByIds(db, playlist.trackIds, mounted).map((t) => [t.id, t]))
  const members = playlist.trackIds.flatMap((id) => byId.get(id) ?? [])
  const styles = new Map(listStyles(db).map((style) => [style.id, style.name]))
  const tempos = members.flatMap((track) => (track.bpm === null ? [] : [Math.round(track.bpm)]))
  return {
    id: playlist.id,
    name: playlist.name,
    tracks: members.map((track) => itemOf(track, styles)),
    totalMs: members.reduce((sum, track) => sum + (track.durationMs ?? 0), 0),
    bpmRange: tempos.length === 0 ? null : [Math.min(...tempos), Math.max(...tempos)],
    keys: [
      ...new Set(members.flatMap((track) => (track.camelotKey === null ? [] : [track.camelotKey])))
    ],
    recommendations: recommend
      ? recommendFor(members, listLibraryTracks(db, mounted)).map(({ track, score }) => ({
          ...itemOf(track, styles),
          score
        }))
      : null
  }
}

/** The track a move swaps places with: the one before (-1) or after (1), or null at an end. */
export function neighbourOf(
  trackIds: readonly number[],
  trackId: number,
  direction: -1 | 1
): number | null {
  const at = trackIds.indexOf(trackId)
  return at === -1 ? null : (trackIds[at + direction] ?? null)
}

/**
 * Applies one edit of the page. Tracks are added at the end, each once, MAX_PLAYLIST_TRACKS
 * at most: a track the playlist holds, one that is not in the library (gone, or set aside
 * as a duplicate), or one beyond the limit is skipped and counted.
 */
export function editPlaylist(
  dependencies: PlaylistDependencies,
  action: PlaylistAction
): Result<PlaylistEditResult> {
  const { db } = dependencies
  const answer = (
    playlistId: number | null,
    { skipped = 0, recommend = true }: { skipped?: number; recommend?: boolean } = {}
  ): Result<PlaylistEditResult> => ({
    ok: true,
    value: {
      playlists: listPlaylists(db),
      view: playlistId === null ? null : playlistView(dependencies, playlistId, { recommend }),
      skipped
    }
  })
  if (action.action === 'create') {
    if (listPlaylists(db).length >= MAX_PLAYLISTS) return { ok: false, code: 'INVALID_INPUT' }
    return answer(createPlaylist(db, action.name))
  }
  const playlist = getPlaylist(db, action.playlistId)
  if (!playlist) return { ok: false, code: 'INVALID_INPUT' }
  switch (action.action) {
    case 'rename':
      renamePlaylist(db, playlist.id, action.name)
      return answer(playlist.id, { recommend: false })
    case 'delete':
      deletePlaylist(db, playlist.id)
      return answer(null)
    case 'add': {
      const held = new Set(playlist.trackIds)
      const asked = [...new Set(action.trackIds)].filter((id) => !held.has(id))
      // Only the tracks asked for are read: the library is not walked for an add.
      const inLibrary = new Set(
        getTracksByIds(db, asked, dependencies.listMountedVolumes())
          .filter((track) => !isSetAsidePath(track.path))
          .map((track) => track.id)
      )
      const room = Math.max(0, MAX_PLAYLIST_TRACKS - playlist.trackIds.length)
      const added = asked.filter((id) => inLibrary.has(id)).slice(0, room)
      appendPlaylistTracks(db, playlist.id, added)
      return answer(playlist.id, { skipped: action.trackIds.length - added.length })
    }
    case 'remove':
      removePlaylistTrack(db, playlist.id, action.trackId)
      return answer(playlist.id)
    case 'move': {
      // The tracks stay the same, and so does what fits them.
      const other = neighbourOf(playlist.trackIds, action.trackId, action.direction)
      if (other !== null) swapPlaylistTracks(db, playlist.id, action.trackId, other)
      return answer(playlist.id, { recommend: false })
    }
  }
}
