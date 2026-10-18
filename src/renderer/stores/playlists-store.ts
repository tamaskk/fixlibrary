import { create } from 'zustand'
import type { ErrorCode } from '@shared/errors'
import type { PlaylistAction, PlaylistSummary, PlaylistView } from '@shared/playlists'

/** What the last edit said: tracks it skipped, or why it failed. */
export type PlaylistNotice =
  { kind: 'skipped'; count: number } | { kind: 'failed'; code: ErrorCode }

/** What an edit came to, for the place that asked for it. */
export type PlaylistEditOutcome = { ok: true; skipped: number } | { ok: false; code: ErrorCode }

interface PlaylistsState {
  playlists: PlaylistSummary[]
  /** False until the list was read once; true also when that failed. */
  loaded: boolean
  loadFailed: boolean
  selectedId: number | null
  view: PlaylistView | null
  viewLoading: boolean
  viewFailed: boolean
  /** True while an edit is on its way. */
  editing: boolean
  /** What the last edit made on the Playlists page said. */
  notice: PlaylistNotice | null
  load: () => Promise<void>
  select: (playlistId: number) => Promise<void>
  /**
   * Sends an edit. From the page (`fromLibrary` false) its outcome is the page's notice;
   * an add from the Library says its own and makes that playlist the one shown.
   */
  edit: (
    action: PlaylistAction,
    options?: { fromLibrary?: boolean }
  ) => Promise<PlaylistEditOutcome>
}

// The main process is the authority: the lists are only ever what main answered.
export const usePlaylistsStore = create<PlaylistsState>((set, get) => ({
  playlists: [],
  loaded: false,
  loadFailed: false,
  selectedId: null,
  view: null,
  viewLoading: false,
  viewFailed: false,
  editing: false,
  notice: null,
  load: async () => {
    try {
      const playlists = await window.api.playlists.list()
      set({ playlists, loaded: true, loadFailed: false })
      const { selectedId } = get()
      const keep = playlists.some((playlist) => playlist.id === selectedId)
      const next = keep ? selectedId : (playlists[0]?.id ?? null)
      if (next !== null) await get().select(next)
      else set({ selectedId: null, view: null })
    } catch {
      set({ loaded: true, loadFailed: true })
    }
  },
  select: async (playlistId) => {
    set({ selectedId: playlistId, viewLoading: true, viewFailed: false, notice: null })
    try {
      const view = await window.api.playlists.view(playlistId)
      // A later choice wins: an answer for a playlist left meanwhile is dropped.
      if (get().selectedId === playlistId) set({ view, viewLoading: false })
    } catch {
      if (get().selectedId === playlistId) set({ viewLoading: false, viewFailed: true })
    }
  },
  edit: async (action, { fromLibrary = false } = {}) => {
    const asked = get().selectedId
    set({ editing: true })
    let outcome: PlaylistEditOutcome
    try {
      const result = await window.api.playlists.edit(action)
      if (result.ok) {
        const { playlists, view, skipped } = result.value
        outcome = { ok: true, skipped }
        set({ playlists })
        const current = get()
        if (view === null) {
          // A delete: the first playlist left is shown.
          const first = playlists[0]?.id ?? null
          if (first !== null) await get().select(first)
          else set({ selectedId: null, view: null })
        } else if (fromLibrary || action.action === 'create' || current.selectedId === asked) {
          // An answer for a playlist the user left meanwhile does not take the page back.
          const kept = current.view?.id === view.id ? current.view.recommendations : null
          set({
            selectedId: view.id,
            view: { ...view, recommendations: view.recommendations ?? kept ?? [] },
            viewFailed: false
          })
        }
      } else {
        outcome = { ok: false, code: result.code }
      }
    } catch {
      outcome = { ok: false, code: 'UNEXPECTED' }
    }
    set({ editing: false })
    if (!fromLibrary) {
      set({
        notice: !outcome.ok
          ? { kind: 'failed', code: outcome.code }
          : outcome.skipped > 0
            ? { kind: 'skipped', count: outcome.skipped }
            : null
      })
    }
    return outcome
  }
}))
