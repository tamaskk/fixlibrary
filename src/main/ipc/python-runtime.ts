import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { PythonRuntimeState } from '@shared/python-runtime'
import { handleIpc } from './handle'
import { PROGRESS_INTERVAL_MS } from './progress'

/** Sends the state to every window, at most four times a second; a change of status at once. */
export function createRuntimeStateSender(): (state: PythonRuntimeState) => void {
  let latest: PythonRuntimeState | null = null
  let timer: NodeJS.Timeout | null = null
  let lastStatus: PythonRuntimeState['status'] | null = null
  const send = (): void => {
    timer = null
    if (latest === null) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.pythonRuntimeChanged, latest)
    }
  }
  return (state) => {
    latest = state
    if (state.status !== lastStatus) {
      lastStatus = state.status
      if (timer !== null) clearTimeout(timer)
      send()
      return
    }
    timer ??= setTimeout(send, PROGRESS_INTERVAL_MS)
  }
}

export function registerPythonRuntimeIpc(dependencies: {
  state: () => PythonRuntimeState
  retry: () => void
}): void {
  handleIpc(IPC_CHANNELS.pythonRuntimeState, z.tuple([]), () => dependencies.state())
  handleIpc(IPC_CHANNELS.pythonRuntimeRetry, z.tuple([]), () => dependencies.retry())
}
