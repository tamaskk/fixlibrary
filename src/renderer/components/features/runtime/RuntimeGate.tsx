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
  const [dismissed, setDismissed] = React.useState(false)

  React.useEffect(() => {
    const unsubscribe = window.api.pythonRuntime.onChange(setState)
    window.api.pythonRuntime
      .state()
      .then(setState)
      .catch(() => setState({ status: 'failed', fraction: null }))
    return unsubscribe
  }, [])

  if (state?.status === 'ready' || dismissed) return <>{children}</>
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1 className="text-h1">FixLibrary</h1>
        <div role="status" className="flex flex-col gap-2">
          {state?.status === 'failed' ? (
            <StatusLine tone="danger">
              Az elemző környezet nem készíthető elő. Az elemzések nem működnek, amíg nem sikerül.
            </StatusLine>
          ) : (
            <p className="text-body text-text-muted">
              {state?.status === 'unpacking'
                ? 'Az elemző környezet kicsomagolása. Ez az első indításkor és frissítés után egyszer kell, egy-két percig tart.'
                : 'Indítás…'}
            </p>
          )}
        </div>
        {state?.status === 'unpacking' && (
          <>
            <ProgressBar percent={(state.fraction ?? 0) * 100} label="Kicsomagolás" />
            <span className="font-mono text-data text-text-muted tabular-nums">
              {formatPercent(state.fraction ?? 0)}
            </span>
          </>
        )}
        {state?.status === 'failed' && (
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                setState({ status: 'checking', fraction: null })
                void window.api.pythonRuntime.retry()
              }}
            >
              Próbáld újra
            </Button>
            <Button onClick={() => setDismissed(true)}>Tovább így is</Button>
          </div>
        )}
      </div>
    </main>
  )
}
