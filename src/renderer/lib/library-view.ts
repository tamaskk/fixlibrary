// How the Library table filters and sorts its rows. Pure: the rows come from main.
import type { LibraryTrack } from '@shared/library'
import type { Style } from '@shared/settings'

export const SORT_KEYS = ['artist', 'title', 'bpm', 'key', 'energy', 'style', 'format'] as const
export type SortKey = (typeof SORT_KEYS)[number]

/** What keeps a track from being worked on, or `ok`. The first that applies wins. */
export const TRACK_STATES = ['ok', 'offline', 'missing', 'unreadable'] as const
export type TrackState = (typeof TRACK_STATES)[number]

export interface LibraryView {
  search: string
  /** Null until a column is chosen: the rows then stay in library order. */
  sort: { key: SortKey; descending: boolean } | null
  /** A style id, `none` for tracks without a style, or `all`. */
  style: number | 'none' | 'all'
  state: TrackState | 'all'
}

export const DEFAULT_VIEW: LibraryView = { search: '', sort: null, style: 'all', state: 'all' }

const collator = new Intl.Collator('hu', { sensitivity: 'base', numeric: true })

export function trackState(track: LibraryTrack): TrackState {
  if (track.offline) return 'offline'
  if (track.fileMissing) return 'missing'
  const scan = track.stageStatus['scan']
  return scan === 'failed' || scan === 'skipped' ? 'unreadable' : 'ok'
}

/** Lower case without accents, so `tuz` finds `Tűz`. */
function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('hu')
}

function matchesSearch(track: LibraryTrack, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const haystack = foldForSearch(`${track.artist ?? ''} ${track.title ?? ''} ${track.fileName}`)
  return words.every((word) => haystack.includes(word))
}

/** Camelot keys in wheel order: 1A, 1B, 2A, … 12B. Anything else sorts after them. */
function camelotRank(key: string | null): number | null {
  const match = key === null ? null : /^(\d{1,2})([AB])$/.exec(key)
  if (!match) return null
  return Number(match[1]) * 2 + (match[2] === 'B' ? 1 : 0)
}

type SortValue = string | number | null

function sortValue(track: LibraryTrack, key: SortKey, styleOrder: Map<number, number>): SortValue {
  switch (key) {
    case 'artist':
      return track.artist
    case 'title':
      return track.title ?? track.fileName
    case 'bpm':
      return track.bpm
    case 'key':
      return camelotRank(track.camelotKey)
    case 'energy':
      return track.energy
    case 'style':
      return track.styleId === null ? null : (styleOrder.get(track.styleId) ?? null)
    case 'format':
      return track.format
  }
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/**
 * The rows the table shows, in the order it shows them. A track without a value in
 * the sorted column comes last in both directions, and equal rows keep library order.
 */
export function applyView(
  tracks: readonly LibraryTrack[],
  view: LibraryView,
  styles: readonly Style[]
): LibraryTrack[] {
  const words = foldForSearch(view.search).split(/\s+/).filter(Boolean)
  const shown = tracks.filter(
    (track) =>
      matchesSearch(track, words) &&
      (view.style === 'all' ||
        (view.style === 'none' ? track.styleId === null : track.styleId === view.style)) &&
      (view.state === 'all' || trackState(track) === view.state)
  )
  if (view.sort === null) return shown

  const { key, descending } = view.sort
  // Styles sort in the order the user gave them in Settings, not by name.
  const styleOrder = new Map(styles.map((style, index) => [style.id, index]))
  return shown
    .map((track, index) => ({ track, index, value: sortValue(track, key, styleOrder) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === null && b.value === null) return a.index - b.index
        return a.value === null ? 1 : -1
      }
      const order = compareValues(a.value, b.value)
      return order === 0 ? a.index - b.index : descending ? -order : order
    })
    .map((entry) => entry.track)
}

/** The next sorting when a column header is clicked: ascending, descending, then none. */
export function nextSort(current: LibraryView['sort'], key: SortKey): LibraryView['sort'] {
  if (current?.key !== key) return { key, descending: false }
  return current.descending ? null : { key, descending: true }
}
