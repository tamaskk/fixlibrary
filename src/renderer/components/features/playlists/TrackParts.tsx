import * as React from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import type { TrackPlayer } from '@/lib/use-track-player'
import { nameOf } from '@/lib/track-name'
import { Data } from './DataText'
import type { PlaylistTrackItem } from '@shared/playlists'

// The parts of a track row, shared by the Playlists and Generator pages.

/** Tempo, key and energy of a track in the Data role, en dashes for what is not known. */
export function TrackFacts({ item }: { item: PlaylistTrackItem }): React.JSX.Element {
  return (
    <span className="flex shrink-0 gap-3 text-text-muted">
      <Data>{item.bpm === null ? '–' : Math.round(item.bpm)}</Data>
      <Data>{item.camelotKey ?? '–'}</Data>
      <Data>{item.energy === null ? '–' : `E${item.energy}`}</Data>
    </span>
  )
}

export function PlayButton({
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

export function TrackName({ item }: { item: PlaylistTrackItem }): React.JSX.Element {
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
