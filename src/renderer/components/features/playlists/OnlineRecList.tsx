import * as React from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCount, formatElapsed } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import type { OnlineRowState } from '@/stores/playlists-store'
import { Data } from './DataText'
import type { OnlineRecommendation } from '@shared/playlists'

function nameOf(item: OnlineRecommendation): string {
  return `${item.artist} - ${item.title}${item.mix === null ? '' : ` (${item.mix})`}`
}

function RowNote({ row, started }: { row: OnlineRowState; started: string }): React.JSX.Element {
  switch (row.kind) {
    case 'started':
      return <span className="text-small text-text-muted">{started}</span>
    case 'lowBitrate':
      return (
        <span className="text-small text-text-muted">
          Gyenge minőség
          {row.kbps === null ? (
            ''
          ) : (
            <>
              : <Data>{formatCount(row.kbps)}</Data> kbps
            </>
          )}
          . Letöltöd így is?
        </span>
      )
    case 'duplicate':
      return (
        <span className="text-small text-text-muted">
          Úgy tűnik, ez megvan a könyvtárban. Letöltöd mégis?
        </span>
      )
    case 'failed':
      return <span className="text-small text-danger-text">{errorMessage(row.code)}</span>
  }
}

/**
 * Online recommendations as rows: names, the video found, length, fit and "Letöltés".
 * A low bitrate or a copy in the library is asked about in the row before it starts.
 */
export function OnlineRecList({
  items,
  rows,
  startedNote,
  onDownload
}: {
  items: readonly OnlineRecommendation[]
  rows: Readonly<Record<string, OnlineRowState>>
  /** What a row says once its download started. */
  startedNote: string
  onDownload: (url: string, confirmed: boolean) => Promise<void>
}): React.JSX.Element {
  const [downloading, setDownloading] = React.useState<string | null>(null)

  async function download(url: string, confirmed: boolean): Promise<void> {
    setDownloading(url)
    await onDownload(url, confirmed)
    setDownloading(null)
  }

  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const row = rows[item.url]
        const asking = row?.kind === 'lowBitrate' || row?.kind === 'duplicate'
        return (
          <li
            key={item.url}
            className="flex min-h-12 items-center gap-2 border-b border-border py-1 last:border-b-0"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span title={nameOf(item)} className="truncate text-body">
                {nameOf(item)}
              </span>
              <span title={item.videoTitle} className="truncate text-small text-text-muted">
                Claude · {item.styleName ?? 'Nincs stílus'} · YouTube: {item.videoTitle}
              </span>
              <span role="status">{row && <RowNote row={row} started={startedNote} />}</span>
            </span>
            <span className="shrink-0 text-text-muted">
              <Data>{formatElapsed(item.durationS * 1000)}</Data>
            </span>
            <span className="w-10 shrink-0 text-right text-text-muted">
              <Data>{Math.round(item.score * 100)}%</Data>
            </span>
            <Button
              className="w-28"
              aria-label={`${row?.kind === 'started' ? 'Elindult' : asking ? (row.kind === 'lowBitrate' ? 'Letöltés így is' : 'Letöltés mégis') : 'Letöltés'}: ${nameOf(item)}`}
              loading={downloading === item.url}
              disabled={downloading !== null || row?.kind === 'started'}
              onClick={() => void download(item.url, asking)}
            >
              {row?.kind === 'started' ? (
                'Elindult'
              ) : (
                <>
                  <Download />
                  {row?.kind === 'lowBitrate'
                    ? 'Így is'
                    : row?.kind === 'duplicate'
                      ? 'Mégis'
                      : 'Letöltés'}
                </>
              )}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
