import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount, formatDateTime, formatDecimal } from '@/lib/format'
import { WIZARD_STEP_TEXTS } from '@/pages/rekordbox-wizard-steps'
import { HOT_CUE_LETTERS } from '@shared/settings'
import type { WizardCueCheckResult, WizardStep } from '@shared/rekordbox-wizard'
import { HOLD_TEXTS } from './check-texts'
import { Entries } from './WizardCheckResult'

type WizardCueResultProps = {
  result: WizardCueCheckResult
  onRepeat: (step: WizardStep) => void
  disabled: boolean
}

const seconds = (ms: number): string => `${formatDecimal(Math.round(ms) / 1000)} s`

/** What the check of phase B found: hot cues out of place, grids Rekordbox moved. */
export function WizardCueResult({
  result,
  onRepeat,
  disabled
}: WizardCueResultProps): React.JSX.Element {
  const { check, verdict } = result
  const mismatches = verdict.mismatches
  return (
    <div className="flex flex-col gap-4">
      <StatusLine tone={verdict.clean ? 'success' : 'neutral'} className="break-all">
        {`Beolvasva: ${check.fileName} (${formatDateTime(check.exportedAt)}), ${formatCount(
          check.tracks
        )} track.`}
      </StatusLine>
      {verdict.clean && (
        <StatusLine tone="success">
          Minden hot cue a helyén van, és a Rekordbox gridje nem változott.
        </StatusLine>
      )}
      {verdict.noCues && (
        <StatusLine tone="warning">
          Még nincs elhelyezett hot cue. Futtasd a Hot cue-k felismerése lépést, és hagyd jóvá.
        </StatusLine>
      )}
      {mismatches.count > 0 && (
        <div className="flex flex-col gap-2">
          <StatusLine tone="warning">
            {`${formatCount(mismatches.count)} hot cue nincs a helyén (±10 ms).`}
          </StatusLine>
          <ul className="flex flex-col gap-1 pl-6">
            {mismatches.items.map((mismatch, index) => (
              <li
                key={`${index}:${mismatch.trackId}:${mismatch.slot}`}
                className="font-mono text-data break-all text-text-muted"
              >
                {`${mismatch.path} · ${HOT_CUE_LETTERS[mismatch.slot - 1] ?? mismatch.slot}: ${seconds(
                  mismatch.expectedMs
                )} helyett ${mismatch.foundMs === null ? 'nincs' : seconds(mismatch.foundMs)}`}
              </li>
            ))}
            {mismatches.count > mismatches.items.length && (
              <li className="text-small text-text-muted">
                {`és még ${formatCount(mismatches.count - mismatches.items.length)}`}
              </li>
            )}
          </ul>
          <div className="pl-6">
            <Button disabled={disabled} onClick={() => onRepeat('b.import')}>
              {`Vissza: ${WIZARD_STEP_TEXTS['b.import'].title}`}
            </Button>
          </div>
        </div>
      )}
      {verdict.gridChanged.count > 0 && (
        <div className="flex flex-col gap-2">
          <StatusLine tone="warning">
            {`${formatCount(verdict.gridChanged.count)} track gridje megváltozott a Rekordboxban.`}
          </StatusLine>
          <Entries list={verdict.gridChanged} />
        </div>
      )}
      {verdict.holds.map((hold) => (
        <StatusLine key={hold} tone="warning">
          {HOLD_TEXTS[hold](hold === 'skipped' ? check.skipped : 0)}
        </StatusLine>
      ))}
    </div>
  )
}
