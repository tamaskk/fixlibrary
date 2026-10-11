import { StatusLine } from '@/components/features/settings/StatusLine'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import type { ScanOutcome } from '@/stores/library-store'

type ScanResultProps = {
  outcome: ScanOutcome
}

export function ScanResult({ outcome }: ScanResultProps): React.JSX.Element | null {
  if (outcome === null) return null
  if (!outcome.ok) {
    return (
      <div role="alert">
        <StatusLine tone="danger">{errorMessage(outcome.code)}</StatusLine>
      </div>
    )
  }

  const { added, updated, unchanged, missing, unreadable } = outcome.summary
  return (
    <div role="status" className="flex flex-col gap-1">
      <StatusLine tone="success">
        Beolvasás kész: {formatCount(added)} új, {formatCount(updated)} módosult,{' '}
        {formatCount(unchanged)} változatlan.
      </StatusLine>
      {missing > 0 && (
        <StatusLine tone="warning">
          {formatCount(missing)} track fájlja nincs a mappában. A track adatai megmaradtak.
        </StatusLine>
      )}
      {unreadable > 0 && (
        <StatusLine tone="warning">
          {formatCount(unreadable)} fájl nem olvasható. Tagek nélkül szerepelnek a könyvtárban.
        </StatusLine>
      )}
    </div>
  )
}
