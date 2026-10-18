import * as React from 'react'
import { createPortal } from 'react-dom'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { GridBeat, SnapMode } from '@shared/beat-grid'
import type { CueEditorCue } from '@shared/cue-editor'
import { HOT_CUE_LETTERS } from '@shared/settings'

type WaveformProps = {
  /** Where the audio is played from: `fixlib-audio://track/<id>`. */
  url: string
  peaks: number[]
  durationSeconds: number
  beats: readonly GridBeat[]
  cues: readonly CueEditorCue[]
  selectedSlot: number | null
  /** True while a slot waits for its place: a click on the waveform puts it there. */
  placing: boolean
  /** Changes when an edit was refused: the markers go back to where they are saved. */
  revision: number
  onSelect: (slot: number) => void
  /** A cue let go after a drag, or moved by a key; `bar` with Shift. */
  onMove: (slot: number, atMs: number, snap: SnapMode) => void
  /** A place clicked, or the play cursor with Enter, for the slot that waits. */
  onPlace: (atMs: number, snap: SnapMode) => void
  onPlayingChange: (playing: boolean) => void
  /** The controls of the player once it is there, and null when it is gone. */
  onReady: (player: WaveformPlayer | null) => void
}

/** What the page may do with the player. */
export interface WaveformPlayer {
  playFrom: (seconds: number) => void
  seek: (seconds: number) => void
  playPause: () => void
  isPlaying: () => boolean
}

const HEIGHT = 128
// Pixels a second at the start, and the bounds of the zoom.
const START_ZOOM = 20
const MAX_ZOOM = 1000
const ZOOM_STEP = 1.25

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const LINE_OPACITY: Readonly<Record<GridBeat['level'], number>> = {
  beat: 0.25,
  bar: 0.55,
  phrase: 0.9
}

/**
 * Dark or light text on a cue's color, whichever reads better: the color is the user's
 * (Settings), so its brightness is not known. `#RRGGBB` only, as the settings keep it.
 */
