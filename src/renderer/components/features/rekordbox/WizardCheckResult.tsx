import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount, formatDateTime } from '@/lib/format'
import { WIZARD_STEP_TEXTS } from '@/pages/rekordbox-wizard-steps'
import type { CheckedList, CheckedTrack } from '@shared/rekordbox'
import { HOLD_TEXTS } from './check-texts'
import type { CheckHold, WizardCheckResult as Result, WizardStep } from '@shared/rekordbox-wizard'

/** The first entries of a list the check found, with how many more there are. */
export function Entries({ list }: { list: CheckedList<CheckedTrack | string> }): React.JSX.Element {
  const more = list.count - list.items.length
  return (
    <ul className="flex flex-col gap-1 pl-6">
      {list.items.map((item, index) => {
        const path = typeof item === 'string' ? item : item.path
        return (
          <li key={`${index}:${path}`} className="font-mono text-data break-all text-text-muted">
            {path}
          </li>
        )
      })}
      {more > 0 && <li className="text-small text-text-muted">{`és még ${formatCount(more)}`}</li>}
    </ul>
  )
}

type WizardCheckResultProps = {
  result: Result
  onRepeat: (step: WizardStep) => void
  disabled: boolean
}

/** What the check of phase A found, and which steps to do again. */
export function WizardCheckResult({
  result,
  onRepeat,
  disabled
}: WizardCheckResultProps): React.JSX.Element {
  const { check, verdict } = result
  const problems: { step: WizardStep; text: string; list: CheckedList<CheckedTrack | string> }[] = [
    {
      step: 'a.importTracks' as const,
      text: `${formatCount(check.notInExport.count)} track a könyvtárból hiányzik az exportból.`,
      list: check.notInExport
    },
    {
      step: 'a.waitAnalysis' as const,
      text: `${formatCount(check.unanalysed.count)} track nincs elemezve a Rekordboxban.`,
      list: check.unanalysed
    },
    {
      step: 'a.removeMissing' as const,
      text: `${formatCount(check.missingFiles.count)} bejegyzés nem létező fájlra mutat (missing).`,
      list: check.missingFiles
    }
  ].filter(({ list }) => list.count > 0)
  const holdCounts: Readonly<Record<CheckHold, number>> = {
    stale: 0,
    unavailable: check.unavailable,
    unchecked: check.unchecked,
    skipped: check.skipped
  }

  return (
    <div className="flex flex-col gap-4">
      <StatusLine tone={verdict.clean ? 'success' : 'neutral'} className="break-all">
        {`Beolvasva: ${check.fileName} (${formatDateTime(check.exportedAt)}), ${formatCount(
          check.tracks
        )} track, ebből ${formatCount(check.matched)} a könyvtárból.`}
      </StatusLine>
      {verdict.clean && (
        <StatusLine tone="success">
          Minden track benne van, nincs missing bejegyzés, és mind elemezve van.
        </StatusLine>
      )}
      {problems.map(({ step, text, list }) => (
        <div key={step} className="flex flex-col gap-2">
          <StatusLine tone="warning">{text}</StatusLine>
          <Entries list={list} />
          <div className="pl-6">
            <Button disabled={disabled} onClick={() => onRepeat(step)}>
              {`Vissza: ${WIZARD_STEP_TEXTS[step].title}`}
            </Button>
          </div>
        </div>
      ))}
      {verdict.holds.map((hold) => (
        <StatusLine key={hold} tone="warning">
          {HOLD_TEXTS[hold](holdCounts[hold])}
        </StatusLine>
      ))}
    </div>
  )
}
