import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
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
import { createFileOps, type FileOps } from './file-ops'
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

  it('starts over when an earlier write of the same file was interrupted', async () => {
    // Arrange
    const target = addTrack('a.mp3')
    writeFileSync(join(library, '.a.mp3.fixlib-tmp'), 'left behind by a crash')

    // Act
    await files.replace(target, (temp) => writeFile(temp, 'new content'))

    // Assert
    expect(readFileSync(target, 'utf8')).toBe('new content')
    expect(allFiles()).toEqual(['Music/a.mp3'])
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
