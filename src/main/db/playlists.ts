import { asc, count, eq } from 'drizzle-orm'
import type { AppDatabase } from './connection'
import { playlists, playlistTracks } from './schema'

const INSERT_CHUNK_SIZE = 500

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

/** Every playlist, in the order they were made, with how many tracks it holds. */
export function listPlaylists(db: AppDatabase): { id: number; name: string; trackCount: number }[] {
  return db
    .select({ id: playlists.id, name: playlists.name, trackCount: count(playlistTracks.id) })
    .from(playlists)
    .leftJoin(playlistTracks, eq(playlistTracks.playlistId, playlists.id))
    .groupBy(playlists.id)
    .orderBy(asc(playlists.id))
    .all()
}

/** One playlist with its tracks in order, or undefined. */
export function getPlaylist(db: AppDatabase, id: number): PlaylistWithTracks | undefined {
  const playlist = db
    .select({ id: playlists.id, name: playlists.name })
    .from(playlists)
    .where(eq(playlists.id, id))
    .get()
  if (!playlist) return undefined
  const trackIds = db
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, id))
    .orderBy(asc(playlistTracks.position), asc(playlistTracks.id))
    .all()
    .map((entry) => entry.trackId)
  return { ...playlist, trackIds }
}

export function createPlaylist(db: AppDatabase, name: string): number {
  const now = new Date()
  return db
    .insert(playlists)
    .values({ name, createdAt: now, updatedAt: now })
    .returning({ id: playlists.id })
    .get().id
}

export function renamePlaylist(db: AppDatabase, id: number, name: string): void {
  db.update(playlists).set({ name, updatedAt: new Date() }).where(eq(playlists.id, id)).run()
}

/** Removes a playlist and its entries; the tracks stay. */
export function deletePlaylist(db: AppDatabase, id: number): void {
  db.delete(playlists).where(eq(playlists.id, id)).run()
}

/** Makes the playlist hold these tracks in this order, and nothing else. In one step. */
export function setPlaylistTracks(db: AppDatabase, id: number, trackIds: readonly number[]): void {
  db.transaction((tx) => {
    tx.delete(playlistTracks).where(eq(playlistTracks.playlistId, id)).run()
    // In chunks: three bound parameters a row, far below SQLite's limit per statement.
    for (let start = 0; start < trackIds.length; start += INSERT_CHUNK_SIZE) {
      const chunk = trackIds.slice(start, start + INSERT_CHUNK_SIZE)
      tx.insert(playlistTracks)
        .values(
          chunk.map((trackId, index) => ({ playlistId: id, trackId, position: start + index }))
        )
        .run()
    }
    tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run()
  })
}
