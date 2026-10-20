import * as React from 'react'
import { Button } from '@/components/ui/button'
import type { ToolCheck, ToolCheckFailure } from '@shared/tools'
import { ClaudeStatus } from './ClaudeStatus'
import { SettingsSection } from './SettingsSection'
import { UpdateStatus } from './UpdateStatus'
import { StatusLine } from '@/components/ui/status-line'

const FAILURES: Record<ToolCheckFailure, string> = {
  missing: 'Hiányzik',
  timeout: 'Nem válaszolt',
  failed: 'Nem indul el',
  unrecognized: 'Ismeretlen választ adott'
}

type ToolsState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; checks: ToolCheck[] }

export function SystemSection(): React.JSX.Element {
  const [tools, setTools] = React.useState<ToolsState>({ status: 'loading' })
  const [logFolderFailed, setLogFolderFailed] = React.useState(false)

  async function runCheck(force: boolean): Promise<void> {
    try {
      setTools({ status: 'ready', checks: await window.api.system.checkTools(force) })
    } catch {
      setTools({ status: 'error' })
    }
  }

  function recheck(): void {
    setTools({ status: 'loading' })
    void runCheck(true)
  }

  // The section starts in the loading state, so the first check only has to fill it in.
  React.useEffect(() => {
    let cancelled = false
    window.api.system
      .checkTools(false)
      .then((checks) => !cancelled && setTools({ status: 'ready', checks }))
      .catch(() => !cancelled && setTools({ status: 'error' }))
    return () => {
      cancelled = true
    }
  }, [])

  async function openLogFolder(): Promise<void> {
    try {
      await window.api.system.openLogFolder()
      setLogFolderFailed(false)
    } catch {
      setLogFolderFailed(true)
    }
  }

  return (
    <SettingsSection title="Rendszer" description="Az app ezekkel a külső eszközökkel dolgozik.">
      <div aria-live="polite" className="flex flex-col gap-2">
        {tools.status === 'loading' && (
          <p className="text-small text-text-muted">Eszközök ellenőrzése…</p>
        )}
        {tools.status === 'error' && (
          <StatusLine tone="danger">Az eszközök nem ellenőrizhetők.</StatusLine>
        )}
        {tools.status === 'ready' && (
          <ul aria-label="Külső eszközök" className="flex flex-col gap-2">
            {tools.checks.map((tool) => (
              <li key={tool.name} className="flex min-h-8 items-center gap-3">
                <span className="w-24 font-mono text-data">{tool.name}</span>
                {tool.ok ? (
                  <StatusLine tone="success">
                    Rendben, verzió{' '}
                    <span className="font-mono text-data tabular-nums">{tool.version}</span>
                  </StatusLine>
                ) : (
                  <StatusLine tone="danger">{FAILURES[tool.reason]}</StatusLine>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button loading={tools.status === 'loading'} onClick={recheck}>
          Újraellenőrzés
        </Button>
        <Button onClick={openLogFolder}>Logmappa megnyitása</Button>
      </div>
      <div role="status">
        {logFolderFailed && <StatusLine tone="danger">A logmappa nem nyitható meg.</StatusLine>}
      </div>
      <UpdateStatus />
      <ClaudeStatus />
    </SettingsSection>
  )
}