function textOn(color: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color)
  if (!match) return 'var(--color-bg)'
  const [r, g, b] = match.slice(1).map((part) => {
    const channel = parseInt(part, 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // Against black the contrast is (L + 0.05) / 0.05, against white 1.05 / (L + 0.05).
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? 'var(--color-bg)'
    : 'var(--color-white)'
}

/** A marker of a cue: its letter and name in its color, the place it stands on a line. */
function markerOf(cue: CueEditorCue, selected: boolean): HTMLElement {
  const marker = document.createElement('div')
  const letter = HOT_CUE_LETTERS[cue.slot - 1] ?? String(cue.slot)
  // The label hangs from the top of the line, in the cue's own color, its text in the
  // Label role; the chosen cue has an outline as well. The player draws inside a
  // shadow root, which the app's classes do not reach: its tokens do.
  Object.assign(marker.style, {
    width: 'max-content',
    marginLeft: '1px',
    padding: '0 calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-sm)',
    font: '500 var(--text-label) / var(--text-label--line-height) var(--font-sans)',
    letterSpacing: 'var(--text-label--letter-spacing)',
    textTransform: 'uppercase',
    color: textOn(cue.color),
    backgroundColor: cue.color,
    cursor: 'grab',
    outline: selected ? '2px solid var(--color-text)' : 'none',
    outlineOffset: '1px'
  })
  marker.dataset['slot'] = String(cue.slot)
  marker.title = `${letter}: ${cue.name}. Kattintás: lejátszás innen. Húzás: áthelyezés.`
  marker.textContent = `${letter} ${cue.name}`
  return marker
}

/** The beat before or after `seconds`, or the bar start with `bar`. */
function stepOf(
  beats: readonly GridBeat[],
  seconds: number,
  direction: -1 | 1,
  mode: SnapMode
): number | null {
  const candidates = beats.filter((beat) => mode === 'beat' || beat.level !== 'beat')
  const next =
    direction > 0
      ? candidates.find((beat) => beat.time > seconds + 0.0005)
      : [...candidates].reverse().find((beat) => beat.time < seconds - 0.0005)
  return next ? next.time : null
}

/**
 * The waveform of a track with its beat grid and hot cues (T-030), drawn from the peaks
 * of the sidecar, so the file is not decoded in the page. A cue is dragged and let go,
 * or moved with the arrow keys; the main process snaps it. The wheel, `+` and `-` zoom.
 */
export function Waveform({
  url,
  peaks,
  durationSeconds,
  beats,
  cues,
  selectedSlot,
  placing,
  revision,
  onSelect,
  onMove,
  onPlace,
  onPlayingChange,
  onReady
}: WaveformProps): React.JSX.Element {
  const container = React.useRef<HTMLDivElement>(null)
  const [player, setPlayer] = React.useState<{ ws: WaveSurfer; regions: RegionsPlugin } | null>(
    null
  )
  // Whether Shift is held when a cue is let go: then it lands on a bar. Read from the
  // pointer as well, and forgotten when the window loses the keyboard.
  const shift = React.useRef(false)
  // The newest handlers, for the events of the player, which is made once per track.
  const handlers = React.useRef({ onSelect, onMove, onPlace, onPlayingChange, onReady, placing })
  React.useLayoutEffect(() => {
    handlers.current = { onSelect, onMove, onPlace, onPlayingChange, onReady, placing }
  })

  React.useEffect(() => {
    const track = (event: KeyboardEvent | PointerEvent): void => {
      shift.current = event.shiftKey
    }
    const forget = (): void => {
      shift.current = false
    }
    window.addEventListener('keydown', track)
    window.addEventListener('keyup', track)
    window.addEventListener('pointermove', track, { capture: true })
    window.addEventListener('pointerup', track, { capture: true })
    window.addEventListener('blur', forget)
    return () => {
      window.removeEventListener('keydown', track)
      window.removeEventListener('keyup', track)
      window.removeEventListener('pointermove', track, { capture: true })
      window.removeEventListener('pointerup', track, { capture: true })
      window.removeEventListener('blur', forget)
    }
  }, [])

  React.useEffect(() => {
    if (!container.current) return
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: container.current,
      url,
      peaks: [Float32Array.from(peaks, (peak) => peak / 1000)],
      duration: durationSeconds,
      height: HEIGHT,
      minPxPerSec: START_ZOOM,
      waveColor: token('--color-text-muted'),
      progressColor: token('--color-primary-text'),
      cursorColor: token('--color-text'),
      cursorWidth: 1,
      normalize: true,
      autoScroll: true,
      plugins: [regions]
    })
    const snap = (): SnapMode => (shift.current ? 'bar' : 'beat')
    ws.on('play', () => handlers.current.onPlayingChange(true))
    ws.on('pause', () => handlers.current.onPlayingChange(false))
    ws.on('finish', () => handlers.current.onPlayingChange(false))
    ws.on('interaction', (time) => {
      if (handlers.current.placing) handlers.current.onPlace(Math.round(time * 1000), snap())
    })
    regions.on('region-updated', (region: Region) => {
      handlers.current.onMove(Number(region.id), Math.round(region.start * 1000), snap())
    })
    regions.on('region-clicked', (region: Region, event: MouseEvent) => {
      event.stopPropagation()
      handlers.current.onSelect(Number(region.id))
      ws.setTime(region.start)
      void ws.play()
    })
    setPlayer({ ws, regions })
    handlers.current.onReady({
      playFrom: (seconds) => {
        ws.setTime(seconds)
        void ws.play()
      },
      seek: (seconds) => ws.setTime(seconds),
      playPause: () => void ws.playPause(),
      isPlaying: () => ws.isPlaying()
    })
    return () => {
      handlers.current.onReady(null)
      setPlayer(null)
      ws.destroy()
    }
    // One player per track: the page gives it a new key for another one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The cues as markers: put in again whenever they change, and after a refused edit.
  React.useEffect(() => {
    if (!player) return
    player.regions.clearRegions()
    for (const cue of cues) {
      player.regions.addRegion({
        id: String(cue.slot),
        start: cue.positionMs / 1000,
        drag: true,
        resize: false,
        color: cue.color,
        content: markerOf(cue, cue.slot === selectedSlot)
      })
    }
  }, [player, cues, selectedSlot, revision])

  function zoomBy(factor: number): void {
    if (!player) return
    const now = player.ws.options.minPxPerSec
    player.ws.zoom(Math.min(MAX_ZOOM, Math.max(START_ZOOM, now * factor)))
  }

  function zoom(event: React.WheelEvent<HTMLDivElement>): void {
    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!player) return
    const mode: SnapMode = event.shiftKey ? 'bar' : 'beat'
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const cue = cues.find((each) => each.slot === selectedSlot)
      if (!cue) return
      event.preventDefault()
      const to = stepOf(beats, cue.positionMs / 1000, event.key === 'ArrowLeft' ? -1 : 1, mode)
      if (to !== null) onMove(cue.slot, Math.round(to * 1000), mode)
    } else if (event.key === 'Enter' && placing) {
      event.preventDefault()
      onPlace(Math.round(player.ws.getCurrentTime() * 1000), mode)
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomBy(ZOOM_STEP)
    } else if (event.key === '-') {
      event.preventDefault()
      zoomBy(1 / ZOOM_STEP)
    }
  }

  const lineColor = 'var(--color-text)'
  const grid = player
    ? createPortal(
        <svg
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            // Over the waveform, under the cues.
            zIndex: 4
          }}
          viewBox={`0 0 ${Math.max(durationSeconds, 1)} 1`}
          preserveAspectRatio="none"
        >
          {beats.map((beat) => (
            <line
              key={beat.time}
              x1={beat.time}
              x2={beat.time}
              y1={0}
              y2={1}
              stroke={lineColor}
              strokeOpacity={LINE_OPACITY[beat.level]}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>,
        player.ws.getWrapper()
      )
    : null

  return (
    <div
      ref={container}
      role="application"
      aria-label="Waveform"
      aria-describedby="waveform-keys"
      tabIndex={0}
      onWheel={zoom}
      onKeyDown={onKeyDown}
      className={
        'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary' +
        (placing ? ' cursor-crosshair' : '')
      }
    >
      {grid}
      <p id="waveform-keys" className="sr-only">
        Nyilak: a kijelölt cue egy beattel arrébb, Shifttel egy barral. Enter: a várakozó slot a
        lejátszás helyére. Plusz és mínusz: nagyítás.
      </p>
    </div>
  )
}
