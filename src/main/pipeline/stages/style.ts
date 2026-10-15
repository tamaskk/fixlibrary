import { basename } from 'path'
import { z } from 'zod'
import type { AppDatabase } from '../../db/connection'
import { listStyles } from '../../db/styles'
import type { Track } from '../../db/tracks'
import type { Claude } from '../claude'
import {
  createStyleTask,
  looksLikeInstructions,
  type StyleAnswer,
  type StyleInput
} from '../../services/claude-prompts/style'
import type { LookupCache } from '../../services/lookup/cache'
import { lookupTrack, type LookupClients } from '../../services/lookup/chain'
import { AppError } from '@shared/errors'
import type { PreviewField, PreviewValue, Proposal } from '@shared/preview'
import { remixerOf } from '@shared/remix'
import { newStyleNameSchema } from '@shared/settings'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { decideStyle, newStyleColor } from '../style'
import { keptFingerprint } from './fingerprint'
import { LOOKUP_STAGE } from './lookup'
import type { Stage, StageContext, StageResult } from './stage'

export const STYLE_STAGE = 'style'

/** Where the genres a decision went by came from. */
export const GENRE_SOURCES = ['id3', 'discogs'] as const

/**
 * What the style stage keeps next to the proposed fields: the name of a style the
 * list does not have yet, created when the batch is approved, and what it went by.
 */
export const styleDetailsSchema = z.object({
  newPrimary: newStyleNameSchema.nullable(),
  /** The color the new style is to get, the one its placeholder is drawn with. */
  newColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/u)
    .nullable()
    .optional(),
  sources: z.array(z.enum(GENRE_SOURCES)).max(GENRE_SOURCES.length)
})

export type StyleDetails = z.output<typeof styleDetailsSchema>

/** The style details a batch item holds, or null. */
export function styleDetailsOf(after: unknown): StyleDetails | null {
  const record = z.record(z.string(), z.unknown()).safeParse(after)
  const parsed = styleDetailsSchema.safeParse(record.data?.['style'])
  return parsed.success ? parsed.data : null
}

export interface StyleStageDependencies {
  db: AppDatabase
  /** Null while there is no Claude to ask. */
  claude: () => Pick<Claude, 'ask'> | null
  cache: LookupCache
  clients: LookupClients
}

function valueOf(proposal: Proposal, field: PreviewField, own: PreviewValue): PreviewValue {
  const proposed = proposal.fields?.[field]
  return proposed === undefined ? own : proposed.value
}

function text(value: PreviewValue): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Decides the primary and the secondary style of a track with Claude, from the genre
 * of its tag and what Discogs files its release under (the lookup's kept answers),
 * its names, its remixer, label, year and tempo. Twenty tracks that run together are
 * one call. The app's rules have the last word (`pipeline/style.ts`): without any
 * genre, or below 70%, a track is Unsorted and flagged. A style the list does not
 * have is proposed by name and created only when the batch is approved. A style the
 * user set by hand is not looked at again.
 */
export function createStyleStage(dependencies: StyleStageDependencies): Stage {
  const { db, cache, clients } = dependencies

  async function run(context: StageContext, track: Track): Promise<StageResult | void> {
    if (track.lockedFields.includes('styleId')) return
    const { proposal } = context
    const artist = text(valueOf(proposal, 'artist', track.artist))
    const title = text(valueOf(proposal, 'title', track.title))
    const mix = text(valueOf(proposal, 'mix', track.mix))
    const found = await lookupTrack(
      {
        fingerprint: keptFingerprint(cache, track),
        durationS: track.durationMs === null ? null : track.durationMs / 1000,
        artist: track.artist,
        title: track.title,
        mix: track.mix,
        fileName: basename(track.path)
      },
      clients,
      // What the lookup of the run kept, asked as the lookup asked it (by the track's
      // own names): the classification sends no request of its own, and runs twenty at
      // a time outside the limit of the network.
      { signal: context.signal, keptOnly: true }
    )
    const tag = track.genre
    const discogsGenres = found.discogsGenres
    const discogsStyles = found.discogsStyles
    const sources = [
      ...(tag !== null ? (['id3'] as const) : []),
      ...(discogsGenres.length + discogsStyles.length > 0 ? (['discogs'] as const) : [])
    ]
    const styles = listStyles(db)
    let answer: Omit<StyleAnswer, 'id'> | null = null
    // Without any genre the track is Unsorted whatever Claude would say: no call.
    if (sources.length > 0) {
      const claude = dependencies.claude()
      if (!claude) throw new AppError('CLAUDE_FAILED', 'no Claude to ask')
      const bpm = valueOf(proposal, 'bpm', track.bpm)
      const label = text(valueOf(proposal, 'label', track.label))
      const year = valueOf(proposal, 'year', track.year)
      const input: StyleInput = {
        artist,
        title,
        mix,
        remixer: remixerOf(mix),
        label,
        year: typeof year === 'number' ? year : null,
        bpm: typeof bpm === 'number' ? Math.round(bpm) : null,
        genres: { tag, discogsGenres, discogsStyles }
      }
      // A track whose text reads like instructions is asked about alone.
      const task = createStyleTask(styles, looksLikeInstructions(input) ? track.id : undefined)
      answer = await claude.ask(task, input, context.signal)
    }
    const genres = [...(tag !== null ? [tag] : []), ...discogsGenres, ...discogsStyles]
    const decision = decideStyle(answer, styles, genres)
    const confidence = decision.confidence
    const chosen = decision.primary
    const primary = chosen !== null && 'id' in chosen ? chosen.id : null
    const newPrimary = chosen !== null && 'newName' in chosen ? chosen.newName : null
    // Read through its own schema before it is kept: what is kept is read the same way.
    const details: StyleDetails = styleDetailsSchema.parse({
      newPrimary,
      newColor: newPrimary === null ? null : newStyleColor(newPrimary, styles),
      sources: [...sources]
    })
    return {
      proposal: {
        fields: {
          styleId: { value: primary, source: 'claude', confidence },
          secondaryStyleId: {
            value: decision.secondary?.id ?? null,
            source: 'claude',
            confidence
          }
        },
        warnings: decision.unsorted ? ['UNSORTED'] : [],
        style: details
      }
    }
  }

  return {
    name: STYLE_STAGE,
    phase: 'compute',
    resource: 'claude',
    // The genres of the release come from the lookup, and so do the names it found.
    dependsOn: [LOOKUP_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.style,
    warnings: ['UNSORTED'],
    run
  }
}
