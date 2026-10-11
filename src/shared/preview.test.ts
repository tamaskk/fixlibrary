import { describe, expect, it } from 'vitest'
import {
  matchesPreviewFilter,
  mergeProposal,
  PREVIEW_FILTERS,
  previewValueSchemas,
  readProposal,
  type PreviewCell,
  type PreviewRow
} from './preview'

const EMPTY_CELL: PreviewCell = {
  before: null,
  after: null,
  changed: false,
  source: null,
  confidence: null
}

function row(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    trackId: 1,
    currentFileName: 'a.mp3',
    cells: {
      fileName: EMPTY_CELL,
      artist: EMPTY_CELL,
      title: EMPTY_CELL,
      mix: EMPTY_CELL,
      styleId: EMPTY_CELL,
      energy: EMPTY_CELL
    },
    warnings: [],
    excluded: false,
    error: null,
    ...overrides
  }
}

describe('readProposal', () => {
  it('keeps the fields and warnings it knows, and drops everything else', () => {
    // Arrange
    const stored = {
      fields: { title: { value: 'One', source: 'lookup', confidence: 0.9 }, bogus: { value: 1 } },
      warnings: ['DUPLICATE'],
      somethingElse: true
    }

    // Act
    const proposal = readProposal(stored)

    // Assert
    expect(proposal).toEqual({
      fields: { title: { value: 'One', source: 'lookup', confidence: 0.9 } },
      warnings: ['DUPLICATE']
    })
  })

  it.each([
    ['a text that is not one line', { fields: { title: { value: 'a\nb', source: 'id3' } } }],
    ['an energy out of range', { fields: { energy: { value: 11, source: 'analysis' } } }],
    ['an unknown source', { fields: { title: { value: 'a', source: 'guess' } } }],
    ['an unknown warning', { warnings: ['SCARY'] }],
    ['something that is no object', 'nothing']
  ])('reads %s as no proposal at all', (_what, stored) => {
    // Act
    const proposal = readProposal(stored)

    // Assert
    expect(proposal).toEqual({})
  })
})

describe('mergeProposal', () => {
  it('adds the fields and warnings of a later stage to those of an earlier one', () => {
    // Arrange
    const current = readProposal({
      fields: { title: { value: 'One', source: 'id3' } },
      warnings: ['LOW_BITRATE']
    })
    const next = readProposal({
      fields: { energy: { value: 7, source: 'analysis' } },
      warnings: ['DUPLICATE', 'LOW_BITRATE']
    })

    // Act
    const merged = mergeProposal(current, next, [])

    // Assert
    expect(merged).toEqual({
      fields: { title: { value: 'One', source: 'id3' }, energy: { value: 7, source: 'analysis' } },
      warnings: ['DUPLICATE', 'LOW_BITRATE']
    })
  })

  it('leaves a field alone that the user set by hand in this preview', () => {
    // Arrange
    const current = readProposal({ fields: { title: { value: 'Mine', source: 'manual' } } })
    const next = readProposal({ fields: { title: { value: 'Theirs', source: 'lookup' } } })

    // Act
    const merged = mergeProposal(current, next, [])

    // Assert
    expect(merged.fields?.title).toEqual({ value: 'Mine', source: 'manual' })
  })

  it('proposes nothing for a field that is locked on the track', () => {
    // Arrange
    const next = readProposal({
      fields: {
        title: { value: 'Theirs', source: 'lookup' },
        artist: { value: 'Them', source: 'lookup' }
      }
    })

    // Act
    const merged = mergeProposal({}, next, ['title'])

    // Assert
    expect(merged.fields).toEqual({ artist: { value: 'Them', source: 'lookup' } })
  })
})

describe('the value of a field', () => {
  it('is trimmed, and an empty text is no value', () => {
    // Act
    const trimmed = previewValueSchemas.title.parse('  One  ')
    const empty = previewValueSchemas.title.parse('   ')

    // Assert
    expect(trimmed).toBe('One')
    expect(empty).toBeNull()
  })

  it.each([0, 11, 5.5])('cannot be the energy %s', (energy) => {
    // Act
    const parsed = previewValueSchemas.energy.safeParse(energy)

    // Assert
    expect(parsed.success).toBe(false)
  })
})

describe('matchesPreviewFilter', () => {
  const plain = row({ trackId: 1 })
  const uncertain = row({ trackId: 2, warnings: ['LOW_CONFIDENCE'] })
  const duplicate = row({ trackId: 3, warnings: ['DUPLICATE'] })
  const collided = row({ trackId: 4, warnings: ['NAME_COLLISION'] })
  const failed = row({
    trackId: 5,
    error: { trackId: 5, stage: 'lookup', code: 'TIMEOUT', message: 'The stage took too long' }
  })
  const rows = [plain, uncertain, duplicate, collided, failed]

  it.each([
    ['all', [1, 2, 3, 4, 5]],
    ['warnings', [2, 3, 4]],
    ['lowConfidence', [2]],
    ['duplicates', [3]],
    ['errors', [5]]
  ] as const)('"%s" shows exactly its rows', (filter, expected) => {
    // Act
    const shown = rows.filter((each) => matchesPreviewFilter(each, filter))

    // Assert
    expect(shown.map((each) => each.trackId)).toEqual(expected)
  })

  it('knows every filter', () => {
    // Act
    const answers = PREVIEW_FILTERS.map((filter) => matchesPreviewFilter(plain, filter))

    // Assert
    expect(answers).toEqual([true, false, false, false, false])
  })
})
