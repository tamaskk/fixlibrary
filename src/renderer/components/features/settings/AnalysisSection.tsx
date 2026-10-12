import * as React from 'react'
import { Input } from '@/components/ui/input'
import { commitOnEnter } from '@/lib/keyboard'
import { useActionFeedback } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import { BPM_MAX_LIMITS, BPM_MIN_LIMITS, type SettingsSnapshot } from '@shared/settings'
import { SettingsSection } from './SettingsSection'

const MIN_ERROR = `Adj meg egy egész számot ${BPM_MIN_LIMITS.min} és ${BPM_MIN_LIMITS.max} között.`
const MAX_ERROR = `Adj meg egy egész számot ${BPM_MAX_LIMITS.min} és ${BPM_MAX_LIMITS.max} között.`
const OCTAVE_ERROR = 'A legnagyobb érték legyen legalább a legkisebb kétszerese.'

function parseWhole(text: string, limits: { min: number; max: number }): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= limits.min && value <= limits.max ? value : null
}

export function AnalysisSection({ snapshot }: { snapshot: SettingsSnapshot }): React.JSX.Element {
  const update = useSettingsStore((state) => state.update)
  const { feedback, run } = useActionFeedback()
  const { bpmMin, bpmMax } = snapshot.settings.analysis
  const [minText, setMinText] = React.useState(String(bpmMin))
  const [maxText, setMaxText] = React.useState(String(bpmMax))
  const [minError, setMinError] = React.useState<string | null>(null)
  const [maxError, setMaxError] = React.useState<string | null>(null)

  // The two ends are saved together: one alone cannot be checked against the other.
  function saveRange(): void {
    const nextMin = parseWhole(minText, BPM_MIN_LIMITS)
    const nextMax = parseWhole(maxText, BPM_MAX_LIMITS)
    setMinError(nextMin === null ? MIN_ERROR : null)
    if (nextMin === null || nextMax === null) {
      setMaxError(nextMax === null ? MAX_ERROR : null)
      return
    }
    if (nextMax < 2 * nextMin) {
      setMaxError(OCTAVE_ERROR)
      return
    }
    setMaxError(null)
    if (nextMin === bpmMin && nextMax === bpmMax) return
    void run(() => update({ analysis: { bpmMin: nextMin, bpmMax: nextMax } }))
  }

  return (
    <SettingsSection
      title="Elemzés"
      description="A mért tempó ebbe a tartományba kerül: alatta duplázva, felette felezve."
      feedback={feedback}
    >
      <div className="flex flex-wrap gap-4">
        <Input
          label="Legkisebb BPM"
          inputMode="numeric"
          className="max-w-32 font-mono text-data tabular-nums"
          value={minText}
          error={minError ?? undefined}
          onChange={(event) => setMinText(event.target.value)}
          onBlur={saveRange}
          onKeyDown={commitOnEnter}
        />
        <Input
          label="Legnagyobb BPM"
          inputMode="numeric"
          className="max-w-32 font-mono text-data tabular-nums"
          value={maxText}
          error={maxError ?? undefined}
          onChange={(event) => setMaxText(event.target.value)}
          onBlur={saveRange}
          onKeyDown={commitOnEnter}
        />
      </div>
      <p className="text-small text-text-muted">
        Ha változtatsz rajta, a trackek a következő futtatáskor újra elemződnek.
      </p>
    </SettingsSection>
  )
}
