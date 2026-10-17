import { formatDecimal } from '@/lib/format'
import type { PreviewNormalization, PreviewRow, PreviewValue } from '@shared/preview'
import { DiffValue } from './cells'
import { diffText, EMPTY } from './diff-text'
import type { PreviewColumn } from './types'

function level(value: PreviewValue): string | null {
  return typeof value === 'number' ? formatDecimal(value) : null
}

/** A gain with its sign: `+3,0`, `−1,5`, and `0,0` for what rounds to nothing. */
export function signedGain(value: number): string {
  // Rounded as it is shown first: a hundredth either way is no sign to show.
  const shown = Math.round(value * 100) / 100
  if (shown === 0) return formatDecimal(0)
  return shown > 0 ? `+${formatDecimal(shown)}` : formatDecimal(shown)
}

function gain(value: PreviewValue): string | null {
  return typeof value === 'number' ? signedGain(value) : null
}

const METHOD_LABELS: Readonly<Record<PreviewNormalization['kind'], string>> = {
  mp3gain: 'Veszteségmentes (1,5 dB-es lépés)',
  reencode: 'Pontos (újrakódolás)',
  pcm: 'Pontos (PCM)'
}

/** What the normalization does with the row, in words. */
export function normalizationState(normalization: PreviewNormalization | null): string | null {
  if (normalization === null) return null
  switch (normalization.action) {
    case 'apply':
      return 'Normalizálás'
    case 'none':
      return 'Célszinten van'
    case 'skip':
      return `Kimarad: ${signedGain(normalization.neededGainDb ?? 0)} dB kellene, legfeljebb ${signedGain(
        normalization.possibleGainDb ?? 0
      )} dB fér bele`
  }
}

// In the Small role, as the source column is: words that explain the numbers before them.
function textOr(text: string | null): React.JSX.Element {
  return text === null ? (
    <span className="text-text-muted">{EMPTY}</span>
  ) : (
    <span className="truncate text-small text-text-muted">{text}</span>
  )
}

/**
 * The columns of a batch that normalizes the loudness (T-032): the loudness and the
 * true peak as measured and as they will be, and the gain, at every width; the method
 * and what happens to the row where the table has room. The values are the preview
 * row's own, so that the A/B player of T-033 can show the same.
 */
export const LOUDNESS_COLUMNS: readonly PreviewColumn[] = [
  {
    id: 'lufs',
    header: 'LUFS',
    track: '128px',
    minWidth: 128,
    numeric: true,
    render: (row: PreviewRow, context) => (
      <DiffValue cell={row.cells.lufs} format={level} data compact={!context.wide} />
    ),
    text: (row) => diffText(row.cells.lufs, level)
  },
  {
    id: 'gain',
    header: 'Gain (dB)',
    track: '96px',
    minWidth: 96,
    numeric: true,
    render: (row) => <DiffValue cell={row.cells.gain} format={gain} data />,
    text: (row) => diffText(row.cells.gain, gain)
  },
  {
    id: 'truePeak',
    header: 'True peak (dBTP)',
    track: '128px',
    minWidth: 128,
    numeric: true,
    render: (row, context) => (
      <DiffValue cell={row.cells.truePeak} format={level} data compact={!context.wide} />
    ),
    text: (row) => diffText(row.cells.truePeak, level)
  },
  {
    id: 'normalizeMethod',
    header: 'Módszer',
    track: '160px',
    minWidth: 160,
    indent: true,
    wideOnly: true,
    render: (row) => textOr(row.normalization ? METHOD_LABELS[row.normalization.kind] : null),
    text: (row) => (row.normalization ? METHOD_LABELS[row.normalization.kind] : null)
  },
  {
    id: 'normalizeState',
    header: 'Állapot',
    track: '192px',
    minWidth: 192,
    wideOnly: true,
    render: (row) => textOr(normalizationState(row.normalization)),
    text: (row) => normalizationState(row.normalization)
  }
]
