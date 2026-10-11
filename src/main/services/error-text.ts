import { toOneLine } from '@shared/text'

const MAX_LOGGED_ERROR_LENGTH = 500

/**
 * An error as one line of the app's own making, for the log. A file name may hold a
 * line break or text that looks like a log line, and a raw error carries the name
 * in its message and its stack: logged as it is, it could forge lines of the log.
 */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return toOneLine(text, MAX_LOGGED_ERROR_LENGTH)
}
