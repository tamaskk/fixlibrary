import type { PlaylistTrackItem } from '@shared/playlists'

/** `Artist - Title`, or the file name when either is not known. */
export function nameOf(item: PlaylistTrackItem): string {
  return item.artist && item.title ? `${item.artist} - ${item.title}` : item.fileName
}
