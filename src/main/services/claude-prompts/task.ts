import type { z } from 'zod'

/**
 * One kind of question the app asks Claude about a list of items. Every item goes in
 * with an id and comes back with the same id, so answers are never matched by their
 * position. A task holds text and schemas only: it calls nothing.
 */
export interface ClaudeTask<Input, Answer extends { id: number }> {
  /**
   * Items of tasks with the same key go into one call. Two tasks that differ in
   * anything Claude sees (the styles to choose from, say) must differ in their key.
   */
  key: string
  systemPrompt: string
  /** The question for these items. What an item holds is data from files and lookups: untrusted. */
  prompt: (items: readonly ({ id: number } & Input)[]) => string
  /** The JSON Schema of the whole answer: `{ items: [...] }`, one entry per item asked. */
  jsonSchema: unknown
  /** Reads one entry of the answer. Claude's output is not trusted before this has read it. */
  answerSchema: z.ZodType<Answer>
}
