import { randomUUID } from 'crypto'
import { basename } from 'path'
import { z } from 'zod'
import { logger } from '../../services/logger'
import type { PythonBridge } from '../../services/python-bridge'
import { AppError } from '@shared/errors'
import { extensionOf } from '@shared/file-names'
import type { Proposal } from '@shared/preview'
import type { ConvertResult } from '@shared/rpc'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import type { Stage } from './stage'

export const CONVERT_STAGE = 'convert'
export const CONVERT_FILE_STAGE = 'convertFile'

/** What a converted file is: the extension it gets and the format of its track. */
const AIFF = { extension: '.aiff', format: 'aiff' } as const

/** The entry of an item's `after` that says its file is to be converted. */
const CONVERT_ENTRY = 'convert'
const convertSchema = z.object({ to: z.literal(AIFF.format) })

/** True when the batch holds a conversion for the track. */
export function wantsConversion(after: unknown): boolean {
  const record = z.record(z.string(), z.unknown()).safeParse(after)
  return record.success && convertSchema.safeParse(record.data[CONVERT_ENTRY]).success
}

/** A file name with the extension its file will have once it is converted. */
export function convertedName(fileName: string): string {
  return `${fileName.slice(0, fileName.length - extensionOf(fileName).length)}${AIFF.extension}`
}

export interface ConvertStageDependencies {
  /** Null while this installation has no sidecar to ask. */
  python: () => Pick<PythonBridge, 'call'> | null
}

/**
 * Proposes to make an AIFF of every WAV: tags and covers do not work in a WAV in
 * Rekordbox, and a file above 48 kHz does not play on every Pioneer player. For a
 * track that is no WAV it proposes nothing. It reads no file and changes none; the
 * `convertFile` stage does the work once the batch is approved.
 */
export function createConvertStage(): Stage {
  return {
    name: CONVERT_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.naming,
    run: async (_context, track) => {
      if (track.format !== 'wav') return
      const proposal: Proposal & Record<string, unknown> = {
        [CONVERT_ENTRY]: { to: AIFF.format },
        // Shown in the preview: the one thing about the track that visibly changes.
        fields: {
          fileName: { value: convertedName(basename(track.path)), source: 'conversion' }
        }
      }
      return { proposal }
    }
  }
}

/** Kilobits per second of uncompressed samples. */
function bitrateOf(result: ConvertResult): number {
  return Math.round((result.sampleRateHz * result.bitDepth * result.channels) / 1000)
}

/**
 * Makes the AIFF of a WAV the batch holds a conversion for: lossless up to 48 kHz
 * and 24 bit, with the tags of the WAV. The sidecar reads the file and writes the
 * temp file it is given; `context.files.convertTo` puts the new file in place, and
 * removes the WAV only when the AIFF is there. In place the WAV is in the backup
 * folder by then; in the clean library the original stays where it is. The batch
 * can be undone, which brings the WAV back.
 */
export function createConvertFileStage(dependencies: ConvertStageDependencies): Stage {
  return {
    name: CONVERT_FILE_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [CONVERT_STAGE],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.convertFile,
    run: async ({ files, proposal }, track) => {
      if (!files) throw new Error('an apply stage must be given its files')
      // The clean library holds every approved track, also one that is no WAV. Said
      // here when the copy had to take a number: a later stage finds it made.
      const copy = await files.ensureCleanCopy()
      const numbered = { proposal: { warnings: ['NAME_COLLISION' as const] } }
      if (!wantsConversion(proposal)) return copy.collided ? numbered : undefined
      // Asked before the file is: a name the rule for new names refuses must not
      // cost a backup, nor make the batch count as one that wrote.
      await files.wouldMove(convertedName(basename(track.path)))
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      const converted = await files.convertTo(AIFF, async (source, tempPath, signal) => {
        // A new id for every attempt: the sidecar refuses one that is still in use.
        const jobId = randomUUID()
        const result = await python.call(
          'convert.wav_to_aiff',
          { src: source, dst: tempPath, jobId },
          { timeoutMs: STAGE_TIMEOUTS_MS.convert, job: { id: jobId, signal } }
        )
        if (result.tagsLost.length > 0) {
          // Said, not passed over: the WAV that held them is about to go.
          logger.warn(
            `Track ${track.id}: ${result.tagsLost.length} tag frames have no place in the AIFF (${result.tagsLost.join(', ')})`
          )
        }
        return {
          sampleRateHz: result.sampleRateHz,
          bitrateKbps: bitrateOf(result),
          durationMs: result.durationMs
        }
      })
      return copy.collided || converted.collided ? numbered : undefined
    }
  }
}
