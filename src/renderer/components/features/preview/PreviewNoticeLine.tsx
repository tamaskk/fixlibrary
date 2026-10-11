import { StatusLine } from '@/components/ui/status-line'
import { formatCount, formatGigabytes } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import type { PreviewNotice } from '@/stores/preview-store'
import type { ErrorCode } from '@shared/errors'

function describeFailure(code: ErrorCode): string {
  if (code === 'RUN_ACTIVE') {
    return 'Most nem lehet: egy futás dolgozik, a könyvtár beolvasása tart, vagy az előbb kérted. Próbáld újra kicsit később.'
  }
  if (code === 'INVALID_INPUT') return 'Ez a batch már nem vár jóváhagyásra.'
  if (code === 'WRITE_FAILED') {
    return 'A visszavonás nem végezhető el: a backupok vagy a batch adatai nem használhatók. Semmi nem változott.'
  }
  return errorMessage(code)
}

/** What the last approval, discard or undo came to, as one status line. */
export function PreviewNoticeLine({ notice }: { notice: PreviewNotice }): React.JSX.Element | null {
  if (notice === null) return null
  switch (notice.kind) {
    case 'failed':
      return <StatusLine tone="danger">{describeFailure(notice.code)}</StatusLine>
    case 'noSpace':
      return (
        <StatusLine tone="danger">
          Nincs elég hely a lemezen: {formatGigabytes(notice.neededBytes, 'up')} kell,{' '}
          {formatGigabytes(notice.freeBytes, 'down')} szabad. Semmi nem változott.
        </StatusLine>
      )
    case 'discarded':
      return <StatusLine tone="neutral">A batch elvetve. A fájljaid nem változtak.</StatusLine>
    case 'undone':
      return (
        <StatusLine tone="success">
          Az utolsó batch visszavonva: {formatCount(notice.outcome.restored)} fájl visszaállítva,{' '}
          {formatCount(notice.outcome.removed)} törölve.
        </StatusLine>
      )
  }
}
