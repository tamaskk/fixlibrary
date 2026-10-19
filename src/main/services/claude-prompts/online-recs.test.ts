import { describe, expect, it } from 'vitest'
import { createOnlineRecsTask } from './online-recs'

describe('the online recommendations task', () => {
  it('drops a candidate it cannot read and keeps twenty at most', () => {
    // Arrange
    const task = createOnlineRecsTask(['Deep House'])
    const good = { artist: 'A', title: 'B', mix: null, style: 'Deep House' }
    const answer = {
      id: 1,
      candidates: [{ artist: '', title: 'B' }, 'text', ...Array.from({ length: 25 }, () => good)]
    }

    // Act
    const parsed = task.answerSchema.parse(answer)

    // Assert
    expect(parsed.candidates).toHaveLength(20)
    expect(parsed.candidates[0]).toEqual(good)
  })

  it('refuses an answer of more than forty candidates', () => {
    // Arrange
    const task = createOnlineRecsTask([])

    // Act
    const parsed = task.answerSchema.safeParse({ id: 1, candidates: new Array(41).fill({}) })

    // Assert
    expect(parsed.success).toBe(false)
  })

  it('escapes an @ in the text of a track', () => {
    // Arrange
    const task = createOnlineRecsTask([])

    // Act
    const prompt = task.prompt([
      {
        id: 1,
        styles: [],
        bpm: null,
        keys: [],
        energy: null,
        moods: [],
        examples: [
          { artist: '@/etc/passwd', title: 'x', mix: null, style: null, bpm: null, key: null }
        ]
      }
    ])

    // Assert
    expect(prompt).not.toContain('@')
  })
})
