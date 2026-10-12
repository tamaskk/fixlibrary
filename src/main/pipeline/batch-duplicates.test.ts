import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBatch,
  getBatchItem,
  mergeBatchItemProposal,
  setBatchItemError,
  setBatchItemsExcluded
} from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { getTrackById, insertTracks, type NewTrack } from '../db/tracks'
import { readProposal } from '@shared/preview'
import {
  groupBatchDuplicates,
  keepDuplicate,
  listDuplicateGroups,
  readDuplicateMark
} from './batch-duplicates'

const ACOUST_ID = '11111111-1111-4111-8111-111111111111'
const NO_VOLUMES: ReadonlySet<string> = new Set()

let testDatabase: TestDatabase

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

/** A batch of tracks as a scan stored them; a track is `Bicep - Glue`, MP3 320, 5 minutes unless told otherwise. */
function batchOf(tracks: Partial<NewTrack>[]): { batchId: number; ids: number[] } {
  const { db } = testDatabase
  const ids = insertTracks(
    db,
    tracks.map((track, index) => {
      const format = track.format ?? 'mp3'
      const path = track.path ?? `/Volumes/Music/Inbox/track-${index + 1}.${format}`
      return {
        originalPath: path,
        path,
        format,
        artist: 'Bicep',
        title: 'Glue',
        durationMs: 300_000,
        bitrateKbps: 320,
        ...track
      }
    })
  )
  const items = ids.map((trackId) => {
    const before = { ...getTrackById(db, trackId, NO_VOLUMES) }
    return { trackId, before }
  })
  return { batchId: createBatch(db, { type: 'run', mode: 'in_place', items }), ids }
}

function markOf(batchId: number, trackId: number): ReturnType<typeof readDuplicateMark> {
  return readDuplicateMark(getBatchItem(testDatabase.db, batchId, trackId)?.after)
}

function warningsOf(batchId: number, trackId: number): string[] {
  return readProposal(getBatchItem(testDatabase.db, batchId, trackId)?.after).warnings ?? []
}

/** Which copy of each group stays, as the tab shows it. */
function kept(batchId: number): number[] {
  return listDuplicateGroups(testDatabase.db, batchId).flatMap((group) =>
    group.members.filter((member) => member.keep).map((member) => member.trackId)
  )
}

