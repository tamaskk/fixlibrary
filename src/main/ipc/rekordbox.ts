import { z } from 'zod'
import { exportRekordboxXml, type RekordboxExportDependencies } from '../pipeline/rekordbox-export'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import type { RekordboxXmlWritten } from '@shared/rekordbox'
import { handleIpc } from './handle'

// Each write reads the whole library on the main process: not more often than this.
const MIN_WRITE_INTERVAL_MS = 2000

export function registerRekordboxIpc(
  dependencies: RekordboxExportDependencies & { now?: () => number }
): void {
  const now = dependencies.now ?? Date.now
  // One XML at a time: a second click waits for nothing and changes nothing.
  let writing = false
  let lastStartedAt = Number.NEGATIVE_INFINITY
  handleIpc(
    IPC_CHANNELS.rekordboxWriteXml,
    z.tuple([]),
    async (): Promise<Result<RekordboxXmlWritten>> => {
      if (writing || now() - lastStartedAt < MIN_WRITE_INTERVAL_MS) {
        return { ok: false, code: 'XML_BUSY' }
      }
      writing = true
      lastStartedAt = now()
      try {
        return await exportRekordboxXml(dependencies)
      } finally {
        writing = false
      }
    }
  )
}
