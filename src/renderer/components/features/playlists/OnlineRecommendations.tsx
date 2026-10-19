import * as React from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { formatElapsed } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { usePlaylistsStore } from '@/stores/playlists-store'
import type { OnlineRecommendation } from '@shared/playlists'

function nameOf(item: OnlineRecommendation): string {
  return `${item.artist} - ${item.title}${item.mix === null ? '' : ` (${item.mix})`}`
}

function Data({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="font-mono text-data tabular-nums">{children}</span>
}

/**
 * Tracks that are not in the library and fit the playlist: Claude names them, each is
 * found on YouTube first. Asked for by the button, as it takes a minute or so.
 */
export function OnlineRecommendations({
  playlistId,
  empty
}: {
  playlistId: number
  /** True for a playlist with no tracks: there is nothing to fit. */
  empty: boolean
}): React.JSX.Element {
  const online = usePlaylistsStore((state) => state.online)
  const loadOnline = usePlaylistsStore((state) => state.loadOnline)
  const requestOnline = usePlaylistsStore((state) => state.requestOnline)
  const downloadOnline = usePlaylistsStore((state) => state.downloadOnline)
  const [downloading, setDownloading] = React.useState<string | null>(null)

  React.useEffect(() => {
    void loadOnline(playlistId)
  }, [loadOnline, playlistId])

  const shown = online.playlistId === playlistId ? online : null
  const items = shown?.items ?? null

  async function download(url: string): Promise<void> {
    setDownloading(url)
    await downloadOnline(playlistId, url)
    setDownloading(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          loading={shown?.loading ?? false}
          disabled={empty}
          onClick={() => void requestOnline(playlistId)}
        >
          {items === null ? 'Ajánlás kérése' : 'Új ajánlás kérése'}
        </Button>
        <span className="text-small text-text-muted">
          {empty
            ? 'Ajánlás az első track hozzáadása után kérhető.'
            : shown?.loading
              ? 'A Claude javasol, a YouTube-on ellenőrzöm. Ez egy percig is tarthat.'
              : 'A Claude javasol trackeket, és csak az jelenik meg, ami megvan a YouTube-on.'}
        </span>
      </div>
      <div role="status">
        {shown?.failure && <StatusLine tone="danger">{errorMessage(shown.failure)}</StatusLine>}
      </div>
      {items !== null && items.length === 0 && !shown?.loading && (
        <p className="text-body text-text-muted">
          Most nincs olyan javaslat, ami megvan a YouTube-on, és még nincs a könyvtárban.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((item) => {
            const started = shown?.started.includes(item.url) ?? false
            const refused = shown?.refused[item.url]
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
                  {started && (
                    <span className="text-small text-text-muted">
                      Letöltés indult. Az Inbox jóváhagyása után a playlist végére kerül.
                    </span>
                  )}
                  {refused && (
                    <span className="text-small text-danger-text">{errorMessage(refused)}</span>
                  )}
                </span>
                <span className="shrink-0 text-text-muted">
                  <Data>{formatElapsed(item.durationS * 1000)}</Data>
                </span>
                <span className="w-10 shrink-0 text-right text-text-muted">
                  <Data>{Math.round(item.score * 100)}%</Data>
                </span>
                {started ? (
                  <span className="w-28 shrink-0 text-small text-text-muted">Elindult</span>
                ) : (
                  <Button
                    className="w-28"
                    aria-label={`${nameOf(item)} letöltése`}
                    loading={downloading === item.url}
                    disabled={downloading !== null}
                    onClick={() => void download(item.url)}
                  >
                    <Download />
                    Letöltés
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
