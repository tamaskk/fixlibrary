import { formatPercent } from '@/lib/format'
import { SOURCE_LABELS } from '@/lib/preview-labels'
import {
  PREVIEW_FIELDS,
  type PreviewCell,
  type PreviewRow,
  type PreviewValue
} from '@shared/preview'
import { formatKey } from '@shared/keys'
import { useCoverThumbsStore } from '@/stores/cover-thumbs-store'
import { DiffValue } from './cells'
import { CoverDiff } from './cover-cell'
import { CHOOSE_HINT, coverDescription } from './cover-text'
import { diffText, EMPTY } from './diff-text'
import type { PreviewColumn, PreviewColumnContext } from './types'

function styleName(context: PreviewColumnContext): (value: PreviewValue) => string | null {
  return (value) => (typeof value === 'number' ? (context.styleNames.get(value) ?? null) : null)
}

// Stands for a style the list does not have yet in the cell of a row: no style has it.
const NEW_STYLE = -1

/** The style cell, with a style the classification named but the list lacks as its value. */
function styleCell(row: PreviewRow): PreviewCell {
  const cell = row.cells.styleId
  return row.newStyle === null ? cell : { ...cell, after: NEW_STYLE, changed: true }
}

function styleOrNew(
  row: PreviewRow,
  context: PreviewColumnContext
): (value: PreviewValue) => string | null {
  return (value) =>
    value === NEW_STYLE && row.newStyle !== null
      ? `Új stílus: ${row.newStyle}`
      : styleName(context)(value)
}

/** `8A Am`: a key in both notations, as the file name will hold it. */
function keyName(value: PreviewValue): string | null {
  return typeof value === 'string' ? formatKey(value) : null
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

/** What a cover cell says as text, also before its pictures are in. */
function coverText(row: PreviewRow): string | null {
  if (!row.cells.cover.changed) return row.error ? null : `Nincs új borító · ${CHOOSE_HINT}`
  return coverDescription(row, useCoverThumbsStore.getState().rows[row.trackId])
}

/** The column of a batch that sorts files into style folders: the folder, old and new. */
export const FOLDER_COLUMN: PreviewColumn = {
  id: 'folder',
  header: 'Mappa',
  track: '128px',
  minWidth: 128,
  // The minimum window keeps the columns up to the key in view; the folder is the
  // first of the columns the table shows where it has room.
  wideOnly: true,
  render: (row) => <DiffValue cell={row.cells.folder} />,
  text: (row) => diffText(row.cells.folder)
}

/** The folder of a batch of the Inbox (T-035): where each new track goes, at every width. */
export const TARGET_FOLDER_COLUMN: PreviewColumn = {
  id: 'folder',
  header: 'Célmappa',
  track: '128px',
  minWidth: 128,
  render: (row) => <DiffValue cell={row.cells.folder} />,
  text: (row) => diffText(row.cells.folder)
}

/** The column of a batch that places hot cues: the slots filled before and after, by letter. */
export const CUES_COLUMN: PreviewColumn = {
  id: 'cues',
  header: 'Cue-k',
  track: '160px',
  minWidth: 160,
  // Always shown: in a batch that places cues they are what is to be approved. Where
  // the table is narrow, only the new letters, as with the file name. Enter or a double
  // click opens the track in the cue editor.
  activate: true,
  render: (row, context) => <DiffValue cell={row.cells.cues} compact={!context.wide} />,
  text: (row) => diffText(row.cells.cues)
}

/** The column of a batch that looked for covers: the old and the new one, side by side. */
export const COVER_COLUMN: PreviewColumn = {
  id: 'cover',
  header: 'Borító',
  // Two thumbnails of 24px and the gap between them.
  track: '96px',
  minWidth: 96,
  // Enter or a double click asks for a picture; one can also be dropped on the cell.
  activate: true,
  render: (row) => <CoverDiff row={row} />,
  text: coverText
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
    // Two file names do not fit side by side in a narrow table: the new one, which is
    // what will be written, gets the room. The row is still named by the old one.
    render: (row, context) => <DiffValue cell={row.cells.fileName} compact={!context.wide} />,
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
    id: 'label',
    header: 'Label',
    track: '96px',
    minWidth: 96,
    wideOnly: true,
    render: (row) => <DiffValue cell={row.cells.label} />,
    // The album has no column of its own: it is told with the label.
    text: (row) => {
      const label = diffText(row.cells.label)
      const album = diffText(row.cells.album)
      return album === null ? label : `${label ?? EMPTY} · Album: ${album}`
    }
  },
  {
    id: 'year',
    header: 'Év',
    track: '64px',
    minWidth: 64,
    numeric: true,
    wideOnly: true,
    render: (row) => <DiffValue cell={row.cells.year} data />,
    text: (row) => diffText(row.cells.year)
  },
  {
    id: 'bpm',
    header: 'BPM',
    track: '64px',
    minWidth: 64,
    numeric: true,
    render: (row) => <DiffValue cell={row.cells.bpm} data />,
    text: (row) => diffText(row.cells.bpm)
  },
  {
    id: 'key',
    header: 'Key',
    // Room for a changed key in both notations: `8A Am` struck through, then `9A Em`.
    track: '96px',
    minWidth: 96,
    indent: true,
    edit: { field: 'key', editor: 'key' },
    render: (row) => <DiffValue cell={row.cells.key} format={keyName} data />,
    text: (row) => diffText(row.cells.key, keyName)
  },
  {
    id: 'style',
    header: 'Stílus',
    track: '128px',
    minWidth: 128,
    edit: { field: 'styleId', editor: 'style' },
    render: (row, context) => <DiffValue cell={styleCell(row)} format={styleOrNew(row, context)} />,
    text: (row, context) => diffText(styleCell(row), styleOrNew(row, context))
  },
  {
    id: 'secondaryStyle',
    header: '2. stílus',
    track: '96px',
    minWidth: 96,
    wideOnly: true,
    edit: { field: 'secondaryStyleId', editor: 'style' },
    render: (row, context) => (
      <DiffValue cell={row.cells.secondaryStyleId} format={styleName(context)} />
    ),
    text: (row, context) => diffText(row.cells.secondaryStyleId, styleName(context))
  },
  {
    id: 'genre',
    header: 'Genre',
    track: '96px',
    minWidth: 96,
    wideOnly: true,
    // What the file's tag says: the classification went by it. A batch that sorts files
    // into style folders proposes the primary style; the user does not edit it here.
    render: (row) => <DiffValue cell={row.cells.genre} />,
    text: (row) => diffText(row.cells.genre)
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
