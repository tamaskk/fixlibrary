import { z } from 'zod'
import { exportRekordboxXml, type RekordboxExportDependencies } from '../pipeline/rekordbox-export'
import { readRekordboxExport, type RekordboxImportDependencies } from '../pipeline/rekordbox-import'
import {
  applyWizardAction,
  checkWizardExport,
  pathToCopy,
  readWizardView
} from '../pipeline/rekordbox-wizard'
import { copyText } from '../services/clipboard'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import type { RekordboxExportCheck, RekordboxXmlWritten } from '@shared/rekordbox'
import { COPYABLE_PATHS, type WizardCheckResult, type WizardState } from '@shared/rekordbox-wizard'
import { handleIpc } from './handle'

// Each XML call reads the whole library on the main process: not more often than this.
const MIN_INTERVAL_MS = 2000
// The clipboard is the user's: the page cannot fill it again and again.
const MIN_COPY_INTERVAL_MS = 1000

export function registerRekordboxIpc(
  dependencies: RekordboxExportDependencies & Pick<RekordboxImportDependencies, 'parseExport'>
): void {
  const now = dependencies.now ?? Date.now
  // One XML at a time, written or read: a second click waits for nothing and changes nothing.
  let working = false
  let lastStartedAt = Number.NEGATIVE_INFINITY
  async function once<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    if (working || now() - lastStartedAt < MIN_INTERVAL_MS) return { ok: false, code: 'XML_BUSY' }
    working = true
    lastStartedAt = now()
    try {
      return await work()
    } finally {
      working = false
    }
  }
  let lastCopyAt = Number.NEGATIVE_INFINITY

  handleIpc(IPC_CHANNELS.rekordboxWriteXml, z.tuple([]), (): Promise<Result<RekordboxXmlWritten>> =>
    once(() => exportRekordboxXml(dependencies))
  )
  handleIpc(
    IPC_CHANNELS.rekordboxReadExport,
    z.tuple([]),
    (): Promise<Result<RekordboxExportCheck>> => once(() => readRekordboxExport(dependencies))
  )

  handleIpc(IPC_CHANNELS.rekordboxWizardView, z.tuple([]), () => readWizardView(dependencies))
  // The action is checked by the pipeline, which answers a bad one with INVALID_INPUT.
  // Not while an XML is read or written: the check would save over what it does.
  handleIpc(
    IPC_CHANNELS.rekordboxWizardAction,
    z.tuple([z.unknown()]),
    async (_event, action): Promise<Result<WizardState>> => {
      // A step is a click of the user's, taken as fast as they click; only not meanwhile.
      if (working) return { ok: false, code: 'XML_BUSY' }
      return applyWizardAction(dependencies, action)
    }
  )
  handleIpc(
    IPC_CHANNELS.rekordboxWizardCheck,
    z.tuple([]),
    (): Promise<Result<WizardCheckResult>> => once(() => checkWizardExport(dependencies))
  )
  handleIpc(IPC_CHANNELS.rekordboxCopyPath, z.tuple([z.enum(COPYABLE_PATHS)]), (_event, which) => {
    if (now() - lastCopyAt < MIN_COPY_INTERVAL_MS) return false
    lastCopyAt = now()
    copyText(pathToCopy(dependencies, which))
    return true
  })
}
