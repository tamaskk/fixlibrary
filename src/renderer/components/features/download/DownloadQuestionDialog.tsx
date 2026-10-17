import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { formatCount } from '@/lib/format'
import { useDownloadStore } from '@/stores/download-store'
import { LOW_BITRATE_KBPS } from '@shared/download'

/** Asks before a download of a low bitrate, or of a track the library seems to have. */
export function DownloadQuestionDialog(): React.JSX.Element {
  const pending = useDownloadStore((state) => state.pending)
  const answer = useDownloadStore((state) => state.answer)
  const inspection = pending?.inspection
  const copy = inspection?.duplicate

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && answer(false)}>
      {pending !== null && inspection !== undefined && (
        <DialogContent
          title={
            pending.question === 'lowBitrate' ? 'Alacsony bitrate' : 'Már megvan a könyvtárban'
          }
          description={inspection.title}
        >
          {pending.question === 'lowBitrate' ? (
            <p className="text-body">
              A legjobb elérhető forrás{' '}
              <span className="font-mono text-data tabular-nums">
                {formatCount(inspection.bitrateKbps ?? 0)} kbps
              </span>
              , ez {LOW_BITRATE_KBPS} kbps alatt van. Az MP3 320 kbps-os lesz, de nem szól jobban a
              forrásnál.
            </p>
          ) : (
            <p className="text-body">
              Ez a track valószínűleg már megvan: {copy?.artist ?? '–'} – {copy?.title ?? '–'}{' '}
              <span className="font-mono text-data break-all text-text-muted">
                ({copy?.fileName})
              </span>
            </p>
          )}
          <DialogFooter>
            <Button autoFocus onClick={() => answer(false)}>
              Mégse
            </Button>
            <Button variant="primary" onClick={() => answer(true)}>
              {pending.question === 'lowBitrate' ? 'Letöltés így is' : 'Letöltés mégis'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
