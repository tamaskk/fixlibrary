import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  CircleHelp,
  FileQuestion,
  Image,
  ImageOff,
  Unplug,
  type LucideIcon
} from 'lucide-react'
import { formatDecimal } from '@/lib/format'
import { trackState, type LibraryView, type SortKey, type TrackState } from '@/lib/library-view'
import type { SelectModifiers, Selection } from '@/lib/selection'
import type { LibraryTrack, TrackCoverStatus } from '@shared/library'
import type { Style } from '@shared/settings'

// DESIGN_SYSTEM §04: table rows are 36px high.
const ROW_HEIGHT = 36
// Fixed columns are multiples of 32px; artist and title share what is left. At the
// minimum window (1024px) every column fits; below its minimum width the table
// scrolls sideways inside itself.
const COLUMNS = '32px 32px minmax(96px, 2fr) minmax(128px, 3fr) 64px 64px 64px 96px 96px'
const MIN_TABLE_WIDTH = 752

// The state comes first, so it is never the column that is scrolled out of sight.
const HEADERS: readonly { label: string; sortKey?: SortKey; numeric?: boolean; hidden?: true }[] = [
  { label: 'Állapot', hidden: true },
  { label: 'Cover', hidden: true },
  { label: 'Artist', sortKey: 'artist' },
  { label: 'Title', sortKey: 'title' },
  { label: 'BPM', sortKey: 'bpm', numeric: true },
  { label: 'Key', sortKey: 'key' },
  { label: 'Energy', sortKey: 'energy', numeric: true },
  { label: 'Stílus', sortKey: 'style' },
  { label: 'Formátum', sortKey: 'format' }
]

const COVERS: Record<TrackCoverStatus, { icon: LucideIcon; label: string; className: string }> = {
  embedded: { icon: Image, label: 'Van beágyazott cover', className: 'text-text-muted' },
  placeholder: { icon: Image, label: 'Generált cover', className: 'text-text-muted' },
  missing: { icon: ImageOff, label: 'Nincs cover', className: 'text-text-muted' },
  unknown: { icon: CircleHelp, label: 'A cover nem ismert', className: 'text-text-muted' }
}

const STATES: Record<TrackState, { icon: LucideIcon; label: string; className: string }> = {
  ok: { icon: Check, label: 'Beolvasva', className: 'text-success' },
  offline: {
    icon: Unplug,
    label: 'Offline: a lemez nincs csatlakoztatva',
    className: 'text-text-muted'
  },
  missing: { icon: FileQuestion, label: 'A fájl nincs a mappában', className: 'text-text-muted' },
  unreadable: { icon: CircleAlert, label: 'A fájl nem olvasható', className: 'text-danger-text' }
}

type LibraryTableProps = {
  rows: readonly LibraryTrack[]
  styles: readonly Style[]
  selection: Selection
  sort: LibraryView['sort']
  onSort: (key: SortKey) => void
  onSelect: (id: number, modifiers: SelectModifiers) => void
  onSelectAll: () => void
  onClearSelection: () => void
}

function IconCell({
  icon: Icon,
  label,
  className
}: {
  icon: LucideIcon
  label: string
  className: string
}): React.JSX.Element {
  return (
    <span role="img" aria-label={label} title={label} className={cn('flex', className)}>
      <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
    </span>
  )
}

/** A cell that cuts its text with an ellipsis and shows all of it in a tooltip. */
function TextCell({
  text,
  className
}: {
  text: string | null
  className?: string
}): React.JSX.Element {
  return (
    <span role="gridcell" title={text ?? undefined} className={cn('truncate', className)}>
      {text ?? <span className="text-text-muted">–</span>}
    </span>
  )
}

