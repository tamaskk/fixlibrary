import { create } from 'zustand'
import type { CalibrationView } from '@shared/energy'
import type { ErrorCode, Result } from '@shared/errors'

interface EnergyState {
  view: CalibrationView | null
  loadFailed: boolean
  /** What the last action failed with, or null. */
  failure: ErrorCode | null
  fitting: boolean
  load: () => Promise<void>
  rate: (trackId: number, rating: number) => Promise<void>
  fit: () => Promise<void>
  newSample: () => Promise<void>
}

// The main process is the authority: the view is only ever what main answered.
export const useEnergyStore = create<EnergyState>((set) => {
  function take(result: Result<CalibrationView>): void {
    if (result.ok) set({ view: result.value, failure: null })
    else set({ failure: result.code })
  }

  return {
    view: null,
    loadFailed: false,
    failure: null,
    fitting: false,
    load: async () => {
      try {
        set({ view: await window.api.energy.calibration(), loadFailed: false })
      } catch {
        set({ loadFailed: true })
      }
    },
    rate: async (trackId, rating) => {
      try {
        take(await window.api.energy.rate({ trackId, rating }))
      } catch {
        set({ failure: 'UNEXPECTED' })
      }
    },
    fit: async () => {
      set({ fitting: true })
      try {
        take(await window.api.energy.fit())
      } catch {
        set({ failure: 'UNEXPECTED' })
      } finally {
        set({ fitting: false })
      }
    },
    newSample: async () => {
      try {
        set({ view: await window.api.energy.newSample(), failure: null })
      } catch {
        set({ failure: 'UNEXPECTED' })
      }
    }
  }
})
