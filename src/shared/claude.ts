// What the app says about the `claude` command-line tool: whether it is there, and
// whether it can be used. Never a path, an account or raw tool output.

/** How many items one call to Claude holds at most. */
export const CLAUDE_BATCH_SIZE = 20

/**
 * Why Claude cannot be used. `missing`: no `claude` command was found. `notLoggedIn`:
 * it is installed but not signed in. `outdated`: it does not know an option the app
 * passes. `failed`: it does not start, or answers something else.
 */
export type ClaudeProblem = 'missing' | 'notLoggedIn' | 'outdated' | 'timeout' | 'failed'

export type ClaudeStatus =
  | {
      ok: true
      version: string
      /** The kind of subscription the login belongs to, such as `max`; null when not told. */
      subscription: string | null
      /** True when the user chose the command by hand in Settings. */
      chosenByHand: boolean
    }
  | {
      ok: false
      reason: ClaudeProblem
      /** Known when the command runs but cannot be used. */
      version: string | null
      chosenByHand: boolean
    }

/** How a test call from Settings went. */
export type ClaudeTestResult =
  | { ok: true; answered: number; asked: number; durationMs: number }
  /** `tooSoon`: a test was made a moment ago; each one is a real call. */
  | { ok: false; reason: ClaudeProblem | 'limit' | 'noAnswer' | 'tooSoon' }
