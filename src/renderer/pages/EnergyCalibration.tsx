import * as React from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ProgressBar } from '@/components/ui/progress-bar'
import { RadioGroup, RadioRow } from '@/components/ui/radio-group'
import { StatusLine } from '@/components/ui/status-line'
import { errorMessage } from '@/lib/messages'
import { useEnergyStore } from '@/stores/energy-store'
import { MIN_RATINGS_TO_FIT, type CalibrationItem } from '@shared/energy'

const RATINGS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

function nameOf(item: CalibrationItem): string {
  return item.artist && item.title ? `${item.artist} - ${item.title}` : item.fileName
}

function SampleRow({
  item,
  playing,
  onPlay,
  onRate
}: {
  item: CalibrationItem
  playing: boolean
  onPlay: () => void
  onRate: (rating: number) => void
}): React.JSX.Element {
  const name = nameOf(item)
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={playing ? `${name} megállítása` : `${name} lejátszása`}
          onClick={onPlay}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <span className="min-w-0 flex-1 truncate text-body">{name}</span>
        <span className="shrink-0 text-small text-text-muted">
          {item.styleName ?? 'Nincs stílus'}
        </span>
      </div>
      <RadioGroup
        aria-label={`${name} energyje`}
        orientation="horizontal"
        className="flex-row flex-wrap gap-x-3 pl-10"
        value={item.rating === null ? '' : String(item.rating)}
        onValueChange={(value) => onRate(Number(value))}
      >
        {RATINGS.map((rating) => (
          <RadioRow
            key={rating}
            value={String(rating)}
            aria-label={`Energy ${rating}`}
            className="w-auto"
          >
            <span className="text-small">{rating}</span>
          </RadioRow>
        ))}
      </RadioGroup>
    </li>
  )
}

export function EnergyCalibration(): React.JSX.Element {
  const view = useEnergyStore((state) => state.view)
  const loadFailed = useEnergyStore((state) => state.loadFailed)
  const failure = useEnergyStore((state) => state.failure)
  const fitting = useEnergyStore((state) => state.fitting)
  const load = useEnergyStore((state) => state.load)
  const rate = useEnergyStore((state) => state.rate)
  const fit = useEnergyStore((state) => state.fit)
  const newSample = useEnergyStore((state) => state.newSample)
  const [playingId, setPlayingId] = React.useState<number | null>(null)
  const audio = React.useRef<HTMLAudioElement | null>(null)

  React.useEffect(() => {
    void load()
    return () => audio.current?.pause()
  }, [load])

  // One track plays at a time; playing the one that plays stops it.
  function play(trackId: number): void {
    audio.current?.pause()
    if (playingId === trackId) {
      setPlayingId(null)
      return
    }
    const player = new Audio(`fixlib-audio://track/${trackId}`)
    player.addEventListener('ended', () => setPlayingId(null))
    player.addEventListener('error', () => setPlayingId(null))
    audio.current = player
    setPlayingId(trackId)
    void player.play().catch(() => setPlayingId(null))
  }

  let body: React.ReactNode
  if (loadFailed) {
    body = (
      <StatusLine tone="danger">A kalibráció nem tölthető be. Nyisd meg újra az oldalt.</StatusLine>
    )
  } else if (view === null) {
    body = <StatusLine tone="neutral">Betöltés…</StatusLine>
  } else if (view.measuredCount === 0) {
    body = (
      <EmptyState message="Még nincs mért track. Futtasd az „Energy jellemzők mérése” funkciót a Könyvtárban." />
    )
  } else {
    const { model, sample, ratedCount } = view
    body = (
      <>
        <Card>
          <CardTitle>Modell</CardTitle>
          <div className="flex flex-col gap-4">
            {model === null ? (
              <p className="text-body text-text-muted">
                Még nincs kalibrálva. Értékelj legalább {MIN_RATINGS_TO_FIT} tracket 1-től 10-ig a
                saját érzésed szerint, stílusán belül.
              </p>
            ) : (
              <p className="text-body">
                Átlagos eltérés:{' '}
                <span className="font-mono text-data tabular-nums">
                  {model.looMae.toLocaleString('hu-HU', { maximumFractionDigits: 1 })}
                </span>{' '}
                ({model.ratedCount} értékelés alapján)
              </p>
            )}
            {model?.stale && (
              <StatusLine tone="warning">
                A jellemzők mérése megváltozott. Kalibrálj újra, addig nem kerül energy a trackekre.
              </StatusLine>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-small text-text-muted">
                Értékelve: {ratedCount} / {sample.length}
              </span>
              <ProgressBar
                percent={sample.length === 0 ? 0 : (ratedCount / sample.length) * 100}
                label="Értékelt trackek"
              />
            </div>
            <div role="status">
              {failure && <StatusLine tone="danger">{errorMessage(failure)}</StatusLine>}
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => void newSample()}>Új minta</Button>
              <Button
                variant="primary"
                loading={fitting}
                disabled={ratedCount < MIN_RATINGS_TO_FIT}
                onClick={() => void fit()}
              >
                Kalibrálás
              </Button>
            </div>
          </div>
        </Card>
        <Card>
          <CardTitle>Minta</CardTitle>
          <ul className="flex flex-col">
            {sample.map((item) => (
              <SampleRow
                key={item.trackId}
                item={item}
                playing={playingId === item.trackId}
                onPlay={() => play(item.trackId)}
                onRate={(rating) => void rate(item.trackId, rating)}
              />
            ))}
          </ul>
        </Card>
      </>
    )
  }

  return (
    <main className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-form flex-col gap-6">
        <h1 className="text-h1">Energy kalibráció</h1>
        {body}
      </div>
    </main>
  )
}
