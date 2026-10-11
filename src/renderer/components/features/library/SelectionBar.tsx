import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { stageLabel } from '@/lib/stage-labels'
import type { RunOutcome } from '@/stores/library-store'
import type { FunctionChoice } from '@/stores/pipeline-store'
import type { ErrorCode } from '@shared/errors'

type SelectionBarProps = {
  selectedCount: number
  /** The functions that can be run; empty while the app has none. */
  functions: readonly string[]
  choice: FunctionChoice
  onChoose: (choice: FunctionChoice) => void
  /** True while a run is active: a second one cannot start. */
  runActive: boolean
  requesting: boolean
  outcome: RunOutcome
  onRun: (scope: 'selection' | 'library') => void
}

function describeStart(count: number, skipped: number): string {
  const left =
    skipped > 0 ? ` ${formatCount(skipped)} kimaradt, mert offline vagy nincs meg a fájlja.` : ''
  return `A futás elindult ${formatCount(count)} tracken.${left}`
}

function describeFailure(code: ErrorCode): string {
  if (code === 'RUN_ACTIVE') return 'Már fut egy futás. Várd meg a végét, vagy szakítsd meg.'
  if (code === 'INVALID_INPUT') return 'Nincs futtatható track: offline, vagy nincs meg a fájljuk.'
  return errorMessage(code)
}

export function SelectionBar({
  selectedCount,
  functions,
  choice,
  onChoose,
  runActive,
  requesting,
  outcome,
  onRun
}: SelectionBarProps): React.JSX.Element {
  const nothingToRun = functions.length === 0
  const blocked = nothingToRun || runActive

  return (
    <section aria-label="Futtatás">
      <div className="flex items-end gap-4">
        <p role="status" className="mr-auto flex h-8 items-center text-small">
          {selectedCount === 0 ? (
            <span className="text-text-muted">Nincs kijelölt track</span>
          ) : (
            <span>
              <span className="font-mono text-data tabular-nums">{formatCount(selectedCount)}</span>{' '}
              track kijelölve
            </span>
          )}
        </p>
        <div className="w-48 shrink-0">
          <Select
            label="Funkció"
            value={nothingToRun ? '' : choice}
            disabled={blocked}
            onChange={(event) => onChoose(event.target.value)}
          >
            {nothingToRun ? (
              <option value="">Nincs futtatható funkció</option>
            ) : (
              <>
                <option value="all">Minden funkció</option>
                {functions.map((name) => (
                  <option key={name} value={name}>
                    {stageLabel(name)}
                  </option>
                ))}
              </>
            )}
          </Select>
        </div>
        <Button
          variant="secondary"
          disabled={blocked || requesting}
          onClick={() => onRun('library')}
        >
          Futtatás a teljes könyvtáron
        </Button>
        <Button
          variant="primary"
          disabled={blocked || selectedCount === 0}
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
              {describeStart(outcome.started.trackIds.length, outcome.started.skipped)}
            </StatusLine>
          ) : (
            <StatusLine tone="danger" className="mt-2">
              {describeFailure(outcome.code)}
            </StatusLine>
          ))}
      </div>
    </section>
  )
}
