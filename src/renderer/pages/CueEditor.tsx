import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronLeft, ChevronRight, Lock, Pause, Play, TriangleAlert } from 'lucide-react'
import { Waveform, type WaveformPlayer } from '@/components/features/cue-editor/Waveform'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { cn } from '@/lib/cn'
import { formatCount, formatCueTime } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { useAppStore } from '@/stores/app-store'
import { useCueEditorStore } from '@/stores/cue-editor-store'
import { beatsOf, gridDurationSeconds } from '@shared/beat-grid'
import type { CueEditorFilter, CueEditorListItem, CueEditorTrack } from '@shared/cue-editor'
import { HOT_CUE_LETTERS } from '@shared/settings'

const ROW_HEIGHT = 48
// Rows a Page Up or Page Down moves: what the list shows at the smallest window.
const PAGE_ROWS = 8

const FILTER_LABELS: Readonly<Record<CueEditorFilter, string>> = {
  all: 'Minden track',
  review: 'Átnézendő',
  noCues: 'Nincs cue'
}

function nameOf(track: { artist: string | null; title: string | null }): string | null {
  return track.artist && track.title ? `${track.artist} – ${track.title}` : null
}

/** True while the keyboard belongs to a field, not to the player. */
function typingInto(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)
  )
}

/** True for a key a focused button or the list takes for itself. */
function keyOfControl(event: KeyboardEvent): boolean {
  const target = event.target
  if (target instanceof HTMLButtonElement) return event.key === ' ' || event.key === 'Enter'
  return target instanceof HTMLElement && target.getAttribute('role') === 'listbox'
}

