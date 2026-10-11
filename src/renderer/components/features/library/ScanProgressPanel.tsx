import { ProgressBar } from '@/components/ui/progress-bar'
import { formatCount } from '@/lib/format'
import type { ScanProgress } from '@shared/library'

type ScanProgressPanelProps = {
  /** Null until the scan has reported for the first time. */
  progress: ScanProgress | null
}

// Finding the files has no known end, so that phase shows a rising count; reading
// the tags does, and shows a bar.
export function ScanProgressPanel({ progress }: ScanProgressPanelProps): React.JSX.Element {
  const reading = progress?.phase === 'reading' && progress.total > 0 ? progress : null
  const percent = reading ? Math.floor((reading.done / reading.total) * 100) : 0

  return (
    <section
      aria-label="Beolvasás állapota"
      className="flex max-w-form flex-col gap-2 rounded-lg border border-border bg-surface p-6"
    >
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-body">{reading ? 'Tagek olvasása' : 'Fájlok keresése'}</p>
        <p className="font-mono text-data text-text-muted tabular-nums">
          {reading
            ? `${formatCount(reading.done)} / ${formatCount(reading.total)} · ${percent}%`
            : `${formatCount(progress?.phase === 'walking' ? progress.found : 0)} fájl`}
        </p>
      </div>
      {reading && <ProgressBar percent={percent} label="Tagek olvasása" />}
    </section>
  )
}
