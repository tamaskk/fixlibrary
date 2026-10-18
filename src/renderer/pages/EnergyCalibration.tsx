import * as React from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ProgressBar } from '@/components/ui/progress-bar'
import { RadioGroup, RadioRow } from '@/components/ui/radio-group'
import { StatusLine } from '@/components/ui/status-line'
import { errorMessage } from '@/lib/messages'
import { useTrackPlayer } from '@/lib/use-track-player'
import { useAppStore } from '@/stores/app-store'
import { useEnergyStore, type EnergyFailure } from '@/stores/energy-store'
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
            <span className="font-mono text-data tabular-nums">{rating}</span>
          </RadioRow>
        ))}
      </RadioGroup>
    </li>
  )
}

// What the page says of a failure; a fit refused for its ratings says why.
function failureText(failure: EnergyFailure): string {
  if (failure.of === 'model' && failure.code === 'INVALID_INPUT') {
    return `A kalibráláshoz legalább ${MIN_RATINGS_TO_FIT} értékelés kell, és nem lehet mind egyforma.`
  }
  return errorMessage(failure.code)
}

function Count({ value }: { value: number }): React.JSX.Element {
  return <span className="font-mono text-data tabular-nums">{value}</span>
}

export function EnergyCalibration(): React.JSX.Element {
  const view = useEnergyStore((state) => state.view)
  const loadFailed = useEnergyStore((state) => state.loadFailed)
  const failure = useEnergyStore((state) => state.failure)
  const fitting = useEnergyStore((state) => state.fitting)
  const choosing = useEnergyStore((state) => state.choosing)
  const load = useEnergyStore((state) => state.load)
  const rate = useEnergyStore((state) => state.rate)
  const fit = useEnergyStore((state) => state.fit)
  const newSample = useEnergyStore((state) => state.newSample)
  const setPage = useAppStore((state) => state.setPage)
  const player = useTrackPlayer()

  React.useEffect(() => {
    void load()
  }, [load])

  function chooseNewSample(): void {
    player.stop()
    void newSample()
  }

  let body: React.ReactNode = null
  if (view !== null && view.measuredCount === 0) {
    body = (
      <EmptyState
        message="Még nincs mért track. Futtasd az „Energy jellemzők mérése” funkciót a Könyvtárban."
        action={
          <Button variant="primary" onClick={() => setPage('library')}>
            Könyvtár megnyitása
          </Button>
        }
      />
    )
  } else if (view !== null) {
    const { model, sample, ratedCount } = view
    const sampleRated = sample.filter((item) => item.rating !== null).length
    body = (
      <>
        <Card>
          <CardTitle>Modell</CardTitle>
          <div className="flex flex-col gap-4">
            {model === null ? (
              <p className="text-body text-text-muted">
                Még nincs kalibrálva. Értékeld a mintát 1-től 10-ig a saját érzésed szerint, a track
                stílusán belül.
              </p>
            ) : (
              <p className="text-body">
                Átlagos eltérés:{' '}
                <span className="font-mono text-data tabular-nums">
                  {model.looMae.toLocaleString('hu-HU', { maximumFractionDigits: 1 })}
                </span>{' '}
                pont (<Count value={model.ratedCount} /> értékelés alapján)
              </p>
            )}
            {model?.stale && (
              <StatusLine tone="warning">
                A jellemzők mérése megváltozott. Kalibrálj újra, addig nem kerül energy a trackekre.
              </StatusLine>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-small text-text-muted">
                A mintából értékelve: <Count value={sampleRated} /> /{' '}
                <Count value={sample.length} />
              </span>
              <ProgressBar
                percent={sample.length === 0 ? 0 : (sampleRated / sample.length) * 100}
                label="A minta értékelt trackjei"
              />
            </div>
            <div role="status">
              {failure?.of === 'model' && (
                <StatusLine tone="danger">{failureText(failure)}</StatusLine>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              {ratedCount < MIN_RATINGS_TO_FIT && (
                <span className="mr-auto text-small text-text-muted">
                  Összesen <Count value={ratedCount} /> értékelés, legalább {MIN_RATINGS_TO_FIT}{' '}
                  kell.
                </span>
              )}
              <Button loading={choosing} onClick={chooseNewSample}>
                Új minta
              </Button>
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
          <div role="status" className="flex flex-col gap-1">
            {failure?.of === 'rating' && (
              <StatusLine tone="danger">
                Az értékelés nem mentődött el: {failureText(failure)}
              </StatusLine>
            )}
            {player.failed && (
              <StatusLine tone="danger">
                A fájl nem játszható le. Lehet, hogy a lemeze nincs csatlakoztatva.
              </StatusLine>
            )}
          </div>
          <ul className="flex flex-col">
            {sample.map((item) => (
              <SampleRow
                key={item.trackId}
                item={item}
                playing={player.playingId === item.trackId}
                onPlay={() => player.toggle(item.trackId)}
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
        <div role="status" className="contents">
          {view === null && !loadFailed && <StatusLine tone="neutral">Betöltés…</StatusLine>}
          {loadFailed && (
            <div className="flex items-center gap-4">
              <StatusLine tone="danger">A kalibráció nem tölthető be.</StatusLine>
              <Button variant="primary" onClick={() => void load()}>
                Próbáld újra
              </Button>
            </div>
          )}
        </div>
        {body}
      </div>
    </main>
  )
}
