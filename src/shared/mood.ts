// The moods a track can have (T-036): a fixed list, so that Claude cannot invent one
// and two tracks are compared by the same words.
import { z } from 'zod'

export const MOOD_TAGS = [
  'deep',
  'dark',
  'uplifting',
  'groovy',
  'melodic',
  'percussive',
  'vocal',
  'sensual',
  'euphoric',
  'hypnotic'
] as const
export type MoodTag = (typeof MOOD_TAGS)[number]

export const MAX_MOOD_TAGS = 3

/** Up to three different moods of the list. */
export const moodTagsSchema = z
  .array(z.enum(MOOD_TAGS))
  .max(MAX_MOOD_TAGS)
  .refine((tags) => new Set(tags).size === tags.length)
