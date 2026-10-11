import { create } from 'zustand'
import type { RunProgress } from '@shared/pipeline'

/** Every function at once, or one of them by its name. */
export type FunctionChoice = 'all' | string

interface PipelineState {
  /** False until the main process has said what can run. */
  loaded: boolean
  /** The names of the functions that can be asked for. */
  functions: string[]
  choice: FunctionChoice
  /** The run that is active now, or null. */
  progress: RunProgress | null
  /** The last report of the run that ended last in this session, or null. */
  lastFinished: RunProgress | null
  load: () => Promise<void>
  choose: (choice: FunctionChoice) => void
  /** The function names a run is started with for the current choice. */
  chosenStages: () => string[]
  pause: () => Promise<void>
  resume: () => Promise<void>
  cancel: () => Promise<void>
}

// The main process is the authority: the store only ever holds what main reported.
export const usePipelineStore = create<PipelineState>((set, get) => {
  let listening = false

  /** Follows the reports of the main process, for as long as the page lives. */
  function listen(): void {
    if (listening) return
    listening = true
    window.api.pipeline.onProgress((progress) => {
      if (progress.state === 'finished') set({ progress: null, lastFinished: progress })
      else set({ progress, lastFinished: null })
    })
  }

  return {
    loaded: false,
    functions: [],
    choice: 'all',
    progress: null,
    lastFinished: null,

    async load() {
      listen()
      try {
        const { functions, progress } = await window.api.pipeline.state()
        const { choice } = get()
        set({
          loaded: true,
          functions,
          progress,
          // A function that is gone cannot stay chosen.
          choice: choice === 'all' || functions.includes(choice) ? choice : 'all'
        })
      } catch {
        // Nothing can be run until the next visit of the page asks again.
        set({ loaded: true, functions: [], progress: null })
      }
    },

    choose: (choice) => set({ choice }),
    chosenStages() {
      const { choice, functions } = get()
      return choice === 'all' ? [...functions] : [choice]
    },

    pause: () => window.api.pipeline.pause(),
    resume: () => window.api.pipeline.resume(),
    cancel: () => window.api.pipeline.cancel()
  }
})
