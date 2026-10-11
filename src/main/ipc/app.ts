import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'

export function registerAppIpc(): void {
  ipcMain.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion())
}
