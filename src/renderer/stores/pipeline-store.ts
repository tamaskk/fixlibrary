import { create } from 'zustand'
import type { RunProgress } from '@shared/pipeline'
import { usePreviewStore } from './preview-store'

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
  /** When the report in `progress` arrived, by the clock of the page. */
  progressAt: number
  /** True when the last pause, resume or cancel could not be passed on. */
  actionFailed: boolean
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
      if (progress.state === 'finished') {
        set({ progress: null, lastFinished: progress, actionFailed: false })
        // A phase that ended changes what waits for approval and what can be undone.
        void usePreviewStore.getState().load()
      } else {
        set({ progress, progressAt: Date.now(), lastFinished: null })
      }
    })
  }

  /** Passes an action on, and remembers if that failed, so the panel can say so. */
  async function act(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      set({ actionFailed: false })
    } catch {
      set({ actionFailed: true })
    }
  }

  return {
    loaded: false,
    functions: [],
    choice: 'all',
    progress: null,
    progressAt: 0,
    actionFailed: false,
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
          progressAt: Date.now(),
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

    pause: () => act(() => window.api.pipeline.pause()),
    resume: () => act(() => window.api.pipeline.resume()),
    cancel: () => act(() => window.api.pipeline.cancel())
  }
})
