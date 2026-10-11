import { formatPercent } from '@/lib/format'
import { SOURCE_LABELS } from '@/lib/preview-labels'
import { PREVIEW_FIELDS, type PreviewRow, type PreviewValue } from '@shared/preview'
import { DiffValue } from './cells'
import { diffText } from './diff-text'
import type { PreviewColumn, PreviewColumnContext } from './types'

function styleName(context: PreviewColumnContext): (value: PreviewValue) => string | null {
  return (value) => (typeof value === 'number' ? (context.styleNames.get(value) ?? null) : null)
}

/** Where the changes of a row come from, and how sure the least sure of them is. */
function provenance(row: PreviewRow): string | null {
  const changed = PREVIEW_FIELDS.map((field) => row.cells[field]).filter((cell) => cell.changed)
  const sources = [...new Set(changed.flatMap((cell) => (cell.source ? [cell.source] : [])))]
  if (sources.length === 0) return null
  const confidences = changed.flatMap((cell) => (cell.confidence === null ? [] : [cell.confidence]))
  const names = sources.map((source) => SOURCE_LABELS[source]).join(', ')
  // The percent first: it is what must not be cut off in a narrow column.
  return confidences.length === 0 ? names : `${formatPercent(Math.min(...confidences))} · ${names}`
}

/**
 * The columns of a batch that a run of the pipeline computed. The widths are
 * multiples of 32px; at the minimum window the three text columns share what is left.
 */
export const RUN_COLUMNS: readonly PreviewColumn[] = [
  {
    id: 'fileName',
    header: 'Fájlnév',
    track: 'minmax(160px, 4fr)',
    minWidth: 160,
    render: (row) => <DiffValue cell={row.cells.fileName} />,
    text: (row) => diffText(row.cells.fileName)
  },
  {
    id: 'artist',
    header: 'Artist',
    track: 'minmax(96px, 1fr)',
    minWidth: 96,
    edit: { field: 'artist', editor: 'text' },
    render: (row) => <DiffValue cell={row.cells.artist} />,
    text: (row) => diffText(row.cells.artist)
  },
  {
    id: 'title',
    header: 'Title',
    track: 'minmax(96px, 1fr)',
    minWidth: 96,
    edit: { field: 'title', editor: 'text' },
    render: (row) => <DiffValue cell={row.cells.title} />,
    text: (row) => diffText(row.cells.title)
  },
  {
    id: 'mix',
    header: 'Mix',
    track: '96px',
    minWidth: 96,
    edit: { field: 'mix', editor: 'text' },
    render: (row) => <DiffValue cell={row.cells.mix} />,
    text: (row) => diffText(row.cells.mix)
  },
  {
    id: 'style',
    header: 'Stílus',
    track: '96px',
    minWidth: 96,
    edit: { field: 'styleId', editor: 'style' },
    render: (row, context) => <DiffValue cell={row.cells.styleId} format={styleName(context)} />,
    text: (row, context) => diffText(row.cells.styleId, styleName(context))
  },
  {
    id: 'energy',
    header: 'Energy',
    track: '64px',
    minWidth: 64,
    numeric: true,
    edit: { field: 'energy', editor: 'energy' },
    render: (row) => <DiffValue cell={row.cells.energy} data />,
    text: (row) => diffText(row.cells.energy)
  },
  {
    id: 'source',
    header: 'Forrás',
    track: '128px',
    minWidth: 128,
    indent: true,
    wideOnly: true,
    render: (row) => {
      const text = provenance(row)
      return text === null ? (
        <span className="text-text-muted">–</span>
      ) : (
        <span className="truncate text-small text-text-muted">{text}</span>
      )
    },
    text: provenance
  }
]
