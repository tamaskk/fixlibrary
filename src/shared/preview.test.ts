import { describe, expect, it } from 'vitest'
import {
  isManualCoverFile,
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
      album: EMPTY_CELL,
      label: EMPTY_CELL,
      year: EMPTY_CELL,
      bpm: EMPTY_CELL,
      key: EMPTY_CELL,
      styleId: EMPTY_CELL,
      secondaryStyleId: EMPTY_CELL,
      genre: EMPTY_CELL,
      folder: EMPTY_CELL,
      cues: EMPTY_CELL,
      energy: EMPTY_CELL,
      cover: EMPTY_CELL
    },
    warnings: [],
    excluded: false,
    error: null,
    newStyle: null,
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

  it('leaves out a field that is not valid, and keeps the others', () => {
    // Arrange
    const stored = {
      fields: {
        title: { value: 'One', source: 'lookup' },
        energy: { value: 11, source: 'analysis' },
        artist: { value: 'a\nb', source: 'id3' },
        mix: { value: 'Live', source: 'guess' }
      },
      warnings: ['DUPLICATE', 'SCARY']
    }

    // Act
    const proposal = readProposal(stored)

    // Assert
    expect(proposal).toEqual({
      fields: { title: { value: 'One', source: 'lookup' } },
      warnings: ['DUPLICATE']
    })
  })

  it.each([
    ['something that is no object', 'nothing'],
    ['fields that are no object', { fields: 'x', warnings: 'y' }]
  ])('reads %s as no proposal at all', (_what, stored) => {
    // Act
    const proposal = readProposal(stored)

    // Assert
    expect(proposal).toEqual({})
  })

  it.each([
    ['a path', '../Other/x.mp3'],
    ['a name with a colon', 'a:b.mp3'],
    ['a dot name', '..'],
    ['a name that turns the reading direction around', 'a\u202eb.mp3'],
    ['a name without an audio extension', 'Artist - Title'],
    ['a hidden name', '.Artist - Title.mp3'],
    ['a name with a zero-width joiner', 'a\u200db.mp3']
  ])('takes no file name that is %s', (_what, value) => {
    // Act
    const proposal = readProposal({ fields: { fileName: { value, source: 'lookup' } } })

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

  it.each(['a\u202eb', 'a\u200bb', 'a\u2066b', 'a\tb', 'a\u200cb', 'a\u00adb', 'a\u3164b'])(
    'cannot be text with an invisible character (%j)',
    (text) => {
      // Act
      const parsed = previewValueSchemas.title.safeParse(text)

      // Assert
      expect(parsed.success).toBe(false)
    }
  )

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

describe('the tempo and key of a proposal', () => {
  it('are read as a whole number and a Camelot code', () => {
    // Arrange
    const stored = {
      fields: {
        bpm: { value: 124, source: 'analysis', confidence: 0.9 },
        key: { value: '8A', source: 'analysis' }
      }
    }

    // Act
    const proposal = readProposal(stored)

    // Assert
    expect(proposal.fields).toEqual(stored.fields)
  })

  it.each([
    ['a tempo that is not whole', { bpm: { value: 123.65, source: 'analysis' } }],
    ['a tempo no music has', { bpm: { value: 4000, source: 'analysis' } }],
    ['a key that is no Camelot code', { key: { value: 'Am', source: 'analysis' } }],
    ['a code in lower case', { key: { value: '8a', source: 'analysis' } }]
  ])('leave out %s', (_name, fields) => {
    // Act
    const proposal = readProposal({ fields })

    // Assert
    expect(proposal.fields).toBeUndefined()
  })
})

describe('isManualCoverFile', () => {
  it.each([
    ['cover.jpg', 'image/jpeg', true],
    ['cover.PNG', 'image/png', true],
    ['cover.webp', '', true],
    ['COVER.JPEG', '', true],
    ['cover.gif', 'image/gif', false],
    ['cover.png', 'image/gif', false],
    ['cover.heic', '', false]
  ])('takes %s of type "%s": %s', (name, type, taken) => {
    // Act
    const result = isManualCoverFile(name, type)

    // Assert
    expect(result).toBe(taken)
  })
})
