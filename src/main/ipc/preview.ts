import { z } from 'zod'
import type { Preview } from '../pipeline/preview'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

const noArguments = z.tuple([])
// What a request holds is checked by the pipeline, which answers a bad one with
// INVALID_INPUT; here only the number of arguments is fixed.
const oneUnknown = z.tuple([z.unknown()])
const batchId = z.tuple([z.number().int().positive()])

export function registerPreviewIpc(preview: Preview): void {
  handleIpc(IPC_CHANNELS.previewState, noArguments, () => preview.state())
  handleIpc(IPC_CHANNELS.previewRows, oneUnknown, (_event, request) => preview.rows(request))
  handleIpc(IPC_CHANNELS.previewEdit, oneUnknown, (_event, edit) => preview.edit(edit))
  // One row at a time, refused while another is on its way; the services themselves
  // are asked no faster than their limits allow, whoever asks.
  handleIpc(IPC_CHANNELS.previewRefreshLookup, oneUnknown, (_event, request) =>
    preview.refresh(request)
  )
  handleIpc(IPC_CHANNELS.previewSetExcluded, oneUnknown, (_event, request) =>
    preview.setExcluded(request)
  )
  handleIpc(IPC_CHANNELS.previewDiscard, batchId, (_event, id) => preview.discard(id))

  // Neither needs a limit of its own: an approval is taken once per batch, an undo
  // once per batch that wrote, and both are refused while the other is on its way.
  handleIpc(IPC_CHANNELS.previewApprove, batchId, (_event, id) => preview.approve(id))
  handleIpc(IPC_CHANNELS.previewUndoLast, noArguments, () => preview.undoLast())
}
