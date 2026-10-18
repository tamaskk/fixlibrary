import * as React from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { StatusLine } from '@/components/ui/status-line'
import { formatCueTime, formatDecimal } from '@/lib/format'
import { AB_CROSSFADE_S, abGainsOf, decibelsOf, rmsOf } from '@shared/ab-player'
import type { PreviewRow, PreviewValue } from '@shared/preview'

type Branch = 'a' | 'b'

type AbPlayerProps = {
  /** The row to listen to, or null while the player is closed. */
  row: PreviewRow | null
  onClose: () => void
}

// How often the level and the place are read while it plays.
const READ_EVERY_MS = 250
// The columns of the table of values: the name, then before and after.
const VALUE_COLUMNS = '1fr 96px 96px'

function level(value: PreviewValue): string {
  return typeof value === 'number' ? formatDecimal(value) : '–'
}

function signed(value: number): string {
  const shown = Math.round(value * 100) / 100
  if (shown === 0) return formatDecimal(0)
  return shown > 0 ? `+${formatDecimal(shown)}` : formatDecimal(shown)
}

/** The audio graph of the player: one source, the two branches, and what measures them. */
interface Graph {
  context: AudioContext
  audio: HTMLAudioElement
  a: GainNode
  b: GainNode
  analyser: AnalyserNode
}

type Loaded = 'loading' | 'ready' | 'failed'

/**
 * The A/B player of the preview (T-033). The original file is played once, through two
 * branches: A as it is, B by the gain the normalization will apply. Both ways of
 * normalizing are a linear gain, so B is what the file will sound like. A switch fades
 * over 20 ms and leaves the place where it is. Keys: A, B and Space.
 */
