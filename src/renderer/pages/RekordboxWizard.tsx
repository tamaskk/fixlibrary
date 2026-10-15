import * as React from 'react'
import { WizardCheckResult } from '@/components/features/rekordbox/WizardCheckResult'
import { WizardStepList } from '@/components/features/rekordbox/WizardStepList'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusLine } from '@/components/ui/status-line'
import { errorMessage } from '@/lib/messages'
import { WIZARD_STEP_TEXTS } from '@/pages/rekordbox-wizard-steps'
import type { ErrorCode } from '@shared/errors'
import type {
  CopyablePath,
  WizardAction,
  WizardCheckResult as CheckResult,
  WizardStep,
  WizardView
} from '@shared/rekordbox-wizard'

type Loaded = { status: 'loading' } | { status: 'error' } | { status: 'ready'; view: WizardView }

/** What the last action said: a failure, or a confirmation of what it did. */
type Said = { tone: 'danger' | 'success'; text: string } | null

/** Why something the wizard did failed, by what it was doing. */
function describeError(code: ErrorCode, doing: 'step' | 'write' | 'check'): string {
  switch (code) {
    case 'XML_NOT_FOUND':
      return doing === 'check'
        ? 'Nem találok Rekordbox exportot. Exportáld a collectiont az export mappájába, és próbáld újra.'
        : 'Az XML ebben a lépésben még nem készült el. Írd meg, mielőtt továbblépsz.'
    case 'XML_BUSY':
      return 'Várj egy pillanatot, és próbáld újra.'
    case 'RUN_ACTIVE':
      return 'Most nem lehet: egy batch fájlokat változtat, vagy a könyvtár beolvasása tart.'
    case 'INVALID_INPUT':
      return 'A varázsló közben máshol tart. Töltsd be újra az oldalt.'
    default:
      return errorMessage(code)
  }
}

/** A path the user is to give Rekordbox, spelled out whole. */
function PathLine({ path }: { path: string }): React.JSX.Element {
  return <p className="font-mono text-data break-all text-text">{path}</p>
}

