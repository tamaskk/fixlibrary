// The playlist generator (T-039): what the page asks for and what it gets back. The
// main process decides which tracks fit; the page only shows and edits.
import { z } from 'zod'
import { customCurveSchema, ENERGY_PROFILES } from './energy-curves'
import { moodTagsSchema } from './mood'
import { MAX_PLAYLIST_NAME, playlistNameSchema, type PlaylistTrackItem } from './playlists'

export const MAX_GENERATOR_STYLES = 5
export const MAX_PROMPT_LENGTH = 500
export const MIN_BPM = 60
export const MAX_BPM = 200
/** Far above a long set; they keep one generation short. */
export const MAX_SET_MINUTES = 600
export const MAX_SET_TRACKS = 200
/** How many alternatives "Csere" offers. */
export const ALTERNATIVE_COUNT = 5

const bpm = z.number().min(MIN_BPM).max(MAX_BPM)

export const setLengthSchema = z.discriminatedUnion('unit', [
  z.strictObject({
    unit: z.literal('minutes'),
    value: z.number().int().min(10).max(MAX_SET_MINUTES)
  }),
  z.strictObject({ unit: z.literal('tracks'), value: z.number().int().min(2).max(MAX_SET_TRACKS) })
])
export type SetLength = z.output<typeof setLengthSchema>

export const generatorParamsSchema = z
  .strictObject({
    /** The styles in the order the set moves through them; none means any style. */
    styleIds: z.array(z.number().int().positive()).max(MAX_GENERATOR_STYLES),
    length: setLengthSchema,
    bpmRange: z.tuple([bpm, bpm]).refine(([low, high]) => low <= high),
    energyProfile: z.enum(ENERGY_PROFILES),
    /** The drawn curve; only read for the profile `custom`. */
    customCurve: customCurveSchema.nullable(),
    moods: moodTagsSchema
  })
  .refine((params) => params.energyProfile !== 'custom' || params.customCurve !== null)
export type GeneratorParams = z.output<typeof generatorParamsSchema>

export const DEFAULT_GENERATOR_PARAMS: GeneratorParams = {
  styleIds: [],
  length: { unit: 'minutes', value: 60 },
  bpmRange: [118, 126],
  energyProfile: 'warmUp',
  customCurve: null,
  moods: []
}

/** What a prompt gave: the fields it named. The page fills them in, the rest stays. */
export type PromptParams = Partial<Omit<GeneratorParams, 'customCurve'>>

export const promptSchema = z.string().trim().min(1).max(MAX_PROMPT_LENGTH)

/** What a missing track should have been like: what the online recommendations look for. */
export interface GapTarget {
  styleId: number | null
  styleName: string | null
  bpm: number | null
  camelotKey: string | null
  energy: number
}

export type GeneratedEntry =
  | { kind: 'track'; item: PlaylistTrackItem; targetEnergy: number }
  | { kind: 'gap'; target: GapTarget }

export interface GeneratorResult {
  entries: GeneratedEntry[]
  gaps: number
  /** The length of the tracks of the list. */
  totalMs: number
  /** The mean distance of the tracks' energy from the curve; null with no track. */
  meanEnergyDeviation: number | null
}

/** A list as the page holds it: track ids in order, null for a gap. */
const listSchema = z
  .array(z.number().int().positive().nullable())
  .min(1)
  .max(MAX_SET_TRACKS * 2)

export const alternativesRequestSchema = z.strictObject({
  params: generatorParamsSchema,
  list: listSchema,
  index: z.number().int().nonnegative()
})
export type AlternativesRequest = z.output<typeof alternativesRequestSchema>

export const saveRequestSchema = z.strictObject({
  name: playlistNameSchema,
  trackIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_SET_TRACKS * 2)
})
export type SaveRequest = z.input<typeof saveRequestSchema>

export const gapTargetSchema = z.strictObject({
  styleId: z.number().int().positive().nullable(),
  styleName: z.string().max(MAX_PLAYLIST_NAME).nullable(),
  bpm: z.number().min(MIN_BPM).max(MAX_BPM).nullable(),
  camelotKey: z.string().max(3).nullable(),
  energy: z.number().min(1).max(10)
})
