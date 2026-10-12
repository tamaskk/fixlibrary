// How often a lookup service may be asked. Every service has a limiter of its own,
// set to what the service allows.

/** A request that was not sent because its service must be left alone for now. */
export class ServiceBusyError extends Error {
  constructor() {
    super('the service is not to be asked for now')
  }
}

export interface RateLimiterOptions {
  /** At most this many requests start … */
  cap: number
  /** … within any stretch of this length. */
  intervalMs: number
  /**
   * A request that would have to wait longer than this for a pause to end is refused
   * instead: the stage that waits for it has a time limit of its own.
   */
  maxPauseWaitMs?: number
  now?: () => number
}

export interface RateLimiter {
  /** Runs `task` when its turn has come. Rejects with what `task` rejects with. */
  schedule: <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>
  /** Starts nothing for this long: the service has asked to be left alone. */
  pauseFor: (ms: number) => void
}

interface Waiter {
  start: () => void
  refuse: (error: Error) => void
}

const DEFAULT_MAX_PAUSE_WAIT_MS = 5000

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { cap, intervalMs } = options
  const maxPauseWaitMs = options.maxPauseWaitMs ?? DEFAULT_MAX_PAUSE_WAIT_MS
  const now = options.now ?? Date.now
  // When the last `cap` requests started, oldest first.
  const starts: number[] = []
  const waiting: Waiter[] = []
  let pausedUntil = 0
  let timer: NodeJS.Timeout | null = null

  function nextStartAt(): number {
    const afterPause = Math.max(now(), pausedUntil)
    return starts.length < cap
      ? afterPause
      : Math.max(afterPause, (starts[0] as number) + intervalMs)
  }

  function pump(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    while (waiting.length > 0) {
      const startAt = nextStartAt()
      const time = now()
      if (startAt > time) {
        timer = setTimeout(pump, startAt - time)
        return
      }
      starts.push(time)
      if (starts.length > cap) starts.shift()
      waiting.shift()?.start()
    }
  }

  return {
    schedule(task, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('the request was given up'))
          return
        }
        if (pausedUntil - now() > maxPauseWaitMs) {
          reject(new ServiceBusyError())
          return
        }
        const onAbort = (): void => {
          const index = waiting.indexOf(waiter)
          if (index >= 0) waiting.splice(index, 1)
          reject(new Error('the request was given up'))
        }
        const waiter: Waiter = {
          start: () => {
            signal?.removeEventListener('abort', onAbort)
            task().then(resolve, reject)
          },
          refuse: (error) => {
            signal?.removeEventListener('abort', onAbort)
            reject(error)
          }
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.push(waiter)
        pump()
      })
    },

    pauseFor(ms) {
      pausedUntil = Math.max(pausedUntil, now() + ms)
      if (ms > maxPauseWaitMs) {
        for (const waiter of waiting.splice(0)) waiter.refuse(new ServiceBusyError())
      }
      pump()
    }
  }
}
