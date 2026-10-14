import { describe, expect, it } from 'vitest'
import type { PreviewCell, PreviewRow } from '@shared/preview'
import { coverDescription } from './cover-text'

const CELL: PreviewCell = {
  before: null,
  after: null,
  changed: false,
  source: null,
  confidence: null
}
const ROW = {
  trackId: 1,
  cells: { cover: { ...CELL, after: 'x.jpg', changed: true, source: 'itunes' } }
} as unknown as PreviewRow
const READY = { status: 'ready' as const, trackId: 1, after: 'data:image/jpeg;base64,AA' }

describe('coverDescription', () => {
  it.each([
    [undefined, 'Új borító: iTunes'],
    [{ status: 'failed' as const }, 'Új borító: iTunes · A képek nem tölthetők be'],
    [
      { ...READY, hadBefore: false, before: null, beforeSize: null },
      'Régi borító: nincs · Új borító: iTunes'
    ],
    [
      { ...READY, hadBefore: true, before: null, beforeSize: null },
      'Régi borító: nem olvasható · Új borító: iTunes'
    ],
    [
      {
        ...READY,
        hadBefore: true,
        before: 'data:image/jpeg;base64,AA',
        beforeSize: { width: 200, height: 180 }
      },
      'Régi borító: 200 × 180 px · Új borító: iTunes'
    ]
  ])('says what the covers of a row are (%#)', (thumbs, text) => {
    // Act
    const said = coverDescription(ROW, thumbs)

    // Assert
    expect(said).toBe(text)
  })
})
