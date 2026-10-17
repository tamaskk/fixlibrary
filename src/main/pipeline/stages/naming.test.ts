import { basename } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/database.test-util'
import { getTrackById, insertTracks, updateTrack, type NewTrack, type Track } from '../../db/tracks'
import { AppError } from '@shared/errors'
import { readProposal, type Proposal } from '@shared/preview'
import type { TrackFiles } from '../batch-files'
import { createNamingStage } from './naming'
import { createRenameStage } from './rename'
import type { StageContext } from './stage'

let testDatabase: TestDatabase

function trackWith(values: Partial<NewTrack> & { path: string }): Track {
  const [id] = insertTracks(testDatabase.db, [
    { originalPath: values.path, format: 'mp3', ...values }
  ]) as [number]
  return getTrackById(testDatabase.db, id, new Set()) as Track
}

function context(proposal: Proposal = {}, files: TrackFiles | null = null): StageContext {
  return { signal: new AbortController().signal, batchId: 1, files, proposal }
}

const ANALYSED: Proposal = {
  fields: {
    bpm: { value: 124, source: 'analysis', confidence: 1 },
    key: { value: '8A', source: 'analysis' }
  }
}

async function proposed(track: Track, proposal: Proposal = ANALYSED): Promise<Proposal['fields']> {
  const outcome = await createNamingStage().run(context(proposal), track)
  // What the stage proposes is what the preview reads: nothing is dropped as invalid.
  expect(readProposal(outcome?.proposal).fields).toEqual(outcome?.proposal?.fields)
  return outcome?.proposal?.fields
}

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
})

