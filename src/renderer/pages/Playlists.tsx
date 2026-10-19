import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Pause, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { StatusLine } from '@/components/ui/status-line'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OnlineRecommendations } from '@/components/features/playlists/OnlineRecommendations'
import { cn } from '@/lib/cn'
import { formatCount, formatElapsed } from '@/lib/format'
import { errorMessage } from '@/lib/messages'
import { useTrackPlayer, type TrackPlayer } from '@/lib/use-track-player'
import {
  usePlaylistsStore,
  type PlaylistEditOutcome,
  type PlaylistNotice
} from '@/stores/playlists-store'
import {
  MAX_PLAYLIST_NAME,
  MAX_PLAYLISTS,
  type PlaylistTrackItem,
  type PlaylistView
} from '@shared/playlists'

function nameOf(item: PlaylistTrackItem): string {
  return item.artist && item.title ? `${item.artist} - ${item.title}` : item.fileName
}

function Data({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="font-mono text-data tabular-nums">{children}</span>
}

/** Tempo, key and energy of a track in the Data role, en dashes for what is not known. */
function TrackFacts({ item }: { item: PlaylistTrackItem }): React.JSX.Element {
  return (
    <span className="flex shrink-0 gap-3 text-text-muted">
      <Data>{item.bpm === null ? '–' : Math.round(item.bpm)}</Data>
      <Data>{item.camelotKey ?? '–'}</Data>
      <Data>{item.energy === null ? '–' : `E${item.energy}`}</Data>
    </span>
  )
}

function PlayButton({
  item,
  player
}: {
  item: PlaylistTrackItem
  player: TrackPlayer
}): React.JSX.Element {
  const name = nameOf(item)
  const playing = player.playingId === item.trackId
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={playing ? `${name} megállítása` : `${name} lejátszása`}
      disabled={item.unavailable}
      onClick={() => player.toggle(item.trackId)}
    >
      {playing ? <Pause /> : <Play />}
    </Button>
  )
}

function TrackName({ item }: { item: PlaylistTrackItem }): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span
        title={nameOf(item)}
        className={cn('truncate text-body', item.unavailable && 'text-text-muted')}
      >
        {nameOf(item)}
      </span>
      <span className="truncate text-small text-text-muted">
        {item.unavailable ? 'Nem elérhető' : (item.styleName ?? 'Nincs stílus')}
      </span>
    </span>
  )
}

function noticeText(notice: PlaylistNotice): string {
  if (notice.kind === 'skipped') {
    return `${formatCount(notice.count)} track kimaradt: már a playlistben van, vagy nincs a könyvtárban.`
  }
  return errorMessage(notice.code)
}

type NameFormProps = {
  initial: string
  confirm: string
  onSave: (name: string) => Promise<PlaylistEditOutcome>
  onDone: () => void
  /** What a refusal of the main process means for this dialog. */
  refused: string
}

