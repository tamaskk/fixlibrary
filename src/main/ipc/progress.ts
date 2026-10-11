/** Progress events reach the renderer at most this often (four per second). */
export const PROGRESS_INTERVAL_MS = 250

/**
 * Passes a progress value on only if the last one went out long enough ago. What
 * comes in between is dropped: progress is a display, and the result of the work
 * arrives on its own.
 */
export function createProgressThrottle<T>(
  send: (progress: T) => void,
  now: () => number = Date.now
): (progress: T) => void {
  let lastSent: number | null = null
  return (progress) => {
    const time = now()
    if (lastSent !== null && time - lastSent < PROGRESS_INTERVAL_MS) return
    lastSent = time
    send(progress)
  }
}
