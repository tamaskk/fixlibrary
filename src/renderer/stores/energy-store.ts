import { create } from 'zustand'
import type { CalibrationView } from '@shared/energy'
import type { ErrorCode, Result } from '@shared/errors'

/** What failed last, and where the page says so. */
export interface EnergyFailure {
  code: ErrorCode
  of: 'rating' | 'model'
}

interface EnergyState {
  view: CalibrationView | null
  loadFailed: boolean
  failure: EnergyFailure | null
  fitting: boolean
  choosing: boolean
  load: () => Promise<void>
  rate: (trackId: number, rating: number) => Promise<void>
  fit: () => Promise<void>
  newSample: () => Promise<void>
}

// The main process is the authority: the view is only ever what main answered.
export const useEnergyStore = create<EnergyState>((set) => {
  // Ratings go out one at a time, and only the last one chosen for a track: the arrow
  // keys choose on every step, and answers must not come back out of order.
  let sending: Promise<void> = Promise.resolve()
  const latest = new Map<number, number>()

  function takeView(result: Result<CalibrationView>): void {
    if (result.ok) set({ view: result.value, failure: null })
    else set({ failure: { code: result.code, of: 'model' } })
  }

  async function send(trackId: number, rating: number): Promise<void> {
    if (latest.get(trackId) !== rating) return
    try {
      const result = await window.api.energy.rate({ trackId, rating })
      if (!result.ok) {
        set({ failure: { code: result.code, of: 'rating' } })
        return
      }
      set((state) => ({
        failure: null,
        view: state.view && {
          ...state.view,
          ratedCount: result.value.ratedCount,
          sample: state.view.sample.map((item) =>
            item.trackId === trackId ? { ...item, rating } : item
          )
        }
      }))
    } catch {
      set({ failure: { code: 'UNEXPECTED', of: 'rating' } })
    }
  }

  return {
    view: null,
    loadFailed: false,
    failure: null,
    fitting: false,
    choosing: false,
    load: async () => {
      set({ loadFailed: false })
      try {
        set({ view: await window.api.energy.calibration() })
      } catch {
        set({ loadFailed: true })
      }
    },
    rate: (trackId, rating) => {
      latest.set(trackId, rating)
      sending = sending.then(() => send(trackId, rating))
      return sending
    },
    fit: async () => {
      set({ fitting: true })
      try {
        takeView(await window.api.energy.fit())
      } catch {
        set({ failure: { code: 'UNEXPECTED', of: 'model' } })
      } finally {
        set({ fitting: false })
      }
    },
    newSample: async () => {
      set({ choosing: true })
      try {
        set({ view: await window.api.energy.newSample(), failure: null })
      } catch {
        set({ failure: { code: 'UNEXPECTED', of: 'model' } })
      } finally {
        set({ choosing: false })
      }
    }
  }
})
