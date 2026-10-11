import { create } from 'zustand'

export type AppPage = 'library' | 'preview' | 'settings'

interface AppState {
  page: AppPage
  setPage: (page: AppPage) => void
}

export const useAppStore = create<AppState>((set) => ({
  page: 'library',
  setPage: (page) => set({ page })
}))