/** The Rekordbox wizard (T-027): the steps that get the library into Rekordbox, in order. */
export function RekordboxWizard(): React.JSX.Element {
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' })
  const [busy, setBusy] = React.useState<'action' | 'write' | 'check' | 'copy' | null>(null)
  const [said, setSaid] = React.useState<Said>(null)
  const [checked, setChecked] = React.useState<CheckResult | null>(null)

  // Asked once on opening, and again on "Próbáld újra"; an answer that comes after the
  // page was left is dropped.
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    window.api.rekordbox
      .wizardView()
      .then((view) => !cancelled && setLoaded({ status: 'ready', view }))
      .catch(() => !cancelled && setLoaded({ status: 'error' }))
    return () => {
      cancelled = true
    }
  }, [attempt])

  function retry(): void {
    setLoaded({ status: 'loading' })
    setAttempt((count) => count + 1)
  }

  async function act(action: WizardAction): Promise<void> {
    setBusy('action')
    setSaid(null)
    try {
      const result = await window.api.rekordbox.wizardAction(action)
      if (!result.ok) {
        setSaid({ tone: 'danger', text: describeError(result.code, 'step') })
        return
      }
      setLoaded((current) =>
        current.status === 'ready'
          ? { status: 'ready', view: { ...current.view, state: result.value, xmlWritten: false } }
          : current
      )
      setChecked(null)
    } catch {
      setSaid({ tone: 'danger', text: errorMessage('UNEXPECTED') })
    } finally {
      setBusy(null)
    }
  }

  async function writeXml(): Promise<void> {
    setBusy('write')
    setSaid(null)
    try {
      const result = await window.api.rekordbox.writeXml()
      if (!result.ok) {
        setSaid({ tone: 'danger', text: describeError(result.code, 'write') })
        return
      }
      // Whether the step counts as done is the main process's to say: asked again.
      const view = await window.api.rekordbox.wizardView()
      setLoaded({ status: 'ready', view })
      setSaid({ tone: 'success', text: 'Az XML elkészült.' })
    } catch {
      setSaid({ tone: 'danger', text: errorMessage('UNEXPECTED') })
    } finally {
      setBusy(null)
    }
  }

  async function copyPath(which: CopyablePath): Promise<void> {
    setBusy('copy')
    setSaid(null)
    try {
      const copied = await window.api.rekordbox.copyPath(which)
      setSaid(
        copied
          ? { tone: 'success', text: 'Az útvonal a vágólapon van.' }
          : { tone: 'danger', text: describeError('XML_BUSY', 'step') }
      )
    } catch {
      setSaid({ tone: 'danger', text: 'Az útvonal nem másolható.' })
    } finally {
      setBusy(null)
    }
  }

  async function checkExport(): Promise<void> {
    setBusy('check')
    setSaid(null)
    setChecked(null)
    try {
      const result = await window.api.rekordbox.wizardCheck()
      if (!result.ok) {
        setSaid({ tone: 'danger', text: describeError(result.code, 'check') })
        return
      }
      setChecked(result.value)
      setLoaded((current) =>
        current.status === 'ready'
          ? { status: 'ready', view: { ...current.view, state: result.value.state } }
          : current
      )
    } catch {
      setSaid({ tone: 'danger', text: errorMessage('UNEXPECTED') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="h-full overflow-y-auto p-6">
      <div className="flex flex-col gap-6">
        <h1 className="text-h1">Rekordbox</h1>
        {/* In the page from the start and filled after, so that it is announced. */}
        <p role="status" className="text-body text-text-muted empty:hidden">
          {loaded.status === 'loading' ? 'A varázsló betöltése…' : ''}
        </p>
        {loaded.status === 'error' && (
          <div role="alert">
            <EmptyState
              message="A varázsló nem tölthető be."
              action={
                <Button variant="primary" onClick={retry}>
                  Próbáld újra
                </Button>
              }
            />
          </div>
        )}
        {loaded.status === 'ready' && (
          <div className="flex gap-6">
            <WizardStepList
              state={loaded.view.state}
              phaseBLocked={loaded.view.phaseBLocked}
              disabled={busy !== null}
              onGoTo={(step) => void act({ type: 'goTo', step })}
            />
            <div className="flex max-w-form min-w-0 flex-1 flex-col gap-4">
              {loaded.view.state.step === 'doneA' ? (
                <Card className="flex flex-col gap-4">
                  <h2 className="text-h2">Az A fázis kész</h2>
                  <p className="text-body text-text-muted">
                    Minden track bent van a Rekordbox collectionben az új útvonalon, nincs missing
                    bejegyzés, és minden track elemezve van.
                  </p>
                  {loaded.view.phaseBLocked && (
                    <StatusLine tone="neutral">
                      A hot cue-k (B fázis) a cue-k felismerésével jönnek.
                    </StatusLine>
                  )}
                  <div>
                    <Button disabled={busy !== null} onClick={() => void act({ type: 'restart' })}>
                      Az A fázis újrakezdése
                    </Button>
                  </div>
                </Card>
              ) : (
                <StepCard
                  step={loaded.view.state.step}
                  view={loaded.view}
                  busy={busy}
                  checked={checked}
                  onComplete={(step) => void act({ type: 'complete', step })}
                  onRepeat={(step) => void act({ type: 'goTo', step })}
                  onWrite={() => void writeXml()}
                  onCopy={(which) => void copyPath(which)}
                  onCheck={() => void checkExport()}
                />
              )}
              <div role="status">
                {said !== null && <StatusLine tone={said.tone}>{said.text}</StatusLine>}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

type StepCardProps = {
  step: WizardStep
  view: WizardView
  busy: 'action' | 'write' | 'check' | 'copy' | null
  checked: CheckResult | null
  onComplete: (step: WizardStep) => void
  onRepeat: (step: WizardStep) => void
  onWrite: () => void
  onCopy: (which: CopyablePath) => void
  onCheck: () => void
}

/** The step the user is at: what to do, what the app does for it, and "Kész". */
function StepCard({
  step,
  view,
  busy,
  checked,
  onComplete,
  onRepeat,
  onWrite,
  onCopy,
  onCheck
}: StepCardProps): React.JSX.Element {
  const text = WIZARD_STEP_TEXTS[step]
  // The XML must be written in this step before it counts as done; the check moves on by itself.
  const canComplete = step === 'a.writeXml' ? view.xmlWritten : step !== 'a.check'
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-h2">{text.title}</h2>
      <ol className="flex list-decimal flex-col gap-1 pl-6 text-body">
        {text.instructions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      {step === 'setup.importedLibrary' && (
        <div className="flex flex-col gap-2">
          <PathLine path={view.xmlPath} />
          <div>
            <Button
              loading={busy === 'copy'}
              disabled={busy !== null}
              onClick={() => onCopy('xml')}
            >
              Útvonal másolása
            </Button>
          </div>
        </div>
      )}
      {step === 'a.export' && (
        <div className="flex flex-col gap-2">
          <PathLine path={view.exportFolder} />
          <div>
            <Button
              loading={busy === 'copy'}
              disabled={busy !== null}
              onClick={() => onCopy('exportFolder')}
            >
              Útvonal másolása
            </Button>
          </div>
        </div>
      )}
      {step === 'a.writeXml' && (
        <div>
          <Button loading={busy === 'write'} disabled={busy !== null} onClick={onWrite}>
            XML írása
          </Button>
        </div>
      )}
      {step === 'a.check' && (
        <div>
          <Button loading={busy === 'check'} disabled={busy !== null} onClick={onCheck}>
            Export ellenőrzése
          </Button>
        </div>
      )}
      {text.note !== null && <p className="text-small text-text-muted">{text.note}</p>}
      {step === 'a.check' && checked !== null && (
        <WizardCheckResult result={checked} onRepeat={onRepeat} disabled={busy !== null} />
      )}
      {step !== 'a.check' && (
        <div className="flex items-center gap-4">
          <Button
            variant="primary"
            loading={busy === 'action'}
            disabled={!canComplete || busy !== null}
            onClick={() => onComplete(step)}
          >
            Kész
          </Button>
          {/* A disabled button shows no tooltip: why it is disabled is said next to it. */}
          {!canComplete && <p className="text-small text-text-muted">Előbb írd meg az XML-t.</p>}
        </div>
      )}
    </Card>
  )
}
