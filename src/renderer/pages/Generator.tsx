import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Replace, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { Textarea } from '@/components/ui/textarea'
import { EnergyChart } from '@/components/features/generator/EnergyChart'
import { EnergyCurveEditor } from '@/components/features/generator/EnergyCurveEditor'
import { Data } from '@/components/features/playlists/DataText'
import { OnlineRecList } from '@/components/features/playlists/OnlineRecList'
import { PlayButton, TrackFacts, TrackName } from '@/components/features/playlists/TrackParts'
import { nameOf } from '@/lib/track-name'
import { formatCount, formatDecimal, formatElapsed, parseDecimal } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { useTrackPlayer, type TrackPlayer } from '@/lib/use-track-player'
import { paramsChanged, useGeneratorStore } from '@/stores/generator-store'
import { DEFAULT_CUSTOM_CURVE, type EnergyProfile } from '@shared/energy-curves'
import {
  MAX_BPM,
  MAX_GENERATOR_STYLES,
  MAX_PROMPT_LENGTH,
  MAX_SET_MINUTES,
  MAX_SET_TRACKS,
  MIN_BPM,
  MIN_SET_MINUTES,
  MIN_SET_TRACKS,
  type GapTarget,
  type GeneratedEntry
} from '@shared/generator'
import { MAX_MOOD_TAGS, MOOD_TAGS } from '@shared/mood'
import { MAX_PLAYLIST_NAME } from '@shared/playlists'

const ROW_HEIGHT = 48

const PROFILE_LABELS: Record<EnergyProfile, string> = {
  warmUp: 'Warm-up',
  peakTime: 'Peak time',
  sunset: 'Sunset',
  closing: 'Closing',
  custom: 'Saját görbe'
}

function gapText(target: GapTarget): string {
  return [
    target.styleName ?? 'bármilyen stílus',
    target.bpm === null ? null : `${Math.round(target.bpm)} BPM`,
    target.camelotKey,
    `E${formatDecimal(target.energy)}`
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** What a gap should be like, its numbers in the Data role. */
function GapFacts({ target }: { target: GapTarget }): React.JSX.Element {
  return (
    <>
      {target.styleName ?? 'bármilyen stílus'}
      {target.bpm !== null && (
        <>
          {' · '}
          <Data>{Math.round(target.bpm)}</Data> BPM
        </>
      )}
      {target.camelotKey !== null && (
        <>
          {' · '}
          <Data>{target.camelotKey}</Data>
        </>
      )}
      {' · '}
      <Data>E{formatDecimal(target.energy)}</Data>
    </>
  )
}

/** A whole number typed in a field, or null while it is not one. */
function wholeOf(text: string): number | null {
  const value = parseDecimal(text)
  return value === null ? null : Math.round(value)
}

function PromptCard(): React.JSX.Element {
  const prompt = useGeneratorStore((state) => state.prompt)
  const setPrompt = useGeneratorStore((state) => state.setPrompt)
  const parsePrompt = useGeneratorStore((state) => state.parsePrompt)
  const parsing = useGeneratorStore((state) => state.parsing)
  const failure = useGeneratorStore((state) => state.promptFailure)
  const unknownStyles = useGeneratorStore((state) => state.unknownStyles)

  return (
    <Card>
      <CardTitle>Prompt</CardTitle>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void parsePrompt()
        }}
      >
        <Textarea
          label="Milyen set legyen?"
          placeholder="2 órás sunset set, Organic House-ból Afro House-ba, 118–124 BPM"
          maxLength={MAX_PROMPT_LENGTH}
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <Button type="submit" loading={parsing} disabled={prompt.trim() === ''}>
          <Wand2 />
          Mezők kitöltése
        </Button>
        <div role="status" className="flex flex-col gap-1">
          {failure && <StatusLine tone="danger">{errorMessage(failure)}</StatusLine>}
          {unknownStyles.length > 0 && (
            <StatusLine tone="neutral">
              Ezek a stílusok nincsenek a listádban: {unknownStyles.join(', ')}.
            </StatusLine>
          )}
        </div>
      </form>
    </Card>
  )
}

