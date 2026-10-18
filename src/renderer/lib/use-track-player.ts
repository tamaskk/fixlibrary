import * as React from 'react'

export interface TrackPlayer {
  /** The track that plays now, or null. */
  playingId: number | null
  /** True when the last track asked for could not be played. */
  failed: boolean
  /** Plays a track; asked for the one that plays, stops it. One track plays at a time. */
  toggle: (trackId: number) => void
  stop: () => void
}

/** Plays tracks of the library from `fixlib-audio://`, and stops when the page goes. */
export function useTrackPlayer(): TrackPlayer {
  const [playingId, setPlayingId] = React.useState<number | null>(null)
  const [failed, setFailed] = React.useState(false)
  const audio = React.useRef<HTMLAudioElement | null>(null)

  const stop = React.useCallback((): void => {
    audio.current?.pause()
    audio.current = null
    setPlayingId(null)
  }, [])

  React.useEffect(() => () => audio.current?.pause(), [])

  function toggle(trackId: number): void {
    const again = playingId === trackId
    stop()
    setFailed(false)
    if (again) return
    const player = new Audio(`fixlib-audio://track/${trackId}`)
    const fail = (): void => {
      if (audio.current !== player) return
      stop()
      setFailed(true)
    }
    player.addEventListener('ended', () => audio.current === player && stop())
    player.addEventListener('error', fail)
    audio.current = player
    setPlayingId(trackId)
    void player.play().catch(fail)
  }

  return { playingId, failed, toggle, stop }
}
