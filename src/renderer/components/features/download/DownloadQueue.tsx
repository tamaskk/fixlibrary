import { ProgressBar } from '@/components/ui/progress-bar'
import { StatusLine } from '@/components/ui/status-line'
import { formatDecimal } from '@/lib/format'
import { SOURCE_NAMES } from '@/lib/download-labels'
import type { DownloadFailure, DownloadItem } from '@shared/download'

const FAILURE_TEXTS: Readonly<Record<DownloadFailure, string>> = {
  extract: 'A yt-dlp nem tudta olvasni az oldalt. Valószínűleg frissíteni kell a yt-dlp-t.',
  failed: 'A letöltés nem sikerült.',
  timeout: 'Túl sokáig tartott, a letöltés leállt.',
  missing: 'Hiányzik a yt-dlp vagy az ffmpeg ebből a telepítésből.'
}

function ItemState({ item }: { item: DownloadItem }): React.JSX.Element {
  switch (item.state) {
    case 'queued':
      return <StatusLine tone="neutral">Sorban áll</StatusLine>
    case 'downloading':
      return (
        <div className="flex items-center gap-2">
          <ProgressBar
            percent={item.percent ?? 0}
            label={`${item.title} letöltése`}
            className="w-32"
          />
          <span className="font-mono text-data text-text-muted tabular-nums">
            {item.percent === null ? '–' : `${formatDecimal(item.percent)}%`}
          </span>
        </div>
      )
    case 'converting':
      return <StatusLine tone="neutral">MP3 készül…</StatusLine>
    case 'done':
      return <StatusLine tone="success">Kész, az Inboxba került</StatusLine>
    case 'failed':
      return <StatusLine tone="danger">{FAILURE_TEXTS[item.failure ?? 'failed']}</StatusLine>
  }
}

/** The downloads of this session, newest last, with how far each is. */
export function DownloadQueue({ items }: { items: DownloadItem[] }): React.JSX.Element {
  if (items.length === 0) {
    return <p className="text-small text-text-muted">Még nincs letöltés.</p>
  }
  return (
    <ul aria-label="Letöltések" className="flex flex-col">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex min-h-9 flex-col gap-1 border-b border-border py-2 last:border-b-0"
        >
          <div className="flex items-baseline justify-between gap-4">
            <span className="truncate text-body" title={item.title}>
              {item.title}
            </span>
            <span className="shrink-0 text-small text-text-muted">{SOURCE_NAMES[item.source]}</span>
          </div>
          <ItemState item={item} />
        </li>
      ))}
    </ul>
  )
}
