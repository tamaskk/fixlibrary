import { z } from 'zod'
import type { FullRun } from '../pipeline/full-run'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

export function registerFullRunIpc(fullRun: FullRun): void {
  handleIpc(IPC_CHANNELS.fullRunView, z.tuple([]), () => fullRun.view())
  // The request is read by the pipeline's own schema.
  handleIpc(IPC_CHANNELS.fullRunStart, z.tuple([z.unknown()]), (_event, request) =>
    fullRun.start(request)
  )
  handleIpc(IPC_CHANNELS.fullRunStop, z.tuple([]), () => fullRun.stop())
}
