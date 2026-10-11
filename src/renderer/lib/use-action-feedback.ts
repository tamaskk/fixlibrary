import * as React from 'react'
import type { ErrorCode } from '@shared/errors'
import { errorMessage } from './messages'

export type ActionFeedback =
  { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string }

const SAVED_VISIBLE_MS = 4000

/**
 * Runs a save and reports what became of it: a short "saved" confirmation, or an
 * error that stays until the next attempt. An action that throws is an error too,
 * so a button never stays stuck in its loading state.
 */
/** Runs a save and resolves to whether it succeeded. */
export type RunAction = (
  action: () => Promise<ErrorCode | null>,
  describe?: (code: ErrorCode) => string
) => Promise<boolean>

export function useActionFeedback(): {
  feedback: ActionFeedback
  run: RunAction
  fail: (message: string) => void
  clear: () => void
} {
  const [feedback, setFeedback] = React.useState<ActionFeedback>({ kind: 'idle' })
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopTimer = React.useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])

  React.useEffect(() => stopTimer, [stopTimer])

  const fail = React.useCallback(
    (message: string) => {
      stopTimer()
      setFeedback({ kind: 'error', message })
    },
    [stopTimer]
  )

  const clear = React.useCallback(() => {
    stopTimer()
    setFeedback({ kind: 'idle' })
  }, [stopTimer])

  const run = React.useCallback(
    async (
      action: () => Promise<ErrorCode | null>,
      describe: (code: ErrorCode) => string = errorMessage
    ): Promise<boolean> => {
      let code: ErrorCode | null
      try {
        code = await action()
      } catch {
        code = 'UNEXPECTED'
      }
      if (code !== null) {
        fail(describe(code))
        return false
      }
      stopTimer()
      setFeedback({ kind: 'saved' })
      timer.current = setTimeout(() => setFeedback({ kind: 'idle' }), SAVED_VISIBLE_MS)
      return true
    },
    [fail, stopTimer]
  )

  return { feedback, run, fail, clear }
}
