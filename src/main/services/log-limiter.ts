export interface LogLimiterOptions {
  /** How many lines pass in one window. */
  limit: number
  windowMs: number
  now?: () => number
}

/**
 * Lets a noisy source write only so many lines per window. What it holds back is
 * summed up in one line at the start of the next window, so a flood of output
 * (a tool's progress display, a page hammering the app) cannot push the rest of
 * the history out of the rotating log.
 */
export function createLogLimiter(
  write: (line: string) => void,
  options: LogLimiterOptions
): (line: string) => void {
  const now = options.now ?? Date.now
  let windowStart = now()
  let written = 0
  let suppressed = 0

  return (line) => {
    if (now() - windowStart >= options.windowMs) {
      if (suppressed > 0) write(`(${suppressed} lines suppressed)`)
      windowStart = now()
      written = 0
      suppressed = 0
    }
    if (written < options.limit) {
      written += 1
      write(line)
    } else {
      suppressed += 1
    }
  }
}
