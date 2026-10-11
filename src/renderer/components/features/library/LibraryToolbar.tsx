import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { formatCount } from '@/lib/format'
import { TRACK_STATES, type LibraryView, type TrackState } from '@/lib/library-view'
import type { Style } from '@shared/settings'

const TRACK_STATE_LABELS: Record<TrackState, string> = {
  ok: 'Rendben',
  offline: 'Offline',
  missing: 'Hiányzó fájl',
  unreadable: 'Nem olvasható'
}

type LibraryToolbarProps = {
  view: LibraryView
  styles: readonly Style[]
  shownCount: number
  totalCount: number
  onChange: (changes: Partial<LibraryView>) => void
}

function parseStyle(value: string): LibraryView['style'] {
  return value === 'all' || value === 'none' ? value : Number(value)
}

function parseState(value: string): LibraryView['state'] {
  return TRACK_STATES.find((state) => state === value) ?? 'all'
}

export function LibraryToolbar({
  view,
  styles,
  shownCount,
  totalCount,
  onChange
}: LibraryToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-end gap-4">
      <div className="w-64">
        <Input
          label="Keresés"
          type="search"
          placeholder="Artist, title vagy fájlnév"
          value={view.search}
          onChange={(event) => onChange({ search: event.target.value })}
        />
      </div>
      <div className="w-48">
        <Select
          label="Stílus"
          value={String(view.style)}
          onChange={(event) => onChange({ style: parseStyle(event.target.value) })}
        >
          <option value="all">Minden stílus</option>
          <option value="none">Stílus nélkül</option>
          {styles.map((style) => (
            <option key={style.id} value={style.id}>
              {style.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-48">
        <Select
          label="Állapot"
          value={view.state}
          onChange={(event) => onChange({ state: parseState(event.target.value) })}
        >
          <option value="all">Minden állapot</option>
          {TRACK_STATES.map((state) => (
            <option key={state} value={state}>
              {TRACK_STATE_LABELS[state]}
            </option>
          ))}
        </Select>
      </div>
      <p className="ml-auto flex h-8 items-center gap-1 text-small text-text-muted">
        <span className="font-mono text-data text-text tabular-nums">
          {shownCount === totalCount
            ? formatCount(totalCount)
            : `${formatCount(shownCount)} / ${formatCount(totalCount)}`}
        </span>{' '}
        track
      </p>
    </div>
  )
}
