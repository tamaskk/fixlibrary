import { checkAll, type ToolLocations } from '../services/binaries'
import type { ToolCheck } from '@shared/tools'

const MIN_RECHECK_INTERVAL_MS = 5000

export interface ToolChecker {
  /** The last result, or a fresh one with `force` or when there is none yet. */
  check: (force: boolean) => Promise<ToolCheck[]>
}

/**
 * Checking starts four processes, so the renderer must not be able to start it
 * over and over: one check runs at a time, its result is kept, and a forced
 * re-check within a few seconds returns that result.
 */
export function createToolChecker(
  locations: ToolLocations,
  runCheck: (locations: ToolLocations) => Promise<ToolCheck[]> = checkAll,
  now: () => number = Date.now
): ToolChecker {
  let running: Promise<ToolCheck[]> | null = null
  let last: { checks: ToolCheck[]; at: number } | null = null

  return {
    check(force) {
      if (running) return running
      // Even a forced check is not repeated back to back.
      if (last && (!force || now() - last.at < MIN_RECHECK_INTERVAL_MS)) {
        return Promise.resolve(last.checks)
      }
      running = runCheck(locations)
        .then((checks) => {
          last = { checks, at: now() }
          return checks
        })
        .finally(() => {
          running = null
        })
      return running
    }
  }
}
