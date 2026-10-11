import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { formatDecimal, parseDecimal } from '@/lib/format'
import { commitOnEnter } from '@/lib/keyboard'
import { useActionFeedback } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import {
  LOUDNESS_PRESETS_LUFS,
  type NormalizationMethod,
  type SettingsSnapshot
} from '@shared/settings'
import { SettingsSection } from './SettingsSection'

const CUSTOM = 'custom'
const CUSTOM_ERROR = 'Adj meg egy számot −23 és −5 között.'

function isPreset(targetLufs: number): boolean {
  return (LOUDNESS_PRESETS_LUFS as readonly number[]).includes(targetLufs)
}

export function LoudnessSection({ snapshot }: { snapshot: SettingsSnapshot }): React.JSX.Element {
  const update = useSettingsStore((state) => state.update)
  const { feedback, run, clear } = useActionFeedback()
  const { targetLufs, method } = snapshot.settings.loudness
  // "Egyedi érték" stays selected while the user is still typing a value.
  const [customChosen, setCustomChosen] = React.useState(!isPreset(targetLufs))
  const [customText, setCustomText] = React.useState(formatDecimal(targetLufs))
  const [customError, setCustomError] = React.useState<string | null>(null)

  async function chooseTarget(choice: string): Promise<void> {
    setCustomError(null)
    if (choice === CUSTOM) {
      // The field starts from the value in use, not from an older custom entry.
      setCustomText(formatDecimal(targetLufs))
      setCustomChosen(true)
      clear()
      return
    }
    // The custom field goes away only once the preset is really saved.
    if (await run(() => update({ loudness: { targetLufs: Number(choice) } }))) {
      setCustomChosen(false)
    }
  }

  function saveCustom(): void {
    // Leaving the field without typing changes nothing.
    if (customText === formatDecimal(targetLufs)) return
    const value = parseDecimal(customText)
    if (value === null || value < -23 || value > -5) {
      setCustomError(CUSTOM_ERROR)
      return
    }
    setCustomError(null)
    if (value !== targetLufs) void run(() => update({ loudness: { targetLufs: value } }))
  }

  return (
    <SettingsSection title="Hangosság" feedback={feedback}>
      <Select
        label="Célszint"
        value={customChosen ? CUSTOM : String(targetLufs)}
        onChange={(event) => chooseTarget(event.target.value)}
      >
        <option value="-11">−11,0 LUFS (alapérték)</option>
        <option value="-8">−8,0 LUFS (hangosabb)</option>
        <option value={CUSTOM}>Egyedi érték</option>
      </Select>
      {customChosen && (
        <Input
          label="Egyedi célszint (LUFS)"
          inputMode="decimal"
          className="font-mono text-data tabular-nums"
          value={customText}
          error={customError ?? undefined}
          onChange={(event) => setCustomText(event.target.value)}
          onBlur={saveCustom}
          onKeyDown={commitOnEnter}
        />
      )}
      <Select
        label="Módszer"
        value={method}
        onChange={(event) =>
          run(() => update({ loudness: { method: event.target.value as NormalizationMethod } }))
        }
      >
        <option value="lossless">Veszteségmentes, 1,5 dB-es lépésekben (alapérték)</option>
        <option value="exact">Pontos, újrakódolással</option>
      </Select>
    </SettingsSection>
  )
}
