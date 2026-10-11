import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../db/connection'
import { listStyles } from '../db/styles'
import type { SecretStore } from '../pipeline/secrets'
import {
  getSettingsSnapshot,
  saveStyles,
  setFolder,
  updateSettings,
  type SettingsEnvironment
} from '../pipeline/settings'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import {
  FOLDER_KINDS,
  KEY_SERVICES,
  SECRET_NAMES,
  type FolderKind,
  type SettingsSnapshot
} from '@shared/settings'
import { handleIpc } from './handle'

const noArguments = z.tuple([])
// The content of a patch, a style list or a secret is checked by the pipeline, which
// answers a bad one with INVALID_INPUT; here only the number of arguments is fixed.
const oneUnknown = z.tuple([z.unknown()])
const folderKind = z.tuple([z.enum(FOLDER_KINDS)])

// Shown by the system dialog itself, so the user sees what the choice is for even
// if the page that asked for the dialog lied about it.
const FOLDER_PROMPTS: Record<FolderKind, string> = {
  libraryRoot: 'Válaszd ki a zenei könyvtár mappáját',
  cleanLibrary: 'Válaszd ki a clean library célmappáját',
  backup: 'Válaszd ki a backup mappát',
  generatedXml: 'Válaszd ki, hová írja az app a Rekordbox XML-t',
  exportedXml: 'Válaszd ki a Rekordboxból exportált XML mappáját'
}

export interface SettingsIpcDependencies {
  db: AppDatabase
  secrets: SecretStore
  environment: SettingsEnvironment
}

export function registerSettingsIpc({ db, secrets, environment }: SettingsIpcDependencies): void {
  let folderDialogOpen = false

  handleIpc(IPC_CHANNELS.settingsGet, noArguments, () => getSettingsSnapshot(db, environment))

  handleIpc(IPC_CHANNELS.settingsUpdate, oneUnknown, (_event, patch) =>
    updateSettings(db, patch, environment)
  )

  handleIpc(
    IPC_CHANNELS.settingsPickFolder,
    folderKind,
    async (event, kind): Promise<Result<SettingsSnapshot> | null> => {
      // One dialog at a time: a page cannot queue them up.
      if (folderDialogOpen) return null
      folderDialogOpen = true
      try {
        // The path comes from this dialog only: a folder is never accepted from the renderer.
        const options: Electron.OpenDialogOptions = {
          title: FOLDER_PROMPTS[kind],
          message: FOLDER_PROMPTS[kind],
          buttonLabel: 'Kiválasztás',
          properties: ['openDirectory', 'createDirectory']
        }
        const window = BrowserWindow.fromWebContents(event.sender)
        const picked = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options)
        const [folder] = picked.filePaths
        if (picked.canceled || folder === undefined) return null
        return setFolder(db, kind, folder, environment)
      } finally {
        folderDialogOpen = false
      }
    }
  )

  handleIpc(IPC_CHANNELS.settingsClearFolder, folderKind, (_event, kind) =>
    setFolder(db, kind, null, environment)
  )

  handleIpc(IPC_CHANNELS.stylesList, noArguments, () => listStyles(db))
  handleIpc(IPC_CHANNELS.stylesSave, oneUnknown, (_event, styles) => saveStyles(db, styles))

  handleIpc(IPC_CHANNELS.secretsStatus, noArguments, () => secrets.status())
  handleIpc(IPC_CHANNELS.secretsSave, oneUnknown, (_event, secret) => secrets.save(secret))
  handleIpc(IPC_CHANNELS.secretsClear, z.tuple([z.enum(SECRET_NAMES)]), (_event, name) =>
    secrets.clear(name)
  )
  handleIpc(IPC_CHANNELS.secretsTest, z.tuple([z.enum(KEY_SERVICES)]), (_event, service) =>
    secrets.test(service)
  )
}
