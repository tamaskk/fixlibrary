import * as React from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Data } from '@/components/features/playlists/DataText'
import { StatusLine } from '@/components/ui/status-line'
import { cn } from '@/lib/cn'
import { formatCount, formatElapsed } from '@/lib/format'
import { useAppStore, type AppPage } from '@/stores/app-store'
import { useFullRunStore } from '@/stores/full-run-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { FULL_RUN_TICK_MS_PAGE, STEP_LABELS, stepsShown } from './full-run-steps'
import type { FullRunStep, FullRunView } from '@shared/full-run'

/** What the user does at a step that waits for them, and where. */
const WAITS_FOR: Partial<Record<FullRunStep, { text: string; page: AppPage; action: string }>> = {
  calibration: {
    text: 'Az energy még nincs kalibrálva. Értékelj néhány tracket, utána a futás magától megy tovább.',
    page: 'energy',
    action: 'Kalibráció megnyitása'
  },
  preview: {
    text: 'Nézd át a változásokat, és hagyd jóvá őket. Utána a fájlműveletek magától lefutnak.',
    page: 'preview',
    action: 'Előnézet megnyitása'
  },
  rekordboxA: {
    text: 'Menj végig a Rekordbox varázsló A fázisán az ellenőrzésig. A stemek közben készülnek.',
    page: 'rekordbox',
    action: 'Rekordbox varázsló'
  },
  cues: {
    text: 'A hot cue-k a stemek után készülnek. Ha az előnézet megjelent, hagyd jóvá.',
    page: 'preview',
    action: 'Előnézet megnyitása'
  },
  rekordboxB: {
    text: 'Menj végig a Rekordbox varázsló B fázisán az ellenőrzésig.',
    page: 'rekordbox',
    action: 'Rekordbox varázsló'
  }
}

const STOP_TEXT: Record<NonNullable<FullRunView['stop']>, string> = {
  cancelled: 'A teljes futás leállt: a batch-et elvetetted vagy megszakítottad.',
  failed: 'A teljes futás leállt: a batch hibával zárult.',
  stopped: 'A teljes futást leállítottad.'
}

/**
 * Where the one-button full run is: its steps as a stepper, the time it took, what the
 * step waits for, and a way to that page. Shown at the top of the Library.
 */
export function FullRunPanel(): React.JSX.Element | null {
  const view = useFullRunStore((state) => state.view)
  const load = useFullRunStore((state) => state.load)
  const stop = useFullRunStore((state) => state.stop)
  const setPage = useAppStore((state) => state.setPage)
  const remainingMs = usePipelineStore((state) => state.progress?.remainingMs ?? null)
  const [now, setNow] = React.useState(() => Date.now())
  const [hidden, setHidden] = React.useState<number | null>(null)
  const titleId = React.useId()
  const active = view !== null && view.step !== 'done' && view.stop === null

  React.useEffect(() => {
    void load()
  }, [load])

  // Main moves the run on; the page looks as often, and keeps its clock going.
  React.useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setNow(Date.now())
      void load()
    }, FULL_RUN_TICK_MS_PAGE)
    return () => clearInterval(timer)
  }, [active, load])

  // A run that ended can be put away for the session; a new one shows again.
  if (view === null || hidden === view.startedAt) return null
  const steps = stepsShown(view)
  const at = steps.indexOf(view.step)
  const waits = active ? WAITS_FOR[view.step] : undefined
  const computing = active && (view.step === 'features' || view.step === 'compute')

  return (
    <Card>
      <section aria-labelledby={titleId} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-h2">
            Teljes futtatás
          </h2>
          {active ? (
            <Button variant="ghost" onClick={() => void stop()}>
              Leállítás
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setHidden(view.startedAt)}>
              Elrejtés
            </Button>
          )}
        </div>
        <ol aria-label="A teljes futtatás lépései" className="flex flex-wrap gap-x-4 gap-y-1">
          {steps.map((step, index) => {
            const done = index < at || view.step === 'done'
            const current = index === at && view.step !== 'done'
            return (
              <li
                key={step}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1 text-small',
                  current ? 'font-medium text-text' : 'text-text-muted'
                )}
              >
                {done ? (
                  <Check aria-label="kész" className="size-4 text-success" />
                ) : (
                  <span className="w-4 text-center">
                    <Data>{index + 1}</Data>
                  </span>
                )}
                {STEP_LABELS[step]}
              </li>
            )
          })}
        </ol>
        <p className="flex flex-wrap gap-x-4 text-small text-text-muted">
          <span>
            Eltelt:{' '}
            <Data>
              {formatElapsed(Math.max(0, (active ? now : view.stepStartedAt) - view.startedAt))}
            </Data>
          </span>
          {computing && (
            <span>
              Hátra (ez a lépés):{' '}
              <Data>{remainingMs === null ? '–' : formatElapsed(remainingMs)}</Data>
            </span>
          )}
          {view.stemsRunning && <span>A stemek a háttérben készülnek.</span>}
        </p>
        <div role="status" className="flex flex-col items-start gap-2">
          {waits && (
            <>
              <StatusLine tone="neutral">{waits.text}</StatusLine>
              <Button onClick={() => setPage(waits.page)}>{waits.action}</Button>
            </>
          )}
          {view.stop !== null && <StatusLine tone="warning">{STOP_TEXT[view.stop]}</StatusLine>}
          {view.step === 'done' && view.summary !== null && (
            <StatusLine tone="success">
              Kész. Feldolgozva: <Data>{formatCount(view.summary.processed)}</Data>, kihagyva:{' '}
              <Data>{formatCount(view.summary.skipped)}</Data>, hibás:{' '}
              <Data>{formatCount(view.summary.failed)}</Data>.
            </StatusLine>
          )}
        </div>
      </section>
    </Card>
  )
}
