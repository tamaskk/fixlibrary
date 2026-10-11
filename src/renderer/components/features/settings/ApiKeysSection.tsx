import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useActionFeedback, type RunAction } from '@/lib/use-action-feedback'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  KeyService,
  KeyTestResult,
  SecretName,
  SecretSource,
  SecretStatus
} from '@shared/settings'
import { SettingsSection } from './SettingsSection'
import { StatusLine, type StatusTone } from '@/components/ui/status-line'

const KEYS: { name: SecretName; label: string }[] = [
  { name: 'acoustid', label: 'AcoustID API kulcs' },
  { name: 'discogsKey', label: 'Discogs consumer key' },
  { name: 'discogsSecret', label: 'Discogs consumer secret' }
]

const SOURCES: Record<SecretSource, { tone: StatusTone; text: string }> = {
  stored: { tone: 'success', text: 'Tárolva a Keychainben' },
  env: { tone: 'neutral', text: 'Forrás: .env.local fájl' },
  unreadable: { tone: 'warning', text: 'A tárolt kulcs nem olvasható. Add meg újra.' },
  missing: { tone: 'neutral', text: 'Nincs megadva' }
}

const TEST_RESULTS: Record<KeyTestResult, { tone: StatusTone; text: string }> = {
  valid: { tone: 'success', text: 'A kulcs érvényes' },
  invalid: { tone: 'danger', text: 'A kulcs érvénytelen' },
  missing: { tone: 'neutral', text: 'Előbb add meg és mentsd el a kulcsot' },
  unreachable: { tone: 'warning', text: 'A szolgáltatás nem érhető el, a kulcs nincs ellenőrizve' },
  throttled: { tone: 'neutral', text: 'Várj néhány másodpercet, aztán próbáld újra' }
}

function KeyField({
  name,
  label,
  source,
  run
}: {
  name: SecretName
  label: string
  source: SecretSource
  run: RunAction
}): React.JSX.Element {
  const saveSecret = useSettingsStore((state) => state.saveSecret)
  const clearSecret = useSettingsStore((state) => state.clearSecret)
  const input = React.useRef<HTMLInputElement>(null)
  const [value, setValue] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSaving(true)
    const saved = await run(() => saveSecret(name, value))
    setSaving(false)
    // The field is emptied after saving: a stored key is never shown again.
    if (saved) setValue('')
    // The save button is disabled again, so the focus goes back to the field.
    input.current?.focus()
  }

  async function remove(): Promise<void> {
    setConfirmingDelete(false)
    await run(() => clearSecret(name))
    // The delete button is gone now; the field is the nearest place to continue from.
    input.current?.focus()
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            ref={input}
            label={label}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={source === 'stored' ? 'Új kulcs a cseréhez' : 'Illeszd be a kulcsot'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          aria-label={`${label} mentése`}
          loading={saving}
          disabled={value.trim() === ''}
        >
          Mentés
        </Button>
        {/* Always in the layout, so the three fields stay the same width. */}
        <Button
          variant="ghost"
          className={source === 'stored' || source === 'unreadable' ? undefined : 'invisible'}
          disabled={source !== 'stored' && source !== 'unreadable'}
          aria-label={`${label} törlése`}
          onClick={() => setConfirmingDelete(true)}
        >
          Törlés
        </Button>
      </div>
      <StatusLine tone={SOURCES[source].tone}>{SOURCES[source].text}</StatusLine>
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent
          title="Törlöd a kulcsot?"
          description={`${label}: az app elfelejti a tárolt kulcsot. Ha újra szükséged lesz rá, a szolgáltatás oldaláról kell újra kimásolnod.`}
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégse</Button>
            </DialogClose>
            <Button variant="danger" onClick={remove}>
              Kulcs törlése
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}

function KeyTest({ service, label }: { service: KeyService; label: string }): React.JSX.Element {
  const [testing, setTesting] = React.useState(false)
  const [result, setResult] = React.useState<KeyTestResult | 'failed' | null>(null)

  async function test(): Promise<void> {
    setTesting(true)
    try {
      setResult(await window.api.secrets.test(service))
    } catch {
      setResult('failed')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex min-h-8 items-center gap-3">
      <Button loading={testing} onClick={test}>
        {label}
      </Button>
      <div role="status">
        {result === 'failed' && <StatusLine tone="danger">A teszt nem futott le.</StatusLine>}
        {result !== null && result !== 'failed' && (
          <StatusLine tone={TEST_RESULTS[result].tone}>{TEST_RESULTS[result].text}</StatusLine>
        )}
      </div>
    </div>
  )
}

export function ApiKeysSection({
  secretStatus
}: {
  secretStatus: SecretStatus
}): React.JSX.Element {
  // A test result belongs to the keys it was run with: when a key is saved or
  // deleted, the tests get a new identity and their old result goes away.
  const revision = useSettingsStore((state) => state.secretRevision)
  const { feedback, run } = useActionFeedback()

  return (
    <SettingsSection
      title="API kulcsok"
      description="Az app titkosítva tárolja a kulcsokat, a titkosítás kulcsa a macOS Keychainben van. Mentés után már nem mutatja meg őket."
      feedback={feedback}
    >
      {KEYS.map(({ name, label }) => (
        <KeyField key={name} name={name} label={label} source={secretStatus[name]} run={run} />
      ))}
      <div className="flex flex-col gap-2">
        <KeyTest
          key={`acoustid-${revision}`}
          service="acoustid"
          label="AcoustID kulcs tesztelése"
        />
        <KeyTest key={`discogs-${revision}`} service="discogs" label="Discogs kulcsok tesztelése" />
      </div>
    </SettingsSection>
  )
}
