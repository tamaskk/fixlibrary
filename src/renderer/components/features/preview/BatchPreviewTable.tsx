import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Check, CircleAlert, type LucideIcon } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/messages'
import { WARNING_LABELS } from '@/lib/preview-labels'
import type { EditablePreviewField, PreviewRow, PreviewValue } from '@shared/preview'
import type { Style } from '@shared/settings'
import { CellEditor } from './CellEditor'
import type { PreviewColumn, PreviewColumnContext } from './preview-columns'

// DESIGN_SYSTEM §04: table rows are 36px high.
const ROW_HEIGHT = 36
// The checkbox and the state come first, so they are never scrolled out of sight.
const LEADING_COLUMNS = '32px 32px'
const LEADING_WIDTH = 32 + 32
const COLUMN_GAP = 8
// The padding of a row and its left edge.
const ROW_INSET = 18
// DESIGN_SYSTEM §06: the least needed column joins from this width on.
const WIDE_FROM_WIDTH = 896

type BatchPreviewTableProps = {
  /** Names the table for assistive technology. */
  label: string
  rows: readonly PreviewRow[]
  columns: readonly PreviewColumn[]
  styles: readonly Style[]
  /** Resolves to false when the value was not taken. */
  onEdit: (trackId: number, field: EditablePreviewField, value: PreviewValue) => Promise<boolean>
  onSetExcluded: (trackId: number, excluded: boolean) => void
}

function rowState(row: PreviewRow): { icon: LucideIcon; label: string; className: string } {
  if (row.error) {
    return {
      icon: CircleAlert,
      label: `Kimaradt: ${errorMessage(row.error.code)}`,
      className: 'text-danger-text'
    }
  }
  if (row.warnings.length > 0) {
    return {
      icon: AlertTriangle,
      label: row.warnings.map((warning) => WARNING_LABELS[warning]).join(' · '),
      className: 'text-warning'
    }
  }
  return { icon: Check, label: 'Nincs figyelmeztetés', className: 'text-success' }
}

