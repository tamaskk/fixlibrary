import { create } from 'zustand'
import type {
  CueEditAction,
  CueEditorFilter,
  CueEditorListItem,
  CueEditorPeaks,
  CueEditorTrack
} from '@shared/cue-editor'
import type { ErrorCode } from '@shared/errors'

type Loading<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; code: ErrorCode | null }
  | { status: 'ready'; value: T }

interface CueEditorState {
  filter: CueEditorFilter
  list: Loading<CueEditorListItem[]>
  trackId: number | null
  track: Loading<CueEditorTrack>
  peaks: Loading<CueEditorPeaks>
  /** Why the last edit was refused, until the next one. */
  editFailed: ErrorCode | null
  /** Counts refused edits: the waveform puts its markers back where they are saved. */
  revision: number
  /** The cue deleted last, to be put back by "Visszavonás" until another edit. */
  deleted: { trackId: number; slot: number; positionMs: number } | null
  setFilter: (filter: CueEditorFilter) => Promise<void>
  loadList: () => Promise<void>
  /** Shows a track: its cues at once, its waveform when the sidecar has it. */
  open: (trackId: number) => Promise<void>
  edit: (action: CueEditAction) => Promise<void>
  /** Puts the cue deleted last back where it was. */
  undoDelete: () => Promise<void>
}

// Answers for a track that is no longer the one shown are dropped.
let opened = 0

export const useCueEditorStore = create<CueEditorState>((set, get) => ({
  filter: 'all',
  list: { status: 'idle' },
  trackId: null,
  track: { status: 'idle' },
  peaks: { status: 'idle' },
  editFailed: null,
  revision: 0,
  deleted: null,

  async setFilter(filter) {
    set({ filter })
    await get().loadList()
  },

  async loadList() {
    const filter = get().filter
    set({ list: { status: 'loading' } })
    try {
      const items = await window.api.cueEditor.tracks(filter)
      if (get().filter === filter) set({ list: { status: 'ready', value: items } })
    } catch {
      set({ list: { status: 'error', code: null } })
    }
  },

  async open(trackId) {
    const ticket = ++opened
    set({
      trackId,
      track: { status: 'loading' },
      peaks: { status: 'loading' },
      editFailed: null,
      deleted: null
    })
    try {
      const track = await window.api.cueEditor.track(trackId)
      if (ticket !== opened) return
      set({
        track: track.ok
          ? { status: 'ready', value: track.value }
          : { status: 'error', code: track.code }
      })
      if (!track.ok) {
        set({ peaks: { status: 'idle' } })
        return
      }
    } catch {
      if (ticket === opened)
        set({ track: { status: 'error', code: null }, peaks: { status: 'idle' } })
      return
    }
    try {
      const peaks = await window.api.cueEditor.peaks(trackId)
      if (ticket !== opened) return
      set({
        peaks: peaks.ok
          ? { status: 'ready', value: peaks.value }
          : { status: 'error', code: peaks.code }
      })
    } catch {
      if (ticket === opened) set({ peaks: { status: 'error', code: null } })
    }
  },

  async edit(action) {
    const ticket = opened
    const before = get().track
    const removed =
      action.type === 'delete' && before.status === 'ready'
        ? before.value.cues.find((cue) => cue.slot === action.slot)
        : undefined
    try {
      const result = await window.api.cueEditor.edit(action)
      if (!result.ok) {
        if (ticket === opened) set({ editFailed: result.code, revision: get().revision + 1 })
        return
      }
      // The count of cues in the list follows, whichever track is shown by now.
      const list = get().list
      if (list.status === 'ready') {
        set({
          list: {
            status: 'ready',
            value: list.value.map((item) =>
              item.trackId === action.trackId
                ? { ...item, cueCount: result.value.cues.length }
                : item
            )
          }
        })
      }
      if (ticket !== opened) return
      set({
        track: { status: 'ready', value: result.value },
        editFailed: null,
        deleted: removed
          ? { trackId: action.trackId, slot: removed.slot, positionMs: removed.positionMs }
          : null
      })
    } catch {
      if (ticket === opened) set({ editFailed: 'UNEXPECTED', revision: get().revision + 1 })
    }
  },

  async undoDelete() {
    const deleted = get().deleted
    if (!deleted) return
    await get().edit({
      type: 'place',
      trackId: deleted.trackId,
      slot: deleted.slot,
      atMs: deleted.positionMs,
      snap: 'beat'
    })
  }
}))
