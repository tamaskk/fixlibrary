import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { usePlaylistsStore } from '@/stores/playlists-store'

type AddToPlaylistProps = {
  /** The tracks selected in the table, in the order the table shows them. */
  trackIds: readonly number[]
}

/** Adds the selected tracks to a playlist chosen from the list. */
export function AddToPlaylist({ trackIds }: AddToPlaylistProps): React.JSX.Element {
  const playlists = usePlaylistsStore((state) => state.playlists)
  const loaded = usePlaylistsStore((state) => state.loaded)
  const load = usePlaylistsStore((state) => state.load)
  const edit = usePlaylistsStore((state) => state.edit)
  const editing = usePlaylistsStore((state) => state.editing)
  const notice = usePlaylistsStore((state) => state.notice)
  const [chosen, setChosen] = React.useState('')
  const [added, setAdded] = React.useState<{ name: string; count: number } | null>(null)

  React.useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const playlistId = Number(chosen) || (playlists[0]?.id ?? 0)
  const name = playlists.find((playlist) => playlist.id === playlistId)?.name ?? ''

  async function add(): Promise<void> {
    setAdded(null)
    const done = await edit({ action: 'add', playlistId, trackIds: [...trackIds] })
    if (done) setAdded({ name, count: trackIds.length })
  }

  if (playlists.length === 0) return <></>
  return (
    <section aria-label="Hozzáadás playlisthez" className="flex flex-col gap-2">
      <div className="flex items-end justify-end gap-4">
        <div className="w-48 shrink-0">
          <Select
            label="Playlist"
            value={String(playlistId)}
            onChange={(event) => setChosen(event.target.value)}
          >
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </Select>
        </div>
        <Button disabled={trackIds.length === 0} loading={editing} onClick={() => void add()}>
          Hozzáadás a playlisthez
        </Button>
      </div>
      <div role="status">
        {added && notice?.kind !== 'failed' && (
          <StatusLine tone="neutral">
            {`${formatCount(added.count - (notice?.kind === 'skipped' ? notice.count : 0))} track hozzáadva: ${added.name}.`}
            {notice?.kind === 'skipped' &&
              ` ${formatCount(notice.count)} kimaradt, mert már benne volt.`}
          </StatusLine>
        )}
        {notice?.kind === 'failed' && (
          <StatusLine tone="danger">{errorMessage(notice.code)}</StatusLine>
        )}
      </div>
    </section>
  )
}
