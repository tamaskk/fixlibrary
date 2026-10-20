import * as React from 'react'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/progress-bar'
import { StatusLine } from '@/components/ui/status-line'
import { formatPercent } from '@/lib/format'
import type { PythonRuntimeState } from '@shared/python-runtime'

/**
 * The page of a first start: the app's Python runtime is unpacked once (T-041), and the
 * analyses cannot run before that. In development the runtime is always ready.
 */
export function RuntimeGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = React.useState<PythonRuntimeState | null>(null)
  // True when main could not even be asked: a retry then asks again.
  const [unknown, setUnknown] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(false)
  const heading = React.useRef<HTMLHeadingElement>(null)

  const ask = React.useCallback(() => {
    window.api.pythonRuntime
      .state()
      // What main sent meanwhile is newer than this answer.
      .then((asked) => setState((pushed) => pushed ?? asked))
      .catch(() => setUnknown(true))
  }, [])

  React.useEffect(() => {
    const unsubscribe = window.api.pythonRuntime.onChange((pushed) => {
      setUnknown(false)
      setState(pushed)
    })
    ask()
    return unsubscribe
  }, [ask])

  if (state?.status === 'ready' || dismissed) return <>{children}</>
  // Nothing until main answers: in development it says ready at once.
  if (state === null && !unknown) return <main className="h-full" />

  const failed = unknown || state?.status === 'failed'
  const unpacking = !failed && state?.status === 'unpacking'

  function retry(): void {
    heading.current?.focus()
    if (unknown) {
      setUnknown(false)
      ask()
      return
    }
    setState({ status: 'checking', fraction: null })
    void window.api.pythonRuntime.retry()
  }

  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1 ref={heading} tabIndex={-1} className="text-h1 outline-none">
          FixLibrary
        </h1>
        <p className="text-body text-text-muted">
          {unpacking
            ? 'Az elemző környezet kicsomagolása. Ez az első indításkor és frissítés után egyszer kell, egy-két percig tart.'
            : failed
              ? 'Az elemző környezet nincs kész.'
              : 'Indítás…'}
        </p>
        {unpacking && (
          <div className="flex items-center gap-2">
            <ProgressBar
              className="flex-1"
              percent={(state.fraction ?? 0) * 100}
              label="Kicsomagolás"
            />
            <span className="w-10 text-right font-mono text-data text-text-muted tabular-nums">
              {formatPercent(state.fraction ?? 0)}
            </span>
          </div>
        )}
        {/* In the page from the start, so a failure is announced when it comes. */}
        <div role="status">
          {failed && (
            <StatusLine tone="danger">
              Az elemző környezet nem készíthető elő. Az elemzések nem működnek, amíg nem sikerül.
            </StatusLine>
          )}
        </div>
        {failed && (
          <div className="flex gap-2">
            <Button variant="primary" autoFocus onClick={retry}>
              Próbáld újra
            </Button>
            <Button onClick={() => setDismissed(true)}>Tovább így is</Button>
          </div>
        )}
      </div>
    </main>
  )
}