export function BatchPreviewTable({
  label,
  rows,
  columns: allColumns,
  styles,
  onEdit,
  onSetExcluded
}: BatchPreviewTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // Measured here: the virtualizer only reports a change of the height it scrolls in.
  const [tableWidth, setTableWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setTableWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const gridId = React.useId()
  // The cell the keys act on: a row, and one of the columns that can be edited.
  const [cursor, setCursor] = React.useState<{ trackId: number; columnId: string | null } | null>(
    null
  )
  const [editing, setEditing] = React.useState<{ trackId: number; columnId: string } | null>(null)
  const context = React.useMemo<PreviewColumnContext>(
    () => ({ styleNames: new Map(styles.map((style) => [style.id, style.name])) }),
    [styles]
  )

  const columns = allColumns.filter((column) => tableWidth >= WIDE_FROM_WIDTH || !column.wideOnly)
  const editable = columns.filter((column) => column.edit !== undefined)
  const template = `${LEADING_COLUMNS} ${columns.map((column) => column.track).join(' ')}`
  const minWidth =
    LEADING_WIDTH +
    columns.reduce((sum, column) => sum + column.minWidth, 0) +
    (columns.length + 1) * COLUMN_GAP +
    ROW_INSET

  // The virtualizer's functions change with every scroll and are meant to be called
  // during render; nothing here memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  const cursorIndex = cursor === null ? -1 : rows.findIndex((row) => row.trackId === cursor.trackId)
  const cursorRow = cursorIndex === -1 ? undefined : rows[cursorIndex]
  // A column that is gone (the table got narrower, or the tab changed) is no place to be.
  const cursorColumn =
    editable.find((column) => column.id === cursor?.columnId) ?? editable[0] ?? null

  function moveToRow(index: number): void {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)]
    if (!row) return
    setCursor({ trackId: row.trackId, columnId: cursorColumn?.id ?? null })
    virtualizer.scrollToIndex(rows.indexOf(row))
  }

  function moveToColumn(step: number): void {
    if (!cursorRow || cursorColumn === null) return
    const next = editable[editable.indexOf(cursorColumn) + step]
    if (next) setCursor({ trackId: cursorRow.trackId, columnId: next.id })
  }

  function startEditing(row: PreviewRow, column: PreviewColumn): void {
    // A track that was skipped is not written: there is nothing to set for it.
    if (!column.edit || row.error) return
    setCursor({ trackId: row.trackId, columnId: column.id })
    setEditing({ trackId: row.trackId, columnId: column.id })
  }

  function stopEditing(): void {
    setEditing(null)
    // Back to the table, so that the arrow keys go on from the cell.
    scrollRef.current?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // A key pressed in a field or on a checkbox belongs to that control, and a key
    // with Cmd, Ctrl or Alt is a shortcut of the system.
    if (event.target !== event.currentTarget) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === ' ') {
      event.preventDefault()
      if (cursorRow && !cursorRow.error) onSetExcluded(cursorRow.trackId, !cursorRow.excluded)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (cursorRow && cursorColumn) startEditing(cursorRow, cursorColumn)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveToColumn(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }

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
      moveToRow(target)
    }
  }

  const virtualRows = virtualizer.getVirtualItems()
  // Only a row that is in the page can be named: the others are not rendered.
  const cursorIsRendered = virtualRows.some((item) => item.index === cursorIndex)
  const cellId = (trackId: number, columnId: string): string => `${gridId}-${trackId}-${columnId}`

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length + 2}
      aria-activedescendant={
        cursorIsRendered && cursorRow
          ? cursorColumn
            ? cellId(cursorRow.trackId, cursorColumn.id)
            : `${gridId}-${cursorRow.trackId}`
          : undefined
      }
      onKeyDown={handleKeyDown}
      className="group min-h-48 flex-1 overflow-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div style={{ minWidth }}>
        <div role="rowgroup" className="sticky top-0 z-10">
          <div
            role="row"
            aria-rowindex={1}
            className="grid h-9 items-center gap-2 border-b border-border bg-surface px-2"
            style={{ gridTemplateColumns: template }}
          >
            {/* Each keeps its place in the row, so the headers stand over their columns. */}
            <div role="columnheader">
              <span className="sr-only">Alkalmazás</span>
            </div>
            <div role="columnheader">
              <span className="sr-only">Állapot</span>
            </div>
            {columns.map((column) => (
              <div
                key={column.id}
                role="columnheader"
                className={cn(
                  'truncate text-label text-text-muted uppercase',
                  column.indent && 'pl-2',
                  column.numeric && 'text-right'
                )}
              >
                {column.header}
              </div>
            ))}
          </div>
        </div>

        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualRows.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            const state = rowState(row)
            const StateIcon = state.icon
            const isCursorRow = row.trackId === cursor?.trackId
            const left = row.error !== null || row.excluded
            return (
              <div
                key={row.trackId}
                id={`${gridId}-${row.trackId}`}
                role="row"
                aria-rowindex={item.index + 2}
                aria-label={row.currentFileName}
                onClick={() =>
                  setCursor({ trackId: row.trackId, columnId: cursorColumn?.id ?? null })
                }
                className={cn(
                  'absolute inset-x-0 top-0 grid cursor-default items-center gap-2 border-b border-l-2 border-border border-l-transparent px-2 text-body select-none hover:bg-surface',
                  // Shown while the table has the focus: it marks where the keys act.
                  isCursorRow && '-outline-offset-1 outline-border group-focus-visible:outline-1',
                  // What will not be written steps back.
                  left && 'text-text-muted'
                )}
                style={{
                  height: ROW_HEIGHT,
                  gridTemplateColumns: template,
                  transform: `translateY(${item.start}px)`
                }}
              >
                <span role="gridcell" className="flex">
                  <Checkbox
                    aria-label={`${row.currentFileName} alkalmazása`}
                    // The table is one stop for the Tab key; Space on a row does the same.
                    tabIndex={-1}
                    checked={!left}
                    disabled={row.error !== null}
                    onCheckedChange={(checked) => onSetExcluded(row.trackId, checked !== true)}
                  />
                </span>
                <span role="gridcell" className="flex">
                  <span
                    role="img"
                    aria-label={state.label}
                    title={state.label}
                    className={cn('flex', state.className)}
                  >
                    <StateIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </span>
                </span>
                {columns.map((column) => {
                  const isEditing =
                    editing?.trackId === row.trackId && editing.columnId === column.id
                  const isCursorCell = isCursorRow && cursorColumn?.id === column.id
                  return (
                    <span
                      key={column.id}
                      id={cellId(row.trackId, column.id)}
                      role="gridcell"
                      title={isEditing ? undefined : (column.text(row, context) ?? undefined)}
                      aria-readonly={column.edit && !row.error ? undefined : true}
                      onClick={(event) => {
                        if (!column.edit) return
                        event.stopPropagation()
                        setCursor({ trackId: row.trackId, columnId: column.id })
                      }}
                      onDoubleClick={() => startEditing(row, column)}
                      className={cn(
                        'flex h-7 min-w-0 items-center rounded-sm',
                        column.indent && 'pl-2',
                        column.numeric && 'justify-end',
                        isCursorCell &&
                          !isEditing &&
                          '-outline-offset-1 outline-primary group-focus-visible:outline-1'
                      )}
                    >
                      {isEditing && column.edit ? (
                        <CellEditor
                          editor={column.edit.editor}
                          label={`${row.currentFileName}: ${column.header}`}
                          value={row.cells[column.edit.field].after}
                          styles={styles}
                          onCancel={stopEditing}
                          onCommit={(value) => {
                            const { field } = column.edit as NonNullable<PreviewColumn['edit']>
                            stopEditing()
                            if (value !== row.cells[field].after) {
                              void onEdit(row.trackId, field, value)
                            }
                          }}
                        />
                      ) : (
                        column.render(row, context)
                      )}
                    </span>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
