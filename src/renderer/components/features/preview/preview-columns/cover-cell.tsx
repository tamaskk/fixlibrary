import * as React from 'react'
import { cn } from '@/lib/cn'
import { useCoverThumbsStore } from '@/stores/cover-thumbs-store'
import { usePreviewStore } from '@/stores/preview-store'
import type { PreviewRow } from '@shared/preview'
import { CHOOSE_HINT, coverDescription } from './cover-text'
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
  const dropCover = usePreviewStore((state) => state.dropCover)
  const thumbs = useCoverThumbsStore((state) => state.rows[row.trackId])
  const request = useCoverThumbsStore((state) => state.request)
  const [over, setOver] = React.useState(false)
  const changed = row.cells.cover.changed
  React.useEffect(() => {
    if (changed && batchId !== null) request(batchId, row.trackId)
    // Asked again when the row's cover is another one: a picture the user chose.
  }, [batchId, changed, request, row.trackId, row.cells.cover.after])

  // A picture dropped on a row that is written becomes its cover. Anything dropped
  // here is taken by the cell: the window never opens a dropped file.
  const dropTarget = {
    onDragOver: (event: React.DragEvent) => {
      if (row.error || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      // Moving onto a thumbnail inside the cell is no leaving.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      setOver(false)
      const file = event.dataTransfer.files[0]
      if (file && !row.error) void dropCover(row.trackId, file)
    }
  }
  const outline = cn(
    'flex h-full w-full min-w-0 items-center gap-1 rounded-sm',
    over && 'outline-1 -outline-offset-1 outline-primary'
  )

  if (!changed) {
    return (
      <span className={outline} {...dropTarget}>
        <span className="text-text-muted">{EMPTY}</span>
        {!row.error && <span className="sr-only">{CHOOSE_HINT}</span>}
      </span>
    )
  }
  const ready = thumbs?.status === 'ready' ? thumbs : null
  const description = coverDescription(row, thumbs)
  return (
    <span className={outline} title={description} {...dropTarget}>
      <span className="sr-only">{row.error ? description : `${description} · ${CHOOSE_HINT}`}</span>
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
