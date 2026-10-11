import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import type { RunProgress } from '@shared/pipeline'

type RunResultProps = {
  /** The last report of the run that ended last, or null. The region stays in place. */
  finished: RunProgress | null
}

// The region is always in the page, so what appears in it is announced.
export function RunResult({ finished }: RunResultProps): React.JSX.Element {
  const failed = finished?.tracks.failed ?? 0
  const processed = (finished?.tracks.total ?? 0) - failed

  return (
    <div role="status">
      {finished !== null && (
        <div className="mb-2 flex flex-col gap-1">
          {finished.outcome === 'cancelled' && finished.phase === 'apply' ? (
            // Files were being written: what was done stays done until it is undone.
            <StatusLine tone="warning">
              Az alkalmazás megszakítva. Ami addig elkészült, megmaradt; az Előnézet oldalon
              visszavonhatod.
            </StatusLine>
          ) : finished.outcome === 'cancelled' ? (
            <StatusLine tone="neutral">A futás megszakítva. A fájljaid nem változtak.</StatusLine>
          ) : finished.outcome === 'applied' ? (
            <>
              <StatusLine tone="success">
                A változások alkalmazva: {formatCount(processed)} track.
              </StatusLine>
              {failed > 0 && (
                <StatusLine tone="danger">
                  {formatCount(failed)} tracknél hiba történt. Ezek kimaradtak.
                </StatusLine>
              )}
            </>
          ) : (
            <>
              <StatusLine tone="success">
                A futás kész: {formatCount(processed)} track feldolgozva.
              </StatusLine>
              {failed > 0 && (
                <StatusLine tone="danger">
                  {formatCount(failed)} tracknél hiba történt. Ezek kimaradtak.
                </StatusLine>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