function StyleOrder(): React.JSX.Element {
  const styles = useGeneratorStore((state) => state.styles)
  const styleIds = useGeneratorStore((state) => state.params.styleIds)
  const setParams = useGeneratorStore((state) => state.setParams)
  const nameOfStyle = new Map((styles ?? []).map((style) => [style.id, style.name]))
  const left = (styles ?? []).filter((style) => !styleIds.includes(style.id))

  function moveStyle(index: number, direction: -1 | 1): void {
    const next = [...styleIds]
    const other = next[index + direction]
    const own = next[index]
    if (other === undefined || own === undefined) return
    next[index] = other
    next[index + direction] = own
    setParams({ styleIds: next })
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-label text-text-muted uppercase">Stílusok sorrendben</span>
      {styleIds.length === 0 ? (
        <p className="text-small text-text-muted">Nincs megadva: bármilyen stílus jöhet.</p>
      ) : (
        <ol className="flex flex-col">
          {styleIds.map((id, index) => {
            const name = nameOfStyle.get(id) ?? 'Törölt stílus'
            return (
              <li key={id} className="flex h-8 items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-body">
                  <Data>{index + 1}.</Data> {name}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${name} feljebb`}
                  disabled={index === 0}
                  onClick={() => moveStyle(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${name} lejjebb`}
                  disabled={index === styleIds.length - 1}
                  onClick={() => moveStyle(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${name} eltávolítása`}
                  onClick={() => setParams({ styleIds: styleIds.filter((each) => each !== id) })}
                >
                  <X />
                </Button>
              </li>
            )
          })}
        </ol>
      )}
      <Select
        label="Stílus hozzáadása"
        value=""
        disabled={left.length === 0 || styleIds.length >= MAX_GENERATOR_STYLES}
        onChange={(event) => {
          const id = Number(event.target.value)
          if (id > 0) setParams({ styleIds: [...styleIds, id] })
        }}
      >
        <option value="">
          {styleIds.length >= MAX_GENERATOR_STYLES
            ? `Legfeljebb ${MAX_GENERATOR_STYLES} stílus`
            : 'Válassz…'}
        </option>
        {left.map((style) => (
          <option key={style.id} value={style.id}>
            {style.name}
          </option>
        ))}
      </Select>
    </div>
  )
}

/** A number field that keeps what is typed and passes on only what is a number in range. */
function NumberField({
  label,
  value,
  min,
  max,
  onValue
}: {
  label: string
  value: number
  min: number
  max: number
  onValue: (value: number) => void
}): React.JSX.Element {
  const [text, setText] = React.useState(String(value))
  const [shown, setShown] = React.useState(value)
  // A value set from elsewhere (the prompt) replaces what was typed.
  if (shown !== value) {
    setShown(value)
    setText(String(value))
  }
  const typed = wholeOf(text)
  const wrong = typed === null || typed < min || typed > max
  return (
    <Input
      label={label}
      inputMode="numeric"
      value={text}
      error={wrong ? `${min} és ${max} között` : undefined}
      onChange={(event) => {
        setText(event.target.value)
        const next = wholeOf(event.target.value)
        if (next !== null && next >= min && next <= max) {
          setShown(next)
          onValue(next)
        }
      }}
    />
  )
}

function ParamsCard(): React.JSX.Element {
  const params = useGeneratorStore((state) => state.params)
  const setParams = useGeneratorStore((state) => state.setParams)
  const generate = useGeneratorStore((state) => state.generate)
  const generating = useGeneratorStore((state) => state.generating)
  const stylesFailed = useGeneratorStore((state) => state.stylesFailed)
  const styles = useGeneratorStore((state) => state.styles)
  const loadStyles = useGeneratorStore((state) => state.loadStyles)
  const { length, bpmRange } = params
  const minutes = length.unit === 'minutes'

  return (
    <Card>
      <CardTitle>Paraméterek</CardTitle>
      <div className="flex flex-col gap-4">
        {stylesFailed ? (
          <div role="status" className="flex flex-col items-start gap-2">
            <StatusLine tone="danger">A stílusok nem tölthetők be.</StatusLine>
            <Button onClick={() => void loadStyles()}>Próbáld újra</Button>
          </div>
        ) : styles === null ? (
          <p className="text-small text-text-muted">Betöltés…</p>
        ) : (
          <StyleOrder />
        )}
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Hossz"
            value={length.unit}
            onChange={(event) =>
              setParams({
                length:
                  event.target.value === 'tracks'
                    ? { unit: 'tracks', value: 20 }
                    : { unit: 'minutes', value: 60 }
              })
            }
          >
            <option value="minutes">Perc</option>
            <option value="tracks">Track</option>
          </Select>
          <NumberField
            label={minutes ? 'Perc' : 'Track'}
            value={length.value}
            min={minutes ? MIN_SET_MINUTES : MIN_SET_TRACKS}
            max={minutes ? MAX_SET_MINUTES : MAX_SET_TRACKS}
            onValue={(value) => setParams({ length: { unit: length.unit, value } })}
          />
          {minutes && (
            <p className="col-span-2 text-small text-text-muted">A trackek teljes hossza számít.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="BPM-től"
            value={bpmRange[0]}
            min={MIN_BPM}
            max={bpmRange[1]}
            onValue={(low) => setParams({ bpmRange: [low, bpmRange[1]] })}
          />
          <NumberField
            label="BPM-ig"
            value={bpmRange[1]}
            min={bpmRange[0]}
            max={MAX_BPM}
            onValue={(high) => setParams({ bpmRange: [bpmRange[0], high] })}
          />
        </div>
        <Select
          label="Energy görbe"
          value={params.energyProfile}
          onChange={(event) => setParams({ energyProfile: event.target.value as EnergyProfile })}
        >
          {Object.entries(PROFILE_LABELS).map(([profile, label]) => (
            <option key={profile} value={profile}>
              {label}
            </option>
          ))}
        </Select>
        {params.energyProfile === 'custom' && (
          <EnergyCurveEditor
            points={params.customCurve ?? DEFAULT_CUSTOM_CURVE}
            onChange={(customCurve) => setParams({ customCurve })}
          />
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-label text-text-muted uppercase">
            Hangulat (legfeljebb {MAX_MOOD_TAGS})
          </legend>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            {MOOD_TAGS.map((mood) => {
              const checked = params.moods.includes(mood)
              return (
                <label key={mood} className="flex h-8 items-center gap-2 text-body">
                  <Checkbox
                    aria-label={mood}
                    checked={checked}
                    disabled={!checked && params.moods.length >= MAX_MOOD_TAGS}
                    onCheckedChange={(on) =>
                      setParams({
                        moods:
                          on === true
                            ? [...params.moods, mood]
                            : params.moods.filter((each) => each !== mood)
                      })
                    }
                  />
                  {mood}
                </label>
              )
            })}
          </div>
        </fieldset>
        <Button variant="primary" loading={generating} onClick={() => void generate()}>
          Generálás
        </Button>
      </div>
    </Card>
  )
}

function EntryRow({
  entry,
  index,
  player
}: {
  entry: GeneratedEntry
  index: number
  player: TrackPlayer
}): React.JSX.Element {
  const openSwap = useGeneratorStore((state) => state.openSwap)
  const requestGap = useGeneratorStore((state) => state.requestGap)
  if (entry.kind === 'gap') {
    return (
      <>
        <span className="w-8 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body text-warning">Hiány</span>
          <span className="truncate text-small text-text-muted">
            <GapFacts target={entry.target} />
          </span>
        </span>
        <Button onClick={() => void requestGap(index)}>Online ajánlás</Button>
      </>
    )
  }
  return (
    <>
      <PlayButton item={entry.item} player={player} />
      <TrackName item={entry.item} />
      <TrackFacts item={entry.item} />
      <Button aria-label={`${nameOf(entry.item)} cseréje`} onClick={() => void openSwap(index)}>
        <Replace />
        Csere
      </Button>
    </>
  )
}

function EntryList({
  entries,
  player
}: {
  entries: readonly GeneratedEntry[]
  player: TrackPlayer
}): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // The virtualizer's functions change with every scroll and are meant to be called
  // during render; nothing here memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8
  })
  return (
    <div
      ref={scrollRef}
      role="list"
      tabIndex={0}
      aria-label="A generált lista"
      className="max-h-96 overflow-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div role="presentation" className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entry = entries[row.index]
          if (!entry) return null
          return (
            <div
              key={row.index}
              role="listitem"
              aria-setsize={entries.length}
              aria-posinset={row.index + 1}
              className="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-border"
              style={{ height: ROW_HEIGHT, transform: `translateY(${row.start}px)` }}
            >
              <span className="w-6 shrink-0 text-right text-text-muted">
                <Data>{row.index + 1}</Data>
              </span>
              <EntryRow entry={entry} index={row.index} player={player} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SwapDialog({ player }: { player: TrackPlayer }): React.JSX.Element {
  const swap = useGeneratorStore((state) => state.swap)
  const closeSwap = useGeneratorStore((state) => state.closeSwap)
  const swapIn = useGeneratorStore((state) => state.swapIn)
  return (
    <Dialog open={swap !== null} onOpenChange={(open) => !open && closeSwap()}>
      <DialogContent
        title="Csere"
        description="Ezek a trackek keverhetők a két szomszédjukkal, és illenek erre a helyre."
      >
        <div role="status">
          {swap?.failure && <StatusLine tone="danger">{errorMessage(swap.failure)}</StatusLine>}
          {swap !== null && swap.items === null && !swap.failure && (
            <StatusLine tone="neutral">Keresés…</StatusLine>
          )}
        </div>
        {swap?.items?.length === 0 && (
          <p className="text-body text-text-muted">
            Nincs más track, ami ide illene. Bővítsd a BPM tartományt, vagy cseréld a szomszédait.
          </p>
        )}
        {swap?.items && swap.items.length > 0 && (
          <ul className="flex flex-col">
            {swap.items.map((item) => (
              <li
                key={item.trackId}
                className="flex min-h-12 items-center gap-2 border-b border-border py-1 last:border-b-0"
              >
                <PlayButton item={item} player={player} />
                <TrackName item={item} />
                <TrackFacts item={item} />
                <Button
                  aria-label={`${nameOf(item)} beválasztása`}
                  onClick={() => swapIn(swap.index, item)}
                >
                  Beválasztás
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button>Mégse</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GapDialog(): React.JSX.Element {
  const gap = useGeneratorStore((state) => state.gap)
  const entry = useGeneratorStore((state) =>
    gap === null ? undefined : state.result?.entries[gap.index]
  )
  const downloadGap = useGeneratorStore((state) => state.downloadGap)
  const close = (): void => useGeneratorStore.setState({ gap: null })
  return (
    <Dialog open={gap !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        title="Online ajánlás a hiányra"
        description={
          entry?.kind === 'gap'
            ? `Ilyen track kellene: ${gapText(entry.target)}. Claude javaslatai, a YouTube-on ellenőrizve.`
            : ''
        }
      >
        <div role="status">
          {gap?.loading && (
            <StatusLine tone="neutral">Keresés… Ez egy percig is tarthat.</StatusLine>
          )}
          {gap?.failure && <StatusLine tone="danger">{errorMessage(gap.failure)}</StatusLine>}
        </div>
        {gap?.items?.length === 0 && (
          <p className="text-body text-text-muted">
            Most nincs olyan javaslat, ami megvan a YouTube-on, és még nincs a könyvtárban.
          </p>
        )}
        {gap?.items && gap.items.length > 0 && (
          <OnlineRecList
            items={gap.items}
            rows={gap.rows}
            startedNote="Letöltés indult. Az Inbox jóváhagyása után a könyvtárba kerül, és a következő generáláskor már választható."
            onDownload={downloadGap}
          />
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button>Bezárás</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SaveForm(): React.JSX.Element {
  const save = useGeneratorStore((state) => state.save)
  const saving = useGeneratorStore((state) => state.saving)
  const saved = useGeneratorStore((state) => state.saved)
  const [name, setName] = React.useState('')
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void save(name).then((ok) => ok && setName(''))
      }}
    >
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Playlist neve"
            maxLength={MAX_PLAYLIST_NAME}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" loading={saving} disabled={name.trim() === ''}>
          Mentés playlistként
        </Button>
      </div>
      <div role="status">
        {saved?.ok === true && (
          <StatusLine tone="success">
            Elmentve: {saved.name}.
            {saved.skipped > 0 && ` ${formatCount(saved.skipped)} track kimaradt.`} A hiányok nélkül
            került a Playlistek közé.
          </StatusLine>
        )}
        {saved?.ok === false && <StatusLine tone="danger">{errorMessage(saved.code)}</StatusLine>}
      </div>
    </form>
  )
}

function ResultPanel(): React.JSX.Element {
  const result = useGeneratorStore((state) => state.result)
  const generatedWith = useGeneratorStore((state) => state.generatedWith)
  const generating = useGeneratorStore((state) => state.generating)
  const failed = useGeneratorStore((state) => state.generateFailed)
  const params = useGeneratorStore((state) => state.params)
  const generate = useGeneratorStore((state) => state.generate)
  const player = useTrackPlayer()
  const tracks = result?.entries.filter((entry) => entry.kind === 'track').length ?? 0

  return (
    <div className="flex flex-col gap-4">
      {result !== null && (
        <p className="flex flex-wrap gap-x-4 text-small text-text-muted">
          <span>
            <Data>{formatCount(tracks)}</Data> track
          </span>
          <span>
            Hossz: <Data>{result.totalMs > 0 ? formatElapsed(result.totalMs) : '–'}</Data>
          </span>
          <span>
            Hiány: <Data>{formatCount(result.gaps)}</Data>
          </span>
        </p>
      )}
      {/* One live region, there before anything is said in it. */}
      <div role="status" className="flex flex-col items-start gap-2">
        {generating && <StatusLine tone="neutral">Generálás…</StatusLine>}
        {failed && (
          <>
            <StatusLine tone="danger">A lista nem generálható.</StatusLine>
            <Button onClick={() => void generate()}>Próbáld újra</Button>
          </>
        )}
        {result !== null && generatedWith !== null && paramsChanged(params, generatedWith) && (
          <StatusLine tone="neutral">
            A paraméterek változtak a generálás óta. A lista és a csere a régiek szerint megy, amíg
            nem generálsz újra.
          </StatusLine>
        )}
        {result !== null && tracks === 0 && (
          <StatusLine tone="neutral">
            Nincs elemzett track ebben a BPM tartományban. Bővítsd a tartományt, vagy futtasd a BPM,
            key és energy elemzést.
          </StatusLine>
        )}
        {result !== null && tracks > 0 && result.gaps > 0 && (
          <StatusLine tone="warning">
            {formatCount(result.gaps)} helyre nincs keverhető track a könyvtárban. Bővítsd a BPM
            tartományt, vagy kérj online ajánlást a hiányokra.
          </StatusLine>
        )}
        {player.failed && (
          <StatusLine tone="danger">
            A fájl nem játszható le. Lehet, hogy a lemeze nincs csatlakoztatva.
          </StatusLine>
        )}
      </div>
      {result === null && !generating && !failed && (
        <EmptyState message="Még nincs generált lista. Add meg a paramétereket, és nyomd meg a Generálás gombot." />
      )}
      {result !== null && generatedWith !== null && result.entries.length > 0 && (
        <>
          <EntryList entries={result.entries} player={player} />
          <EnergyChart
            profile={generatedWith.energyProfile}
            curve={generatedWith.customCurve}
            entries={result.entries}
          />
          <SaveForm />
        </>
      )}
      <SwapDialog player={player} />
      <GapDialog />
    </div>
  )
}

export function Generator(): React.JSX.Element {
  const loadStyles = useGeneratorStore((state) => state.loadStyles)

  React.useEffect(() => {
    void loadStyles()
  }, [loadStyles])

  return (
    <main className="flex h-full flex-col gap-6 overflow-auto p-6">
      <h1 className="text-h1">Generátor</h1>
      <div className="flex min-w-0 gap-6">
        <div className="flex w-80 shrink-0 flex-col gap-6">
          <PromptCard />
          <ParamsCard />
        </div>
        <div className="min-w-0 flex-1">
          <Card>
            <CardTitle>Generált lista</CardTitle>
            <ResultPanel />
          </Card>
        </div>
      </div>
    </main>
  )
}
