import type { AppDatabase } from '../../db/connection'
import { listStyles } from '../../db/styles'
import { updateTrack } from '../../db/tracks'
import { looksLikeInstructions } from '../../services/claude-prompts/style'
import { createMoodTask, type MoodInput } from '../../services/claude-prompts/mood'
import type { Claude } from '../claude'
import { AppError } from '@shared/errors'
import type { PreviewValue } from '@shared/preview'
import { STAGE_TIMEOUTS_MS } from '@shared/timeouts'
import { BPM_KEY_STAGE } from './bpm-key'
import { ENERGY_STAGE } from './energy-value'
import type { Stage } from './stage'
import { STYLE_STAGE } from './style'
import { fieldOf } from './style-tags'

export const MOOD_STAGE = 'mood'

export interface MoodStageDependencies {
  db: AppDatabase
  /** Null while there is no Claude to ask. */
  claude: () => Pick<Claude, 'ask'> | null
}

// Words a tag has no reason to hold and an instruction about moods does. Not "every"
// or "all" alone: titles hold them.
const TALKING_OF_MOODS = /\b(?:moods?|choose|every track|all tracks)\b/iu

/**
 * True for a track whose text reads like it talks to the model: the words of the style
 * task, and those of this one. The style name counts: a new style was named by Claude.
 */
function talksToTheModel(input: MoodInput): boolean {
  const style = { artist: input.style, title: null, mix: null, label: null }
  const texts = [input.artist, input.title, input.mix, input.label, input.style]
  return (
    [input, style].some((each) => looksLikeInstructions(each)) ||
    texts.some((text) => text !== null && TALKING_OF_MOODS.test(text))
  )
}

function text(value: PreviewValue): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function whole(value: PreviewValue): number | null {
  return typeof value === 'number' ? Math.round(value) : null
}

/**
 * Asks Claude for the moods of a track, up to three words of a fixed list, from its
 * names, label, style, tempo and energy as the batch has them (T-036). Twenty tracks
 * that run together are one call. Kept on the track once, like an analysis: a track
 * that has its moods is not asked again. It proposes nothing and writes no file.
 */
export function createMoodStage(dependencies: MoodStageDependencies): Stage {
  const { db } = dependencies
  return {
    name: MOOD_STAGE,
    phase: 'compute',
    resource: 'claude',
    dependsOn: [],
    // It asks with what these find, when the batch has them, and without it otherwise.
    follows: [BPM_KEY_STAGE, STYLE_STAGE, ENERGY_STAGE],
    selectable: true,
    timeoutMs: STAGE_TIMEOUTS_MS.style,
    run: async ({ proposal, signal }, track) => {
      if (track.moodTags !== null) return
      const claude = dependencies.claude()
      if (!claude) throw new AppError('CLAUDE_FAILED', 'no Claude to ask')
      const styleId = fieldOf(track, proposal, 'styleId', track.primaryStyleId).value
      const input: MoodInput = {
        artist: text(fieldOf(track, proposal, 'artist', track.artist).value),
        title: text(fieldOf(track, proposal, 'title', track.title).value),
        mix: text(fieldOf(track, proposal, 'mix', track.mix).value),
        label: text(fieldOf(track, proposal, 'label', track.label).value),
        style: listStyles(db).find((style) => style.id === styleId)?.name ?? null,
        bpm: whole(fieldOf(track, proposal, 'bpm', track.bpm).value),
        energy: whole(fieldOf(track, proposal, 'energy', track.energy).value)
      }
      // A track whose text reads like instructions is asked about alone.
      const task = createMoodTask(talksToTheModel(input) ? track.id : undefined)
      const answer = await claude.ask(task, input, signal)
      // A run that was stopped keeps nothing of an answer that came after all.
      if (signal.aborted) throw new AppError('UNEXPECTED', 'the stage was stopped')
      updateTrack(db, track.id, { moodTags: answer.moods })
    }
  }
}
