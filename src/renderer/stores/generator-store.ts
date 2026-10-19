import { create } from 'zustand'
import type { ErrorCode } from '@shared/errors'
import { DEFAULT_CUSTOM_CURVE } from '@shared/energy-curves'
import {
  DEFAULT_GENERATOR_PARAMS,
  type GeneratedEntry,
  type GeneratorParams,
  type GeneratorResult
} from '@shared/generator'
import type { OnlineRecommendation, PlaylistTrackItem } from '@shared/playlists'
import type { OnlineRowState } from '@/stores/playlists-store'

/** The alternatives "Csere" shows for one place. */
interface Swap {
  index: number
  items: PlaylistTrackItem[] | null
  failure: ErrorCode | null
}

/** The online recommendations of one gap. */
interface GapRecs {
  index: number
  items: OnlineRecommendation[] | null
  loading: boolean
  failure: ErrorCode | null
  rows: Record<string, OnlineRowState>
}

type SaveOutcome = { ok: true; name: string; skipped: number } | { ok: false; code: ErrorCode }

interface GeneratorState {
  styles: { id: number; name: string }[] | null
  stylesFailed: boolean
  params: GeneratorParams
  prompt: string
  parsing: boolean
  promptFailure: ErrorCode | null
  /** Styles the prompt named that the user does not have. */
  unknownStyles: string[]
  generating: boolean
  generateFailed: boolean
  /** The list as generated, with the places swapped since. Kept for the session only. */
  result: GeneratorResult | null
  swap: Swap | null
  gap: GapRecs | null
  saving: boolean
  saved: SaveOutcome | null
  loadStyles: () => Promise<void>
  setParams: (patch: Partial<GeneratorParams>) => void
  setPrompt: (prompt: string) => void
  parsePrompt: () => Promise<void>
  generate: () => Promise<void>
  openSwap: (index: number) => Promise<void>
  closeSwap: () => void
  swapIn: (index: number, item: PlaylistTrackItem) => void
  requestGap: (index: number) => Promise<void>
  downloadGap: (url: string, confirmed: boolean) => Promise<void>
  save: (name: string) => Promise<boolean>
}

/** The track ids of the list in order, null for a gap: what main checks a swap against. */
export function listOf(entries: readonly GeneratedEntry[]): (number | null)[] {
  return entries.map((entry) => (entry.kind === 'track' ? entry.item.trackId : null))
}

export const useGeneratorStore = create<GeneratorState>((set, get) => ({
  styles: null,
  stylesFailed: false,
  params: DEFAULT_GENERATOR_PARAMS,
  prompt: '',
  parsing: false,
  promptFailure: null,
  unknownStyles: [],
  generating: false,
  generateFailed: false,
  result: null,
  swap: null,
  gap: null,
  saving: false,
  saved: null,
  loadStyles: async () => {
    try {
      const styles = await window.api.styles.list()
      set({
        styles: styles.flatMap((style) =>
          style.id === undefined ? [] : [{ id: style.id, name: style.name }]
        ),
        stylesFailed: false
      })
    } catch {
      set({ stylesFailed: true })
    }
  },
  setParams: (patch) => {
    const params = { ...get().params, ...patch }
    // A drawn curve starts flat; it is kept when another profile is chosen meanwhile.
    if (params.energyProfile === 'custom' && params.customCurve === null) {
      params.customCurve = DEFAULT_CUSTOM_CURVE
    }
    set({ params })
  },
  setPrompt: (prompt) => set({ prompt }),
  parsePrompt: async () => {
    set({ parsing: true, promptFailure: null, unknownStyles: [] })
    try {
      const result = await window.api.generator.parsePrompt(get().prompt)
      if (result.ok) {
        set({ params: { ...get().params, ...result.value.params } })
        set({ unknownStyles: result.value.unknownStyles })
      } else {
        set({ promptFailure: result.code })
      }
    } catch {
      set({ promptFailure: 'UNEXPECTED' })
    }
    set({ parsing: false })
  },
  generate: async () => {
    set({ generating: true, generateFailed: false, swap: null, gap: null, saved: null })
    try {
      const params = get().params
      const result = await window.api.generator.generate({
        ...params,
        customCurve: params.energyProfile === 'custom' ? params.customCurve : null
      })
      set({ result })
    } catch {
      set({ generateFailed: true })
    }
    set({ generating: false })
  },
  openSwap: async (index) => {
    const result = get().result
    if (result === null) return
    set({ swap: { index, items: null, failure: null } })
    let next: Swap
    try {
      const found = await window.api.generator.alternatives({
        params: get().params,
        list: listOf(result.entries),
        index
      })
      next = found.ok
        ? { index, items: found.value, failure: null }
        : { index, items: null, failure: found.code }
    } catch {
      next = { index, items: null, failure: 'UNEXPECTED' }
    }
    if (get().swap?.index === index) set({ swap: next })
  },
  closeSwap: () => set({ swap: null }),
  swapIn: (index, item) => {
    const result = get().result
    const entry = result?.entries[index]
    if (!result || entry === undefined) return
    const targetEnergy = entry.kind === 'track' ? entry.targetEnergy : entry.target.energy
    const entries = result.entries.map((each, at) =>
      at === index ? { kind: 'track' as const, item, targetEnergy } : each
    )
    set({
      result: {
        ...result,
        entries,
        gaps: entries.filter((each) => each.kind === 'gap').length,
        totalMs: entries.reduce(
          (sum, each) => sum + (each.kind === 'track' ? (each.item.durationMs ?? 0) : 0),
          0
        )
      },
      swap: null,
      saved: null
    })
  },
  requestGap: async (index) => {
    const entry = get().result?.entries[index]
    if (entry?.kind !== 'gap') return
    set({ gap: { index, items: null, loading: true, failure: null, rows: {} } })
    let next: Pick<GapRecs, 'items' | 'failure'>
    try {
      const found = await window.api.generator.gapRecs(entry.target)
      next = found.ok ? { items: found.value, failure: null } : { items: null, failure: found.code }
    } catch {
      next = { items: null, failure: 'UNEXPECTED' }
    }
    const gap = get().gap
    if (gap?.index === index) set({ gap: { ...gap, ...next, loading: false } })
  },
  downloadGap: async (url, confirmed) => {
    let row: OnlineRowState
    try {
      const result = await window.api.generator.gapDownload(url, confirmed)
      row = result.ok ? result.value : { kind: 'failed', code: result.code }
    } catch {
      row = { kind: 'failed', code: 'UNEXPECTED' }
    }
    const gap = get().gap
    if (gap !== null) set({ gap: { ...gap, rows: { ...gap.rows, [url]: row } } })
  },
  save: async (name) => {
    const result = get().result
    if (result === null) return false
    const trackIds = listOf(result.entries).flatMap((id) => (id === null ? [] : [id]))
    set({ saving: true, saved: null })
    let saved: SaveOutcome
    try {
      const answer = await window.api.generator.save({ name, trackIds })
      saved = answer.ok
        ? { ok: true, name: name.trim(), skipped: answer.value.skipped }
        : { ok: false, code: answer.code }
    } catch {
      saved = { ok: false, code: 'UNEXPECTED' }
    }
    set({ saving: false, saved })
    return saved.ok
  }
}))
