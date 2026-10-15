import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileOps, unusableNameReason, type FileOps } from './file-ops'
import { logger } from './logger'

const FIXTURE = join(import.meta.dirname, '../../../tests/fixtures/synthetic/sine.mp3')

let folder: string
let library: string
let backups: string
let outside: string
let files: FileOps

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function addTrack(name: string): string {
  const path = join(library, name)
  mkdirSync(join(path, '..'), { recursive: true })
  copyFileSync(FIXTURE, path)
  return path
}

/** Every file under the test folder, as paths relative to it. */
function allFiles(root = folder): string[] {
  return (
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1))
      // Seen a second time through a link that a test made.
      .filter((path) => !path.includes('/Linked/'))
      .sort()
  )
}

beforeEach(() => {
  // As the file system names it: the temp folder sits behind a symlink on macOS.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-fileops-')))
  library = join(folder, 'Music')
  backups = join(folder, 'FixLibrary Backups')
  outside = join(folder, 'Elsewhere')
  for (const each of [library, backups, outside]) mkdirSync(each)
  files = createFileOps({ allowedRoots: () => [library, backups] })
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('copy', () => {
  it('makes a byte-identical copy, in folders that do not exist yet, and leaves no temp file', async () => {
    // Arrange
    const original = addTrack('a.mp3')
    const target = join(backups, '7', '12.mp3')

    // Act
    await files.copy(original, target)

    // Assert
    expect(sha256(target)).toBe(sha256(original))
    expect(allFiles()).toEqual(['FixLibrary Backups/7/12.mp3', 'Music/a.mp3'])
  })

  it('refuses a target that exists, and leaves it as it is', async () => {
    // Arrange
    const original = addTrack('a.mp3')
    const target = join(backups, 'kept.mp3')
    writeFileSync(target, 'an earlier backup')

    // Act
    const copy = files.copy(original, target)

    // Assert
    await expect(copy).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(readFileSync(target, 'utf8')).toBe('an earlier backup')
  })

  it('leaves nothing behind when it was told to stop', async () => {
    // Arrange
    const original = addTrack('a.mp3')
    const stop = new AbortController()
    stop.abort()

    // Act
    const copy = files.copy(original, join(backups, 'a.mp3'), stop.signal)

    // Assert
    await expect(copy).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })
})

describe('replace', () => {
  it('changes the file in one step, after the new content is complete', async () => {
    // Arrange
    const target = addTrack('a.mp3')
    let seenWhileWriting = ''

    // Act
    await files.replace(target, async (temp) => {
      await writeFile(temp, 'new content')
      seenWhileWriting = sha256(target)
    })

    // Assert
    expect(seenWhileWriting).toBe(sha256(FIXTURE))
    expect(readFileSync(target, 'utf8')).toBe('new content')
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it('leaves the file byte-identical and removes the temp file when the write fails halfway', async () => {
    // Arrange
    const target = addTrack('a.mp3')

    // Act
    const replace = files.replace(target, async (temp) => {
      await writeFile(temp, 'half of the new con')
      throw new Error('the encoder crashed')
    })

    // Assert
    await expect(replace).rejects.toThrow('the encoder crashed')
    expect(sha256(target)).toBe(sha256(FIXTURE))
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it('never puts the new content in place once it was told to stop, even if the write finished', async () => {
    // Arrange
    const target = addTrack('a.mp3')
    const stop = new AbortController()

    // Act
    const replace = files.replace(
      target,
      async (temp) => {
        await writeFile(temp, 'complete new content')
        stop.abort()
      },
      stop.signal
    )

    // Assert
    await expect(replace).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(sha256(target)).toBe(sha256(FIXTURE))
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it('is not disturbed by a temp file that an earlier write of the same file left behind', async () => {
    // Arrange
    const target = addTrack('a.mp3')
    writeFileSync(join(library, '.a.mp3.fixlib-tmp'), 'left behind by a crash')

    // Act
    await files.replace(target, (temp) => writeFile(temp, 'new content'))
    const cleaned = await files.removeTempFiles(library)

    // Assert
    expect(readFileSync(target, 'utf8')).toBe('new content')
    expect(cleaned).toBe(1)
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it('lets two writes of one file run at the same time without losing either temp file', async () => {
    // Arrange
    const target = addTrack('a.mp3')
    const slow = (text: string) => async (temp: string) => {
      await writeFile(temp, text)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // Act
    const results = await Promise.allSettled([
      files.replace(target, slow('first')),
      files.replace(target, slow('second'))
    ])

    // Assert
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(['first', 'second']).toContain(readFileSync(target, 'utf8'))
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it('writes a file whose name is as long as a name may be', async () => {
    // Arrange
    const target = addTrack(`${'á'.repeat(246)}.mp3`)

    // Act
    await files.replace(target, (temp) => writeFile(temp, 'new content'))

    // Assert
    expect(readFileSync(target, 'utf8')).toBe('new content')
    expect(readdirSync(library)).toHaveLength(1)
  })
})

describe('create', () => {
  it('makes a new file in one step, after its content is complete', async () => {
    // Arrange
    const target = join(library, 'House', 'a.aiff')
    let thereWhileWriting = true

    // Act
    await files.create(target, async (temp) => {
      await writeFile(temp, 'new content')
      thereWhileWriting = existsSync(target)
    })

    // Assert
    expect(thereWhileWriting).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('new content')
    expect(allFiles()).toEqual(['Music/House/a.aiff'])
  })

  it('never takes the place of a file: one that is there stays, and nothing is left beside it', async () => {
    // Arrange
    const taken = addTrack('a.mp3')

    // Act
    const create = files.create(taken, async (temp) => writeFile(temp, 'new content'))

    // Assert
    await expect(create).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(sha256(taken)).toBe(sha256(FIXTURE))
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it('gives the file its name inside the turn it is handed, and writes outside it', async () => {
    // Arrange
    const target = join(library, 'a.aiff')
    const order: string[] = []

    // Act
    await files.create(
      target,
      async (temp) => {
        order.push('write')
        await writeFile(temp, 'new content')
      },
      undefined,
      async (name) => {
        order.push('turn starts')
        await name()
        order.push(existsSync(target) ? 'named' : 'not named')
      }
    )

    // Assert
    expect(order).toEqual(['write', 'turn starts', 'named'])
  })

  it('does not name a file when the write was stopped while it waited for its turn', async () => {
    // Arrange
    const target = join(library, 'a.aiff')
    const stopping = new AbortController()

    // Act
    const create = files.create(
      target,
      async (temp) => writeFile(temp, 'new content'),
      stopping.signal,
      async (name) => {
        stopping.abort()
        await name()
      }
    )

    // Assert
    await expect(create).rejects.toThrow()
    expect(allFiles()).toEqual([])
  })

  it('refuses a link that was left where the content was to be written', async () => {
    // Arrange
    const target = join(library, 'a.aiff')
    const elsewhere = join(outside, 'secret.aiff')
    writeFileSync(elsewhere, 'not of the library')

    // Act
    const create = files.create(target, async (temp) => symlinkSync(elsewhere, temp))

    // Assert: the file the link points to does not get a name in the library.
    await expect(create).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(elsewhere, 'utf8')).toBe('not of the library')
  })
})

describe('restore', () => {
  it('puts a backup back over a changed file, byte for byte, in one step', async () => {
    // Arrange
    const original = addTrack('a.mp3')
    const backup = join(backups, '1', '5.mp3')
    await files.copy(original, backup)
    writeFileSync(original, 'what a bad batch wrote')

    // Act
    await files.restore(backup, original)

    // Assert
    expect(sha256(original)).toBe(sha256(FIXTURE))
    expect(sha256(backup)).toBe(sha256(FIXTURE))
    expect(allFiles()).toEqual(['FixLibrary Backups/1/5.mp3', 'Music/a.mp3'])
  })

  it('puts a backup back where the file no longer is', async () => {
    // Arrange
    const original = addTrack('House/a.mp3')
    const backup = join(backups, '1', '5.mp3')
    await files.copy(original, backup)
    rmSync(join(library, 'House'), { recursive: true })

    // Act
    await files.restore(backup, original)

    // Assert
    expect(sha256(original)).toBe(sha256(FIXTURE))
  })
})

describe('telling files and folders apart', () => {
  it('knows one file under two spellings, and what lies inside a folder', async () => {
    // Arrange
    const path = addTrack('House/a.mp3')
    symlinkSync(join(library, 'House'), join(library, 'Linked'))

    // Act
    const same = await files.sameFile(path, join(library, 'Linked', 'a.mp3'))
    const different = await files.sameFile(path, addTrack('b.mp3'))
    const inside = await files.isInside(join(library, 'House', 'new', 'c.mp3'), library)
    const notInside = await files.isInside(join(outside, 'c.mp3'), library)
    const sameVolume = (await files.volumeOf(library)) === (await files.volumeOf(backups))

    // Assert
    expect([same, different, inside, notInside, sameVolume]).toEqual([
      true,
      false,
      true,
      false,
      true
    ])
  })
})

describe('move and freeName', () => {
  it('renames a file into a folder that does not exist yet', async () => {
    // Arrange
    const from = addTrack('a.mp3')
    const to = join(library, 'House', 'Artist - Title.mp3')

    // Act
    await files.move(from, to)

    // Assert
    expect(sha256(to)).toBe(sha256(FIXTURE))
    expect(allFiles()).toEqual(['Music/House/Artist - Title.mp3'])
  })

  it('refuses a name that another file has, and changes neither file', async () => {
    // Arrange
    const from = addTrack('a.mp3')
    const taken = join(library, 'b.mp3')
    writeFileSync(taken, 'another track')

    // Act
    const move = files.move(from, taken)

    // Assert
    await expect(move).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(readFileSync(taken, 'utf8')).toBe('another track')
    expect(existsSync(from)).toBe(true)
  })

  it('finds the first free name by counting up from (2)', async () => {
    // Arrange
    addTrack('Artist - Title.mp3')
    addTrack('Artist - Title (2).mp3')
    const wanted = join(library, 'Artist - Title.mp3')

    // Act
    const free = await files.freeName(wanted)
    const untouched = await files.freeName(join(library, 'Other.mp3'))

    // Assert
    expect(free).toEqual({ path: join(library, 'Artist - Title (3).mp3'), collided: true })
    expect(untouched).toEqual({ path: join(library, 'Other.mp3'), collided: false })
  })

  it('does not count the file itself as being in the way of its own new name', async () => {
    // Arrange
    const own = addTrack('artist - title.mp3')
    const sameNameOtherCase = join(library, 'Artist - Title.mp3')

    // Act
    const free = await files.freeName(sameNameOtherCase, own)
    await files.move(own, free.path)

    // Assert: where the disk ignores letter case the two names are one file.
    expect(free.path).toBe(sameNameOtherCase)
    expect(readdirSync(library)).toEqual(['Artist - Title.mp3'])
  })
})

describe('never in the place of another file', () => {
  it('lets only one of ten files have a name that all ten are renamed to at the same time', async () => {
    // Arrange
    const tracks = Array.from({ length: 10 }, (_, index) => {
      const path = join(library, `track-${index}.mp3`)
      writeFileSync(path, `the audio of track ${index}`)
      return path
    })
    const wanted = join(library, 'Artist - Title.mp3')

    // Act
    const results = await Promise.allSettled(tracks.map((path) => files.move(path, wanted)))

    // Assert: one won, nine were refused, and the audio of all ten is still there.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(9)
    const contents = readdirSync(library).map((name) => readFileSync(join(library, name), 'utf8'))
    expect(contents.sort()).toEqual(tracks.map((_, index) => `the audio of track ${index}`))
  })

  it('lets only one of several copies land on a name that all are copied to at the same time', async () => {
    // Arrange
    const sources = Array.from({ length: 6 }, (_, index) => {
      const path = join(library, `track-${index}.mp3`)
      writeFileSync(path, `the audio of track ${index}`)
      return path
    })
    const target = join(backups, 'same.mp3')

    // Act
    const results = await Promise.allSettled(sources.map((path) => files.copy(path, target)))

    // Assert
    const won = results.findIndex((result) => result.status === 'fulfilled')
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(readFileSync(target, 'utf8')).toBe(`the audio of track ${won}`)
    expect(allFiles(backups)).toEqual(['FixLibrary Backups/same.mp3'])
  })

  it('does not take a second name of the same file for the file itself', async () => {
    // Arrange: two tracks that are hard links of one file.
    const first = addTrack('a.mp3')
    const second = join(library, 'b.mp3')
    linkSync(first, second)

    // Act
    const move = files.move(first, second)

    // Assert
    await expect(move).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(readdirSync(library).sort()).toEqual(['a.mp3', 'b.mp3'])
  })

  it('refuses to copy what a link points at', async () => {
    // Arrange
    writeFileSync(join(outside, 'private.mp3'), 'not ours')
    symlinkSync(join(outside, 'private.mp3'), join(library, 'link.mp3'))

    // Act
    const attempts = await Promise.allSettled([
      files.copy(join(library, 'link.mp3'), join(backups, 'stolen.mp3')),
      files.restore(join(library, 'link.mp3'), join(library, 'a.mp3'))
    ])

    // Assert
    expect(attempts).toMatchObject([
      { status: 'rejected', reason: { code: 'WRITE_FAILED' } },
      { status: 'rejected', reason: { code: 'WRITE_FAILED' } }
    ])
    expect(allFiles(backups)).toEqual([])
  })
})

describe('names', () => {
  it.each([
    ['Artist feat. X - Title (Mix) [8A Am - 124 - E7].mp3', 'file'],
    ['Ünnep - Tűz.AIFF', 'file'],
    ['Deep House', 'folder']
  ] as const)('accepts %j as a %s name', (name, kind) => {
    // Act
    const reason = unusableNameReason(name, kind)

    // Assert
    expect(reason).toBeNull()
  })

  it.each([
    ['a hidden name', '.38 Special - Hold On.mp3'],
    ['the name of a temp file', '.Baby.mp3.fixlib-tmp'],
    ['a line break', 'Song\n[info] Batch 7 undone.mp3'],
    ['a character that reverses the reading direction', 'Song\u202e3pm.mp3'],
    ['a path separator', 'AC/DC - Thunderstruck.mp3'],
    ['a colon', 'Artist: Title.mp3'],
    ['a trailing space', 'Song.mp3 '],
    ['another kind of file', 'Song.txt'],
    ['no extension', 'Song'],
    ['a decomposed name', 'Tűz.mp3'.normalize('NFD')],
    ['a name that is too long', `${'a'.repeat(230)}.mp3`],
    ['a dot name', '..']
  ])('refuses %s', (_what, name) => {
    // Act
    const reason = unusableNameReason(name, 'file')

    // Assert
    expect(reason).not.toBeNull()
  })

  it('counts a name that the disk would refuse as taken', async () => {
    // Arrange
    const tooLong = join(library, `${'a'.repeat(260)}.mp3`)

    // Act
    const free = files.freeName(tooLong)

    // Assert
    await expect(free).rejects.toMatchObject({ code: 'WRITE_FAILED' })
  })
})

describe('the folders themselves', () => {
  it('never removes the library, its clean copy or the backup folder, even when empty', async () => {
    // Act
    await files.removeEmptyFolder(backups)
    await files.removeEmptyFolder(library)

    // Assert
    expect(readdirSync(folder).sort()).toEqual(['Elsewhere', 'FixLibrary Backups', 'Music'])
  })

  it('creates the backup folder when it is not there yet, and no other folder', async () => {
    // Arrange
    rmSync(backups, { recursive: true })

    // Act
    await files.createRoot(backups)
    const other = files.createRoot(join(folder, 'Anything'))

    // Assert
    expect(existsSync(backups)).toBe(true)
    await expect(other).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(existsSync(join(folder, 'Anything'))).toBe(false)
  })

  it('refuses a link in the place of the backup folder', async () => {
    // Arrange
    rmSync(backups, { recursive: true })
    symlinkSync(outside, backups)

    // Act
    const create = files.createRoot(backups)

    // Assert
    await expect(create).rejects.toMatchObject({ code: 'WRITE_FAILED' })
  })

  it('finds a path under a folder that is spelled in another letter case or Unicode form', async () => {
    // Arrange
    const decomposed = join(folder, 'Zenék'.normalize('NFD'))
    mkdirSync(join(decomposed, 'House'), { recursive: true })
    writeFileSync(join(decomposed, 'House', 'a.mp3'), 'x')
    const composedPath = join(folder, 'Zenék'.normalize('NFC'), 'House', 'a.mp3')

    // Act
    const inRoot = await files.relativeTo(decomposed, composedPath)
    const otherCase = await files.relativeTo(join(folder, 'music'), join(library, 'b.mp3'))
    const notInside = await files.relativeTo(library, join(outside, 'c.mp3'))

    // Assert
    expect(inRoot).toBe(join('House', 'a.mp3'))
    expect(otherCase).toBe('b.mp3')
    expect(notInside).toBeNull()
  })
})

describe('remove', () => {
  it('deletes a file and says whether there was one', async () => {
    // Arrange
    const path = addTrack('a.mp3')

    // Act
    const first = await files.remove(path)
    const second = await files.remove(path)

    // Assert
    expect([first, second]).toEqual([true, false])
  })

  it('never deletes a folder', async () => {
    // Arrange
    addTrack('House/a.mp3')

    // Act
    const remove = files.remove(join(library, 'House'))

    // Assert
    await expect(remove).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(allFiles()).toEqual(['Music/House/a.mp3'])
  })

  it('removes a folder only when it is empty', async () => {
    // Arrange
    addTrack('Full/a.mp3')
    mkdirSync(join(library, 'Empty'))

    // Act
    await files.removeEmptyFolder(join(library, 'Full'))
    await files.removeEmptyFolder(join(library, 'Empty'))

    // Assert
    expect(readdirSync(library).sort()).toEqual(['Full'])
  })

  it('removes a folder that holds nothing but what Finder keeps there, and nothing else', async () => {
    // Arrange
    mkdirSync(join(library, 'Finder'))
    writeFileSync(join(library, 'Finder', '.DS_Store'), 'finder')
    mkdirSync(join(library, 'Empty'))
    mkdirSync(join(library, 'Other'))
    writeFileSync(join(library, 'Other', '.DS_Store'), 'finder')
    writeFileSync(join(library, 'Other', 'notes.txt'), 'mine')
    mkdirSync(join(library, 'Odd'))
    mkdirSync(join(library, 'Odd', '.DS_Store'))

    // Act
    const removed = await Promise.all(
      ['Finder', 'Empty', 'Other', 'Odd', 'Missing'].map((name) =>
        files.removeFolderOfFinderData(join(library, name))
      )
    )
    const root = await files.removeFolderOfFinderData(library)

    // Assert
    expect(removed).toEqual([true, true, false, false, false])
    expect(root).toBe(false)
    expect(readdirSync(library).sort()).toEqual(['Odd', 'Other'])
    expect(readdirSync(join(library, 'Other')).sort()).toEqual(['.DS_Store', 'notes.txt'])
  })

  it('follows no link, and deletes nothing through one', async () => {
    // Arrange
    mkdirSync(join(library, 'Real'))
    writeFileSync(join(library, 'Real', '.DS_Store'), 'finder')
    symlinkSync(join(library, 'Real'), join(library, 'Linked'))
    mkdirSync(join(library, 'Data'))
    symlinkSync(join(library, 'Real', '.DS_Store'), join(library, 'Data', '.DS_Store'))

    // Act
    const throughLink = await files.removeFolderOfFinderData(join(library, 'Linked'))
    const linkedData = await files.removeFolderOfFinderData(join(library, 'Data'))

    // Assert
    expect([throughLink, linkedData]).toEqual([false, false])
    expect(readdirSync(join(library, 'Real'))).toEqual(['.DS_Store'])
  })

  it('leaves a folder whose Finder data cannot be deleted, and says so without failing', async () => {
    // Arrange
    const locked = join(library, 'Locked')
    mkdirSync(locked)
    writeFileSync(join(locked, '.DS_Store'), 'finder')
    execFileSync('chflags', ['uchg', join(locked, '.DS_Store')])

    // Act
    const removed = await files.removeFolderOfFinderData(locked).finally(() => {
      execFileSync('chflags', ['nouchg', join(locked, '.DS_Store')])
    })

    // Assert
    expect(removed).toBe(false)
    expect(readdirSync(locked)).toEqual(['.DS_Store'])
  })

  it('deletes a folder once when two ask at the same time, and fails neither', async () => {
    // Arrange
    mkdirSync(join(library, 'Album'))
    writeFileSync(join(library, 'Album', '.DS_Store'), 'finder')

    // Act
    const answers = await Promise.all([
      files.removeFolderOfFinderData(join(library, 'Album')),
      files.removeFolderOfFinderData(join(library, 'Album'))
    ])

    // Assert
    expect(answers.filter(Boolean).length).toBeLessThanOrEqual(1)
    expect(readdirSync(library)).not.toContain('Album')
  })
})

describe('the folders it may touch', () => {
  it.each([
    ['copy to a path', (f: FileOps, inside: string, out: string) => f.copy(inside, out)],
    ['copy from a path', (f: FileOps, inside: string, out: string) => f.copy(out, inside + '.x')],
    [
      'replace a file',
      (f: FileOps, _inside: string, out: string) => f.replace(out, (temp) => writeFile(temp, 'x'))
    ],
    ['move a file to a path', (f: FileOps, inside: string, out: string) => f.move(inside, out)],
    ['move a file from a path', (f: FileOps, inside: string, out: string) => f.move(out, inside)],
    ['delete a file', (f: FileOps, _inside: string, out: string) => f.remove(out)]
  ])('refuses to %s outside the library and its backups', async (_name, act) => {
    // Arrange
    const inside = addTrack('a.mp3')
    const out = join(outside, 'private.mp3')
    writeFileSync(out, 'not ours')

    // Act
    const attempt = act(files, inside, out)

    // Assert
    await expect(attempt).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(readFileSync(out, 'utf8')).toBe('not ours')
    expect(readdirSync(outside)).toEqual(['private.mp3'])
  })

  it('is not led out by a link, by dots in the path or by a relative path', async () => {
    // Arrange
    writeFileSync(join(outside, 'private.mp3'), 'not ours')
    symlinkSync(outside, join(library, 'Linked'))

    // Act
    const attempts = await Promise.allSettled([
      files.remove(join(library, 'Linked', 'private.mp3')),
      files.remove(join(library, '..', 'Elsewhere', 'private.mp3')),
      files.remove('Music/a.mp3')
    ])

    // Assert
    expect(attempts).toMatchObject([
      { status: 'rejected', reason: { code: 'INVALID_INPUT' } },
      { status: 'rejected', reason: { code: 'INVALID_INPUT' } },
      { status: 'rejected', reason: { code: 'INVALID_INPUT' } }
    ])
    expect(readFileSync(join(outside, 'private.mp3'), 'utf8')).toBe('not ours')
  })

  it('follows the settings when the folders change', async () => {
    // Arrange
    let roots = [library]
    const changing = createFileOps({ allowedRoots: () => roots })
    const path = join(outside, 'a.mp3')
    writeFileSync(path, 'x')

    // Act
    const before = changing.remove(path)
    await expect(before).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    roots = [outside]
    const after = await changing.remove(path)

    // Assert
    expect(after).toBe(true)
  })
})

describe('removeTempFiles', () => {
  // `chflags` is how macOS makes a file that cannot be removed; the app runs nowhere else.
  it.skipIf(process.platform !== 'darwin')(
    'goes on with the rest of a folder, and the folders below it, after a file it cannot remove',
    async () => {
      // Arrange: a temp file the system will not let go of, among others.
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      addTrack('House/Deep/c.mp3')
      const stuck = join(library, 'House', '.a.mp3.11111111.fixlib-tmp')
      writeFileSync(stuck, 'half')
      writeFileSync(join(library, 'House', '.b.mp3.22222222.fixlib-tmp'), 'half')
      writeFileSync(join(library, 'House', 'Deep', '.c.mp3.33333333.fixlib-tmp'), 'half')
      execFileSync('chflags', ['uchg', stuck])

      try {
        // Act
        const removed = await files.removeTempFiles(library)

        // Assert
        expect(removed).toBe(2)
        expect(allFiles()).toEqual([
          'Music/House/.a.mp3.11111111.fixlib-tmp',
          'Music/House/Deep/c.mp3'
        ])
      } finally {
        execFileSync('chflags', ['nouchg', stuck])
      }
    }
  )

  it('deletes what interrupted writes left behind, in every folder, and nothing else', async () => {
    // Arrange
    addTrack('a.mp3')
    addTrack('House/b.mp3')
    writeFileSync(join(library, '.a.mp3.fixlib-tmp'), 'half')
    writeFileSync(join(library, 'House', '.b.mp3.fixlib-tmp'), 'half')
    writeFileSync(join(library, 'House', '.DS_Store'), 'finder')
    writeFileSync(join(library, 'House', 'notes.fixlib-tmp'), 'not a temp file of ours')
    writeFileSync(join(outside, '.c.mp3.fixlib-tmp'), 'not in the library')
    symlinkSync(outside, join(library, 'Linked'))

    // Act
    const removed = await files.removeTempFiles(library)

    // Assert
    expect(removed).toBe(2)
    expect(allFiles()).toEqual([
      'Elsewhere/.c.mp3.fixlib-tmp',
      'Music/House/.DS_Store',
      'Music/House/b.mp3',
      'Music/House/notes.fixlib-tmp',
      'Music/a.mp3'
    ])
  })

  it('finds nothing in a folder that is not there', async () => {
    // Act
    const removed = await files.removeTempFiles(join(library, 'Gone'))

    // Assert
    expect(removed).toBe(0)
  })

  it('does not walk a link that stands in the place of the folder', async () => {
    // Arrange
    writeFileSync(join(outside, '.c.mp3.fixlib-tmp'), 'not ours')
    const linkedFiles = createFileOps({ allowedRoots: () => [join(folder, 'Linked root')] })
    symlinkSync(outside, join(folder, 'Linked root'))

    // Act
    const removed = await linkedFiles.removeTempFiles(join(folder, 'Linked root'))

    // Assert
    expect(removed).toBe(0)
    expect(existsSync(join(outside, '.c.mp3.fixlib-tmp'))).toBe(true)
  })

  it('refuses to clean a folder outside the library', async () => {
    // Arrange
    vi.spyOn(logger, 'warn').mockImplementation(() => {})

    // Act
    const clean = files.removeTempFiles(outside)

    // Assert
    await expect(clean).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('sizes', () => {
  it('reads the size of a file and the free space of its volume', async () => {
    // Arrange
    const path = addTrack('a.mp3')

    // Act
    const size = await files.sizeOf(path)
    const free = await files.freeBytes(join(backups, 'not', 'there', 'yet'))

    // Assert
    expect(size).toBe(10_468)
    expect(free).toBeGreaterThan(0)
  })
})

describe('what the second audit found', () => {
  it('does not move a link: its target outside the library would get a second name inside', async () => {
    // Arrange
    writeFileSync(join(outside, 'private.mp3'), 'not a library file')
    const link = join(library, 'link.mp3')
    symlinkSync(join(outside, 'private.mp3'), link)

    // Act
    const move = files.move(link, join(library, 'moved.mp3'))

    // Assert
    await expect(move).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(allFiles(library)).not.toContain('Music/moved.mp3')
  })

  it('puts nothing in place when the write is told to stop after its content was written', async () => {
    // Arrange
    const target = addTrack('a.mp3')
    const before = sha256(target)
    const stop = new AbortController()

    // Act: the stop arrives while the temp file is being synced to disk.
    const replace = files.replace(
      target,
      async (temp) => {
        await writeFile(temp, 'new content')
        setImmediate(() => stop.abort())
      },
      stop.signal
    )

    // Assert
    await expect(replace).rejects.toMatchObject({ code: 'WRITE_FAILED' })
    expect(sha256(target)).toBe(before)
    expect(allFiles()).toEqual(['Music/a.mp3'])
  })

  it.each(['​', '⁠', '﻿', '­'])('refuses a name with the invisible character %j', (character) => {
    // Arrange
    const name = `Tra${character}ck.mp3`

    // Act
    const reason = unusableNameReason(name, 'file')

    // Assert
    expect(reason).not.toBeNull()
  })
})
