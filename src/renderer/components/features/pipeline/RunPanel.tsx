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
  const phase = PHASE_LABELS[progress.phase]

  return (
    <section
      aria-label="Futás állapota"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-h3">{paused ? `${phase} szünetel` : `${phase} folyamatban`}</h2>
          {progress.pauseReason === 'offline' && (
            <StatusLine tone="warning">
              A könyvtár lemeze nincs csatlakoztatva. Csatlakoztasd, és folytasd a futást.
            </StatusLine>
          )}
        </div>
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
        <ProgressBar percent={percent} label={phase} />
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-small text-text-muted">
          <span className="font-mono text-data text-text tabular-nums">
            {formatCount(finished)} / {formatCount(counts.total)} · {percent}%
          </span>
          <span>
            Eltelt:{' '}
            <span className="font-mono text-data tabular-nums">
              {formatElapsed(now - progress.startedAt)}
            </span>
          </span>
          <span>
            Hátravan:{' '}
            {paused
              ? 'szünetel'
              : progress.remainingMs === null
                ? 'még nem becsülhető'
                : formatRemaining(progress.remainingMs)}
          </span>
          {counts.failed > 0 && (
            <StatusLine tone="danger">Hibák: {formatCount(counts.failed)}</StatusLine>
          )}
        </div>
        <ul aria-label="Lépések" className="flex flex-wrap gap-x-6 gap-y-1 text-text-muted">
          {progress.stages.map((stage) => (
            <li key={stage.stage} className="flex items-baseline gap-2 text-small">
              <span>{stageLabel(stage.stage)}</span>
              <span className="font-mono text-data tabular-nums">
                {formatCount(finishedOf(stage))} / {formatCount(stage.total)}
              </span>
            </li>
          ))}
        </ul>
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
