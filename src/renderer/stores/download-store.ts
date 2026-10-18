import { create } from 'zustand'
import type {
  DownloadInspection,
  DownloadItem,
  DownloadSearchHit,
  DownloadSource
} from '@shared/download'
import type { ErrorCode } from '@shared/errors'

/** What the user is asked before a download starts. */
export type DownloadQuestion = 'lowBitrate' | 'duplicate'

export interface PendingQuestion {
  question: DownloadQuestion
  inspection: DownloadInspection
}

/** What became of one pasted address. */
export interface AddressOutcome {
  url: string
  state: 'checking' | 'started' | 'declined' | 'failed'
  title: string | null
  code: ErrorCode | null
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; hits: DownloadSearchHit[] }
  | { status: 'error'; code: ErrorCode }

interface DownloadState {
  items: DownloadItem[]
  /** False until the list was read once; true also when that failed. */
  loaded: boolean
  loadFailed: boolean
  outcomes: AddressOutcome[]
  /** True while pasted addresses are being worked through. */
  working: boolean
  pending: PendingQuestion | null
  search: SearchState
  load: () => Promise<void>
  /** Asks about each address in turn, asks the user where needed, and starts the rest. */
  downloadAll: (urls: string[]) => Promise<void>
  answer: (yes: boolean) => void
  runSearch: (source: DownloadSource, query: string) => Promise<void>
}

// The main process is the authority: the list is only ever what main reported.
export const useDownloadStore = create<DownloadState>((set, get) => {
  let listening = false
  let resolveAnswer: ((yes: boolean) => void) | null = null

  function listen(): void {
    if (listening) return
    listening = true
    window.api.download.onChange((items) => set({ items }))
  }

  function ask(question: DownloadQuestion, inspection: DownloadInspection): Promise<boolean> {
    return new Promise((resolve) => {
      resolveAnswer = resolve
      set({ pending: { question, inspection } })
    })
  }

  function setOutcome(index: number, outcome: Partial<AddressOutcome>): void {
    set({
      outcomes: get().outcomes.map((each, at) => (at === index ? { ...each, ...outcome } : each))
    })
  }

  async function downloadOne(url: string, index: number): Promise<void> {
    const inspected = await window.api.download.inspect(url)
    if (!inspected.ok) {
      setOutcome(index, { state: 'failed', code: inspected.code })
      return
    }
    const inspection = inspected.value
    setOutcome(index, { title: inspection.title })
    // Decline means nothing is downloaded and no file is made.
    if (inspection.lowBitrate && !(await ask('lowBitrate', inspection))) {
      setOutcome(index, { state: 'declined' })
      return
    }
    if (inspection.duplicate !== null && !(await ask('duplicate', inspection))) {
      setOutcome(index, { state: 'declined' })
      return
    }
    const started = await window.api.download.start(inspection.url)
    if (started.ok) {
      set({ items: started.value })
      setOutcome(index, { state: 'started' })
    } else {
      setOutcome(index, { state: 'failed', code: started.code })
    }
  }

  return {
    items: [],
    loaded: false,
    loadFailed: false,
    outcomes: [],
    working: false,
    pending: null,
    search: { status: 'idle' },

    async load() {
      listen()
      try {
        set({ items: await window.api.download.list(), loaded: true, loadFailed: false })
      } catch {
        set({ loaded: true, loadFailed: true })
      }
    },

    async downloadAll(urls) {
      if (get().working || urls.length === 0) return
      set({
        working: true,
        outcomes: urls.map((url) => ({ url, state: 'checking', title: null, code: null }))
      })
      try {
        for (const [index, url] of urls.entries()) {
          try {
            await downloadOne(url, index)
          } catch {
            setOutcome(index, { state: 'failed', code: 'UNEXPECTED' })
          }
        }
      } finally {
        set({ working: false, pending: null })
      }
    },

    answer(yes) {
      const resolve = resolveAnswer
      resolveAnswer = null
      set({ pending: null })
      resolve?.(yes)
    },

    async runSearch(source, query) {
      set({ search: { status: 'loading' } })
      try {
        const found = await window.api.download.search({ source, query })
        set({
          search: found.ok
            ? { status: 'ready', hits: found.value }
            : { status: 'error', code: found.code }
        })
      } catch {
        set({ search: { status: 'error', code: 'UNEXPECTED' } })
      }
    }
  }
})

/** The addresses of a text: one a line, blank lines and doubles left out. */
export function addressesOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    )
  ]
}