export function LibraryTable({
  rows,
  styles,
  selection,
  sort,
  onSort,
  onSelect,
  onSelectAll,
  onClearSelection
}: LibraryTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const gridId = React.useId()
  // The row the arrow keys move from. It follows the mouse as well.
  const [cursorId, setCursorId] = React.useState<number | null>(null)
  const styleNames = React.useMemo(
    () => new Map(styles.map((style) => [style.id, style.name])),
    [styles]
  )

  // The virtualizer's functions change with every scroll and are meant to be called
  // during render; nothing here memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  const cursorIndex = cursorId === null ? -1 : rows.findIndex((row) => row.id === cursorId)

  function moveCursor(index: number, extend: boolean): void {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)]
    if (!row) return
    setCursorId(row.id)
    onSelect(row.id, { range: extend, toggle: false })
    virtualizer.scrollToIndex(rows.indexOf(row))
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // Keys pressed in a header button belong to that button.
    if (event.target !== event.currentTarget) return
    const pageSize = Math.max(
      1,
      Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1
    )
    const moves: Record<string, number> = {
      ArrowDown: cursorIndex + 1,
      ArrowUp: cursorIndex === -1 ? 0 : cursorIndex - 1,
      PageDown: cursorIndex + pageSize,
      PageUp: cursorIndex - pageSize,
      Home: 0,
      End: rows.length - 1
    }
    const target = moves[event.key]
    if (target !== undefined) {
      event.preventDefault()
      moveCursor(target, event.shiftKey)
    } else if (event.key === 'a' && event.metaKey) {
      event.preventDefault()
      onSelectAll()
    } else if (event.key === 'Escape') {
      onClearSelection()
    }
  }

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label="Trackek"
      aria-multiselectable="true"
      aria-rowcount={rows.length + 1}
      aria-colcount={HEADERS.length}
      aria-activedescendant={cursorIndex === -1 ? undefined : `${gridId}-${cursorId}`}
      onKeyDown={handleKeyDown}
      className="min-h-48 flex-1 overflow-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div style={{ minWidth: MIN_TABLE_WIDTH }}>
        <div role="rowgroup" className="sticky top-0 z-10">
          <div
            role="row"
            aria-rowindex={1}
            className="grid h-9 items-center gap-2 border-b border-border bg-surface px-2"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            {HEADERS.map(({ label, sortKey, numeric, hidden }) => {
              const sorted = sortKey !== undefined && sort?.key === sortKey
              const SortIcon = sorted && sort.descending ? ArrowDown : ArrowUp
              return (
                <div
                  key={label}
                  role="columnheader"
                  aria-sort={sorted ? (sort.descending ? 'descending' : 'ascending') : undefined}
                  className={cn(
                    'flex min-w-0 text-label text-text-muted uppercase',
                    numeric && 'justify-end'
                  )}
                >
                  {sortKey === undefined ? (
                    <span className={cn(hidden && 'sr-only')}>{label}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSort(sortKey)}
                      className={cn(
                        'flex h-7 min-w-0 items-center gap-1 rounded-sm uppercase transition-colors duration-150 ease-out hover:text-text focus-visible:outline-2 focus-visible:outline-primary',
                        sorted && 'text-text'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {sorted && (
                        <SortIcon
                          className="size-4 shrink-0"
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            const selected = selection.ids.has(row.id)
            const state = trackState(row)
            const unavailable = state === 'offline' || state === 'missing'
            return (
              <div
                key={row.id}
                id={`${gridId}-${row.id}`}
                role="row"
                aria-rowindex={item.index + 2}
                aria-selected={selected}
                title={`${row.folder}/${row.fileName}`}
                onClick={(event) => {
                  setCursorId(row.id)
                  onSelect(row.id, { range: event.shiftKey, toggle: event.metaKey })
                }}
                className={cn(
                  'absolute inset-x-0 top-0 grid cursor-default items-center gap-2 border-b border-l-2 border-border border-l-transparent px-2 text-body select-none',
                  selected ? 'border-l-primary bg-surface-hover' : 'hover:bg-surface',
                  row.id === cursorId && 'outline-1 -outline-offset-1 outline-border',
                  unavailable && 'text-text-muted'
                )}
                style={{
                  height: ROW_HEIGHT,
                  gridTemplateColumns: COLUMNS,
                  transform: `translateY(${item.start}px)`
                }}
              >
                <span role="gridcell" className="flex">
                  <IconCell {...STATES[state]} />
                </span>
                <span role="gridcell" className="flex">
                  <IconCell {...COVERS[row.coverStatus]} />
                </span>
                <TextCell text={row.artist} />
                <TextCell
                  text={row.title ?? row.fileName}
                  className={cn(row.title === null && 'text-text-muted')}
                />
                <TextCell
                  text={row.bpm === null ? null : formatDecimal(row.bpm)}
                  className="text-right font-mono text-data tabular-nums"
                />
                <TextCell text={row.camelotKey} className="font-mono text-data tabular-nums" />
                <TextCell
                  text={row.energy === null ? null : String(row.energy)}
                  className="text-right font-mono text-data tabular-nums"
                />
                <TextCell
                  text={row.styleId === null ? null : (styleNames.get(row.styleId) ?? null)}
                />
                <TextCell text={row.format.toUpperCase()} className="text-small text-text-muted" />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
