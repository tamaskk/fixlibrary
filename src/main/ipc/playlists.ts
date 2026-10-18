import { z } from 'zod'
import {
  editPlaylist,
  listPlaylistSummaries,
  playlistView,
  type PlaylistDependencies
} from '../pipeline/playlists'
import { IPC_CHANNELS } from '@shared/ipc'
import { playlistActionSchema } from '@shared/playlists'
import { handleIpc } from './handle'

export function registerPlaylistsIpc(dependencies: PlaylistDependencies): void {
  handleIpc(IPC_CHANNELS.playlistsList, z.tuple([]), () => listPlaylistSummaries(dependencies))
  handleIpc(IPC_CHANNELS.playlistsView, z.tuple([z.number().int().positive()]), (_event, id) =>
    playlistView(dependencies, id)
  )
  handleIpc(IPC_CHANNELS.playlistsEdit, z.tuple([playlistActionSchema]), (_event, action) =>
    editPlaylist(dependencies, action)
  )
}
