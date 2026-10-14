import { SOURCE_LABELS } from '@/lib/preview-labels'
import type { RowCoverThumbs } from '@/stores/cover-thumbs-store'
import type { PreviewRow } from '@shared/preview'
import { EMPTY } from './diff-text'

/** What the covers of a row are, in words: for the tooltip and for assistive technology. */
export function coverDescription(row: PreviewRow, thumbs: RowCoverThumbs | undefined): string {
  const cell = row.cells.cover
  const found = `Új borító: ${cell.source ? SOURCE_LABELS[cell.source] : EMPTY}`
  if (thumbs?.status === 'failed') return `${found} · A képek nem tölthetők be`
  if (thumbs?.status !== 'ready') return found
  if (!thumbs.hadBefore) return `Régi borító: nincs · ${found}`
  return thumbs.beforeSize === null
    ? `Régi borító: nem olvasható · ${found}`
    : `Régi borító: ${thumbs.beforeSize.width} × ${thumbs.beforeSize.height} px · ${found}`
}
