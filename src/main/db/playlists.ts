import { asc } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { playlists, playlistTracks } from './schema'

export interface PlaylistWithTracks {
  id: number
  name: string
  /** The tracks in the playlist's order. */
  trackIds: number[]
}

/** Every playlist, in the order they were made, with its tracks in order. */
export function listPlaylistsWithTracks(db: AppDatabase): PlaylistWithTracks[] {
  const entries = db
    .select({ playlistId: playlistTracks.playlistId, trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .orderBy(asc(playlistTracks.playlistId), asc(playlistTracks.position), asc(playlistTracks.id))
    .all()
  // Grouped once: a library of playlists times their entries is not walked again per playlist.
  const byPlaylist = new Map<number, number[]>()
  for (const entry of entries) {
    const list = byPlaylist.get(entry.playlistId)
    if (list) list.push(entry.trackId)
    else byPlaylist.set(entry.playlistId, [entry.trackId])
  }
  return db
    .select({ id: playlists.id, name: playlists.name })
    .from(playlists)
    .orderBy(asc(playlists.id))
    .all()
    .map((playlist) => ({ ...playlist, trackIds: byPlaylist.get(playlist.id) ?? [] }))
}
