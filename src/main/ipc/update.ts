import { BrowserWindow, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/ipc'
import type { VersionsView } from '@shared/release'
import { handleIpc } from './handle'

export function sendUpdateView(view: VersionsView): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.updateChanged, view)
  }
}

export function registerUpdateIpc(dependencies: {
  view: () => VersionsView
  check: () => void
  /** The DMG that is downloaded and checked, or null. The page never names a path. */
  readyDmg: () => string | null
  quit: () => void
}): void {
  handleIpc(IPC_CHANNELS.updateView, z.tuple([]), () => dependencies.view())
  handleIpc(IPC_CHANNELS.updateCheck, z.tuple([]), () => dependencies.check())
  handleIpc(IPC_CHANNELS.updateOpen, z.tuple([]), async () => {
    const dmg = dependencies.readyDmg()
    if (dmg === null) return false
    // Finder mounts the image; the user drags the new app over the old one.
    return (await shell.openPath(dmg)) === ''
  })
  handleIpc(IPC_CHANNELS.updateQuit, z.tuple([]), () => dependencies.quit())
}
