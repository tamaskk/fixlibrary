import { describe, expect, it } from 'vitest'
import {
  findDuplicateGroups,
  normalizeName,
  suggestKeep,
  type DuplicateCandidate
} from './duplicates'

const ACOUST_A = '11111111-1111-4111-8111-111111111111'
const ACOUST_B = '22222222-2222-4222-8222-222222222222'

function candidate(trackId: number, changes: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    trackId,
    acoustId: null,
    artist: 'Bicep',
    title: 'Glue',
    mix: null,
    durationMs: 300_000,
    format: 'mp3',
    bitrateKbps: 320,
    ...changes
  }
}

describe('normalizeName', () => {
  it.each([
    ['  Above  &   Beyond ', 'above and beyond'],
    ['Above&Beyond', 'above and beyond'],
    ['ABOVE AND BEYOND', 'above and beyond'],
    ['Tiësto', 'tiësto'],
    // Composed and decomposed spellings of one name.
    ['Tiësto', 'tiësto'],
    [null, '']
  ])('reads %j as %j', (name, normalized) => {
    expect(normalizeName(name)).toBe(normalized)
  })

  it('keeps accents: two names that differ only in one are two names', () => {
    expect(normalizeName('Tiësto')).not.toBe(normalizeName('Tiesto'))
  })
})

