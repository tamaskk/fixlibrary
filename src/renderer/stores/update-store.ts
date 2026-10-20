import { create } from 'zustand'
import type { VersionsView } from '@shared/release'

interface UpdateStoreState {
  view: VersionsView | null
  failed: boolean
  /** True once the DMG was opened: the page then offers to quit. */
  opened: boolean
  openFailed: boolean
  load: () => Promise<void>
  subscribe: () => () => void
  check: () => Promise<void>
  open: () => Promise<void>
  quit: () => Promise<void>
}

// Main finds, downloads and checks the update; the page only shows it and opens it.
export const useUpdateStore = create<UpdateStoreState>((set) => ({
  view: null,
  failed: false,
  opened: false,
  openFailed: false,
  load: async () => {
    try {
      set({ view: await window.api.update.view(), failed: false })
    } catch {
      set({ failed: true })
    }
  },
  subscribe: () => window.api.update.onChange((view) => set({ view, failed: false })),
  check: async () => {
    try {
      await window.api.update.check()
    } catch {
      set({ failed: true })
    }
  },
  open: async () => {
    try {
      const opened = await window.api.update.open()
      set({ opened, openFailed: !opened })
    } catch {
      set({ openFailed: true })
    }
  },
  quit: async () => {
    await window.api.update.quit()
  }
}))
