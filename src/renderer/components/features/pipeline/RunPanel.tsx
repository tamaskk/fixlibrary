import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { ProgressBar } from '@/components/ui/progress-bar'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount, formatElapsed, formatRemaining } from '@/lib/format'
import { stageLabel } from '@/lib/stage-labels'
import type { JobCounts, RunProgress } from '@shared/pipeline'

type RunPanelProps = {
  progress: RunProgress
  /** When this report arrived, by the clock of the page. */
  receivedAt: number
  /** True when the last pause, resume or cancel could not be passed on. */
  actionFailed: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

const PHASE_LABELS: Record<RunProgress['phase'], string> = {
  compute: 'Elemzés',
  apply: 'Alkalmazás'
}

function finishedOf(counts: JobCounts): number {
  return counts.done + counts.failed + counts.skipped
}

/** The current time, read again every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

export function RunPanel({
  progress,
  receivedAt,
  actionFailed,
  onPause,
  onResume,
  onCancel
}: RunPanelProps): React.JSX.Element {
  const [confirming, setConfirming] = React.useState(false)
  const paused = progress.state === 'paused'
  const now = useNow(!paused)
  const { counts } = progress
  const finished = finishedOf(counts)
  const percent = counts.total === 0 ? 0 : Math.floor((finished / counts.total) * 100)
  const heading = `${PHASE_LABELS[progress.phase]} ${paused ? 'szünetel' : 'folyamatban'}`
  // The report says how long the run had worked when it was sent; while the run goes
  // on, the time since then is added here. A paused run stands still.
  const elapsedMs = progress.elapsedMs + (paused ? 0 : Math.max(0, now - receivedAt))
  const steps = progress.stages
    .map((stage) => `${stageLabel(stage.stage)} ${finishedOf(stage)} / ${stage.total}`)
    .join(', ')

  return (
    <section
      aria-label="Futás állapota"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="min-w-0 truncate text-h3">{heading}</h2>
        {/* Says it again when it changes: the run started, paused or went on. */}
        <p role="status" className="sr-only">
          {heading}
        </p>
        <div className="flex shrink-0 gap-2">
          {paused ? (
            <Button variant="secondary" onClick={onResume}>
              Folytatás
            </Button>
          ) : (
            <Button variant="secondary" onClick={onPause}>
              Szünet
            </Button>
          )}
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Megszakítás
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <ProgressBar percent={percent} label="Futás előrehaladása" />
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-small text-text-muted">
          <span className="font-mono text-data text-text tabular-nums">
            {formatCount(finished)} / {formatCount(counts.total)} · {percent}%
          </span>
          <span>
            Eltelt:{' '}
            <span className="font-mono text-data tabular-nums">{formatElapsed(elapsedMs)}</span>
          </span>
          <span>
            Hátravan:{' '}
            {paused
              ? 'szünetel'
              : progress.remainingMs === null
                ? 'még nem becsülhető'
                : formatRemaining(progress.remainingMs)}
          </span>
          {progress.tracks.failed > 0 && (
            <StatusLine tone="danger">
              Hibás track: {formatCount(progress.tracks.failed)}
            </StatusLine>
          )}
        </div>
        {/* One line, whatever there is to say: the panel must not grow and push the
            table and the run buttons out of a small window. */}
        <div className="h-5 min-w-0">
          {actionFailed ? (
            <StatusLine tone="danger">A művelet nem sikerült. Próbáld újra.</StatusLine>
          ) : progress.pauseReason === 'offline' ? (
            <StatusLine tone="warning" className="truncate">
              A könyvtár lemeze nincs csatlakoztatva. Csatlakoztasd, és folytasd a futást.
            </StatusLine>
          ) : progress.claudeRetryAt !== null ? (
            <StatusLine tone="warning" className="truncate">
              Claude usage limit elérve. Az app 15 percenként újrapróbálja; a többi lépés megy
              tovább.
            </StatusLine>
          ) : (
            <p
              aria-label={`Lépések: ${steps}`}
              title={steps}
              className="truncate text-small text-text-muted"
            >
              {progress.stages.map((stage, index) => (
                <span key={stage.stage}>
                  {index > 0 && <span aria-hidden="true"> · </span>}
                  {stageLabel(stage.stage)}{' '}
                  <span className="font-mono text-data tabular-nums">
                    {formatCount(finishedOf(stage))} / {formatCount(stage.total)}
                  </span>
                </span>
              ))}
            </p>
          )}
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title="Megszakítod a futást?"
          description="A futás azonnal leáll, és amit eddig kiszámolt, elvész. A fájljaid nem változnak."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégsem</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false)
                onCancel()
              }}
            >
              Megszakítás
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