describe('groupBatchDuplicates', () => {
  it('proposes the AIFF of a group of an MP3 320 and an AIFF as the copy to keep', () => {
    // Arrange
    const { batchId, ids } = batchOf([
      {},
      { format: 'aiff', bitrateKbps: 1411 },
      { title: 'Apricots' }
    ])
    const [mp3, aiff, other] = ids as [number, number, number]

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    expect(markOf(batchId, mp3)).toEqual({ group: mp3, keep: false, keeper: aiff, chosen: false })
    expect(markOf(batchId, aiff)).toEqual({ group: mp3, keep: true, keeper: aiff, chosen: false })
    expect(markOf(batchId, other)).toBeNull()
    expect(ids.map((id) => warningsOf(batchId, id))).toEqual([['DUPLICATE'], ['DUPLICATE'], []])
  })

  it('does not put the Extended Mix and the Radio Edit of a track into one group', () => {
    // Arrange: the mix is still in the title, as a tag often has it.
    const { batchId, ids } = batchOf([
      { title: 'Glue (Extended Mix)', acoustId: ACOUST_ID },
      { title: 'Glue (Radio Edit)', acoustId: ACOUST_ID }
    ])

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    expect(ids.map((id) => markOf(batchId, id))).toEqual([null, null])
    expect(listDuplicateGroups(testDatabase.db, batchId)).toEqual([])
  })

  it('goes by the names the batch proposes, and by the AcoustID its lookup found', () => {
    // Arrange: two files whose tags say nothing alike.
    const { batchId, ids } = batchOf([
      { artist: 'bicep_glue_final', title: null },
      { artist: 'Unknown', title: 'Track 03', durationMs: 295_000 },
      { artist: 'Somebody', title: 'Else', durationMs: 250_000 }
    ])
    const [first, second, third] = ids as [number, number, number]
    const found = { acoustId: ACOUST_ID, musicbrainzRecordingId: null }
    mergeBatchItemProposal(testDatabase.db, batchId, first, { identifiers: found }, [])
    mergeBatchItemProposal(testDatabase.db, batchId, second, { identifiers: found }, [])
    mergeBatchItemProposal(
      testDatabase.db,
      batchId,
      third,
      {
        fields: {
          artist: { value: 'Unknown', source: 'musicbrainz' },
          title: { value: 'Track 03', source: 'musicbrainz' }
        }
      },
      []
    )

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert: 1 and 2 by their AcoustID; 3 by the names proposed for it, but its
    // length is 45 s off, so it joins nothing.
    expect(markOf(batchId, first)?.group).toBe(first)
    expect(markOf(batchId, second)?.group).toBe(first)
    expect(markOf(batchId, third)).toBeNull()
  })

  it('reads the names of an untagged file from its file name, junk and all', () => {
    // Arrange
    const untagged = { artist: null, title: null }
    const { batchId, ids } = batchOf([
      { ...untagged, path: '/Volumes/Music/Inbox/01. Bicep_-_Glue (Official Video) [HD].mp3' },
      { ...untagged, path: '/Volumes/Music/Old/bicep - glue.mp3', bitrateKbps: 128 },
      { ...untagged, path: '/Volumes/Music/Old/Bicep - Glue (Hammer Remix).mp3' }
    ])
    const [first, second, remix] = ids as [number, number, number]

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    expect([markOf(batchId, first), markOf(batchId, second), markOf(batchId, remix)]).toEqual([
      { group: first, keep: true, keeper: first, chosen: false },
      { group: first, keep: false, keeper: first, chosen: false },
      null
    ])
    expect(listDuplicateGroups(testDatabase.db, batchId)).toMatchObject([
      { artist: 'Bicep', title: 'Glue', mix: null }
    ])
  })

  it('keeps what the item held besides: its fields, its other warnings, the ids of the lookup', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, {}])
    const [first] = ids as [number, number]
    const identifiers = { acoustId: ACOUST_ID, musicbrainzRecordingId: null }
    mergeBatchItemProposal(
      testDatabase.db,
      batchId,
      first,
      {
        identifiers,
        fields: { label: { value: 'Ninja Tune', source: 'discogs' } },
        warnings: ['LOW_BITRATE']
      },
      []
    )

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    const after = getBatchItem(testDatabase.db, batchId, first)?.after as Record<string, unknown>
    expect(after['identifiers']).toEqual(identifiers)
    expect(readProposal(after)).toEqual({
      fields: { label: { value: 'Ninja Tune', source: 'discogs' } },
      warnings: ['DUPLICATE', 'LOW_BITRATE']
    })
  })

  it('leaves a track a stage failed for out of every group', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, {}, {}])
    const [first, second, failed] = ids as [number, number, number]
    groupBatchDuplicates(testDatabase.db, batchId)
    setBatchItemError(testDatabase.db, batchId, {
      trackId: failed,
      stage: 'lookup',
      code: 'TIMEOUT',
      message: 'too long'
    })

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    expect(markOf(batchId, failed)).toBeNull()
    expect(warningsOf(batchId, failed)).toEqual([])
    expect([markOf(batchId, first)?.group, markOf(batchId, second)?.group]).toEqual([first, first])
  })

  it('changes nothing when it is done a second time', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, { bitrateKbps: 192 }, { title: 'Apricots' }])
    groupBatchDuplicates(testDatabase.db, batchId)
    const once = ids.map((id) => getBatchItem(testDatabase.db, batchId, id)?.after)

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    expect(ids.map((id) => getBatchItem(testDatabase.db, batchId, id)?.after)).toEqual(once)
  })

  it('takes a track out of its group once its names say it is another track', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, {}])
    const [first, second] = ids as [number, number]
    groupBatchDuplicates(testDatabase.db, batchId)
    mergeBatchItemProposal(
      testDatabase.db,
      batchId,
      second,
      { fields: { mix: { value: 'Hammer Remix', source: 'manual' } } },
      []
    )

    // Act
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert: a group of one is no group.
    expect([markOf(batchId, first), markOf(batchId, second)]).toEqual([null, null])
    expect([warningsOf(batchId, first), warningsOf(batchId, second)]).toEqual([[], []])
  })
})

