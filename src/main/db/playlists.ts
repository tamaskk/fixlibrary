import { and, asc, count, desc, eq } from 'drizzle-orm'
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

/** Swaps the places of two tracks of a playlist; the rest stay where they are. */
export function swapPlaylistTracks(db: AppDatabase, id: number, a: number, b: number): void {
  db.transaction((tx) => {
    const entryOf = (trackId: number): { id: number; position: number } | undefined =>
      tx
        .select({ id: playlistTracks.id, position: playlistTracks.position })
        .from(playlistTracks)
        .where(and(eq(playlistTracks.playlistId, id), eq(playlistTracks.trackId, trackId)))
        .get()
    const first = entryOf(a)
    const second = entryOf(b)
    if (!first || !second) return
    tx.update(playlistTracks)
      .set({ position: second.position })
      .where(eq(playlistTracks.id, first.id))
      .run()
    tx.update(playlistTracks)
      .set({ position: first.position })
      .where(eq(playlistTracks.id, second.id))
      .run()
    tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run()
  })
}

/** Takes one track out of a playlist; the order of the rest stays. */
export function removePlaylistTrack(db: AppDatabase, id: number, trackId: number): void {
  db.transaction((tx) => {
    tx.delete(playlistTracks)
      .where(and(eq(playlistTracks.playlistId, id), eq(playlistTracks.trackId, trackId)))
      .run()
    tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run()
  })
}

/** Appends tracks at the end of a playlist, after the last place it has. */
export function appendPlaylistTracks(
  db: AppDatabase,
  id: number,
  trackIds: readonly number[]
): void {
  db.transaction((tx) => {
    const last = tx
      .select({ position: playlistTracks.position })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, id))
      .orderBy(desc(playlistTracks.position))
      .limit(1)
      .get()
    const start = (last?.position ?? -1) + 1
    for (let from = 0; from < trackIds.length; from += INSERT_CHUNK_SIZE) {
      const chunk = trackIds.slice(from, from + INSERT_CHUNK_SIZE)
      tx.insert(playlistTracks)
        .values(
          chunk.map((trackId, index) => ({
            playlistId: id,
            trackId,
            position: start + from + index
          }))
        )
        .run()
    }
    tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id)).run()
  })
}
