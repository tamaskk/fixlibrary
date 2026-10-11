import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import type { RunProgress } from '@shared/pipeline'

type RunResultProps = {
  /** The last report of the run that ended last, or null. The region stays in place. */
  finished: RunProgress | null
}

// The region is always in the page, so what appears in it is announced.
export function RunResult({ finished }: RunResultProps): React.JSX.Element {
  return (
    <div role="status">
      {finished !== null && (
        <div className="mb-2 flex flex-col gap-1">
          {finished.outcome === 'cancelled' ? (
            <StatusLine tone="neutral">A futás megszakítva. A fájljaid nem változtak.</StatusLine>
          ) : (
            <StatusLine tone="success">
              A futás kész: {formatCount(finished.counts.done)} lépés lefutott
              {finished.counts.skipped > 0 && `, ${formatCount(finished.counts.skipped)} kimaradt`}.
            </StatusLine>
          )}
          {finished.counts.failed > 0 && (
            <StatusLine tone="danger">
              Hibák: {formatCount(finished.counts.failed)}. Az érintett trackek kimaradtak.
            </StatusLine>
          )}
        </div>
      )}
    </div>
  )
}
