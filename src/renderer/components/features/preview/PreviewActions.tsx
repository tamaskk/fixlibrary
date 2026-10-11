import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { formatCount } from '@/lib/format'
import type { PreviewBatch } from '@shared/preview'

type PreviewActionsProps = {
  mode: PreviewBatch['mode']
  counts: { applied: number; excluded: number; failed: number }
  /** The action that is on its way, or null. */
  busy: 'approve' | 'discard' | 'undo' | null
  onApprove: () => void
  onDiscard: () => void
}

const MODE_NOTES: Readonly<Record<PreviewBatch['mode'], string>> = {
  in_place: 'Mód: helyben. Minden fájlról backup készül, mielőtt változik.',
  clean_library:
    'Mód: clean library. A munka másolatokon történik, az eredeti fájlok nem változnak.'
}

function Count({ value }: { value: number }): React.JSX.Element {
  return <span className="font-mono text-data text-text tabular-nums">{formatCount(value)}</span>
}

/** The bar under a preview: what an approval would do, and the two ways to end it. */
export function PreviewActions({
  mode,
  counts,
  busy,
  onApprove,
  onDiscard
}: PreviewActionsProps): React.JSX.Element {
  const [confirming, setConfirming] = React.useState<'approve' | 'discard' | null>(null)
  const left = counts.excluded + counts.failed

  return (
    <section aria-label="Jóváhagyás" className="flex items-center gap-4">
      <p role="status" className="mr-auto flex h-8 items-center gap-1 text-small text-text-muted">
        <Count value={counts.applied} /> track alkalmazásra vár
        {counts.excluded > 0 && (
          <>
            <span aria-hidden="true"> · </span>
            <Count value={counts.excluded} /> kizárva
          </>
        )}
        {counts.failed > 0 && (
          <>
            <span aria-hidden="true"> · </span>
            <Count value={counts.failed} /> hibás
          </>
        )}
      </p>
      <Button
        variant="secondary"
        disabled={busy !== null}
        loading={busy === 'discard'}
        onClick={() => setConfirming('discard')}
      >
        Elvetés
      </Button>
      <Button
        variant="primary"
        disabled={busy !== null || counts.applied === 0}
        loading={busy === 'approve'}
        onClick={() => setConfirming('approve')}
      >
        Jóváhagyás
      </Button>

      <Dialog open={confirming === 'approve'} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent
          title="Jóváhagyod a változásokat?"
          description={`${formatCount(counts.applied)} track fájljai változnak, ${formatCount(left)} kimarad. ${MODE_NOTES[mode]}`}
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégsem</Button>
            </DialogClose>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(null)
                onApprove()
              }}
            >
              Jóváhagyás
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirming === 'discard'} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent
          title="Elveted a batch-et?"
          description="Amit a futás kiszámolt és amit itt szerkesztettél, elvész. A fájljaid nem változnak."
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégsem</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(null)
                onDiscard()
              }}
            >
              Elvetés
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
