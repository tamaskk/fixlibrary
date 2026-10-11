import { errorMessage } from '@/lib/messages'
import { stageLabel } from '@/lib/stage-labels'
import type { PreviewColumn } from './types'

/** The columns of the "Hibák" tab: which track was skipped, at which step, and why. */
export const ERROR_COLUMNS: readonly PreviewColumn[] = [
  {
    id: 'fileName',
    header: 'Fájlnév',
    track: 'minmax(160px, 2fr)',
    minWidth: 160,
    render: (row) => <span className="truncate">{row.currentFileName}</span>,
    text: (row) => row.currentFileName
  },
  {
    id: 'stage',
    header: 'Lépés',
    track: '160px',
    minWidth: 160,
    render: (row) => (
      <span className="truncate">{row.error ? stageLabel(row.error.stage) : '–'}</span>
    ),
    text: (row) => (row.error ? stageLabel(row.error.stage) : null)
  },
  {
    id: 'reason',
    header: 'Hiba',
    track: 'minmax(160px, 3fr)',
    minWidth: 160,
    // Chosen from the code: the text of the app, never what a tool printed.
    render: (row) => (
      <span className="truncate">{row.error ? errorMessage(row.error.code) : '–'}</span>
    ),
    text: (row) => (row.error ? errorMessage(row.error.code) : null)
  }
]
