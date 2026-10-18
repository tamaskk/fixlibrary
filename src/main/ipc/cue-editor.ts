import { z } from 'zod'
import {
  applyCueEdit,
  cueEditorPeaks,
  keptCueEditorPeaks,
  cueEditorTrack,
  listCueEditorTracks,
  type CueEditorDependencies
} from '../pipeline/cue-editor'
import { CUE_EDITOR_FILTERS, cueEditActionSchema, type CueEditorPeaks } from '@shared/cue-editor'
import type { Result } from '@shared/errors'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

const trackId = z.number().int().positive()

export function registerCueEditorIpc(dependencies: CueEditorDependencies): void {
  handleIpc(IPC_CHANNELS.cueEditorTracks, z.tuple([z.enum(CUE_EDITOR_FILTERS)]), (_event, filter) =>
    listCueEditorTracks(dependencies, filter)
  )
  handleIpc(IPC_CHANNELS.cueEditorTrack, z.tuple([trackId]), (_event, id) =>
    cueEditorTrack(dependencies, id)
  )
  // A kept waveform is given at once. One is made at a time, and only for the track
  // the page asked for last: going on to another track stops the making of the one
  // before, so the sidecar never decodes whole files for tracks no one looks at.
  let making: Promise<unknown> = Promise.resolve()
  let latest: AbortController | null = null
  handleIpc(IPC_CHANNELS.cueEditorPeaks, z.tuple([trackId]), async (_event, id) => {
    const kept = await keptCueEditorPeaks(dependencies, id)
    if (kept) return { ok: true, value: kept } satisfies Result<CueEditorPeaks>
    latest?.abort()
    const controller = new AbortController()
    latest = controller
    const next = making.then((): Promise<Result<CueEditorPeaks>> =>
      controller.signal.aborted
        ? Promise.resolve({ ok: false, code: 'UNEXPECTED' })
        : cueEditorPeaks(dependencies, id, controller.signal)
    )
    making = next.catch(() => {})
    return next
  })
  handleIpc(IPC_CHANNELS.cueEditorEdit, z.tuple([cueEditActionSchema]), (_event, action) =>
    applyCueEdit(dependencies, action)
  )
}
