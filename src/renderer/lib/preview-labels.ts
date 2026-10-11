import type { FieldSource, PreviewFilter, PreviewWarning } from '@shared/preview'

export const WARNING_LABELS: Readonly<Record<PreviewWarning, string>> = {
  LOW_CONFIDENCE: 'Bizonytalan találat (70% alatt)',
  DUPLICATE: 'Lehetséges duplikátum',
  NAME_COLLISION: 'A név foglalt volt, a fájl sorszámot kapott',
  LOW_BITRATE: 'Alacsony bitrate',
  CANNOT_NORMALIZE: 'Nem normalizálható',
  UNSORTED: 'Nincs stílusa (Unsorted)'
}

export const SOURCE_LABELS: Readonly<Record<FieldSource, string>> = {
  lookup: 'Lookup',
  id3: 'ID3',
  analysis: 'Elemzés',
  claude: 'Claude',
  manual: 'Kézi'
}

export const FILTER_LABELS: Readonly<Record<PreviewFilter, string>> = {
  all: 'Minden sor',
  warnings: 'Csak figyelmeztetések',
  lowConfidence: 'Bizonytalan (70% alatt)',
  duplicates: 'Duplikátumok',
  errors: 'Hibák'
}
