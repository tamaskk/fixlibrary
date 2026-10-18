import { create } from 'zustand'
import type { ErrorCode } from '@shared/errors'
import type { PlaylistAction, PlaylistSummary, PlaylistView } from '@shared/playlists'

/** What the last edit said: tracks it skipped, or why it failed. */
export type PlaylistNotice =
  { kind: 'skipped'; count: number } | { kind: 'failed'; code: ErrorCode }

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
  notice: PlaylistNotice | null
  load: () => Promise<void>
  select: (playlistId: number) => Promise<void>
  /** Sends an edit; true when it was made. */
  edit: (action: PlaylistAction) => Promise<boolean>
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
  edit: async (action) => {
    set({ editing: true })
    try {
      const result = await window.api.playlists.edit(action)
      if (!result.ok) {
        set({ notice: { kind: 'failed', code: result.code } })
        return false
      }
      const { playlists, view, skipped } = result.value
      const selectedId = view?.id ?? playlists[0]?.id ?? null
      set({
        playlists,
        view: view ?? null,
        selectedId,
        viewFailed: false,
        notice: skipped > 0 ? { kind: 'skipped', count: skipped } : null
      })
      // After a delete the first playlist left is shown.
      if (view === null && selectedId !== null) await get().select(selectedId)
      return true
    } catch {
      set({ notice: { kind: 'failed', code: 'UNEXPECTED' } })
      return false
    } finally {
      set({ editing: false })
    }
  }
}))
