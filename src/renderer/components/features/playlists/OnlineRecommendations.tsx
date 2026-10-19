import * as React from 'react'
import { Button } from '@/components/ui/button'
import { StatusLine } from '@/components/ui/status-line'
import { errorMessage } from '@/lib/messages'
import { usePlaylistsStore } from '@/stores/playlists-store'
import { OnlineRecList } from './OnlineRecList'

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

  React.useEffect(() => {
    void loadOnline(playlistId)
  }, [loadOnline, playlistId])

  const shown = online.playlistId === playlistId ? online : null
  const items = shown?.items ?? null

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
        <OnlineRecList
          items={items}
          rows={shown?.rows ?? {}}
          startedNote="Letöltés indult. Az Inbox jóváhagyása után a playlist végére kerül."
          onDownload={(url, confirmed) => downloadOnline(playlistId, url, confirmed)}
        />
      )}
    </div>
  )
}
