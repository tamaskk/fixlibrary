import { create } from 'zustand'
import { MAX_COVER_THUMB_TRACKS, type CoverThumbs } from '@shared/preview'

/** What the page knows of the covers of one row. */
export type RowCoverThumbs =
  { status: 'loading' } | { status: 'failed' } | ({ status: 'ready' } & CoverThumbs)

interface CoverThumbsState {
  /** The batch the thumbnails belong to; another batch starts afresh. */
  batchId: number | null
  rows: Readonly<Record<number, RowCoverThumbs>>
  /** Asks for the covers of a row, once. Rows asked for together go in one call. */
  request: (batchId: number, trackId: number) => void
  /** Forgets the covers of a row whose cover changed, so they are asked for again. */
  forget: (trackId: number) => void
}

// The main process is the authority: the store only ever holds what main returned.
export const useCoverThumbsStore = create<CoverThumbsState>((set, get) => {
  // The rows asked for since the last call went out, by batch.
  let waiting: { batchId: number; trackIds: Set<number> } | null = null
  // How often the covers of a row were forgotten: an answer asked for before is old.
  const generations = new Map<number, number>()

  async function send(batchId: number, trackIds: number[]): Promise<void> {
    const asked = new Map(trackIds.map((id) => [id, generations.get(id) ?? 0]))
    const result = await window.api.preview.coverThumbs({ batchId, trackIds }).catch(() => null)
    if (get().batchId !== batchId) return
    const current = trackIds.filter((id) => asked.get(id) === (generations.get(id) ?? 0))
    const rows: Record<number, RowCoverThumbs> = { ...get().rows }
    for (const trackId of current) rows[trackId] = { status: 'failed' }
    if (result?.ok) {
      for (const thumbs of result.value) {
        if (current.includes(thumbs.trackId)) rows[thumbs.trackId] = { status: 'ready', ...thumbs }
      }
    }
    set({ rows })
  }

  function flush(): void {
    const sending = waiting
    waiting = null
    if (!sending) return
    const trackIds = [...sending.trackIds]
    for (let start = 0; start < trackIds.length; start += MAX_COVER_THUMB_TRACKS) {
      void send(sending.batchId, trackIds.slice(start, start + MAX_COVER_THUMB_TRACKS))
    }
  }

  return {
    batchId: null,
    rows: {},
    forget(trackId) {
      generations.set(trackId, (generations.get(trackId) ?? 0) + 1)
      const rows = { ...get().rows }
      delete rows[trackId]
      set({ rows })
    },
    request(batchId, trackId) {
      if (get().batchId !== batchId) {
        set({ batchId, rows: {} })
        waiting = null
      }
      // A row whose call failed is asked again when it comes into view again.
      const known = get().rows[trackId]
      if (known !== undefined && known.status !== 'failed') return
      set({ rows: { ...get().rows, [trackId]: { status: 'loading' } } })
      if (!waiting) {
        waiting = { batchId, trackIds: new Set() }
        // The rows a scroll brings into view mount in one go: they are asked for together.
        setTimeout(flush, 0)
      }
      waiting.trackIds.add(trackId)
    }
  }
})
