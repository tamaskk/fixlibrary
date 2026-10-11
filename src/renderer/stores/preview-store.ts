import { create } from 'zustand'
import type { ErrorCode } from '@shared/errors'
import {
  matchesPreviewFilter,
  PREVIEW_PAGE_SIZE,
  type EditablePreviewField,
  type PreviewBatch,
  type PreviewEdit,
  type PreviewFilter,
  type PreviewRow,
  type PreviewState as MainPreviewState,
  type PreviewValue,
  type UndoOutcome
} from '@shared/preview'
import type { Style } from '@shared/settings'

export type PreviewTab = 'changes' | 'errors'

type PreviewRows =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rows: PreviewRow[] }

/** What the last approval, discard or undo came to; null until there is one. */
export type PreviewNotice =
  | { kind: 'failed'; code: ErrorCode }
  | { kind: 'noSpace'; neededBytes: number; freeBytes: number }
  | { kind: 'discarded' }
  | { kind: 'undone'; outcome: UndoOutcome }
  | null

interface PreviewStoreState {
  /** False until the main process has said whether a batch waits. */
  loaded: boolean
  loadFailed: boolean
  batch: PreviewBatch | null
  canUndo: boolean
  rows: PreviewRows
  /** For the style column and its editor. */
  styles: Style[]
  tab: PreviewTab
  filter: PreviewFilter
  /** The action that is on its way to the main process, or null. */
  busy: 'approve' | 'discard' | 'undo' | null
  notice: PreviewNotice
  /** True when the last edit or exclusion was not taken; the rows were read again. */
  editFailed: boolean
  load: () => Promise<void>
  setTab: (tab: PreviewTab) => void
  setFilter: (filter: PreviewFilter) => void
  /** Sets a field by hand. Resolves to false when the value was not taken. */
  edit: (trackId: number, field: EditablePreviewField, value: PreviewValue) => Promise<boolean>
  setExcluded: (trackIds: readonly number[], excluded: boolean) => Promise<void>
  /** Resolves to true when the apply phase has started. */
  approve: () => Promise<boolean>
  discard: () => Promise<void>
  undo: () => Promise<void>
}

/** The rows a tab and a filter show, in the order of the batch. */
export function shownRows(
  rows: readonly PreviewRow[],
  tab: PreviewTab,
  filter: PreviewFilter
): PreviewRow[] {
  if (tab === 'errors') return rows.filter((row) => row.error !== null)
  return rows.filter((row) => matchesPreviewFilter(row, filter))
}

/** How many rows an approval would write, and how many it would leave. */
export function countRows(rows: readonly PreviewRow[]): {
  applied: number
  excluded: number
  failed: number
} {
  const failed = rows.filter((row) => row.error !== null).length
  const excluded = rows.filter((row) => row.error === null && row.excluded).length
  return { applied: rows.length - failed - excluded, excluded, failed }
}