describe('the naming stage', () => {
  it('names an untagged file by what its file name says, without the junk', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/01. Artist_-_Title (Official Video) [HD].mp3' })

    // Act
    const fields = await proposed(track)

    // Assert
    expect(fields).toEqual({
      artist: { value: 'Artist', source: 'fileName' },
      title: { value: 'Title', source: 'fileName' },
      fileName: { value: 'Artist - Title [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('cleans what a lookup found, and keeps where it came from and how sure it was', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/x.mp3', artist: 'old', title: 'old' })
    const found: Proposal = {
      fields: {
        ...ANALYSED.fields,
        artist: { value: 'Daft Punk', source: 'musicbrainz', confidence: 0.9 },
        title: {
          value: 'Get Lucky (feat. Pharrell Williams) (Radio Edit)',
          source: 'musicbrainz',
          confidence: 0.9
        }
      }
    }

    // Act
    const fields = await proposed(track, found)

    // Assert
    expect(fields).toEqual({
      artist: {
        value: 'Daft Punk feat. Pharrell Williams',
        source: 'musicbrainz',
        confidence: 0.9
      },
      title: { value: 'Get Lucky', source: 'musicbrainz', confidence: 0.9 },
      mix: { value: 'Radio Edit', source: 'musicbrainz', confidence: 0.9 },
      fileName: {
        value: 'Daft Punk feat. Pharrell Williams - Get Lucky (Radio Edit) [8A Am - 124].mp3',
        source: 'naming'
      }
    })
  })

  it('cleans the tags of a track that no lookup named', async () => {
    // Arrange
    const track = trackWith({
      path: '/Music/whatever.mp3',
      artist: 'Artist ft. X',
      title: 'Title (Original Mix) [Free Download]'
    })

    // Act
    const fields = await proposed(track)

    // Assert
    expect(fields).toEqual({
      artist: { value: 'Artist feat. X', source: 'id3' },
      title: { value: 'Title', source: 'id3' },
      mix: { value: 'Original Mix', source: 'id3' },
      fileName: {
        value: 'Artist feat. X - Title (Original Mix) [8A Am - 124].mp3',
        source: 'naming'
      }
    })
  })

  it('proposes only the file name for names that are clean already', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/a.wav', artist: 'Ákos', title: 'Ilyenek voltunk' })

    // Act
    const fields = await proposed(track)

    // Assert
    expect(fields).toEqual({
      fileName: { value: 'Ákos - Ilyenek voltunk [8A Am - 124].wav', source: 'naming' }
    })
  })

  it('writes the energy into the name once the track has one', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/a.mp3', artist: 'A', title: 'T', energy: 7 })

    // Act
    const fields = await proposed(track)

    // Assert
    expect(fields?.fileName?.value).toBe('A - T [8A Am - 124 - E7].mp3')
  })

  it('takes the key and the tempo of the track when the batch proposes none', async () => {
    // Arrange
    const track = trackWith({
      path: '/Music/a.mp3',
      artist: 'A',
      title: 'T',
      bpm: 128,
      camelotKey: '11B',
      musicalKey: 'A'
    })

    // Act
    const fields = await proposed(track, {})

    // Assert
    expect(fields?.fileName?.value).toBe('A - T [11B A - 128].mp3')
  })

  it('takes a name the user set by hand as it is, in this preview or an earlier one', async () => {
    // Arrange
    const track = trackWith({
      path: '/Music/a.mp3',
      artist: 'Locked ft. Artist',
      title: 'Tag Title (Official Video)'
    })
    updateTrack(testDatabase.db, track.id, { lockedFields: ['artist'] })
    const locked = getTrackById(testDatabase.db, track.id, new Set()) as Track
    const edited: Proposal = {
      fields: { ...ANALYSED.fields, title: { value: 'By Hand (Audio)', source: 'manual' } }
    }

    // Act
    const fields = await proposed(locked, edited)

    // Assert
    expect(fields).toEqual({
      fileName: { value: 'Locked ft. Artist - By Hand (Audio) [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('leaves a guest in the title of a track whose artist the user set by hand', async () => {
    // Arrange
    const track = trackWith({
      path: '/Music/a.mp3',
      artist: 'Locked',
      title: 'Title (feat. X) [HD]'
    })
    updateTrack(testDatabase.db, track.id, { lockedFields: ['artist'] })
    const locked = getTrackById(testDatabase.db, track.id, new Set()) as Track

    // Act
    const fields = await proposed(locked)

    // Assert
    expect(fields).toEqual({
      title: { value: 'Title (feat. X)', source: 'id3' },
      fileName: { value: 'Locked - Title (feat. X) [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('writes the mix of a title the user set by hand once, where the user put it', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/a.mp3', artist: 'A', title: 'Song (Original Mix)' })
    updateTrack(testDatabase.db, track.id, { lockedFields: ['title'] })
    const locked = getTrackById(testDatabase.db, track.id, new Set()) as Track

    // Act
    const fields = await proposed(locked)

    // Assert
    expect(fields).toEqual({
      fileName: { value: 'A - Song (Original Mix) [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('keeps two versions apart when the mix was set by hand', async () => {
    // Arrange
    const track = trackWith({
      path: '/Music/a.mp3',
      artist: 'A',
      title: 'Song (Radio Edit)',
      mix: 'Dub'
    })
    updateTrack(testDatabase.db, track.id, { lockedFields: ['mix'] })
    const locked = getTrackById(testDatabase.db, track.id, new Set()) as Track

    // Act
    const fields = await proposed(locked)

    // Assert
    expect(fields).toEqual({
      fileName: { value: 'A - Song (Radio Edit) (Dub) [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('names a file that is to be converted by what it will be, also when the row shows no name', () => {
    // Arrange: an earlier edit left nothing to name the file by; this one gives a title again.
    const track = trackWith({ path: '/Music/a.wav' })
    const values = {
      fileName: null,
      artist: 'Bicep',
      title: 'Glue',
      mix: null,
      album: null,
      label: null,
      year: null,
      bpm: 124,
      key: '8A',
      styleId: null,
      secondaryStyleId: null,
      genre: null,
      folder: null,
      cues: null,
      energy: null,
      cover: null
    }

    // Act
    const converted = createNamingStage().recompute?.(track, values, { convert: { to: 'aiff' } })
    const kept = createNamingStage().recompute?.(track, values, {})

    // Assert
    expect(converted?.fields?.fileName?.value).toBe('Bicep - Glue [8A Am - 124].aiff')
    expect(kept?.fields?.fileName?.value).toBe('Bicep - Glue [8A Am - 124].wav')
  })

  it('takes the proposed name back when an edit leaves nothing to name the file by', () => {
    // Arrange
    const track = trackWith({ path: '/Music/a.mp3' })

    // Act
    const again = createNamingStage().recompute?.(
      track,
      {
        fileName: 'A - T [8A Am - 124].mp3',
        artist: null,
        title: null,
        mix: null,
        album: null,
        label: null,
        year: null,
        bpm: 124,
        key: '8A',
        styleId: null,
        secondaryStyleId: null,
        genre: null,
        folder: null,
        cues: null,
        energy: null,
        cover: null
      },
      {}
    )

    // Assert
    expect(again).toEqual({ fields: { fileName: { value: null, source: 'naming' } } })
  })

  it('reads only the title from the file name of a track whose artist the user set', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/Foo - Bar.mp3', artist: 'Foo!' })
    updateTrack(testDatabase.db, track.id, { lockedFields: ['artist'] })
    const locked = getTrackById(testDatabase.db, track.id, new Set()) as Track

    // Act
    const fields = await proposed(locked)

    // Assert
    expect(fields).toEqual({
      title: { value: 'Bar', source: 'fileName' },
      fileName: { value: 'Foo! - Bar [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('does the same for an artist typed in this preview', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/Foo - Bar.mp3' })
    const edited: Proposal = {
      fields: { ...ANALYSED.fields, artist: { value: 'By Hand', source: 'manual' } }
    }

    // Act
    const fields = await proposed(track, edited)

    // Assert
    expect(fields?.title).toEqual({ value: 'Bar', source: 'fileName' })
    expect(fields?.fileName?.value).toBe('By Hand - Bar [8A Am - 124].mp3')
  })

  it('makes the whole file name the title of a track whose artist the user took away', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/A - T.mp3' })
    updateTrack(testDatabase.db, track.id, { lockedFields: ['artist'] })
    const locked = getTrackById(testDatabase.db, track.id, new Set()) as Track

    // Act
    const fields = await proposed(locked)

    // Assert
    expect(fields).toEqual({
      title: { value: 'A - T', source: 'fileName' },
      fileName: { value: 'A - T [8A Am - 124].mp3', source: 'naming' }
    })
  })

  it('keeps a name that was nothing but junk, rather than leaving the track without one', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/a.mp3', artist: 'Artist', title: '(Official Video)' })

    // Act
    const fields = await proposed(track)

    // Assert
    expect(fields).not.toHaveProperty('title')
    expect(fields?.fileName?.value).toBe('Artist - (Official Video) [8A Am - 124].mp3')
  })

  it('follows the row after an edit, without cleaning what the user typed', () => {
    // Arrange
    const track = trackWith({ path: '/Music/a.aiff' })

    // Act
    const again = createNamingStage().recompute?.(
      track,
      {
        fileName: 'old.aiff',
        artist: 'AC/DC',
        title: 'Thunder (Audio)',
        mix: 'Live',
        album: null,
        label: null,
        year: null,
        bpm: 134,
        key: '5A',
        styleId: null,
        secondaryStyleId: null,
        genre: null,
        folder: null,
        cues: null,
        energy: 9,
        cover: null
      },
      {}
    )

    // Assert
    expect(again).toEqual({
      fields: {
        fileName: {
          value: 'AC-DC - Thunder (Audio) (Live) [5A Cm - 134 - E9].aiff',
          source: 'naming'
        }
      }
    })
  })

  it('runs after the lookup and the analysis, and the user can ask for it', () => {
    expect(createNamingStage()).toMatchObject({
      name: 'naming',
      phase: 'compute',
      resource: 'cpu',
      dependsOn: ['lookup', 'bpmKey'],
      selectable: true,
      timeoutMs: 10_000
    })
  })
})

describe('the rename stage', () => {
  function filesAt(working: string): TrackFiles & { moves: string[] } {
    const moves: string[] = []
    return {
      moves,
      workingPath: async () => working,
      ensureCleanCopy: async () => ({ collided: false }),
      wouldMove: async (fileName) => basename(working) !== fileName,
      move: async (to) => {
        moves.push(to)
        return { path: to, collided: false }
      },
      organize: async () => {
        throw new Error('a rename organizes nothing')
      },
      convertTo: async () => {
        throw new Error('a rename converts nothing')
      },
      setAside: async () => {
        throw new Error('a rename sets nothing aside')
      },
      replaceContent: async () => {
        throw new Error('a rename writes no content')
      }
    }
  }

  function named(fileName: unknown): Proposal {
    return { fields: { fileName: { value: fileName, source: 'naming' } } } as Proposal
  }

  it('leaves alone the name a conversion showed: the file has it already', async () => {
    // Arrange: the name of the file as it is, with what the naming's own rule refuses in it.
    const files = filesAt('/Music/What?.aiff')
    const proposal = {
      fields: { fileName: { value: 'What?.aiff', source: 'conversion' } }
    } as Proposal

    // Act
    const result = await createRenameStage().run(
      { signal: new AbortController().signal, batchId: 1, files, proposal },
      trackWith({ path: '/Music/What?.aiff' })
    )

    // Assert
    expect(result).toBeUndefined()
    expect(files.moves).toEqual([])
  })

  it('gives the file the proposed name, in the folder it is in', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/House/old.mp3' })
    const files = filesAt('/Music/House/old.mp3')

    // Act
    const outcome = await createRenameStage().run(
      context(named('Artist - Title [8A Am - 124].mp3'), files),
      track
    )

    // Assert
    expect(files.moves).toEqual(['/Music/House/Artist - Title [8A Am - 124].mp3'])
    expect(outcome).toBeUndefined()
  })

  it('reports a name that was taken', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/old.mp3' })
    const files = filesAt('/Music/old.mp3')
    files.move = async (to) => ({ path: to.replace('.mp3', ' (2).mp3'), collided: true })

    // Act
    const outcome = await createRenameStage().run(context(named('New.mp3'), files), track)

    // Assert
    expect(outcome).toEqual({ proposal: { warnings: ['NAME_COLLISION'] } })
  })

  it('leaves a file alone that has its name already, or for which none was proposed', async () => {
    // Arrange
    const track = trackWith({ path: '/Music/Same.mp3' })
    const files = filesAt('/Music/Same.mp3')
    // Not even asked for: asking makes the backup of the track.
    files.workingPath = async () => {
      throw new Error('the file must not be asked for')
    }

    // Act
    await createRenameStage().run(context(named('Same.mp3'), files), track)
    await createRenameStage().run(context({}, files), track)

    // Assert
    expect(files.moves).toEqual([])
  })

  it.each([
    ['a path', '../Elsewhere/New.mp3'],
    ['a hidden name', '.New.mp3'],
    ['another kind of file', 'New.wav'],
    ['no audio file at all', 'New.sh'],
    ['a name with a line break', 'New\n.mp3'],
    ['a name exFAT refuses', 'What?.mp3'],
    ['a name with a backslash', 'x\\..\\y.mp3'],
    ['a name that starts with a space', ' New.mp3'],
    ['a name with half a character', 'New\ud800.mp3'],
    ['a name of too many bytes', `${'ű'.repeat(200)}.mp3`],
    ['a name with a letter that shows as nothing', 'New\u2800.mp3']
  ])('refuses %s, and renames nothing', async (_name, fileName) => {
    // Arrange
    const track = trackWith({ path: '/Music/old.mp3' })
    const files = filesAt('/Music/old.mp3')
    // As stored by an older version or by hand: the stage does not take the preview's word.
    const proposal = { fields: { fileName: { value: fileName, source: 'naming' } } } as Proposal

    // Act
    const running = createRenameStage().run(context(proposal, files), track)

    // Assert
    await expect(running).rejects.toBeInstanceOf(AppError)
    expect(files.moves).toEqual([])
  })

  it('writes only after approval, and is not a function the user picks', () => {
    expect(createRenameStage()).toMatchObject({
      name: 'rename',
      phase: 'apply',
      resource: 'io',
      dependsOn: ['naming'],
      selectable: false
    })
  })
})
