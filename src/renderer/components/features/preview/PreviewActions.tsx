import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { formatCount } from '@/lib/format'
import { DUPLICATES_FOLDER } from '@shared/duplicates'
import type { PreviewBatch } from '@shared/preview'

type PreviewActionsProps = {
  mode: PreviewBatch['mode']
  counts: { applied: number; excluded: number; failed: number }
  /**
   * How many files an approval moves out of the library, into `_Duplicates`. Null
   * when the batch looked for duplicates and what it found could not be read.
   */
  setAside: number | null
  /** The styles an approval creates, as the classification named them: five at most. */
  newStyles: readonly string[]
  /** How many other new styles the rows name: their tracks stay Unsorted. */
  newStylesLeft: number
  /** True when the list of styles cannot take the new ones: their tracks stay Unsorted. */
  stylesFull: boolean
  /** True when the batch sorts files into style folders: their genre and comment are replaced. */
  organizes: boolean
  /** The action that is on its way, or null. */
  busy: 'approve' | 'discard' | 'undo' | null
  onApprove: () => void
  onDiscard: () => void
  /** Called when a dialog closes and its button is gone or disabled: the page finds the focus a place. */
  onFocusLost: () => void
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
  setAside,
  newStyles,
  newStylesLeft,
  stylesFull,
  organizes,
  busy,
  onApprove,
  onDiscard,
  onFocusLost
}: PreviewActionsProps): React.JSX.Element {
  const [confirming, setConfirming] = React.useState<'approve' | 'discard' | null>(null)
  const approveButton = React.useRef<HTMLButtonElement>(null)
  const discardButton = React.useRef<HTMLButtonElement>(null)
  function backTo(button: HTMLButtonElement | null): void {
    if (button && !button.disabled) button.focus()
    else onFocusLost()
  }
  const left = counts.excluded + counts.failed
  // Said before the approval, whether or not the tab of the duplicates was opened:
  // these files leave the library.
  const asideNote =
    setAside === null
      ? ` Lehet, hogy fájlok kerülnek a ${DUPLICATES_FOLDER} mappába: a duplikátumok nem tölthetők be.`
      : setAside > 0
        ? ` ${formatCount(setAside)} fájl a ${DUPLICATES_FOLDER} mappába kerül.`
        : ''
  // Said too: a style is added to the list of Settings, and its name becomes a folder.
  const stylesNote =
    newStyles.length === 0
      ? ''
      : ` Új stílusok jönnek létre: ${newStyles.join(', ')}.${
          stylesFull
            ? ' A stílusok listája megtelik: amelyik nem fér el, annak a trackjei Unsorted maradnak.'
            : ''
        }${
          newStylesLeft > 0
            ? ` Egy batch legfeljebb 5 új stílust hoz létre: további ${formatCount(newStylesLeft)} stílus trackjei Unsorted maradnak.`
            : ''
        }`

  // Said too: what the file's genre and comment held is gone after the approval.
  const organizeNote = organizes
    ? ' A fájlok a stílusmappájukba kerülnek, a genre és a comment tag felülíródik.'
    : ''

  return (
    <section aria-label="Jóváhagyás" className="flex items-center gap-4">
      {/* May take a second line: with every part present it is wider than the minimum window leaves it. */}
      <p
        role="status"
        className="mr-auto flex min-h-8 min-w-0 flex-wrap items-center gap-x-1 text-small text-text-muted"
      >
        <Count value={counts.applied} /> track alkalmazásra vár
        {counts.excluded > 0 && (
          <span className="whitespace-nowrap">
            <span aria-hidden="true">· </span>
            <Count value={counts.excluded} /> kizárva
          </span>
        )}
        {setAside !== null && setAside > 0 && (
          <span className="whitespace-nowrap">
            <span aria-hidden="true">· </span>
            <Count value={setAside} /> fájl a {DUPLICATES_FOLDER} mappába kerül
          </span>
        )}
        {newStyles.length > 0 && (
          <span className="whitespace-nowrap">
            <span aria-hidden="true">· </span>
            <Count value={newStyles.length} /> új stílus
          </span>
        )}
        {counts.failed > 0 && (
          <span className="whitespace-nowrap">
            <span aria-hidden="true">· </span>
            <Count value={counts.failed} /> hibás
          </span>
        )}
      </p>
      <Button
        ref={discardButton}
        variant="secondary"
        disabled={busy !== null}
        loading={busy === 'discard'}
        onClick={() => setConfirming('discard')}
      >
        Elvetés
      </Button>
      <Button
        ref={approveButton}
        variant="primary"
        disabled={busy !== null || counts.applied === 0}
        loading={busy === 'approve'}
        onClick={() => setConfirming('approve')}
      >
        Jóváhagyás
      </Button>

      <Dialog open={confirming === 'approve'} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent
          // Opened from state, so nothing tells the dialog where the focus came from:
          // it is sent back to the button by hand.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            backTo(approveButton.current)
          }}
          title="Jóváhagyod a változásokat?"
          description={`${formatCount(counts.applied)} track fájljai változnak, ${formatCount(left)} kimarad.${asideNote}${stylesNote}${organizeNote} ${MODE_NOTES[mode]}`}
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
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            backTo(discardButton.current)
          }}
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
