import { create } from 'zustand'
import type { ErrorCode, Result } from '@shared/errors'
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
      applyStatus(await window.api.library.status())
    } catch {
      set({ lastScan: { ok: false, code: 'UNEXPECTED' } })
    } finally {
      stopListening?.()
      set({ scanning: false, progress: null })
    }
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
        if (status.scanning) void track(() => window.api.library.followScan())
      } catch {
        set({ data: { status: 'error' } })
      }
    },

    scan: () => track(() => window.api.library.scan())
  }
})
