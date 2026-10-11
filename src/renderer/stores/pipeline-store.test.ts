import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FixLibraryApi } from '@shared/ipc'
import type { PipelineState, RunProgress } from '@shared/pipeline'

type PipelineApi = FixLibraryApi['pipeline']

let state: PipelineState
let stateFails: boolean
let listeners: ((progress: RunProgress) => void)[]
let calls: string[]
let actionsFail: boolean

const api = {
  pipeline: {
    state: async () => {
      if (stateFails) throw new Error('IPC failed')
      return state
    },
    pause: async () => {
      if (actionsFail) throw new Error('IPC failed')
      calls.push('pause')
    },
    resume: async () => void calls.push('resume'),
    cancel: async () => void calls.push('cancel'),
    onProgress: (listener) => {
      listeners.push(listener)
      return () => {}
    }
  } satisfies PipelineApi
}

function progress(changes: Partial<RunProgress> = {}): RunProgress {
  return {
    batchId: 1,
    phase: 'compute',
    state: 'running',
    outcome: null,
    pauseReason: null,
    counts: { total: 40, done: 4, failed: 0, skipped: 0, running: 2 },
    stages: [],
    tracks: { total: 20, failed: 0 },
    elapsedMs: 0,
    remainingMs: null,
    ...changes
  }
}

// The store is a module with state: every test gets a fresh one.
async function freshStore(): Promise<typeof import('./pipeline-store').usePipelineStore> {
  vi.resetModules()
  vi.stubGlobal('window', { api })
  return (await import('./pipeline-store')).usePipelineStore
}

beforeEach(() => {
  state = { functions: ['bpmKey', 'energy'], progress: null }
  stateFails = false
  listeners = []
  calls = []
  actionsFail = false
})

describe('load', () => {
  it('takes over what can run and the run that is active', async () => {
    // Arrange
    state = { functions: ['bpmKey'], progress: progress() }
    const store = await freshStore()

    // Act
    await store.getState().load()

    // Assert
    expect(store.getState()).toMatchObject({
      loaded: true,
      functions: ['bpmKey'],
      progress: { batchId: 1, state: 'running' }
    })
  })

  it('listens for reports once, however often the page is opened', async () => {
    // Arrange
    const store = await freshStore()

    // Act
    await store.getState().load()
    await store.getState().load()

    // Assert
    expect(listeners).toHaveLength(1)
  })

  it('offers nothing to run when the main process cannot be asked', async () => {
    // Arrange
    stateFails = true
    const store = await freshStore()

    // Act
    await store.getState().load()

    // Assert
    expect(store.getState()).toMatchObject({ loaded: true, functions: [], progress: null })
  })

  it('goes back to every function when the chosen one is gone', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().load()
    store.getState().choose('energy')
    state = { functions: ['bpmKey'], progress: null }

    // Act
    await store.getState().load()

    // Assert
    expect(store.getState().choice).toBe('all')
  })
})

describe('the chosen function', () => {
  it('means every function by default, and one when one is chosen', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().load()

    // Act
    const all = store.getState().chosenStages()
    store.getState().choose('energy')
    const one = store.getState().chosenStages()

    // Assert
    expect(all).toEqual(['bpmKey', 'energy'])
    expect(one).toEqual(['energy'])
  })
})

describe('reports of a run', () => {
  it('shows a run as it goes on, and keeps its last report when it has ended', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().load()
    const report = listeners[0] as (progress: RunProgress) => void

    // Act
    report(progress({ state: 'paused', pauseReason: 'offline' }))
    const whileRunning = { ...store.getState() }
    report(progress({ state: 'finished', outcome: 'preview' }))

    // Assert
    expect(whileRunning).toMatchObject({
      progress: { state: 'paused', pauseReason: 'offline' },
      lastFinished: null
    })
    expect(store.getState()).toMatchObject({
      progress: null,
      lastFinished: { state: 'finished', outcome: 'preview' }
    })
  })

  it('takes the note about the last run away when the next run starts', async () => {
    // Arrange
    const store = await freshStore()
    await store.getState().load()
    const report = listeners[0] as (progress: RunProgress) => void
    report(progress({ state: 'finished', outcome: 'cancelled' }))

    // Act
    report(progress({ batchId: 2 }))

    // Assert
    expect(store.getState()).toMatchObject({ progress: { batchId: 2 }, lastFinished: null })
  })
})

describe('acting on a run', () => {
  it('asks the main process to pause, resume and cancel', async () => {
    // Arrange
    const store = await freshStore()

    // Act
    await store.getState().pause()
    await store.getState().resume()
    await store.getState().cancel()

    // Assert
    expect(calls).toEqual(['pause', 'resume', 'cancel'])
  })

  it('remembers that an action could not be passed on, until one works again', async () => {
    // Arrange
    const store = await freshStore()
    actionsFail = true

    // Act
    await store.getState().pause()
    const afterFailure = store.getState().actionFailed
    actionsFail = false
    await store.getState().pause()

    // Assert
    expect(afterFailure).toBe(true)
    expect(store.getState().actionFailed).toBe(false)
  })
})
