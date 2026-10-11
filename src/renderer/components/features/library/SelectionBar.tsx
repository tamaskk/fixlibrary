import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import type { RunOutcome } from '@/stores/library-store'

type SelectionBarProps = {
  selectedCount: number
  requesting: boolean
  outcome: RunOutcome
  onRun: (scope: 'selection' | 'library') => void
}

function describeTargets(count: number, skipped: number): string {
  const left =
    skipped > 0 ? ` ${formatCount(skipped)} kimarad, mert offline vagy nincs meg a fájlja.` : ''
  return `A futtatás még nem érhető el. ${formatCount(count)} track kerülne feldolgozásra.${left}`
}

export function SelectionBar({
  selectedCount,
  requesting,
  outcome,
  onRun
}: SelectionBarProps): React.JSX.Element {
  return (
    <section aria-label="Futtatás">
      <div className="flex items-center gap-4">
        <p role="status" className="mr-auto text-small">
          {selectedCount === 0 ? (
            <span className="text-text-muted">Nincs kijelölt track</span>
          ) : (
            <>
              <span className="font-mono text-data tabular-nums">{formatCount(selectedCount)}</span>{' '}
              track kijelölve
            </>
          )}
        </p>
        <Button variant="secondary" disabled={requesting} onClick={() => onRun('library')}>
          Futtatás a teljes könyvtáron
        </Button>
        <Button
          variant="primary"
          disabled={selectedCount === 0}
          loading={requesting}
          onClick={() => onRun('selection')}
        >
          Futtatás a kijelölteken
        </Button>
      </div>
      {/* In the page before there is an answer, so the answer is announced. */}
      <div role="status">
        {outcome !== null &&
          (outcome.ok ? (
            <StatusLine tone="neutral" className="mt-2">
              {describeTargets(outcome.targets.trackIds.length, outcome.targets.skipped)}
            </StatusLine>
          ) : (
            <StatusLine tone="danger" className="mt-2">
              {errorMessage(outcome.code)}
            </StatusLine>
          ))}
      </div>
    </section>
  )
}
