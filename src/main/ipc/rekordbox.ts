import { z } from 'zod'
import { exportRekordboxXml, type RekordboxExportDependencies } from '../pipeline/rekordbox-export'
import { readRekordboxExport, type RekordboxImportDependencies } from '../pipeline/rekordbox-import'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import type { RekordboxExportCheck, RekordboxXmlWritten } from '@shared/rekordbox'
import { handleIpc } from './handle'

// Each call reads the whole library on the main process: not more often than this.
const MIN_INTERVAL_MS = 2000

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

  handleIpc(IPC_CHANNELS.rekordboxWriteXml, z.tuple([]), (): Promise<Result<RekordboxXmlWritten>> =>
    once(() => exportRekordboxXml(dependencies))
  )
  handleIpc(
    IPC_CHANNELS.rekordboxReadExport,
    z.tuple([]),
    (): Promise<Result<RekordboxExportCheck>> => once(() => readRekordboxExport(dependencies))
  )
}
