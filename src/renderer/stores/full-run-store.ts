import { create } from 'zustand'
import type { ErrorCode } from '@shared/errors'
import type { FullRunView } from '@shared/full-run'

interface FullRunState {
  /** The full run that goes on or ended last; null when none was started. */
  view: FullRunView | null
  loadFailed: boolean
  starting: boolean
  startFailure: ErrorCode | null
  stopFailed: boolean
  /** The run put away for this session, by when it started; a new one shows again. */
  hiddenStartedAt: number | null
  hide: (startedAt: number) => void
  /** Before the start dialog opens: what an earlier start said is no news. */
  clearStartFailure: () => void
  load: () => Promise<void>
  /** On these tracks, or on the whole library with null. */
  start: (trackIds: number[] | null) => Promise<boolean>
  stop: () => Promise<void>
}

// Main moves the run on; the page only reads where it is.
export const useFullRunStore = create<FullRunState>((set, get) => ({
  view: null,
  loadFailed: false,
  starting: false,
  startFailure: null,
  stopFailed: false,
  hiddenStartedAt: null,
  hide: (startedAt) => set({ hiddenStartedAt: startedAt }),
  clearStartFailure: () => set({ startFailure: null }),
  load: async () => {
    try {
      set({ view: await window.api.fullRun.view(), loadFailed: false })
    } catch {
      set({ loadFailed: true })
    }
  },
  start: async (trackIds) => {
    set({ starting: true, startFailure: null })
    try {
      const result = await window.api.fullRun.start({ trackIds })
      if (result.ok) set({ view: result.value })
      else set({ startFailure: result.code })
      return result.ok
    } catch {
      set({ startFailure: 'UNEXPECTED' })
      return false
    } finally {
      set({ starting: false })
    }
  },
  stop: async () => {
    try {
      await window.api.fullRun.stop()
      set({ stopFailed: false })
    } catch {
      set({ stopFailed: true })
    }
    await get().load()
  }
}))
