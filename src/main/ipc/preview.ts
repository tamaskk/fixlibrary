import { z } from 'zod'
import type { Preview } from '../pipeline/preview'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'
import { createRateGate } from './progress'

const noArguments = z.tuple([])
// What a request holds is checked by the pipeline, which answers a bad one with
// INVALID_INPUT; here only the number of arguments is fixed.
const oneUnknown = z.tuple([z.unknown()])
const batchId = z.tuple([z.number().int().positive()])

// An approval or an undo copies files for a while; a page that asks in a loop gets
// the same answer as while a run is active.
const WRITE_INTERVAL_MS = 2000

export function registerPreviewIpc(preview: Preview): void {
  handleIpc(IPC_CHANNELS.previewState, noArguments, () => preview.state())
  handleIpc(IPC_CHANNELS.previewRows, oneUnknown, (_event, request) => preview.rows(request))
  handleIpc(IPC_CHANNELS.previewEdit, oneUnknown, (_event, edit) => preview.edit(edit))
  handleIpc(IPC_CHANNELS.previewSetExcluded, oneUnknown, (_event, request) =>
    preview.setExcluded(request)
  )
  handleIpc(IPC_CHANNELS.previewDiscard, batchId, (_event, id) => preview.discard(id))

  const mayWrite = createRateGate(WRITE_INTERVAL_MS)
  handleIpc(IPC_CHANNELS.previewApprove, batchId, (_event, id) =>
    mayWrite() ? preview.approve(id) : ({ ok: false, code: 'RUN_ACTIVE' } as const)
  )
  handleIpc(IPC_CHANNELS.previewUndoLast, noArguments, () =>
    mayWrite() ? preview.undoLast() : ({ ok: false, code: 'RUN_ACTIVE' } as const)
  )
}
