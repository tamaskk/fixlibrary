import { z } from 'zod'
import {
  alternatives,
  generate,
  parsePrompt,
  saveAsPlaylist,
  type GeneratorDependencies
} from '../pipeline/generator'
import { MAX_URL_LENGTH } from '@shared/download'
import {
  alternativesRequestSchema,
  gapTargetSchema,
  generatorParamsSchema,
  promptSchema,
  saveRequestSchema
} from '@shared/generator'
import { IPC_CHANNELS } from '@shared/ipc'
import { handleIpc } from './handle'

export function registerGeneratorIpc(dependencies: GeneratorDependencies): void {
  handleIpc(IPC_CHANNELS.generatorParsePrompt, z.tuple([promptSchema]), (_event, prompt) =>
    parsePrompt(dependencies, prompt)
  )
  handleIpc(IPC_CHANNELS.generatorGenerate, z.tuple([generatorParamsSchema]), (_event, params) =>
    generate(dependencies, params)
  )
  handleIpc(
    IPC_CHANNELS.generatorAlternatives,
    z.tuple([alternativesRequestSchema]),
    (_event, request) => alternatives(dependencies, request)
  )
  handleIpc(IPC_CHANNELS.generatorSave, z.tuple([saveRequestSchema]), (_event, request) =>
    saveAsPlaylist(dependencies, request)
  )
  handleIpc(IPC_CHANNELS.generatorGapRecs, z.tuple([gapTargetSchema]), async (_event, target) => {
    const onlineRecs = dependencies.onlineRecs()
    return onlineRecs === null
      ? { ok: false as const, code: 'UNEXPECTED' as const }
      : onlineRecs.requestGap(target)
  })
  handleIpc(
    IPC_CHANNELS.generatorGapDownload,
    z.tuple([z.string().max(MAX_URL_LENGTH), z.boolean()]),
    async (_event, url, confirmed) => {
      const onlineRecs = dependencies.onlineRecs()
      return onlineRecs === null
        ? { ok: false as const, code: 'UNEXPECTED' as const }
        : onlineRecs.downloadGap(url, confirmed)
    }
  )
}
