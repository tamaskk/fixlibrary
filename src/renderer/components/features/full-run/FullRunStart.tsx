import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { useFullRunStore } from '@/stores/full-run-store'

/**
 * "Teljes futtatás": every function in order, on the selected tracks or, with none
 * selected, the whole library. Asked once more, as it leads through several steps.
 */
export function FullRunStart({
  selectedIds,
  libraryCount
}: {
  /** In library order; empty for the whole library. */
  selectedIds: number[]
  libraryCount: number
}): React.JSX.Element {
  const view = useFullRunStore((state) => state.view)
  const start = useFullRunStore((state) => state.start)
  const starting = useFullRunStore((state) => state.starting)
  const failure = useFullRunStore((state) => state.startFailure)
  const [open, setOpen] = React.useState(false)
  const active = view !== null && view.step !== 'done' && view.stop === null
  const whole = selectedIds.length === 0
  const count = whole ? libraryCount : selectedIds.length

  return (
    <>
      <Button disabled={active} onClick={() => setOpen(true)}>
        Teljes futtatás
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Teljes futtatás"
          description={`${whole ? 'A teljes könyvtáron' : 'A kijelölt trackeken'} (${formatCount(count)} track) minden funkció lefut sorban: elemzés, előnézet és jóváhagyás, fájlműveletek, Rekordbox A fázis, hot cue-k, Rekordbox B fázis. A kalibrációnál, a jóváhagyásoknál és a Rekordboxnál a te lépésedre vár. Az app bezárható, újraindítás után ugyanonnan folytatódik.`}
        >
          <div role="status">
            {failure && <StatusLine tone="danger">{errorMessage(failure)}</StatusLine>}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégse</Button>
            </DialogClose>
            <Button
              variant="primary"
              loading={starting}
              onClick={() =>
                void start(whole ? null : selectedIds).then((ok) => ok && setOpen(false))
              }
            >
              Indítás
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
