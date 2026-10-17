// The normalization of a track (T-032): what a batch keeps of its plan, for the
// preview to show and the apply stage to carry out.
import { z } from 'zod'

const kindSchema = z.enum(['mp3gain', 'reencode', 'pcm'])

const planSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    kind: kindSchema,
    gainDb: z.number().min(-40).max(40),
    expectedLufs: z.number(),
    expectedTruePeakDbtp: z.number(),
    toleranceLu: z.number().positive().max(1)
  }),
  z.object({ action: z.literal('none'), kind: kindSchema }),
  z.object({
    action: z.literal('skip'),
    kind: kindSchema,
    neededGainDb: z.number(),
    possibleGainDb: z.number()
  })
])

/** The entry the normalize stage keeps next to its proposal. */
export const normalizeEntrySchema = z.object({
  targetLufs: z.number().min(-23).max(-5),
  measuredLufs: z.number(),
  measuredTruePeakDbtp: z.number(),
  plan: planSchema
})

export type NormalizeEntry = z.output<typeof normalizeEntrySchema>

/** The normalize entry an item of a batch holds, or null when the batch planned none. */
export function normalizeEntryOf(after: unknown): NormalizeEntry | null {
  const record = z.record(z.string(), z.unknown()).safeParse(after)
  const parsed = normalizeEntrySchema.safeParse(record.data?.['normalize'])
  return parsed.success ? parsed.data : null
}
