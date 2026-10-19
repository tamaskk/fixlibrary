import { create } from 'zustand'

export type AppPage =
  | 'library'
  | 'preview'
  | 'download'
  | 'cues'
  | 'energy'
  | 'playlists'
  | 'generator'
  | 'rekordbox'
  | 'settings'

interface AppState {
  page: AppPage
  /** The track the cue editor is to show when it opens, or null for the first of its list. */
  cueTrackId: number | null
  setPage: (page: AppPage) => void
  /** Opens the cue editor on a track. */
  openCueEditor: (trackId: number) => void
}

export const useAppStore = create<AppState>((set) => ({
  page: 'library',
  cueTrackId: null,
  setPage: (page) => set({ page }),
  openCueEditor: (trackId) => set({ page: 'cues', cueTrackId: trackId })
}))
