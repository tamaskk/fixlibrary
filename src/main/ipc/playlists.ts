import { z } from 'zod'
import {
  editPlaylist,
  listPlaylistSummaries,
  playlistView,
  type PlaylistDependencies
} from '../pipeline/playlists'
import type { OnlineRecs } from '../pipeline/online-recs'
import { MAX_URL_LENGTH } from '@shared/download'
import { IPC_CHANNELS } from '@shared/ipc'
import { playlistActionSchema } from '@shared/playlists'
import { handleIpc } from './handle'

const playlistId = z.number().int().positive()

export function registerPlaylistsIpc(
  dependencies: PlaylistDependencies,
  onlineRecs: OnlineRecs
): void {
  handleIpc(IPC_CHANNELS.playlistsList, z.tuple([]), () => listPlaylistSummaries(dependencies))
  handleIpc(IPC_CHANNELS.playlistsView, z.tuple([z.number().int().positive()]), (_event, id) =>
    playlistView(dependencies, id)
  )
  handleIpc(IPC_CHANNELS.playlistsEdit, z.tuple([playlistActionSchema]), (_event, action) =>
    editPlaylist(dependencies, action)
  )
  handleIpc(IPC_CHANNELS.playlistsOnlineLast, z.tuple([playlistId]), (_event, id) =>
    onlineRecs.last(id)
  )
  handleIpc(IPC_CHANNELS.playlistsOnlineRequest, z.tuple([playlistId]), (_event, id) =>
    onlineRecs.request(id)
  )
  handleIpc(
    IPC_CHANNELS.playlistsOnlineDownload,
    z.tuple([playlistId, z.string().max(MAX_URL_LENGTH), z.boolean()]),
    (_event, id, url, confirmed) => onlineRecs.download(id, url, confirmed)
  )
}
