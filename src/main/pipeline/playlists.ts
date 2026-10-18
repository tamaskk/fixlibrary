// Playlists and the tracks of the library that fit them (T-037). The page asks for one
// playlist at a time; what it holds and what is recommended for it is worked out here.
import { basename } from 'path'
import {
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  renamePlaylist,
  setPlaylistTracks
} from '../db/playlists'
import type { AppDatabase } from '../db/connection'
import { listStyles } from '../db/styles'
import { getTracksByIds, listLibraryTracks, type Track } from '../db/tracks'
import { buildProfile, profileSimilarity } from './similarity'
import type { Result } from '@shared/errors'
import {
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
  return listPlaylists(dependencies.db)
}

function itemOf(track: Track, styles: ReadonlyMap<number, string>): PlaylistTrackItem {
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
    unavailable: track.offline || track.fileMissing
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

/** One playlist as the page shows it, or null when there is no such playlist. */
export function playlistView(
  dependencies: PlaylistDependencies,
  playlistId: number
): PlaylistView | null {
  const { db } = dependencies
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
    recommendations: recommendFor(members, listLibraryTracks(db, mounted)).map(
      ({ track, score }) => ({ ...itemOf(track, styles), score })
    )
  }
}

/** The order of a playlist with one track moved a place up (-1) or down (1). */
export function movedOne(
  trackIds: readonly number[],
  trackId: number,
  direction: -1 | 1
): number[] {
  const from = trackIds.indexOf(trackId)
  const to = from + direction
  if (from === -1 || to < 0 || to >= trackIds.length) return [...trackIds]
  const order = [...trackIds]
  order[from] = order[to] as number
  order[to] = trackId
  return order
}

/**
 * Applies one edit of the page. Tracks are added at the end, each once: a track the
 * playlist holds, or one that is not in the library (gone, or set aside as a
 * duplicate), is skipped and counted.
 */
export function editPlaylist(
  dependencies: PlaylistDependencies,
  action: PlaylistAction
): Result<PlaylistEditResult> {
  const { db } = dependencies
  const answer = (playlistId: number | null, skipped = 0): Result<PlaylistEditResult> => ({
    ok: true,
    value: {
      playlists: listPlaylists(db),
      view: playlistId === null ? null : playlistView(dependencies, playlistId),
      skipped
    }
  })
  if (action.action === 'create') return answer(createPlaylist(db, action.name))
  const playlist = getPlaylist(db, action.playlistId)
  if (!playlist) return { ok: false, code: 'INVALID_INPUT' }
  switch (action.action) {
    case 'rename':
      renamePlaylist(db, playlist.id, action.name)
      return answer(playlist.id)
    case 'delete':
      deletePlaylist(db, playlist.id)
      return answer(null)
    case 'add': {
      const held = new Set(playlist.trackIds)
      const inLibrary = new Set(
        listLibraryTracks(db, dependencies.listMountedVolumes()).map((track) => track.id)
      )
      const added = [...new Set(action.trackIds)].filter((id) => !held.has(id) && inLibrary.has(id))
      setPlaylistTracks(db, playlist.id, [...playlist.trackIds, ...added])
      return answer(playlist.id, action.trackIds.length - added.length)
    }
    case 'remove':
      setPlaylistTracks(
        db,
        playlist.id,
        playlist.trackIds.filter((id) => id !== action.trackId)
      )
      return answer(playlist.id)
    case 'move':
      setPlaylistTracks(
        db,
        playlist.id,
        movedOne(playlist.trackIds, action.trackId, action.direction)
      )
      return answer(playlist.id)
  }
}
