import { app } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

export function registerAppIpc(): void {
  handleIpc(IPC_CHANNELS.appGetVersion, z.tuple([]), () => app.getVersion())
}
