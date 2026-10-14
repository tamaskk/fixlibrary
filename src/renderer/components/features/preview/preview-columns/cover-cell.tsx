import * as React from 'react'
import { useCoverThumbsStore } from '@/stores/cover-thumbs-store'
import { usePreviewStore } from '@/stores/preview-store'
import type { PreviewRow } from '@shared/preview'
import { coverDescription } from './cover-text'
import { EMPTY } from './diff-text'

// Only what the main process made of a cover: a JPEG in a `data:` address.
const THUMB = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/

function Thumb({ src }: { src: string | null | undefined }): React.JSX.Element {
  if (!src || !THUMB.test(src)) {
    // Room kept while the picture loads, or where it cannot be shown.
    return <span aria-hidden className="size-6 shrink-0 rounded-sm bg-surface-hover" />
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="size-6 shrink-0 rounded-sm border border-border object-cover"
    />
  )
}

/**
 * The cover of a row: the one the file holds now, then the one the batch found. The
 * two are marked up as a deletion and an insertion, as a changed value is; what they
 * are is said in words for the tooltip and for assistive technology.
 */
export function CoverDiff({ row }: { row: PreviewRow }): React.JSX.Element {
  const batchId = usePreviewStore((state) => state.batch?.id ?? null)
  const thumbs = useCoverThumbsStore((state) => state.rows[row.trackId])
  const request = useCoverThumbsStore((state) => state.request)
  const changed = row.cells.cover.changed
  React.useEffect(() => {
    if (changed && batchId !== null) request(batchId, row.trackId)
  }, [batchId, changed, request, row.trackId])

  if (!changed) return <span className="text-text-muted">{EMPTY}</span>
  const ready = thumbs?.status === 'ready' ? thumbs : null
  const description = coverDescription(row, thumbs)
  return (
    <span className="flex items-center gap-1" title={description}>
      <span className="sr-only">{description}</span>
      {ready?.before && (
        <del className="flex">
          <Thumb src={ready.before} />
        </del>
      )}
      <ins className="flex no-underline">
        <Thumb src={ready?.after} />
      </ins>
    </span>
  )
}