/** The eight slots: a cue's place and lock, or a button that places an empty one. */
function SlotStrip({
  track,
  selectedSlot,
  placingSlot,
  onSelect,
  onPlace
}: {
  track: CueEditorTrack
  selectedSlot: number | null
  placingSlot: number | null
  onSelect: (slot: number) => void
  onPlace: (slot: number) => void
}): React.JSX.Element {
  return (
    <ul className="grid grid-cols-4 gap-2" aria-label="Hot cue slotok">
      {HOT_CUE_LETTERS.map((letter, index) => {
        const slot = index + 1
        const cue = track.cues.find((each) => each.slot === slot)
        const lockedEmpty = track.lockedEmpty.includes(slot)
        if (!cue) {
          return (
            <li key={letter} className="min-w-0">
              <Button
                className="w-full justify-start gap-1 px-2"
                variant={placingSlot === slot ? 'primary' : 'secondary'}
                aria-pressed={placingSlot === slot}
                aria-label={`+ ${letter}${lockedEmpty ? ', kézzel ürítve' : ''}`}
                title={
                  lockedEmpty ? 'Kézzel ürítve: egy automatikus futás sem tölti ki.' : undefined
                }
                onClick={() => onPlace(slot)}
              >
                {`+ ${letter}`}
                {lockedEmpty && <Lock aria-hidden="true" className="text-text-muted" />}
              </Button>
            </li>
          )
        }
        return (
          <li key={letter} className="min-w-0">
            <Button
              className={cn(
                'w-full justify-start gap-1 overflow-hidden px-2',
                selectedSlot === slot && 'bg-surface-hover'
              )}
              aria-pressed={selectedSlot === slot}
              title={cue.name}
              aria-label={`${letter} ${cue.name} ${formatCueTime(cue.positionMs)}${
                cue.locked ? ', kézzel elhelyezve' : ''
              }`}
              onClick={() => onSelect(slot)}
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: cue.color }}
              />
              <span>{letter}</span>
              <span className="font-mono text-data text-text-muted tabular-nums">
                {formatCueTime(cue.positionMs)}
              </span>
              {cue.locked && <Lock aria-hidden="true" className="text-text-muted" />}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/** The tracks with a grid: one stop for Tab, the arrows move through them. */
function TrackList({
  items,
  trackId,
  onOpen
}: {
  items: readonly CueEditorListItem[]
  trackId: number | null
  onOpen: (index: number) => void
}): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null)
  // The virtualizer's functions change with every scroll and are meant to be called
  // during render; nothing here memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })
  const index = items.findIndex((item) => item.trackId === trackId)

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const last = items.length - 1
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: last,
      PageDown: index + PAGE_ROWS,
      PageUp: index - PAGE_ROWS
    }
    const to = moves[event.key]
    if (to === undefined) return
    event.preventDefault()
    const clamped = Math.min(last, Math.max(0, to))
    virtualizer.scrollToIndex(clamped)
    if (clamped !== index) onOpen(clamped)
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      tabIndex={0}
      aria-label="Trackek"
      aria-activedescendant={index >= 0 ? `cue-track-${items[index]?.trackId}` : undefined}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]
          if (!item) return null
          const chosen = item.trackId === trackId
          return (
            <div
              key={item.trackId}
              id={`cue-track-${item.trackId}`}
              role="option"
              aria-selected={chosen}
              onClick={() => onOpen(row.index)}
              className={cn(
                'absolute inset-x-0 flex cursor-pointer flex-col justify-center rounded-sm border-l-2 px-2',
                chosen
                  ? 'border-primary bg-surface-hover'
                  : 'border-transparent hover:bg-surface-hover'
              )}
              style={{ top: row.start, height: ROW_HEIGHT }}
            >
              <span className="truncate text-small">{item.fileName}</span>
              <span className="flex items-center gap-1 text-small text-text-muted">
                {`${item.cueCount} cue`}
                {item.review && (
                  <>
                    <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
                    <span>Átnézendő</span>
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The cue editor (T-030): the tracks with Rekordbox's grid on the left, the waveform of
 * one with its hot cues on the right. Every change is saved at once and locks its slot,
 * so that no automatic run changes it again; a deleted cue can be put back.
 */
export function CueEditor(): React.JSX.Element {
  const { filter, list, trackId, track, peaks, editFailed, revision, deleted } = useCueEditorStore()
  const setFilter = useCueEditorStore((state) => state.setFilter)
  const loadList = useCueEditorStore((state) => state.loadList)
  const open = useCueEditorStore((state) => state.open)
  const edit = useCueEditorStore((state) => state.edit)
  const undoDelete = useCueEditorStore((state) => state.undoDelete)
  const askedTrackId = useAppStore((state) => state.cueTrackId)
  const setPage = useAppStore((state) => state.setPage)
  // Each of these belongs to the track it was set for: another track starts with none.
  const [selected, setSelected] = React.useState<{ trackId: number; slot: number } | null>(null)
  const [placing, setPlacing] = React.useState<{ trackId: number; slot: number } | null>(null)
  const [playingTrack, setPlayingTrack] = React.useState<number | null>(null)
  const selectedSlot = selected && selected.trackId === trackId ? selected.slot : null
  const placingSlot = placing && placing.trackId === trackId ? placing.slot : null
  const playing = playingTrack !== null && playingTrack === trackId
  const setSelectedSlot = (slot: number | null): void =>
    setSelected(slot === null || trackId === null ? null : { trackId, slot })
  const setPlacingSlot = (slot: number | null): void =>
    setPlacing(slot === null || trackId === null ? null : { trackId, slot })
  const setPlaying = (value: boolean): void => setPlayingTrack(value ? trackId : null)
  const [xmlBusy, setXmlBusy] = React.useState(false)
  const [xmlSaid, setXmlSaid] = React.useState<string | null>(null)
  const player = React.useRef<WaveformPlayer | null>(null)

  React.useEffect(() => {
    void loadList()
  }, [loadList])

  // The track asked for from the preview, or the first of the list.
  const items = list.status === 'ready' ? list.value : []
  React.useEffect(() => {
    if (list.status !== 'ready') return
    const wanted = askedTrackId ?? trackId ?? list.value[0]?.trackId ?? null
    if (wanted !== null && wanted !== trackId) void open(wanted)
  }, [list, askedTrackId, trackId, open])

  const current = track.status === 'ready' ? track.value : null
  const index = items.findIndex((item) => item.trackId === trackId)

  function go(to: number): void {
    const item = items[to]
    if (item) {
      useAppStore.setState({ cueTrackId: item.trackId })
      void open(item.trackId)
    }
  }

  function remove(slot: number): void {
    if (!current) return
    void edit({ type: 'delete', trackId: current.trackId, slot })
    setSelectedSlot(null)
  }

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (typingInto(event.target) || keyOfControl(event) || !current) return
      if (event.key === ' ') {
        event.preventDefault()
        player.current?.playPause()
      } else if (event.key === 'Backspace' && selectedSlot !== null) {
        event.preventDefault()
        remove(selectedSlot)
      } else if (event.key === 'Escape') {
        setPlacingSlot(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function refreshXml(): Promise<void> {
    setXmlSaid(null)
    setXmlBusy(true)
    try {
      const moved = await window.api.rekordbox.wizardAction({ type: 'goTo', step: 'b.writeXml' })
      if (moved.ok) setPage('rekordbox')
      else
        setXmlSaid('Előbb fejezd be a Rekordbox varázsló A fázisát, utána frissítheted az XML-t.')
    } finally {
      setXmlBusy(false)
    }
  }

  const beats = React.useMemo(
    () => (current ? beatsOf(current.grid, gridDurationSeconds(current.durationMs)) : []),
    [current]
  )

  const selectedCue = current?.cues.find((cue) => cue.slot === selectedSlot) ?? null
  const deletedHere = deleted && current && deleted.trackId === current.trackId ? deleted : null

  return (
    <main className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-h1">Cue-k</h1>
          <Button loading={xmlBusy} onClick={() => void refreshXml()}>
            XML frissítése a Rekordboxhoz
          </Button>
        </div>
        <div role="status">{xmlSaid && <StatusLine tone="warning">{xmlSaid}</StatusLine>}</div>
      </div>

      {list.status === 'ready' && list.value.length === 0 && filter === 'all' ? (
        <EmptyState
          message="Nincs track Rekordbox griddel. Előbb a Rekordbox varázsló A fázisa kell."
          action={<Button onClick={() => setPage('rekordbox')}>A Rekordbox varázsló</Button>}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-6">
          <aside className="flex w-64 shrink-0 flex-col gap-2">
            <Select
              label="Szűrő"
              value={filter}
              onChange={(event) => void setFilter(event.target.value as CueEditorFilter)}
            >
              {Object.entries(FILTER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            {list.status === 'loading' || list.status === 'idle' ? (
              <StatusLine tone="neutral">Betöltés…</StatusLine>
            ) : list.status === 'error' ? (
              <div className="flex flex-col gap-2">
                <StatusLine tone="danger">A lista nem tölthető be.</StatusLine>
                <Button onClick={() => void loadList()}>Próbáld újra</Button>
              </div>
            ) : items.length === 0 ? (
              <p className="text-small text-text-muted">Ebben a szűrőben nincs track.</p>
            ) : (
              <>
                <p className="text-small text-text-muted">{`${formatCount(items.length)} track`}</p>
                <TrackList items={items} trackId={trackId} onOpen={go} />
              </>
            )}
          </aside>

          <section className="flex min-w-0 flex-1 flex-col gap-4" aria-label="Szerkesztés">
            {track.status === 'loading' || track.status === 'idle' ? (
              <StatusLine tone="neutral">Betöltés…</StatusLine>
            ) : track.status === 'error' ? (
              <StatusLine tone="danger">
                Ez a track most nem szerkeszthető. Lehet, hogy a lemeze nincs csatlakoztatva.
              </StatusLine>
            ) : current ? (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Előző track"
                    title="Előző track"
                    disabled={index <= 0}
                    onClick={() => go(index - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Következő track"
                    title="Következő track"
                    disabled={index < 0 || index >= items.length - 1}
                    onClick={() => go(index + 1)}
                  >
                    <ChevronRight />
                  </Button>
                  <div className="min-w-0">
                    <h2 className="truncate text-h2">{current.fileName}</h2>
                    {nameOf(current) && (
                      <p className="truncate text-small text-text-muted">{nameOf(current)}</p>
                    )}
                  </div>
                </div>

                {peaks.status === 'ready' ? (
                  <div className="flex flex-col gap-2">
                    <Waveform
                      key={current.trackId}
                      url={`fixlib-audio://track/${current.trackId}`}
                      peaks={peaks.value.peaks}
                      durationSeconds={peaks.value.durationSeconds}
                      beats={beats}
                      cues={current.cues}
                      selectedSlot={selectedSlot}
                      placing={placingSlot !== null}
                      revision={revision}
                      onSelect={setSelectedSlot}
                      onMove={(slot, atMs, snap) =>
                        void edit({ type: 'place', trackId: current.trackId, slot, atMs, snap })
                      }
                      onPlace={(atMs, snap) => {
                        if (placingSlot === null) return
                        void edit({
                          type: 'place',
                          trackId: current.trackId,
                          slot: placingSlot,
                          atMs,
                          snap
                        })
                        setPlacingSlot(null)
                      }}
                      onPlayingChange={setPlaying}
                      onReady={(controls) => {
                        player.current = controls
                      }}
                    />
                    {peaks.value.truncated && (
                      <StatusLine tone="neutral">
                        A waveform az első 20 percet mutatja, a track ennél hosszabb.
                      </StatusLine>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        size="icon"
                        aria-label={playing ? 'Szünet' : 'Lejátszás'}
                        title={playing ? 'Szünet' : 'Lejátszás'}
                        onClick={() => player.current?.playPause()}
                      >
                        {playing ? <Pause /> : <Play />}
                      </Button>
                      <p className="max-w-xl text-small text-text-muted">
                        Húzd a cue-t: a legközelebbi beatre kerül, Shifttel a bar elejére. Szóköz:
                        lejátszás és szünet.
                      </p>
                    </div>
                  </div>
                ) : peaks.status === 'error' ? (
                  <div className="flex flex-col items-start gap-2">
                    <StatusLine tone="danger">
                      {`A waveform nem készíthető el. ${errorMessage(peaks.code ?? 'UNEXPECTED')}`}
                    </StatusLine>
                    <Button onClick={() => void open(current.trackId)}>Próbáld újra</Button>
                  </div>
                ) : (
                  <StatusLine tone="neutral">A waveform készül…</StatusLine>
                )}

                <SlotStrip
                  track={current}
                  selectedSlot={selectedSlot}
                  placingSlot={placingSlot}
                  onSelect={(slot) => {
                    setSelectedSlot(slot)
                    // Chosen to be edited: the cursor goes there, and plays on if it was playing.
                    const cue = current.cues.find((each) => each.slot === slot)
                    if (cue && player.current) {
                      if (player.current.isPlaying()) player.current.playFrom(cue.positionMs / 1000)
                      else player.current.seek(cue.positionMs / 1000)
                    }
                  }}
                  onPlace={(slot) => setPlacingSlot(placingSlot === slot ? null : slot)}
                />

                <div className="flex flex-wrap items-center gap-2">
                  {placingSlot !== null && (
                    <p className="text-small text-text-muted">
                      {`Kattints a waveformra, ahová a ${HOT_CUE_LETTERS[placingSlot - 1]} cue kerüljön, vagy Enter a lejátszás helyén. Esc: mégse.`}
                    </p>
                  )}
                  {selectedCue && (
                    <>
                      <Button onClick={() => remove(selectedCue.slot)}>
                        {`${HOT_CUE_LETTERS[selectedCue.slot - 1]} törlése`}
                      </Button>
                      {selectedCue.locked && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void edit({
                              type: 'release',
                              trackId: current.trackId,
                              slot: selectedCue.slot
                            })
                          }
                        >
                          Vissza az automatikusra
                        </Button>
                      )}
                    </>
                  )}
                  {deletedHere && selectedCue === null && (
                    <Button variant="ghost" onClick={() => void undoDelete()}>
                      {`${HOT_CUE_LETTERS[deletedHere.slot - 1]} visszavonása`}
                    </Button>
                  )}
                  {selectedSlot === null &&
                    current.lockedEmpty.length > 0 &&
                    placingSlot === null && (
                      <p className="text-small text-text-muted">
                        A lakattal jelölt üres slotokat egy automatikus futás sem tölti ki.
                      </p>
                    )}
                </div>
                <div role="status">
                  {editFailed && (
                    <StatusLine tone="danger">
                      {editFailed === 'INVALID_INPUT'
                        ? 'Ez a hely nincs a griden. Próbáld a track hosszán belül.'
                        : errorMessage(editFailed)}
                    </StatusLine>
                  )}
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </main>
  )
}
