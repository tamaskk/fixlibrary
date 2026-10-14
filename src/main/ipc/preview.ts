import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import type { Preview } from '../pipeline/preview'
import { IPC_CHANNELS } from '@shared/ipc'
import { previewTrackSchema } from '@shared/preview'
import { handleIpc } from './handle'

const noArguments = z.tuple([])
// What a request holds is checked by the pipeline, which answers a bad one with
// INVALID_INPUT; here only the number of arguments is fixed.
const oneUnknown = z.tuple([z.unknown()])
const batchId = z.tuple([z.number().int().positive()])
// The request is checked by the pipeline; the path is what the preload learned of a
// dropped file, and is read only, by the pipeline's rules.
const requestAndPath = z.tuple([z.unknown(), z.string().max(4096)])

export function registerPreviewIpc(preview: Preview): void {
  let coverDialogOpen = false
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
  handleIpc(IPC_CHANNELS.previewDuplicates, batchId, (_event, id) => preview.duplicates(id))
  handleIpc(IPC_CHANNELS.previewKeepDuplicate, oneUnknown, (_event, request) =>
    preview.keepDuplicate(request)
  )
  handleIpc(IPC_CHANNELS.previewCoverThumbs, oneUnknown, (_event, request) =>
    preview.coverThumbs(request)
  )
  // The picture chosen in the last dialog, for the row it was chosen for: kept here,
  // so the page can say "processing" between the choice and the cover.
  let chosen: { batchId: number; trackId: number; path: string } | null = null

  handleIpc(IPC_CHANNELS.previewChooseCover, oneUnknown, async (event, request) => {
    const row = previewTrackSchema.safeParse(request)
    // One dialog at a time, and none for a row that could not take a picture.
    if (!row.success || coverDialogOpen || !preview.canSetCover(row.data)) return false
    coverDialogOpen = true
    chosen = null
    try {
      const options: Electron.OpenDialogOptions = {
        title: 'Borító kiválasztása',
        message: 'Borító kiválasztása',
        buttonLabel: 'Kiválasztás',
        properties: ['openFile'],
        filters: [{ name: 'Képek', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      const [path] = picked.filePaths
      if (picked.canceled || path === undefined) return false
      chosen = { ...row.data, path }
      return true
    } finally {
      coverDialogOpen = false
    }
  })
  handleIpc(IPC_CHANNELS.previewSetChosenCover, oneUnknown, (_event, request) => {
    const row = previewTrackSchema.safeParse(request)
    const pick = chosen
    chosen = null
    // Only the picture the user chose in the dialog, for that row, and only once.
    if (
      !row.success ||
      !pick ||
      pick.batchId !== row.data.batchId ||
      pick.trackId !== row.data.trackId
    ) {
      return Promise.resolve({ ok: false, code: 'INVALID_INPUT' } as const)
    }
    return preview.setCover(row.data, pick.path)
  })
  handleIpc(IPC_CHANNELS.previewDropCover, requestAndPath, (_event, request, path) =>
    preview.setCover(request, path)
  )
  handleIpc(IPC_CHANNELS.previewDiscard, batchId, (_event, id) => preview.discard(id))

  // Neither needs a limit of its own: an approval is taken once per batch, an undo
  // once per batch that wrote, and both are refused while the other is on its way.
  handleIpc(IPC_CHANNELS.previewApprove, batchId, (_event, id) => preview.approve(id))
  handleIpc(IPC_CHANNELS.previewUndoLast, noArguments, () => preview.undoLast())
}
