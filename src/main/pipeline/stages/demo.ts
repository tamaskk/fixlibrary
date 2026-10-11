import type { Stage } from './stage'

const DEFAULT_DEMO_STAGE_MS = 200

/** Waits, and stops waiting as soon as the stage is told to stop. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = (): void => {
      clearTimeout(timer)
      reject(new Error('the demo stage was stopped'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stopped)
      resolve()
    }, ms)
    if (signal.aborted) stopped()
    else signal.addEventListener('abort', stopped, { once: true })
  })
}

/**
 * Two stages that only wait: they read and write no file and call nothing. They let
 * a run be started, paused and cancelled in the running app while no real stage
 * exists, and are only ever added in development (see `src/main/index.ts`).
 */
export function createDemoStages(ms: number = DEFAULT_DEMO_STAGE_MS): Stage[] {
  return [
    {
      name: 'demoAnalyze',
      phase: 'compute',
      resource: 'cpu',
      dependsOn: [],
      selectable: true,
      timeoutMs: ms + 30_000,
      run: async ({ signal }) => {
        await wait(ms, signal)
        return { proposal: { demoAnalyzed: true } }
      }
    },
    {
      name: 'demoLookup',
      phase: 'compute',
      resource: 'network',
      dependsOn: ['demoAnalyze'],
      selectable: true,
      timeoutMs: ms + 30_000,
      run: async ({ signal }) => {
        await wait(ms, signal)
        return { proposal: { demoLookedUp: true } }
      }
    }
  ]
}