describe('findDuplicateGroups', () => {
  it.each<[string, Partial<DuplicateCandidate>, Partial<DuplicateCandidate>, boolean]>([
    [
      'the same AcoustID and the same mix, whatever the names, and lengths 8 s apart',
      { acoustId: ACOUST_A, artist: 'bicep', title: 'GLUE (web rip)', durationMs: 292_000 },
      { acoustId: ACOUST_A, durationMs: 300_000 },
      true
    ],
    [
      'the same AcoustID in another letter case',
      { acoustId: ACOUST_A.toUpperCase(), title: 'One' },
      { acoustId: ACOUST_A, title: 'Other' },
      true
    ],
    [
      'the same AcoustID but another mix',
      { acoustId: ACOUST_A, mix: 'Extended Mix' },
      { acoustId: ACOUST_A, mix: 'Radio Edit' },
      false
    ],
    ['the same names but another mix', { mix: 'Extended Mix' }, { mix: 'Radio Edit' }, false],
    [
      'two AcoustIDs and two titles',
      { acoustId: ACOUST_A },
      { acoustId: ACOUST_B, title: 'Apricots' },
      false
    ],
    [
      'the same names under two AcoustIDs: the names still say so',
      { acoustId: ACOUST_A },
      { acoustId: ACOUST_B },
      true
    ],
    ['the same names, written in other letter cases', { artist: 'BICEP' }, { title: 'glue' }, true],
    ['`&` and `and`', { artist: 'Above & Beyond' }, { artist: 'Above and Beyond' }, true],
    ['an accent more', { artist: 'Tiësto' }, { artist: 'Tiesto' }, false],
    ['a mix named in both', { mix: 'Extended Mix' }, { mix: 'extended  mix' }, true],
    ['no mix and `Original Mix`', { mix: null }, { mix: 'Original Mix' }, true],
    ['no mix and a remix', { mix: null }, { mix: 'Hammer Remix' }, false],
    ['lengths 2 s apart', { durationMs: 300_000 }, { durationMs: 302_000 }, true],
    [
      'lengths a little more than 2 s apart',
      { durationMs: 300_000 },
      { durationMs: 302_001 },
      false
    ],
    ['a length that is not known', { durationMs: null }, {}, false],
    ['no artist', { artist: null }, { artist: null }, false],
    ['no title', { title: null }, { title: null }, false],
    [
      'no artist, but the same AcoustID',
      { acoustId: ACOUST_A, artist: null },
      { acoustId: ACOUST_A },
      true
    ]
  ])('%s', (_name, first, second, together) => {
    const candidates = [candidate(1, first), candidate(2, second)]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual(together ? [[1, 2]] : [])
  })

  it('measures from the shortest file: a row of files each a little longer is not one group', () => {
    const candidates = [
      candidate(1, { durationMs: 100_000 }),
      candidate(2, { durationMs: 102_000 }),
      candidate(3, { durationMs: 104_000 }),
      candidate(4, { durationMs: 105_500 }),
      candidate(5, { durationMs: 110_000 })
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual([
      [1, 2],
      [3, 4]
    ])
  })

  it('does not make one group of a folder of files that share a made-up name', () => {
    // 60 files named alike, each 1.9 s longer than the one before.
    const candidates = Array.from({ length: 60 }, (_, index) =>
      candidate(index + 1, {
        artist: 'Unknown Artist',
        title: 'Track 01',
        durationMs: 100_000 + index * 1900
      })
    )

    const groups = findDuplicateGroups(candidates)

    expect(Math.max(...groups.map((group) => group.length))).toBe(2)
  })

  it.each([
    ['10 s apart', 310_000, true],
    ['a little more than 10 s apart', 310_001, false],
    ['of which one has no known length', null, true]
  ])('takes two files of one AcoustID that are %s as %s', (_name, durationMs, together) => {
    const candidates = [
      candidate(1, { acoustId: ACOUST_A, title: 'One' }),
      candidate(2, { acoustId: ACOUST_A, title: 'Other', durationMs })
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual(together ? [[1, 2]] : [])
  })

  it('does not let two rules chain files of ever greater length into one group', () => {
    // 40 files: each shares an AcoustID with the next (9 s longer) or a name (2 s longer).
    const candidates = Array.from({ length: 40 }, (_, index) => {
      const pair = Math.floor((index + 1) / 2)
      return candidate(index + 1, {
        acoustId: `${String(pair).padStart(8, '0')}-1111-4111-8111-111111111111`,
        title: `Title ${Math.floor(index / 2)}`,
        durationMs: 100_000 + Math.floor(index / 2) * 9000 + Math.floor((index + 1) / 2) * 2000
      })
    })

    const groups = findDuplicateGroups(candidates)

    const lengths = new Map(candidates.map((each) => [each.trackId, each.durationMs ?? 0]))
    for (const group of groups) {
      const of = group.map((id) => lengths.get(id) ?? 0)
      expect(Math.max(...of) - Math.min(...of)).toBeLessThanOrEqual(10_000)
    }
    expect(groups.length).toBeGreaterThan(1)
  })

  it('leaves a file of unknown length out when the files of its AcoustID are not one group', () => {
    const candidates = [
      candidate(1, { acoustId: ACOUST_A, title: 'One', durationMs: 200_000 }),
      candidate(2, { acoustId: ACOUST_A, title: 'Two', durationMs: 440_000 }),
      candidate(3, { acoustId: ACOUST_A, title: 'Three', durationMs: null }),
      candidate(4, { acoustId: ACOUST_A, title: 'Four', durationMs: 203_000 })
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual([[1, 4]])
  })

  it('keeps a file of unknown length with the files of its AcoustID when a wider group is cut', () => {
    const candidates = [
      candidate(1, { acoustId: ACOUST_A, title: 'One', durationMs: 100_000 }),
      candidate(2, { acoustId: ACOUST_A, title: 'Two', durationMs: 109_000 }),
      candidate(3, { acoustId: ACOUST_B, title: 'Two', durationMs: 110_500 }),
      candidate(4, { acoustId: ACOUST_B, title: 'Four', durationMs: 119_900 }),
      candidate(5, { acoustId: ACOUST_A, title: 'Five', durationMs: null })
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual([
      [1, 2, 5],
      [3, 4]
    ])
  })

  it('does not leave a file in a group it hung on only by a file that was cut away', () => {
    // 3 is the wrong answer of a lookup: the AcoustID of 2 on another track.
    const candidates = [
      candidate(1, { durationMs: 200_000 }),
      candidate(2, { acoustId: ACOUST_A, durationMs: 201_500 }),
      candidate(3, { acoustId: ACOUST_A, artist: 'Other', title: 'Song', durationMs: 211_000 }),
      candidate(4, { artist: 'Other', title: 'Song', durationMs: 209_500, format: 'aiff' })
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual([[1, 2]])
  })

  it('connects a track found by its AcoustID with one found by its names', () => {
    const candidates = [
      candidate(1, { acoustId: ACOUST_A, artist: null }),
      candidate(2, { acoustId: ACOUST_A }),
      candidate(3)
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual([[1, 2, 3]])
  })

  it('keeps the groups of two recordings apart', () => {
    const candidates = [
      candidate(1),
      candidate(2, { title: 'Apricots' }),
      candidate(3),
      candidate(4, { title: 'Apricots' }),
      candidate(5, { title: 'Atlas' })
    ]

    const groups = findDuplicateGroups(candidates)

    expect(groups).toEqual([
      [1, 3],
      [2, 4]
    ])
  })

  it('finds nothing among no tracks', () => {
    expect(findDuplicateGroups([])).toEqual([])
  })
})

describe('suggestKeep', () => {
  it.each<[string, Partial<DuplicateCandidate>, Partial<DuplicateCandidate>, number]>([
    [
      'an AIFF over an MP3 320',
      { format: 'mp3', bitrateKbps: 320 },
      { format: 'aiff', bitrateKbps: 1411 },
      2
    ],
    ['a WAV over an MP3 320', { format: 'wav', bitrateKbps: null }, { format: 'mp3' }, 1],
    [
      'a shorter AIFF over a longer MP3',
      { format: 'mp3', durationMs: 400_000 },
      { format: 'aiff', durationMs: 300_000 },
      2
    ],
    ['the MP3 with the higher bitrate', { bitrateKbps: 192 }, { bitrateKbps: 320 }, 2],
    [
      'a shorter MP3 320 over a longer MP3 192',
      { bitrateKbps: 320, durationMs: 300_000 },
      { bitrateKbps: 192, durationMs: 301_000 },
      1
    ],
    ['an MP3 whose bitrate is known', { bitrateKbps: null }, { bitrateKbps: 128 }, 2],
    ['the longer of two MP3 320s', { durationMs: 300_000 }, { durationMs: 301_500 }, 2],
    [
      'the longer of an AIFF and a WAV, whatever their bitrates',
      { format: 'aiff', bitrateKbps: 2116, durationMs: 300_000 },
      { format: 'wav', bitrateKbps: 1411, durationMs: 300_500 },
      2
    ],
    ['the first of two that nothing tells apart', {}, {}, 1]
  ])('keeps %s', (_name, first, second, kept) => {
    const members = [candidate(1, first), candidate(2, second)]

    const keep = suggestKeep(members)

    expect(keep).toBe(kept)
    expect(suggestKeep([...members].reverse())).toBe(kept)
  })

  it('orders a whole group: lossless, then bitrate, then length', () => {
    const members = [
      candidate(1, { format: 'mp3', bitrateKbps: 320, durationMs: 310_000 }),
      candidate(2, { format: 'wav', durationMs: 300_000 }),
      candidate(3, { format: 'aiff', durationMs: 300_800 }),
      candidate(4, { format: 'mp3', bitrateKbps: 128, durationMs: 320_000 })
    ]

    const keep = suggestKeep(members)

    expect(keep).toBe(3)
  })

  it('has nothing to keep of an empty group', () => {
    expect(suggestKeep([])).toBeNull()
  })
})
