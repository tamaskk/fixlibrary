import { create } from 'zustand'
import type { ErrorCode } from '@shared/errors'
import type { LibraryStatus, ScanProgress, ScanSummary } from '@shared/library'

type LibraryData =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rootChosen: boolean; trackCount: number }

/** How the last scan of this session ended; null before the first one. */
export type ScanOutcome = { ok: true; summary: ScanSummary } | { ok: false; code: ErrorCode } | null

interface LibraryState {
  data: LibraryData
  scanning: boolean
  /** Null until the running scan has reported for the first time. */
  progress: ScanProgress | null
  lastScan: ScanOutcome
  load: () => Promise<void>
  /** Starts a scan, or follows the one the app is already running. */
  scan: () => Promise<void>
}

// The main process is the authority: the store only ever holds what main returned.
export const useLibraryStore = create<LibraryState>((set, get) => {
  function applyStatus({ rootChosen, trackCount }: LibraryStatus): void {
    set({ data: { status: 'ready', rootChosen, trackCount } })
  }

  return {
    data: { status: 'loading' },
    scanning: false,
    progress: null,
    lastScan: null,

    async load() {
      try {
        const status = await window.api.library.status()
        applyStatus(status)
        // A scan the app started at launch: follow it, so its result shows up here.
        if (status.scanning) void get().scan()
      } catch {
        set({ data: { status: 'error' } })
      }
    },

    async scan() {
      if (get().scanning) return
      set({ scanning: true, progress: null })
      const stopListening = window.api.library.onScanProgress((progress) => set({ progress }))
      try {
        const result = await window.api.library.scan()
        set({
          lastScan: result.ok
            ? { ok: true, summary: result.value }
            : { ok: false, code: result.code }
        })
        applyStatus(await window.api.library.status())
      } catch {
        set({ lastScan: { ok: false, code: 'UNEXPECTED' } })
      } finally {
        stopListening()
        set({ scanning: false, progress: null })
      }
    }
  }
})
