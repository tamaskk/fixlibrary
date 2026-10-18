import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { StatusLine } from '@/components/ui/status-line'
import { formatCount } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { usePlaylistsStore, type PlaylistEditOutcome } from '@/stores/playlists-store'

type AddToPlaylistProps = {
  /** The tracks selected in the table, in the order the library holds them. */
  trackIds: readonly number[]
}

type Said = { name: string; asked: number; outcome: PlaylistEditOutcome }

function sayingOf({ name, asked, outcome }: Said): React.JSX.Element {
  if (!outcome.ok) return <StatusLine tone="danger">{errorMessage(outcome.code)}</StatusLine>
  const skipped =
    outcome.skipped > 0
      ? ` ${formatCount(outcome.skipped)} kimaradt: már a playlistben van, vagy nincs a könyvtárban.`
      : ''
  return (
    <StatusLine tone="neutral">
      {`${formatCount(asked - outcome.skipped)} track hozzáadva: ${name}.${skipped}`}
    </StatusLine>
  )
}

/** Adds the selected tracks to a playlist chosen from the list. */
export function AddToPlaylist({ trackIds }: AddToPlaylistProps): React.JSX.Element | null {
  const playlists = usePlaylistsStore((state) => state.playlists)
  const loaded = usePlaylistsStore((state) => state.loaded)
  const load = usePlaylistsStore((state) => state.load)
  const edit = usePlaylistsStore((state) => state.edit)
  const editing = usePlaylistsStore((state) => state.editing)
  const [chosen, setChosen] = React.useState<number | null>(null)
  const [said, setSaid] = React.useState<Said | null>(null)

  React.useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // A playlist deleted meanwhile is no choice: the first one is.
  const playlist = playlists.find((each) => each.id === chosen) ?? playlists[0]
  if (!playlist) return null

  async function add(target: { id: number; name: string }): Promise<void> {
    setSaid(null)
    const asked = trackIds.length
    const outcome = await edit(
      { action: 'add', playlistId: target.id, trackIds: [...trackIds] },
      { fromLibrary: true }
    )
    setSaid({ name: target.name, asked, outcome })
  }

  return (
    <section aria-label="Hozzáadás playlisthez" className="flex flex-col gap-2">
      <div className="flex items-end justify-end gap-4">
        <div className="w-48 shrink-0">
          <Select
            label="Playlist"
            value={String(playlist.id)}
            onChange={(event) => setChosen(Number(event.target.value))}
          >
            {playlists.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={trackIds.length === 0}
          loading={editing}
          onClick={() => void add(playlist)}
        >
          Hozzáadás a playlisthez
        </Button>
      </div>
      <div role="status">{said && sayingOf(said)}</div>
    </section>
  )
}
