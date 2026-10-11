import { create } from 'zustand'
import type { ErrorCode, Result } from '@shared/errors'
import {
  LIBRARY_PAGE_SIZE,
  type LibraryStatus,
  type LibraryTrack,
  type RunStarted,
  type ScanProgress,
  type ScanSummary
} from '@shared/library'
import type { Style } from '@shared/settings'
import {
  applyView,
  DEFAULT_VIEW,
  nextSort,
  type LibraryView,
  type SortKey
} from '@/lib/library-view'
import {
  EMPTY_SELECTION,
  keepExisting,
  selectAll,
  selectedInOrder,
  selectRow,
  type SelectModifiers,
  type Selection
} from '@/lib/selection'

type LibraryData =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rootChosen: boolean; trackCount: number }

/** The rows of the table. `idle` until the library is known to hold tracks. */
type TrackList =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; tracks: LibraryTrack[] }

/** How the last scan of this session ended; null before the first one. */
export type ScanOutcome = { ok: true; summary: ScanSummary } | { ok: false; code: ErrorCode } | null

/** What the main process answered to the last run request; null before the first one. */
export type RunOutcome = { ok: true; started: RunStarted } | { ok: false; code: ErrorCode } | null

interface LibraryState {
  data: LibraryData
  scanning: boolean
  /** Null until the running scan has reported for the first time. */
  progress: ScanProgress | null
  lastScan: ScanOutcome
  list: TrackList
  /** For the style column and the style filter. */
  styles: Style[]
  view: LibraryView
  selection: Selection
  requestingRun: boolean
  lastRun: RunOutcome
  load: () => Promise<void>
  /** Starts a scan, or follows the one the app is already running. */
  scan: () => Promise<void>
  loadTracks: () => Promise<void>
  /** A search or filter that hides selected rows also takes them out of the selection. */
  setView: (changes: Partial<LibraryView>) => void
  toggleSort: (key: SortKey) => void
  /** `shownIds` are the rows as the table shows them, which is what a range follows. */
  select: (id: number, modifiers: SelectModifiers, shownIds: readonly number[]) => void
  selectAllShown: (shownIds: readonly number[]) => void
  clearSelection: () => void
  /** Asks main to run the functions on the selected tracks, or on the whole library. */
  run: (scope: 'selection' | 'library', stages: readonly string[]) => Promise<void>
}

// The main process is the authority: the store only ever holds what main returned.
export const useLibraryStore = create<LibraryState>((set, get) => {
  // Only the answer to the latest request for the rows is kept.
  let latestListRequest = 0

  function applyStatus({ rootChosen, trackCount }: LibraryStatus): void {
    set({ data: { status: 'ready', rootChosen, trackCount } })
  }

  /** Shows a scan while it runs and its result when it ends. `null` means there was none. */
  async function track(run: () => Promise<Result<ScanSummary> | null>): Promise<void> {
    if (get().scanning) return
    set({ scanning: true, progress: null })
    let stopListening: (() => void) | null = null
    try {
      stopListening = window.api.library.onScanProgress((progress) => set({ progress }))
      const result = await run()
      if (result !== null) {
        set({
          lastScan: result.ok
            ? { ok: true, summary: result.value }
            : { ok: false, code: result.code }
        })
      }
    } catch {
      set({ lastScan: { ok: false, code: 'UNEXPECTED' } })
    } finally {
      stopListening?.()
      set({ scanning: false, progress: null })
    }
    // Asked on its own: if this fails, the result of the scan above still stands,
    // and the page keeps the count it had.
    try {
      applyStatus(await window.api.library.status())
    } catch {
      // The next visit of the page asks again.
    }
    // A scan changes the rows even when it fails halfway.
    await get().loadTracks()
  }

  return {
    data: { status: 'loading' },
    scanning: false,
    progress: null,
    lastScan: null,
    list: { status: 'idle' },
    styles: [],
    view: DEFAULT_VIEW,
    selection: EMPTY_SELECTION,
    requestingRun: false,
    lastRun: null,

    async load() {
      // A retry from the error state shows that something is happening.
      if (get().data.status === 'error') set({ data: { status: 'loading' } })
      try {
        const status = await window.api.library.status()
        applyStatus(status)
        // A scan the app started at launch: follow it, so its result shows up here.
        if (status.scanning) void track(() => window.api.library.followScan())
        // Also while a scan runs: the rows that are there can be shown already, and
        // the scan loads them again when it ends.
        void get().loadTracks()
      } catch {
        set({ data: { status: 'error' } })
      }
    },

    scan: () => track(() => window.api.library.scan()),

    async loadTracks() {
      const request = ++latestListRequest
      // Rows that are already shown stay until the new ones are here.
      if (get().list.status !== 'ready') set({ list: { status: 'loading' } })
      try {
        const styles = await window.api.styles.list()
        // By id: a scan that adds or removes rows between two pages shifts the rest,
        // and the same track can then arrive twice.
        const byId = new Map<number, LibraryTrack>()
        let offset = 0
        let total = Infinity
        while (offset < total) {
          const page = await window.api.library.list({ limit: LIBRARY_PAGE_SIZE, offset })
          if (!page.ok) throw new Error(page.code)
          for (const row of page.value.tracks) byId.set(row.id, row)
          offset += page.value.tracks.length
          total = page.value.total
          // A library that shrank while it was read: stop instead of asking forever.
          if (page.value.tracks.length === 0) break
        }
        if (request !== latestListRequest) return
        const tracks = [...byId.values()]
        set({
          list: { status: 'ready', tracks },
          styles,
          selection: keepExisting(get().selection, new Set(tracks.map(({ id }) => id)))
        })
      } catch {
        if (request === latestListRequest) set({ list: { status: 'error' } })
      }
    },

    setView(changes) {
      const { list, styles, selection } = get()
      const view = { ...get().view, ...changes }
      // What a run processes is what the user can see selected: a row that the new
      // search or filter hides leaves the selection.
      const shown =
        list.status === 'ready' ? applyView(list.tracks, view, styles).map(({ id }) => id) : []
      set({ view, selection: keepExisting(selection, new Set(shown)), lastRun: null })
    },
    toggleSort: (key) => set({ view: { ...get().view, sort: nextSort(get().view.sort, key) } }),

    select: (id, modifiers, shownIds) =>
      set({ selection: selectRow(get().selection, id, modifiers, shownIds), lastRun: null }),
    selectAllShown: (shownIds) =>
      set({ selection: selectAll(get().selection, shownIds), lastRun: null }),
    clearSelection: () => set({ selection: EMPTY_SELECTION, lastRun: null }),

    async run(scope, functions) {
      const { list, selection, requestingRun } = get()
      if (requestingRun || list.status !== 'ready' || functions.length === 0) return
      const stages = [...functions]
      // In library order; which of them can be processed is for main to decide.
      const trackIds = selectedInOrder(
        selection,
        list.tracks.map(({ id }) => id)
      )
      if (scope === 'selection' && trackIds.length === 0) return
      set({ requestingRun: true })
      try {
        const result = await window.api.library.run(
          scope === 'selection' ? { scope, trackIds, stages } : { scope, stages }
        )
        set({
          lastRun: result.ok
            ? { ok: true, started: result.value }
            : { ok: false, code: result.code }
        })
      } catch {
        set({ lastRun: { ok: false, code: 'UNEXPECTED' } })
      } finally {
        set({ requestingRun: false })
      }
    }
  }
})