// Mounted with the dialog's content, so every opening starts from `initial`.
function NameForm({ initial, confirm, onSave, onDone, refused }: NameFormProps): React.JSX.Element {
  const [name, setName] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  const trimmed = name.trim()

  async function submit(event: React.SubmitEvent): Promise<void> {
    event.preventDefault()
    if (trimmed === '') return
    setSaving(true)
    const outcome = await onSave(trimmed)
    setSaving(false)
    if (outcome.ok) onDone()
    else setFailure(outcome.code === 'INVALID_INPUT' ? refused : errorMessage(outcome.code))
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <Input
        label="Név"
        value={name}
        maxLength={MAX_PLAYLIST_NAME}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <div role="status">{failure && <StatusLine tone="danger">{failure}</StatusLine>}</div>
      <DialogFooter>
        <DialogClose asChild>
          <Button>Mégse</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={saving} disabled={trimmed === ''}>
          {confirm}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The dialog that names a new playlist or renames one. */
function NameDialog({
  open,
  title,
  onClose,
  ...form
}: Omit<NameFormProps, 'onDone'> & {
  open: boolean
  title: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent title={title}>
        <NameForm {...form} onDone={onClose} />
      </DialogContent>
    </Dialog>
  )
}

// A row of the list: two lines of text, and the buttons of 32px.
const ROW_HEIGHT = 48

/**
 * The tracks of a playlist, in order, with their buttons. Virtualized: a playlist may
 * hold thousands of tracks, and every move would draw them all again.
 */
function TrackList({
  view,
  player
}: {
  view: PlaylistView
  player: TrackPlayer
}): React.JSX.Element {
  const edit = usePlaylistsStore((state) => state.edit)
  const editing = usePlaylistsStore((state) => state.editing)
  const { tracks } = view
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // The virtualizer's functions change with every scroll and are meant to be called
  // during render; nothing here memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8
  })

  function move(trackId: number, direction: -1 | 1): void {
    void edit({ action: 'move', playlistId: view.id, trackId, direction })
  }

  return (
    <div
      ref={scrollRef}
      role="list"
      // A Tab stop of its own, like the tables: with the focus on it the arrows scroll.
      tabIndex={0}
      aria-label="A playlist trackjei"
      className="max-h-96 overflow-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = tracks[row.index]
          if (!item) return null
          const name = nameOf(item)
          const index = row.index
          return (
            <div
              key={item.trackId}
              role="listitem"
              aria-setsize={tracks.length}
              aria-posinset={index + 1}
              className="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-border"
              style={{ height: ROW_HEIGHT, transform: `translateY(${row.start}px)` }}
            >
              <span className="w-6 shrink-0 text-right text-text-muted">
                <Data>{index + 1}</Data>
              </span>
              <PlayButton item={item} player={player} />
              <TrackName item={item} />
              <TrackFacts item={item} />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${name} mozgatása feljebb`}
                disabled={index === 0 || editing}
                onClick={() => move(item.trackId, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${name} mozgatása lejjebb`}
                disabled={index === tracks.length - 1 || editing}
                onClick={() => move(item.trackId, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${name} eltávolítása a playlistből`}
                disabled={editing}
                onClick={() =>
                  void edit({ action: 'remove', playlistId: view.id, trackId: item.trackId })
                }
              >
                <X />
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PlaylistBody({
  view,
  player
}: {
  view: PlaylistView
  player: TrackPlayer
}): React.JSX.Element {
  const edit = usePlaylistsStore((state) => state.edit)
  const editing = usePlaylistsStore((state) => state.editing)
  const notice = usePlaylistsStore((state) => state.notice)
  const [renaming, setRenaming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const { tracks } = view
  const recommendations = view.recommendations ?? []

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 truncate text-h2">{view.name}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${view.name} átnevezése`}
          onClick={() => setRenaming(true)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${view.name} törlése`}
          className="ml-auto"
          onClick={() => setDeleting(true)}
        >
          <Trash2 />
        </Button>
      </div>
      <p className="flex flex-wrap gap-x-4 text-small text-text-muted">
        <span>
          <Data>{formatCount(tracks.length)}</Data> track
        </span>
        <span>
          Hossz: <Data>{view.totalMs > 0 ? formatElapsed(view.totalMs) : '–'}</Data>
        </span>
        <span>
          BPM:{' '}
          <Data>
            {view.bpmRange === null
              ? '–'
              : view.bpmRange[0] === view.bpmRange[1]
                ? view.bpmRange[0]
                : `${view.bpmRange[0]}–${view.bpmRange[1]}`}
          </Data>
        </span>
        <span>
          Key: <Data>{view.keys.length === 0 ? '–' : view.keys.join(' ')}</Data>
        </span>
      </p>
      <div role="status" className="flex flex-col gap-1">
        {notice && (
          <StatusLine tone={notice.kind === 'failed' ? 'danger' : 'neutral'}>
            {noticeText(notice)}
          </StatusLine>
        )}
        {player.failed && (
          <StatusLine tone="danger">
            A fájl nem játszható le. Lehet, hogy a lemeze nincs csatlakoztatva.
          </StatusLine>
        )}
      </div>

      <Card>
        <CardTitle>Trackek</CardTitle>
        {tracks.length === 0 ? (
          <p className="text-body text-text-muted">
            Még üres. Jelölj ki trackeket a Könyvtárban, és add hozzá őket a playlisthez.
          </p>
        ) : (
          <TrackList view={view} player={player} />
        )}
      </Card>

      <Card>
        <CardTitle>Ajánlások</CardTitle>
        <Tabs defaultValue="library" className="flex flex-col gap-4">
          <TabsList aria-label="Ajánlások">
            <TabsTrigger value="library">Könyvtárból</TabsTrigger>
            <TabsTrigger value="online">Online ajánlás</TabsTrigger>
          </TabsList>
          <TabsContent value="library">
            {recommendations.length === 0 ? (
              <p className="text-body text-text-muted">
                {tracks.length === 0
                  ? 'Ajánlás az első track hozzáadása után jelenik meg.'
                  : 'Nincs több track a könyvtárban, ami ajánlható lenne.'}
              </p>
            ) : (
              <ul className="flex flex-col">
                {recommendations.map((item) => (
                  <li
                    key={item.trackId}
                    className="flex min-h-12 items-center gap-2 border-b border-border py-1 last:border-b-0"
                  >
                    <PlayButton item={item} player={player} />
                    <TrackName item={item} />
                    <TrackFacts item={item} />
                    <span className="w-10 shrink-0 text-right text-text-muted">
                      <Data>{Math.round(item.score * 100)}%</Data>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${nameOf(item)} hozzáadása a playlisthez`}
                      disabled={editing}
                      onClick={() =>
                        void edit({ action: 'add', playlistId: view.id, trackIds: [item.trackId] })
                      }
                    >
                      <Plus />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="online">
            <OnlineRecommendations playlistId={view.id} empty={tracks.length === 0} />
          </TabsContent>
        </Tabs>
      </Card>

      <NameDialog
        open={renaming}
        title="Playlist átnevezése"
        initial={view.name}
        confirm="Átnevezés"
        refused="A playlist már nincs meg."
        onClose={() => setRenaming(false)}
        onSave={(name) => edit({ action: 'rename', playlistId: view.id, name })}
      />
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent
          title="Playlist törlése"
          description={`A(z) „${view.name}” playlist törlődik. A trackek a könyvtárban maradnak.`}
        >
          <DialogFooter>
            <DialogClose asChild>
              <Button>Mégse</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={editing}
              onClick={() =>
                void edit({ action: 'delete', playlistId: view.id }).then(
                  (outcome) => outcome.ok && setDeleting(false)
                )
              }
            >
              Törlés
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function Playlists(): React.JSX.Element {
  const playlists = usePlaylistsStore((state) => state.playlists)
  const loaded = usePlaylistsStore((state) => state.loaded)
  const loadFailed = usePlaylistsStore((state) => state.loadFailed)
  const selectedId = usePlaylistsStore((state) => state.selectedId)
  const view = usePlaylistsStore((state) => state.view)
  const viewLoading = usePlaylistsStore((state) => state.viewLoading)
  const viewFailed = usePlaylistsStore((state) => state.viewFailed)
  const load = usePlaylistsStore((state) => state.load)
  const select = usePlaylistsStore((state) => state.select)
  const edit = usePlaylistsStore((state) => state.edit)
  const [creating, setCreating] = React.useState(false)
  const player = useTrackPlayer()

  React.useEffect(() => {
    void load()
  }, [load])

  function choose(playlistId: number): void {
    player.stop()
    void select(playlistId)
  }

  const createDialog = (
    <NameDialog
      open={creating}
      title="Új playlist"
      initial=""
      confirm="Létrehozás"
      refused={`Legfeljebb ${formatCount(MAX_PLAYLISTS)} playlist lehet.`}
      onClose={() => setCreating(false)}
      onSave={(name) => edit({ action: 'create', name })}
    />
  )

  let body: React.ReactNode
  if (loadFailed) {
    body = (
      <div className="flex items-center gap-4">
        <StatusLine tone="danger">A playlistek nem tölthetők be.</StatusLine>
        <Button variant="primary" onClick={() => void load()}>
          Próbáld újra
        </Button>
      </div>
    )
  } else if (!loaded) {
    body = null
  } else if (playlists.length === 0) {
    body = (
      <EmptyState
        message="Még nincs playlist."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            Új playlist
          </Button>
        }
      />
    )
  } else {
    body = (
      <div className="flex min-h-0 gap-6">
        <div className="flex w-48 shrink-0 flex-col gap-2">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            Új playlist
          </Button>
          <nav aria-label="Playlistek">
            <ul className="flex flex-col">
              {playlists.map((playlist) => {
                const current = playlist.id === selectedId
                return (
                  <li key={playlist.id}>
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      onClick={() => choose(playlist.id)}
                      className={cn(
                        'flex h-8 w-full items-center gap-2 rounded-r-md border-l-2 px-3 text-left text-small font-medium transition-colors duration-150 ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                        current
                          ? 'border-primary bg-surface-hover text-text'
                          : 'border-transparent text-text-muted hover:text-text'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
                      <Data>{formatCount(playlist.trackCount)}</Data>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
        </div>
        {viewFailed ? (
          <div className="flex items-center gap-4">
            <StatusLine tone="danger">A playlist nem tölthető be.</StatusLine>
            <Button onClick={() => selectedId !== null && void select(selectedId)}>
              Próbáld újra
            </Button>
          </div>
        ) : view === null ? (
          <div role="status">
            {viewLoading && <StatusLine tone="neutral">Betöltés…</StatusLine>}
          </div>
        ) : (
          <PlaylistBody view={view} player={player} />
        )}
      </div>
    )
  }

  return (
    <main className="h-full overflow-y-auto p-6">
      <div className="max-w-content mx-auto flex flex-col gap-6">
        <h1 className="text-h1">Playlistek</h1>
        <div role="status" className="contents">
          {!loaded && !loadFailed && <StatusLine tone="neutral">Betöltés…</StatusLine>}
        </div>
        {body}
      </div>
      {createDialog}
    </main>
  )
}
