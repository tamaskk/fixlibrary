import { describe, expect, it } from 'vitest'
import type { RekordboxExportCheck } from '@shared/rekordbox'
import { compareCues, judgeExportCheck } from './rekordbox-check'

const NONE = { count: 0, items: [] }

function checkWith(overrides: Partial<RekordboxExportCheck> = {}): RekordboxExportCheck {
  return {
    fileName: 'rekordbox.xml',
    exportedAt: 0,
    tracks: 3,
    skipped: 0,
    matched: 3,
    notInExport: NONE,
    missingFiles: NONE,
    unavailable: 0,
    unchecked: 0,
    unanalysed: NONE,
    ...overrides
  }
}

describe('judgeExportCheck', () => {
  it('passes an export with every track, no missing entry and every grid', () => {
    // Act
    const verdict = judgeExportCheck(checkWith())

    // Assert
    expect(verdict).toEqual({ clean: true, repeat: [], holds: [] })
  })

  it('asks for each step that puts right what the export shows, in the order of the wizard', () => {
    // Arrange
    const one = { count: 1, items: [{ trackId: 1, path: '/a.mp3' }] }

    // Act
    const verdict = judgeExportCheck(
      checkWith({
        notInExport: one,
        unanalysed: one,
        missingFiles: { count: 2, items: ['/x', '/y'] }
      })
    )

    // Assert
    expect(verdict).toEqual({
      clean: false,
      repeat: ['a.importTracks', 'a.waitAnalysis', 'a.removeMissing'],
      holds: []
    })
  })

  it('does not pass an export it could not look at whole', () => {
    // Act
    const verdict = judgeExportCheck(checkWith({ unavailable: 1, unchecked: 2, skipped: 3 }))

    // Assert
    expect(verdict).toEqual({
      clean: false,
      repeat: [],
      holds: ['unavailable', 'unchecked', 'skipped']
    })
  })
})

describe('judgeExportCheck and the time of the export', () => {
  it('holds an export made before the export step, allowing two seconds of a coarse clock', () => {
    // Act
    const stale = judgeExportCheck(checkWith({ exportedAt: 10_000 }), 12_001)
    const fresh = judgeExportCheck(checkWith({ exportedAt: 10_000 }), 12_000)

    // Assert
    expect(stale).toEqual({ clean: false, repeat: [], holds: ['stale'] })
    expect(fresh.clean).toBe(true)
  })
})

describe('compareCues', () => {
  it('finds a hot cue missing or more than 10 ms away, and passes one within 10 ms', () => {
    // Arrange
    const expected = [
      { trackId: 1, slot: 1, positionMs: 1000 },
      { trackId: 1, slot: 4, positionMs: 61_960 },
      { trackId: 1, slot: 5, positionMs: 90_000 },
      { trackId: 1, slot: 8, positionMs: 120_000 },
      { trackId: 2, slot: 1, positionMs: 500 }
    ]
    const exported = new Map([
      [
        1,
        [
          { num: 0, startSeconds: 1.01 },
          { num: 3, startSeconds: 61.951 },
          { num: 4, startSeconds: 90.011 },
          { num: -1, startSeconds: 120 }
        ]
      ]
    ])

    // Act
    const mismatches = compareCues(expected, (trackId) => exported.get(trackId) ?? null)

    // Assert
    expect(mismatches).toEqual([
      { trackId: 1, slot: 5, foundMs: 90_011, expectedMs: 90_000 },
      { trackId: 1, slot: 8, foundMs: null, expectedMs: 120_000 },
      { trackId: 2, slot: 1, foundMs: null, expectedMs: 500 }
    ])
  })
})
