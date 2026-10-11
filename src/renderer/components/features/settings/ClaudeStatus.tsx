import * as React from 'react'
import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount, formatDecimal } from '@/lib/format'
import type { ClaudeProblem, ClaudeStatus as Status, ClaudeTestResult } from '@shared/claude'

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; claude: Status }

// What is wrong, and what the user can do about it.
const PROBLEMS: Record<ClaudeProblem, { text: string; help: string | null }> = {
  missing: {
    text: 'Nem található',
    help: 'Telepítsd a Claude Code-ot (claude.com/claude-code), majd ellenőrizd újra. Ha telepítve van, válaszd ki kézzel a claude parancsot.'
  },
  notLoggedIn: {
    text: 'Nincs bejelentkezve',
    help: 'Jelentkezz be a Terminálban a „claude auth login” paranccsal, majd ellenőrizd újra.'
  },
  outdated: {
    text: 'Túl régi verzió',
    help: 'Frissítsd a Terminálban a „claude update” paranccsal, majd ellenőrizd újra.'
  },
  timeout: { text: 'Nem válaszolt', help: null },
  failed: { text: 'Nem indul el', help: null }
}

function describeTest(result: ClaudeTestResult): { tone: 'success' | 'danger'; text: string } {
  if (result.ok) {
    const seconds = formatDecimal(Math.round(result.durationMs / 100) / 10)
    return {
      tone: 'success',
      text: `A teszt sikerült: ${formatCount(result.asked)} trackből ${formatCount(result.answered)} kapott választ, ${seconds} mp alatt.`
    }
  }
  if (result.reason === 'limit') {
    return { tone: 'danger', text: 'Claude usage limit elérve. Próbáld újra később.' }
  }
  if (result.reason === 'tooSoon') {
    return { tone: 'danger', text: 'Az előbb volt egy teszt. Várj fél percet, és próbáld újra.' }
  }
  if (result.reason === 'noAnswer') {
    return { tone: 'danger', text: 'A Claude válaszolt, de a válasza nem volt használható.' }
  }
  return { tone: 'danger', text: `A teszt nem sikerült: ${PROBLEMS[result.reason].text}.` }
}

/**
 * Whether Claude can be used: the version and the login of the `claude` command, what
 * to do when something is missing, and a test call. Everything else in the app works
 * without it.
 */
export function ClaudeStatus(): React.JSX.Element {
  const [state, setState] = React.useState<State>({ status: 'loading' })
  const [busy, setBusy] = React.useState<'check' | 'pick' | 'test' | null>(null)
  const [test, setTest] = React.useState<ClaudeTestResult | null>(null)
  const [pickRefused, setPickRefused] = React.useState(false)

  // The block starts in the loading state, so the first check only has to fill it in.
  React.useEffect(() => {
    let cancelled = false
    window.api.system
      .claudeStatus(false)
      .then((claude) => !cancelled && setState({ status: 'ready', claude }))
      .catch(() => !cancelled && setState({ status: 'error' }))
    return () => {
      cancelled = true
    }
  }, [])

  async function act(
    kind: 'check' | 'pick',
    run: () => Promise<Status | null | 'refused'>
  ): Promise<void> {
    setBusy(kind)
    setTest(null)
    setPickRefused(false)
    try {
      const claude = await run()
      if (claude === 'refused') setPickRefused(true)
      else if (claude !== null) setState({ status: 'ready', claude })
    } catch {
      setState({ status: 'error' })
    } finally {
      setBusy(null)
    }
  }

  async function runTest(): Promise<void> {
    setBusy('test')
    setTest(null)
    try {
      setTest(await window.api.system.testClaude())
    } catch {
      setTest({ ok: false, reason: 'failed' })
    } finally {
      setBusy(null)
    }
  }

  const claude = state.status === 'ready' ? state.claude : null
  const tested = test === null ? null : describeTest(test)

  return (
    <section aria-label="Claude" className="flex flex-col gap-2">
      <div aria-live="polite" className="flex flex-col gap-1">
        <div className="flex min-h-8 items-center gap-3">
          <span className="w-24 font-mono text-data">claude</span>
          {state.status === 'loading' && (
            <p className="text-small text-text-muted">Claude ellenőrzése…</p>
          )}
          {state.status === 'error' && (
            <StatusLine tone="danger">A Claude nem ellenőrizhető.</StatusLine>
          )}
          {claude?.ok === true && (
            <StatusLine tone="success">
              Rendben, verzió{' '}
              <span className="font-mono text-data tabular-nums">{claude.version}</span>,
              bejelentkezve{claude.subscription === null ? '' : ` (${claude.subscription})`}
            </StatusLine>
          )}
          {claude?.ok === false && (
            <StatusLine tone="danger">
              {PROBLEMS[claude.reason].text}
              {claude.version !== null && (
                <>
                  {' '}
                  (verzió <span className="font-mono text-data tabular-nums">{claude.version}</span>
                  )
                </>
              )}
            </StatusLine>
          )}
        </div>
        {claude?.ok === false && PROBLEMS[claude.reason].help !== null && (
          <p className="text-small text-text-muted">{PROBLEMS[claude.reason].help}</p>
        )}
        {claude?.ok === false && (
          <p className="text-small text-text-muted">
            A Claude nélkül a stílus döntés és a szöveges playlist nem megy; minden más működik.
          </p>
        )}
        {claude?.chosenByHand === true && (
          <p className="text-small text-text-muted">A claude parancsot kézzel választottad ki.</p>
        )}
        {claude?.ok === true && claude.subscription === null && (
          <StatusLine tone="warning">
            A bejelentkezés nem előfizetéshez tartozik: a hívások díjkötelesek lehetnek.
          </StatusLine>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          loading={busy === 'check'}
          disabled={busy !== null}
          onClick={() => void act('check', () => window.api.system.claudeStatus(true))}
        >
          Claude újraellenőrzése
        </Button>
        <Button
          loading={busy === 'pick'}
          disabled={busy !== null}
          onClick={() =>
            void act('pick', async () => {
              const picked = await window.api.system.pickClaude()
              if (picked === null) return null
              return picked.ok ? picked.value : 'refused'
            })
          }
        >
          claude kiválasztása
        </Button>
        {claude?.chosenByHand === true && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              void act('pick', async () => {
                const cleared = await window.api.system.clearClaude()
                return cleared.ok ? cleared.value : null
              })
            }
          >
            Automatikus keresés
          </Button>
        )}
        <Button
          loading={busy === 'test'}
          disabled={busy !== null || claude?.ok !== true}
          onClick={() => void runTest()}
        >
          Teszt
        </Button>
      </div>
      <p className="text-small text-text-muted">
        A teszt egy valódi hívás: legfeljebb öt track adatait (artist, title, label, év, BPM) és a
        stílusaid nevét küldi el Claude-nak.
      </p>
      <div role="status">
        {pickRefused && (
          <StatusLine tone="danger">
            Ez nem a claude parancs. Egy „claude” nevű, futtatható fájlt válassz.
          </StatusLine>
        )}
        {tested !== null && <StatusLine tone={tested.tone}>{tested.text}</StatusLine>}
      </div>
    </section>
  )
}
