import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import type { ScanOutcome } from '@/stores/library-store'

type ScanResultProps = {
  /** Null while there is nothing to report; the regions stay in place for announcements. */
  outcome: ScanOutcome
}

// Both regions are always in the page: a live region that appears already filled is
// often not announced.
export function ScanResult({ outcome }: ScanResultProps): React.JSX.Element {
  const summary = outcome?.ok ? outcome.summary : null

  return (
    <>
      <div role="alert">
        {outcome !== null && !outcome.ok && (
          <StatusLine tone="danger">{errorMessage(outcome.code)}</StatusLine>
        )}
      </div>
      <div role="status" className="flex flex-col gap-1">
        {summary !== null && (
          <>
            <StatusLine tone="success">
              Beolvasás kész: {formatCount(summary.added)} új, {formatCount(summary.updated)}{' '}
              módosult, {formatCount(summary.unchanged)} változatlan.
            </StatusLine>
            {summary.missing > 0 && (
              <StatusLine tone="warning">
                {formatCount(summary.missing)} track fájlja nincs a mappában. A track adatai
                megmaradtak.
              </StatusLine>
            )}
            {summary.unreadable > 0 && (
              <StatusLine tone="warning">
                Nem olvasható fájlok: {formatCount(summary.unreadable)}. Tagek nélkül kerültek a
                könyvtárba.
              </StatusLine>
            )}
            {!summary.complete && (
              <StatusLine tone="warning">
                A mappa egy része nem volt olvasható, ezért a hiányzó fájlokat most nem jelöltem
                meg.
              </StatusLine>
            )}
          </>
        )}
      </div>
    </>
  )
}
