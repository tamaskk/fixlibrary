import * as React from 'react'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/progress-bar'
import { StatusLine } from '@/components/ui/status-line'
import { formatDateTime, formatPercent } from '@/lib/format'
import { Data } from '@/components/features/playlists/DataText'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateState } from '@shared/release'

function updateText(update: UpdateState): { tone: 'neutral' | 'success' | 'danger'; text: string } {
  switch (update.status) {
    case 'idle':
      return { tone: 'neutral', text: 'Még nem keresett frissítést.' }
    case 'checking':
      return { tone: 'neutral', text: 'Frissítések keresése…' }
    case 'upToDate':
      return {
        tone: 'success',
        text: `Ez a legújabb verzió (ellenőrizve: ${formatDateTime(update.checkedAt)}).`
      }
    case 'downloading':
      return { tone: 'neutral', text: `Letöltés: ${update.version}.` }
    case 'ready':
      return { tone: 'success', text: `Új verzió: ${update.version}, letöltve és ellenőrizve.` }
    case 'unverifiable':
      return {
        tone: 'neutral',
        text: 'Ebben a buildben nincs kiadási kulcs, ezért az app nem frissíti magát.'
      }
    case 'failed':
      return {
        tone: 'danger',
        text: 'A frissítés keresése vagy letöltése nem sikerült. Később újra megpróbálja.'
      }
  }
}

/** The versions of the app, its runtime and yt-dlp, and the updates (T-043). */
export function UpdateStatus(): React.JSX.Element {
  const view = useUpdateStore((state) => state.view)
  const failed = useUpdateStore((state) => state.failed)
  const checkFailed = useUpdateStore((state) => state.checkFailed)
  const load = useUpdateStore((state) => state.load)
  const check = useUpdateStore((state) => state.check)
  const open = useUpdateStore((state) => state.open)

  React.useEffect(() => {
    void load()
  }, [load])

  const update = view?.update
  const busy = update?.status === 'checking' || update?.status === 'downloading'
  const line = update === undefined ? null : updateText(update)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label text-text-muted uppercase">Verziók és frissítés</h3>
      {view === null ? (
        !failed && <p className="text-small text-text-muted">Betöltés…</p>
      ) : (
        <ul aria-label="Verziók" className="flex flex-col gap-1 text-small">
          <li>
            App: <Data>{view.app}</Data>
          </li>
          <li>
            Elemző környezet:{' '}
            {view.runtime === null ? 'fejlesztői környezet' : <Data>{view.runtime}</Data>}
          </li>
          <li>
            yt-dlp:{' '}
            {view.ytDlp.updating ? (
              'frissítés…'
            ) : view.ytDlp.version === null ? (
              'az elemző környezeté'
            ) : (
              <>
                frissítve: <Data>{view.ytDlp.version}</Data>
              </>
            )}
          </li>
        </ul>
      )}
      <div role="status" className="flex flex-col gap-2">
        {failed && <StatusLine tone="danger">A verziók nem tölthetők be.</StatusLine>}
        {checkFailed && (
          <StatusLine tone="danger">A frissítések keresése nem indult el. Próbáld újra.</StatusLine>
        )}
        {line !== null && <StatusLine tone={line.tone}>{line.text}</StatusLine>}
      </div>
      {/* Outside the live region: its steps are no news to be read out. */}
      {update?.status === 'downloading' && (
        <div className="flex items-center gap-2">
          <ProgressBar
            className="flex-1"
            percent={update.fraction * 100}
            label="Frissítés letöltése"
          />
          <Data>{formatPercent(update.fraction)}</Data>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button loading={busy} onClick={() => void check()}>
          {failed || checkFailed ? 'Próbáld újra' : 'Frissítések keresése'}
        </Button>
        {update?.status === 'ready' && <Button onClick={() => void open()}>Megnyitás</Button>}
      </div>
    </div>
  )
}
