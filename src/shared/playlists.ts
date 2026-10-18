// Playlists (T-037): what the page shows of them, and the edits it can ask for. The
// main process decides everything else: which tracks may be added and what fits.
import { z } from 'zod'

export const MAX_PLAYLIST_NAME = 100
export const RECOMMENDATION_COUNT = 10
// Far above a set or a crate; they keep one edit from scanning without end.
export const MAX_PLAYLISTS = 500
export const MAX_PLAYLIST_TRACKS = 5000

/** A playlist name: one line, trimmed, its runs of spaces made one. */
export const playlistNameSchema = z
  .string()
  .transform((name) => name.trim().replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(MAX_PLAYLIST_NAME)
      .refine((name) => !/\p{C}/u.test(name))
  )

const playlistId = z.number().int().positive()
const trackId = z.number().int().positive()

export const playlistActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), name: playlistNameSchema }),
  z.strictObject({ action: z.literal('rename'), playlistId, name: playlistNameSchema }),
  z.strictObject({ action: z.literal('delete'), playlistId }),
  z.strictObject({
    action: z.literal('add'),
    playlistId,
    trackIds: z.array(trackId).min(1).max(10_000)
  }),
  z.strictObject({ action: z.literal('remove'), playlistId, trackId }),
  z.strictObject({
    action: z.literal('move'),
    playlistId,
    trackId,
    direction: z.union([z.literal(-1), z.literal(1)])
  })
])
export type PlaylistAction = z.output<typeof playlistActionSchema>

/** One playlist in the list of them. */
export interface PlaylistSummary {
  id: number
  name: string
  trackCount: number
}

/** One track as the page shows it, in the playlist or recommended for it. */
export interface PlaylistTrackItem {
  trackId: number
  fileName: string
  artist: string | null
  title: string | null
  bpm: number | null
  camelotKey: string | null
  energy: number | null
  styleName: string | null
  durationMs: number | null
  /** The drive is not connected or the file is gone: it cannot be played. */
  unavailable: boolean
}

/** A playlist with its tracks in order, what they add up to, and what would fit. */
export interface PlaylistView {
  id: number
  name: string
  tracks: PlaylistTrackItem[]
  /** The length of the tracks whose length is known. */
  totalMs: number
  /** The lowest and the highest tempo, whole; null when no track has one. */
  bpmRange: [number, number] | null
  /** The Camelot keys of its tracks, each once, in the order they first come. */
  keys: string[]
  /**
   * Up to ten tracks of the library that fit it best, the best first, with their score;
   * null after an edit that leaves them as they were (a move or a rename).
   */
  recommendations: (PlaylistTrackItem & { score: number })[] | null
}

/** What an edit answers: the list of playlists, and the one it was about. */
export interface PlaylistEditResult {
  playlists: PlaylistSummary[]
  /** The playlist the edit was about, or null after a delete. */
  view: PlaylistView | null
  /**
   * For an add: the tracks that were in the playlist already, are not in the library
   * (gone, or set aside as a duplicate), or did not fit under MAX_PLAYLIST_TRACKS.
   */
  skipped: number
}
