import { create } from 'zustand'
import type { VersionsView } from '@shared/release'

interface UpdateStoreState {
  view: VersionsView | null
  /** The versions could not be read. */
  failed: boolean
  /** Asking for a check failed in the page itself. */
  checkFailed: boolean
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
  checkFailed: false,
  opened: false,
  openFailed: false,
  load: async () => {
    try {
      set({ view: await window.api.update.view(), failed: false })
    } catch {
      set({ failed: true })
    }
  },
  subscribe: () =>
    window.api.update.onChange((view) =>
      set((current) => {
        const before = current.view?.update
        const after = view.update
        // A new version ready is news again: what was done with the last one is not.
        const sameReady =
          before?.status === 'ready' && after.status === 'ready' && before.version === after.version
        return {
          view,
          failed: false,
          ...(sameReady ? {} : { opened: false, openFailed: false })
        }
      })
    ),
  check: async () => {
    set({ checkFailed: false })
    try {
      await window.api.update.check()
      // The versions are read again too: they may not have loaded before.
      set({ view: await window.api.update.view(), failed: false })
    } catch {
      set({ checkFailed: true })
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