// The main process is the authority: the store only ever holds what main returned.
export const usePreviewStore = create<PreviewStoreState>((set, get) => {
  // Only the answer to the latest request for the rows is kept.
  let latestRowsRequest = 0

  function applyState({ batch, canUndo }: MainPreviewState): void {
    const known = get().batch
    set({ batch, canUndo, loaded: true, loadFailed: false })
    // Another batch, or none: the rows that are shown belong to the old one.
    if (batch?.id !== known?.id) {
      set({ rows: { status: 'idle' }, filter: 'all', tab: 'changes', editFailed: false })
    }
  }

  async function loadRows(batchId: number): Promise<void> {
    const request = ++latestRowsRequest
    if (get().rows.status !== 'ready') set({ rows: { status: 'loading' } })
    try {
      const styles = await window.api.styles.list()
      const rows: PreviewRow[] = []
      let total = Infinity
      while (rows.length < total) {
        const page = await window.api.preview.rows({
          batchId,
          offset: rows.length,
          limit: PREVIEW_PAGE_SIZE
        })
        if (!page.ok) throw new Error(page.code)
        rows.push(...page.value.rows)
        total = page.value.total
        if (page.value.rows.length === 0) break
      }
      if (request === latestRowsRequest) set({ rows: { status: 'ready', rows }, styles })
    } catch {
      if (request === latestRowsRequest) set({ rows: { status: 'error' } })
    }
  }

  function replaceRow(next: PreviewRow): void {
    const { rows } = get()
    if (rows.status !== 'ready') return
    set({
      rows: {
        status: 'ready',
        rows: rows.rows.map((row) => (row.trackId === next.trackId ? next : row))
      }
    })
  }

  /** After a change that was not taken: what main holds is shown again. */
  async function resync(): Promise<void> {
    set({ editFailed: true })
    await get().load()
  }

  return {
    loaded: false,
    loadFailed: false,
    batch: null,
    canUndo: false,
    rows: { status: 'idle' },
    styles: [],
    tab: 'changes',
    filter: 'all',
    busy: null,
    notice: null,
    editFailed: false,

    async load() {
      try {
        applyState(await window.api.preview.state())
        const { batch } = get()
        if (batch) await loadRows(batch.id)
      } catch {
        set({ loaded: true, loadFailed: true })
      }
    },

    setTab: (tab) => set({ tab }),
    setFilter: (filter) => set({ filter }),

    async edit(trackId, field, value) {
      const { batch } = get()
      if (!batch) return false
      try {
        // The schema of main decides whether the value fits the field.
        const result = await window.api.preview.edit({
          batchId: batch.id,
          trackId,
          field,
          value
        } as PreviewEdit)
        if (result.ok) {
          replaceRow(result.value)
          set({ editFailed: false })
          return true
        }
        // A value that is not allowed is the user's to correct; anything else means
        // the batch is not what the page thinks it is.
        // Nor is an approval that is on its way a reason to read anything again: it
        // will say itself how it ended.
        if (result.code !== 'INVALID_INPUT' && result.code !== 'RUN_ACTIVE') await resync()
        return false
      } catch {
        await resync()
        return false
      }
    },

    async setExcluded(trackIds, excluded) {
      const { batch, rows } = get()
      if (!batch || rows.status !== 'ready' || trackIds.length === 0) return
      const ids = new Set(trackIds)
      try {
        const result = await window.api.preview.setExcluded({
          batchId: batch.id,
          trackIds: [...ids],
          excluded
        })
        if (!result.ok) {
          if (result.code !== 'RUN_ACTIVE') await resync()
          return
        }
        // Shown once main has taken it; the rows may have been edited meanwhile.
        const current = get().rows
        if (current.status !== 'ready') return
        set({
          batch: result.value.batch,
          editFailed: false,
          rows: {
            status: 'ready',
            rows: current.rows.map((row) => (ids.has(row.trackId) ? { ...row, excluded } : row))
          }
        })
      } catch {
        await resync()
      }
    },

    async approve() {
      const { batch, busy } = get()
      if (!batch || busy !== null) return false
      set({ busy: 'approve', notice: null })
      try {
        const result = await window.api.preview.approve(batch.id)
        if (!result.ok) {
          set({ notice: { kind: 'failed', code: result.code } })
          return false
        }
        if (!result.value.started) {
          const { neededBytes, freeBytes } = result.value
          set({ notice: { kind: 'noSpace', neededBytes, freeBytes } })
          return false
        }
        // The batch is being written now: nothing waits for approval any more.
        set({ batch: null, rows: { status: 'idle' } })
        return true
      } catch {
        set({ notice: { kind: 'failed', code: 'UNEXPECTED' } })
        return false
      } finally {
        set({ busy: null })
      }
    },

    async discard() {
      const { batch, busy } = get()
      if (!batch || busy !== null) return
      set({ busy: 'discard', notice: null })
      try {
        const result = await window.api.preview.discard(batch.id)
        if (result.ok) {
          applyState(result.value)
          set({ notice: { kind: 'discarded' } })
        } else {
          set({ notice: { kind: 'failed', code: result.code } })
        }
      } catch {
        set({ notice: { kind: 'failed', code: 'UNEXPECTED' } })
      } finally {
        set({ busy: null })
      }
    },

    async undo() {
      if (get().busy !== null) return
      set({ busy: 'undo', notice: null })
      try {
        const result = await window.api.preview.undoLast()
        set({
          notice: result.ok
            ? { kind: 'undone', outcome: result.value }
            : { kind: 'failed', code: result.code }
        })
      } catch {
        set({ notice: { kind: 'failed', code: 'UNEXPECTED' } })
      } finally {
        set({ busy: null })
      }
      // An undo gives up the batch that waited, and there may be nothing left to undo.
      await get().load()
    }
  }
})
