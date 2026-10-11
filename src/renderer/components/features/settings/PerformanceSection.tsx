import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { commitOnEnter } from '@/lib/keyboard'
import { useActionFeedback } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import type { SettingsSnapshot } from '@shared/settings'
import { SettingsSection } from './SettingsSection'

const COUNT_ERROR = 'Adj meg egy egész számot 1 és 64 között.'

export function PerformanceSection({
  snapshot
}: {
  snapshot: SettingsSnapshot
}): React.JSX.Element {
  const update = useSettingsStore((state) => state.update)
  const { feedback, run } = useActionFeedback()
  const { workerCount } = snapshot.settings.performance
  const effective = snapshot.effective.workerCount
  const [countText, setCountText] = React.useState(String(workerCount ?? effective))
  const [countError, setCountError] = React.useState<string | null>(null)

  function setAutomatic(automatic: boolean): void {
    setCountError(null)
    setCountText(String(effective))
    void run(() => update({ performance: { workerCount: automatic ? null : effective } }))
  }

  function saveTypedCount(): void {
    const value = Number(countText.trim())
    if (!/^\d+$/.test(countText.trim()) || value < 1 || value > 64) {
      setCountError(COUNT_ERROR)
      return
    }
    setCountError(null)
    if (value !== workerCount) void run(() => update({ performance: { workerCount: value } }))
  }

  return (
    <SettingsSection title="Teljesítmény" feedback={feedback}>
      <Switch
        label="Automatikus szálszám"
        description="Bekapcsolva a processzormagok száma mínusz egy, hogy a gép közben használható maradjon. Kikapcsolva te adod meg."
        checked={workerCount === null}
        onCheckedChange={setAutomatic}
      />
      <Input
        label="Párhuzamos szálak száma"
        inputMode="numeric"
        className="max-w-32 font-mono text-data tabular-nums"
        disabled={workerCount === null}
        value={workerCount === null ? String(effective) : countText}
        error={countError ?? undefined}
        onChange={(event) => setCountText(event.target.value)}
        onBlur={saveTypedCount}
        onKeyDown={commitOnEnter}
      />
      {workerCount !== null && workerCount > effective && (
        <p className="text-small text-text-muted">
          Ezen a gépen legfeljebb{' '}
          <span className="font-mono text-data tabular-nums">{effective}</span> szál használható.
        </p>
      )}
    </SettingsSection>
  )
}
