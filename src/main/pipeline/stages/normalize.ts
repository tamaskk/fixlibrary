import { randomUUID } from 'crypto'
import { basename } from 'path'
import { logger } from '../../services/logger'
import { normalizeEntryOf, type NormalizeEntry } from '../normalize'
import { isSetAsidePath } from '@shared/duplicates'
import { AppError } from '@shared/errors'
import { applyPlanOf, normalizeKindOf, planNormalization, reachedPlan } from '@shared/normalize'
import type { Settings } from '@shared/settings'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { CONVERT_FILE_STAGE } from './convert'
import { EMBED_COVER_STAGE, REDRAW_PLACEHOLDER_STAGE } from './cover-stages'
import {
  keptLoudness,
  LOUDNESS_STAGE,
  measureLoudness,
  type LoudnessStageDependencies
} from './loudness'
import { SET_ASIDE_STAGE } from './set-aside'
import type { Stage } from './stage'
import { WRITE_TAGS_STAGE } from './write-tags'

export const NORMALIZE_STAGE = 'normalize'
export const NORMALIZE_FILE_STAGE = 'normalizeFile'

export interface NormalizeStageDependencies extends LoudnessStageDependencies {
  /** The target and the method of the settings, read for every track. */
  loudnessSettings: () => Settings['loudness']
}

/**
 * Plans the gain that brings a track to the target loudness of the settings (T-032),
 * from its measure: by steps of 1.5 dB with mp3gain or encoded again for an MP3, by
 * the exact gain for the samples of an AIFF or a WAV. A track the gain would take
 * above −1 dBTP is skipped and warns `CANNOT_NORMALIZE`; no limiter is used. The
 * file is changed when the batch is approved.
 */
export function createNormalizeStage(dependencies: NormalizeStageDependencies): Stage {
  return {
    name: NORMALIZE_STAGE,
    phase: 'compute',
    resource: 'cpu',
    dependsOn: [LOUDNESS_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.normalizePlan,
    run: async (_context, track) => {
      const measured = keptLoudness(dependencies.db, track)
      if (!measured) throw new AppError('UNEXPECTED', 'the track was not measured')
      const settings = dependencies.loudnessSettings()
      const kind = normalizeKindOf(basename(track.path), settings.method)
      if (kind === null) return
      const plan = planNormalization(measured, settings.targetLufs, kind)
      const entry: NormalizeEntry = {
        targetLufs: settings.targetLufs,
        measuredLufs: measured.integratedLufs,
        measuredTruePeakDbtp: measured.truePeakDbtp,
        plan
      }
      const applied = plan.action === 'apply'
      return {
        proposal: {
          fields: {
            lufs: {
              value: applied ? plan.expectedLufs : measured.integratedLufs,
              source: 'analysis'
            },
            truePeak: {
              value: applied ? plan.expectedTruePeakDbtp : measured.truePeakDbtp,
              source: 'analysis'
            },
            gain: { value: applied ? plan.gainDb : null, source: 'analysis' }
          },
          ...(plan.action === 'skip' ? { warnings: ['CANNOT_NORMALIZE' as const] } : {}),
          normalize: entry
        }
      }
    }
  }
}

/**
 * Changes the loudness of an approved track's file by its plan. The sidecar writes the
 * file with its gain changed into the temp file it is given; `replaceContent` puts it
 * in place, after the original was backed up or copied. The file is measured again
 * afterwards: one that is farther from the plan than its method allows, or whose
 * raised peak went above −1 dBTP, stays as it is written and fails with `OFF_TARGET`,
 * for the user to undo or keep. A copy that was set aside as a duplicate is left alone.
 */
export function createNormalizeFileStage(dependencies: NormalizeStageDependencies): Stage {
  return {
    name: NORMALIZE_FILE_STAGE,
    phase: 'apply',
    resource: 'io',
    dependsOn: [NORMALIZE_STAGE],
    // Each of them gives the file another path or other bytes, and their steps must
    // not be mixed. Last of them: the tags and the cover are in the file it measures.
    after: [
      CONVERT_FILE_STAGE,
      SET_ASIDE_STAGE,
      REDRAW_PLACEHOLDER_STAGE,
      WRITE_TAGS_STAGE,
      EMBED_COVER_STAGE
    ],
    selectable: false,
    timeoutMs: STAGE_TIMEOUTS_MS.normalizeFile,
    run: async ({ files, proposal, signal }, track) => {
      if (!files) throw new Error('an apply stage must be given its files')
      // The clean library holds every approved track, also one whose gain stays.
      const copy = await files.ensureCleanCopy()
      const numbered = copy.collided
        ? { proposal: { warnings: ['NAME_COLLISION' as const] } }
        : undefined
      const plan = normalizeEntryOf(proposal)?.plan
      if (plan?.action !== 'apply') return numbered
      if (isSetAsidePath(track.path)) {
        logger.info(`Track ${track.id}: a copy set aside is not normalized`)
        return numbered
      }
      const python = dependencies.python()
      if (!python) throw new AppError('PYTHON_CRASHED', 'the sidecar is not running')
      // On a resume after the app stopped, the gain may be in the file already: the
      // kept measure cannot tell, since mp3gain keeps the size of the file.
      const now = await measureLoudness(
        dependencies,
        track,
        await files.workingPath(),
        signal,
        false
      )
      if (reachedPlan(plan, now)) {
        logger.info(`Track ${track.id}: at its planned loudness already, not normalized again`)
        return numbered
      }
      await files.replaceContent(async (tempPath, attemptSignal, source) => {
        // A new id for every attempt: the sidecar refuses one that is still in use.
        const jobId = randomUUID()
        await python.call(
          'normalize.apply',
          { src: source, dst: tempPath, plan: applyPlanOf(plan), jobId },
          { timeoutMs: STAGE_TIMEOUTS_MS.normalize, job: { id: jobId, signal: attemptSignal } }
        )
      })
      const after = await measureLoudness(
        dependencies,
        track,
        await files.workingPath(),
        signal,
        false
      )
      if (!reachedPlan(plan, after)) {
        logger.warn(
          `Track ${track.id}: normalized to ${after.integratedLufs} LUFS and ` +
            `${after.truePeakDbtp} dBTP, planned ${plan.expectedLufs} LUFS`
        )
        throw new AppError('OFF_TARGET', 'the loudness after the normalization is off its plan')
      }
      return numbered
    }
  }
}