describe('keepDuplicate', () => {
  it('makes the chosen copy the one that stays, in place of the proposed one', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, { format: 'aiff' }, { bitrateKbps: 128 }])
    const [mp3, aiff, low] = ids as [number, number, number]
    groupBatchDuplicates(testDatabase.db, batchId)

    // Act
    const taken = keepDuplicate(testDatabase.db, batchId, mp3)

    // Assert
    expect(taken).toBe(true)
    expect(ids.map((id) => markOf(batchId, id))).toEqual([
      { group: mp3, keep: true, keeper: mp3, chosen: true },
      { group: mp3, keep: false, keeper: mp3, chosen: true },
      { group: mp3, keep: false, keeper: mp3, chosen: true }
    ])
    // The proposal is still shown as what it is.
    const [group] = listDuplicateGroups(testDatabase.db, batchId)
    expect(group?.members.map((member) => member.suggested)).toEqual([false, true, false])
    expect([aiff, low].map((id) => warningsOf(batchId, id))).toEqual([['DUPLICATE'], ['DUPLICATE']])
  })

  it('leaves the other groups as they were', () => {
    // Arrange
    const { batchId, ids } = batchOf([
      {},
      { bitrateKbps: 192 },
      { title: 'Apricots', bitrateKbps: 192 },
      { title: 'Apricots' }
    ])
    groupBatchDuplicates(testDatabase.db, batchId)

    // Act
    keepDuplicate(testDatabase.db, batchId, ids[1] as number)

    // Assert
    expect(kept(batchId)).toEqual([ids[1], ids[3]])
  })

  it('refuses a track that is in no group, and a track of another batch', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, {}, { title: 'Apricots' }])
    groupBatchDuplicates(testDatabase.db, batchId)

    // Act
    const alone = keepDuplicate(testDatabase.db, batchId, ids[2] as number)
    const unknown = keepDuplicate(testDatabase.db, batchId, 9999)

    // Assert
    expect([alone, unknown]).toEqual([false, false])
    expect(kept(batchId)).toEqual([ids[0]])
  })

  it('still holds after the tracks are grouped again', () => {
    // Arrange
    const { batchId, ids } = batchOf([{}, { format: 'aiff' }, { format: 'wav' }])
    const [mp3, , wav] = ids as [number, number, number]
    groupBatchDuplicates(testDatabase.db, batchId)
    keepDuplicate(testDatabase.db, batchId, mp3)

    // Act: another copy leaves the group; the chosen one is still in it.
    mergeBatchItemProposal(
      testDatabase.db,
      batchId,
      wav,
      { fields: { title: { value: 'Something else', source: 'manual' } } },
      []
    )
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert
    expect(kept(batchId)).toEqual([mp3])
    expect(markOf(batchId, wav)).toBeNull()
  })

  it('gives way to the proposal when two groups with a chosen copy each become one', () => {
    // Arrange
    const { batchId, ids } = batchOf([
      { bitrateKbps: 128 },
      {},
      { title: 'Apricots', bitrateKbps: 128 },
      { title: 'Apricots', format: 'aiff' }
    ])
    groupBatchDuplicates(testDatabase.db, batchId)
    keepDuplicate(testDatabase.db, batchId, ids[0] as number)
    keepDuplicate(testDatabase.db, batchId, ids[2] as number)

    // Act: the second pair turns out to be the first track too.
    for (const id of [ids[2], ids[3]] as number[]) {
      mergeBatchItemProposal(
        testDatabase.db,
        batchId,
        id,
        { fields: { title: { value: 'Glue', source: 'manual' } } },
        []
      )
    }
    groupBatchDuplicates(testDatabase.db, batchId)

    // Assert: one group, and of two chosen copies neither is taken for the choice.
    expect(kept(batchId)).toEqual([ids[3]])
    expect(markOf(batchId, ids[0] as number)).toEqual({
      group: ids[0],
      keep: false,
      keeper: ids[3],
      chosen: false
    })
  })
})

describe('listDuplicateGroups', () => {
  it('shows each group with its copies, what tells them apart, and which one stays', () => {
    // Arrange
    const { batchId, ids } = batchOf([
      { title: 'Apricots' },
      { mix: 'Extended Mix' },
      { title: 'Apricots', bitrateKbps: 192, durationMs: 301_000 },
      { mix: 'Extended Mix', format: 'aiff', bitrateKbps: 1411 },
      { title: 'Atlas' }
    ])
    groupBatchDuplicates(testDatabase.db, batchId)
    setBatchItemsExcluded(testDatabase.db, batchId, [ids[2] as number], true)

    // Act
    const groups = listDuplicateGroups(testDatabase.db, batchId)

    // Assert
    expect(groups).toEqual([
      {
        id: ids[0],
        artist: 'Bicep',
        title: 'Apricots',
        mix: null,
        members: [
          {
            trackId: ids[0],
            fileName: 'track-1.mp3',
            folder: '/Volumes/Music/Inbox',
            format: 'mp3',
            bitrateKbps: 320,
            durationMs: 300_000,
            keep: true,
            suggested: true,
            excluded: false
          },
          {
            trackId: ids[2],
            fileName: 'track-3.mp3',
            folder: '/Volumes/Music/Inbox',
            format: 'mp3',
            bitrateKbps: 192,
            durationMs: 301_000,
            keep: false,
            suggested: false,
            excluded: true
          }
        ]
      },
      {
        id: ids[1],
        artist: 'Bicep',
        title: 'Glue',
        mix: 'Extended Mix',
        members: [
          expect.objectContaining({ trackId: ids[1], format: 'mp3', keep: false }),
          expect.objectContaining({ trackId: ids[3], format: 'aiff', keep: true, suggested: true })
        ]
      }
    ])
  })

  it('shows a file name on one line, whatever the name of the file holds', () => {
    // Arrange
    const { batchId } = batchOf([
      { path: '/Volumes/Music/Inbox/evil‮gpj.mp3', originalPath: '/Volumes/Music/Inbox/a.mp3' },
      {}
    ])
    groupBatchDuplicates(testDatabase.db, batchId)

    // Act
    const [group] = listDuplicateGroups(testDatabase.db, batchId)

    // Assert
    expect(group?.members[0]?.fileName).not.toContain('‮')
  })

  it('has no groups for a batch without duplicates, or for one that does not exist', () => {
    // Arrange
    const { batchId } = batchOf([{}, { title: 'Apricots' }])
    groupBatchDuplicates(testDatabase.db, batchId)

    // Act
    const groups = [
      listDuplicateGroups(testDatabase.db, batchId),
      listDuplicateGroups(testDatabase.db, 9999)
    ]

    // Assert
    expect(groups).toEqual([[], []])
  })
})