function AbPlayerBody({ row }: { row: PreviewRow }): React.JSX.Element {
  const gainDb = typeof row.cells.gain.after === 'number' ? row.cells.gain.after : null
  const gains = abGainsOf(gainDb)
  const graph = React.useRef<Graph | null>(null)
  const [branch, setBranch] = React.useState<Branch>('a')
  const [playing, setPlaying] = React.useState(false)
  const [loaded, setLoaded] = React.useState<Loaded>('loading')
  const [place, setPlace] = React.useState(0)
  const [measured, setMeasured] = React.useState<number | null>(null)

  React.useEffect(() => {
    let closed = false
    const audio = new Audio()
    // The page reads the samples of the app's own protocol, which allows it with the
    // token of this launch (T-033).
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'
    const context = new AudioContext()
    const source = context.createMediaElementSource(audio)
    const a = context.createGain()
    const b = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 32_768
    a.gain.value = gains.a
    b.gain.value = 0
    source.connect(a).connect(analyser)
    source.connect(b).connect(analyser)
    analyser.connect(context.destination)
    graph.current = { context, audio, a, b, analyser }
    const onReady = (): void => setLoaded('ready')
    const onPlaying = (): void => {
      setPlaying(true)
      setLoaded('ready')
    }
    const onStopped = (): void => {
      setPlaying(false)
      setMeasured(null)
    }
    const onError = (): void => setLoaded('failed')
    audio.addEventListener('canplay', onReady)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('pause', onStopped)
    audio.addEventListener('ended', onStopped)
    audio.addEventListener('error', onError)
    window.api.app
      .audioReadToken()
      .then((token) => {
        if (!closed) audio.src = `fixlib-audio://track/${row.trackId}?read=${token}`
      })
      .catch(() => {
        if (!closed) setLoaded('failed')
      })
    const samples = new Float32Array(analyser.fftSize)
    const timer = window.setInterval(() => {
      setPlace(audio.currentTime)
      if (audio.paused) return
      analyser.getFloatTimeDomainData(samples)
      setMeasured(decibelsOf(rmsOf(samples)))
    }, READ_EVERY_MS)
    return () => {
      closed = true
      window.clearInterval(timer)
      audio.removeEventListener('canplay', onReady)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('pause', onStopped)
      audio.removeEventListener('ended', onStopped)
      audio.removeEventListener('error', onError)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      void context.close()
      graph.current = null
    }
    // One graph per row: the dialog is made again for another one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function choose(next: Branch): void {
    const current = graph.current
    if (!current) return
    setBranch(next)
    const now = current.context.currentTime
    for (const [node, target] of [
      [current.a, next === 'a' ? gains.a : 0],
      [current.b, next === 'b' ? gains.b : 0]
    ] as const) {
      node.gain.cancelScheduledValues(now)
      node.gain.setValueAtTime(node.gain.value, now)
      node.gain.linearRampToValueAtTime(target, now + AB_CROSSFADE_S)
    }
  }

  async function playPause(): Promise<void> {
    const current = graph.current
    if (!current || loaded !== 'ready') return
    if (!current.audio.paused) {
      current.audio.pause()
      return
    }
    try {
      await current.context.resume()
      // The dialog may have been closed meanwhile: its graph is not to be played.
      if (graph.current !== current) return
      await current.audio.play()
    } catch (error) {
      // A pause or a close while it started is no failure of the file.
      if (error instanceof DOMException && error.name === 'NotSupportedError') setLoaded('failed')
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
    // A focused button takes Space and Enter for itself.
    if (event.target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter'))
      return
    const key = event.key.toLowerCase()
    if (key === 'a' || key === 'b') {
      event.preventDefault()
      choose(key)
    } else if (event.key === ' ') {
      event.preventDefault()
      void playPause()
    }
  }

  const lufs = row.cells.lufs
  const peak = row.cells.truePeak
  const values: [string, string, string][] = [
    ['Loudness (LUFS)', level(lufs.before), level(lufs.after)],
    ['True peak (dBTP)', level(peak.before), level(peak.after)]
  ]
  const data = 'text-right font-mono text-data tabular-nums'

  return (
    <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
      <div role="table" aria-label="Mért értékek" className="flex flex-col">
        <div
          role="row"
          className="grid h-8 items-center gap-2 text-label text-text-muted uppercase"
          style={{ gridTemplateColumns: VALUE_COLUMNS }}
        >
          <span role="columnheader">Érték</span>
          <span role="columnheader" className="text-right">
            Előtte (A)
          </span>
          <span role="columnheader" className="text-right">
            Utána (B)
          </span>
        </div>
        {values.map(([name, before, after]) => (
          <div
            key={name}
            role="row"
            className="grid h-8 items-center gap-2"
            style={{ gridTemplateColumns: VALUE_COLUMNS }}
          >
            <span role="cell" className="truncate text-small">
              {name}
            </span>
            <span role="cell" className={data}>
              {before}
            </span>
            <span role="cell" className={data}>
              {after}
            </span>
          </div>
        ))}
        <div
          role="row"
          className="grid h-8 items-center gap-2"
          style={{ gridTemplateColumns: VALUE_COLUMNS }}
        >
          <span role="cell" className="truncate text-small">
            Gain és különbség
          </span>
          <span role="cell" className={`col-span-2 ${data}`}>
            {gainDb === null ? '–' : `${signed(gainDb)} dB · ${signed(gainDb)} LU`}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="icon"
          aria-label={playing ? 'Szünet' : 'Lejátszás'}
          aria-keyshortcuts="Space"
          title={playing ? 'Szünet' : 'Lejátszás'}
          disabled={loaded !== 'ready'}
          onClick={() => void playPause()}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <div role="group" aria-label="Melyik változat szól" className="flex gap-1">
          {(['a', 'b'] as const).map((each) => (
            <Button
              key={each}
              variant={branch === each ? 'primary' : 'secondary'}
              aria-pressed={branch === each}
              aria-keyshortcuts={each.toUpperCase()}
              disabled={loaded === 'failed'}
              onClick={() => choose(each)}
            >
              {each === 'a' ? 'A: eredeti' : 'B: normalizált'}
            </Button>
          ))}
        </div>
        <span
          role="timer"
          aria-label="Hely"
          className="ml-auto font-mono text-data text-text-muted tabular-nums"
        >
          {formatCueTime(Math.round(place * 1000))}
        </span>
      </div>
      <p className="text-small text-text-muted">
        {'Szint most: '}
        <span className="font-mono text-data tabular-nums" data-testid="ab-level">
          {measured === null || !Number.isFinite(measured)
            ? '– (lejátszáskor)'
            : `${formatDecimal(Math.round(measured * 10) / 10)} dB`}
        </span>
      </p>
      <p className="text-small text-text-muted">
        A, B: váltás · Szóköz: lejátszás és szünet · Esc: bezárás
      </p>
      <div role="status">
        {loaded === 'loading' && <StatusLine tone="neutral">Betöltés…</StatusLine>}
        {loaded === 'failed' && (
          <StatusLine tone="danger">
            A fájl nem játszható le. Lehet, hogy a lemeze nincs csatlakoztatva.
          </StatusLine>
        )}
      </div>
    </div>
  )
}

export function AbPlayer({ row, onClose }: AbPlayerProps): React.JSX.Element {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      {row && (
        <DialogContent title="Meghallgatás" description={row.currentFileName}>
          <AbPlayerBody key={row.trackId} row={row} />
        </DialogContent>
      )}
    </Dialog>
  )
}
