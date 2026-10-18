import { app } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

export function registerAppIpc(dependencies: { audioReadToken: string }): void {
  handleIpc(IPC_CHANNELS.appGetVersion, z.tuple([]), () => app.getVersion())
  // Only to the main frame of the app's page, as every call (handleIpc): a frame or a
  // document of another origin never learns it.
  handleIpc(IPC_CHANNELS.appAudioReadToken, z.tuple([]), () => dependencies.audioReadToken)
}
