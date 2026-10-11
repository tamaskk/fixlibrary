import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertBackup } from '../db/backups'
import { createBatch, setBatchStatus } from '../db/batches'
import { createTestDatabase, type TestDatabase } from '../db/database.test-util'
import { setSetting } from '../db/settings'
import { listStyles } from '../db/styles'
import { insertTracks } from '../db/tracks'
import { DEFAULT_SETTINGS, DEFAULT_STYLES, type StyleInput } from '@shared/settings'
import {
  ensureDefaultStyles,
  getSettingsSnapshot,
  isUnsuitableLibraryRoot,
  libraryFoldersOverlap,
  resolveEffectiveSettings,
  saveStyles,
  setFolder,
  updateSettings,
  type SettingsEnvironment
} from './settings'

const environment: SettingsEnvironment = { homeDir: '/Users/dj', cpuCount: 8 }

let testDatabase: TestDatabase

/** A real folder inside the test's temp directory. */
function makeFolder(...segments: string[]): string {
  const folder = join(testDatabase.migrationsFolder, 'folders', ...segments)
  mkdirSync(folder, { recursive: true })
  // As the file system names it: the temp folder itself sits behind a symlink on macOS.
  return realpathSync.native(folder)
}

beforeEach(() => {
  testDatabase = createTestDatabase()
})

afterEach(() => {
  testDatabase.cleanup()
  vi.restoreAllMocks()
})

describe('getSettingsSnapshot', () => {
  it('returns the documented defaults on a fresh database', () => {
    // Act
    const snapshot = getSettingsSnapshot(testDatabase.db, environment)

    // Assert
    expect(snapshot.settings).toEqual(DEFAULT_SETTINGS)
    expect(snapshot.effective).toEqual({
      backupFolder: null,
      generatedXmlFolder: '/Users/dj/Documents/FixLibrary',
      exportedXmlFolder: '/Users/dj/Documents/FixLibrary',
      workerCount: 7
    })
  })

  it.each(['/Volumes/DJ USB', '/Users/dj', '/Music'])(
    'has no default backup folder for the library %s, which has no usable folder next to it',
    (rootFolder) => {
      // Arrange
      const settings = {
        ...DEFAULT_SETTINGS,
        library: { ...DEFAULT_SETTINGS.library, rootFolder }
      }

      // Act
      const effective = resolveEffectiveSettings(settings, environment)

      // Assert
      expect(effective.backupFolder).toBeNull()
    }
  )

  it('puts the default backup folder next to a library inside a drive', () => {
    // Arrange
    const settings = {
      ...DEFAULT_SETTINGS,
      library: { ...DEFAULT_SETTINGS.library, rootFolder: '/Volumes/DJ USB/Music' }
    }

    // Act
    const effective = resolveEffectiveSettings(settings, environment)

    // Assert
    expect(effective.backupFolder).toBe('/Volumes/DJ USB/FixLibrary Backups')
  })

  it('never resolves the automatic worker count below one', () => {
    // Act
    const snapshot = getSettingsSnapshot(testDatabase.db, { homeDir: '/Users/dj', cpuCount: 1 })

    // Assert
    expect(snapshot.effective.workerCount).toBe(1)
  })

  it('falls back to the default of a group whose stored value is invalid', () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setSetting(testDatabase.db, 'loudness', { targetLufs: 'loud' })
    setSetting(testDatabase.db, 'performance', { workerCount: 3 })

    // Act
    const { settings } = getSettingsSnapshot(testDatabase.db, environment)

    // Assert
    expect(settings.loudness).toEqual(DEFAULT_SETTINGS.loudness)
    expect(settings.performance).toEqual({ workerCount: 3 })
  })
})

describe('updateSettings', () => {
  it('changes only the given fields and keeps them after a restart', () => {
    // Arrange
    const patch = { library: { mode: 'in_place' }, loudness: { targetLufs: -8 } }

    // Act
    const result = updateSettings(testDatabase.db, patch, environment)
    const afterRestart = getSettingsSnapshot(testDatabase.reopen(), environment)

    // Assert
    expect(result.ok).toBe(true)
    expect(afterRestart.settings).toEqual({
      ...DEFAULT_SETTINGS,
      library: { ...DEFAULT_SETTINGS.library, mode: 'in_place' },
      loudness: { targetLufs: -8, method: 'lossless' }
    })
  })

  it('refuses a folder path sent by the renderer and changes nothing', () => {
    // Arrange
    const patch = { library: { mode: 'in_place', rootFolder: '/Volumes/DJ SSD' } }

    // Act
    const result = updateSettings(testDatabase.db, patch, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(getSettingsSnapshot(testDatabase.db, environment).settings).toEqual(DEFAULT_SETTINGS)
  })

  it('resolves a fixed worker count as given', () => {
    // Act
    const result = updateSettings(testDatabase.db, { performance: { workerCount: 3 } }, environment)

    // Assert
    expect(result.ok && result.value.effective.workerCount).toBe(3)
  })

  it('never uses more workers than the machine has cores', () => {
    // Act
    const result = updateSettings(
      testDatabase.db,
      { performance: { workerCount: 64 } },
      environment
    )

    // Assert
    expect(result.ok && result.value.settings.performance.workerCount).toBe(64)
    expect(result.ok && result.value.effective.workerCount).toBe(8)
  })

  it('ignores a field that is present but undefined, keeping the stored value', () => {
    // Arrange
    updateSettings(testDatabase.db, { loudness: { targetLufs: -8, method: 'exact' } }, environment)

    // Act
    const result = updateSettings(
      testDatabase.db,
      { loudness: { targetLufs: undefined, method: 'lossless' } },
      environment
    )
    const afterRestart = getSettingsSnapshot(testDatabase.reopen(), environment)

    // Assert
    expect(result.ok).toBe(true)
    expect(afterRestart.settings.loudness).toEqual({ targetLufs: -8, method: 'lossless' })
  })

  it('stores a name composed, with single plain spaces', () => {
    // Arrange
    const typed = '  Dro\u0301p\u00a0\u00a0 1 '
    const hotCues = DEFAULT_SETTINGS.hotCues.map((cue, index) =>
      index === 0 ? { ...cue, name: typed } : cue
    )

    // Act
    const result = updateSettings(testDatabase.db, { hotCues }, environment)

    // Assert
    expect(result.ok && result.value.settings.hotCues[0]?.name).toBe('Dr\u00f3p 1')
  })

  it.each([
    ['a control character', 'Dro\u0000p'],
    ['a line break', 'Drop\n1'],
    ['an invisible direction mark', 'Drop\u202e1'],
    ['a character that XML cannot hold', 'Drop\uffff'],
    ['a private-use character', 'Drop\ue000'],
    ['only a symbol that shows nothing', '\u3164'],
    ['only punctuation', '---']
  ])('refuses a hot cue name with %s', (_name, name) => {
    // Arrange
    const hotCues = DEFAULT_SETTINGS.hotCues.map((cue, index) =>
      index === 0 ? { ...cue, name } : cue
    )

    // Act
    const result = updateSettings(testDatabase.db, { hotCues }, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
})

describe('setFolder', () => {
  it('stores the library root and derives the backup folder next to it', () => {
    // Arrange
    const root = makeFolder('Music')

    // Act
    const result = setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Assert
    expect(result.ok && result.value.settings.library.rootFolder).toBe(root)
    expect(result.ok && result.value.effective.backupFolder).toBe(
      join(root, '..', 'FixLibrary Backups')
    )
  })

  it('goes back to the default when a folder is cleared', () => {
    // Arrange
    const exports = makeFolder('Exports')
    setFolder(testDatabase.db, 'exportedXml', exports, environment)

    // Act
    const result = setFolder(testDatabase.db, 'exportedXml', null, environment)

    // Assert
    expect(result.ok && result.value.settings.rekordbox.exportedXmlFolder).toBeNull()
    expect(result.ok && result.value.effective.exportedXmlFolder).toBe(
      '/Users/dj/Documents/FixLibrary'
    )
  })

  it.each([
    ['a folder that does not exist', '/no/such/folder'],
    ['a relative path', 'Music'],
    ['the root of the disk', '/']
  ])('refuses %s', (_name, folder) => {
    // Act
    const result = setFolder(testDatabase.db, 'libraryRoot', folder, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('refuses a clean library folder inside the library, and the other way round', () => {
    // Arrange
    const root = makeFolder('Music')
    const inside = makeFolder('Music', 'Clean')
    const parent = makeFolder()
    setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Act
    const nested = setFolder(testDatabase.db, 'cleanLibrary', inside, environment)
    const same = setFolder(testDatabase.db, 'cleanLibrary', root, environment)
    const containing = setFolder(testDatabase.db, 'cleanLibrary', parent, environment)

    // Assert
    expect([nested.ok, same.ok, containing.ok]).toEqual([false, false, false])
    expect(
      getSettingsSnapshot(testDatabase.db, environment).settings.library.cleanLibraryFolder
    ).toBeNull()
  })

  it('refuses a clean library folder that is, or is inside, the backup folder', () => {
    // Arrange
    const root = makeFolder('Music')
    const backup = makeFolder('Backups')
    const insideBackup = makeFolder('Backups', 'Clean')
    setFolder(testDatabase.db, 'libraryRoot', root, environment)
    setFolder(testDatabase.db, 'backup', backup, environment)

    // Act
    const same = setFolder(testDatabase.db, 'cleanLibrary', backup, environment)
    const nested = setFolder(testDatabase.db, 'cleanLibrary', insideBackup, environment)

    // Assert
    expect([same.ok, nested.ok]).toEqual([false, false])
  })

  it('refuses the default backup folder as the clean library folder', () => {
    // Arrange
    const root = makeFolder('Music')
    const defaultBackup = makeFolder('FixLibrary Backups')
    setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Act
    const result = setFolder(testDatabase.db, 'cleanLibrary', defaultBackup, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('sees through a symlink that points into the library', () => {
    // Arrange
    const root = makeFolder('Music')
    makeFolder('Music', 'Clean')
    const link = join(root, '..', 'Link To Clean')
    symlinkSync(join(root, 'Clean'), link)
    setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Act
    const result = setFolder(testDatabase.db, 'cleanLibrary', link, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('sees through a different letter case, where the disk ignores case', (context) => {
    // Arrange
    const root = makeFolder('Music')
    makeFolder('Music', 'Clean')
    const otherCase = join(root, 'CLEAN')
    // On a case-sensitive disk this path is simply another, missing folder.
    if (!existsSync(otherCase)) context.skip()
    setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Act
    const result = setFolder(testDatabase.db, 'cleanLibrary', otherCase, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('refuses a library whose default backup folder is a link back into it', () => {
    // Arrange
    const root = makeFolder('Music')
    makeFolder('Music', 'Inside')
    symlinkSync(join(root, 'Inside'), join(root, '..', 'FixLibrary Backups'))

    // Act
    const result = setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('still lets folders be changed and cleared after a stored one has disappeared', () => {
    // Arrange
    const root = makeFolder('Drive', 'Music')
    const copy = makeFolder('Drive', 'Clean')
    const elsewhere = makeFolder('Elsewhere')
    setFolder(testDatabase.db, 'libraryRoot', root, environment)
    setFolder(testDatabase.db, 'cleanLibrary', copy, environment)
    // The drive is unplugged.
    rmSync(join(root, '..'), { recursive: true })

    // Act
    const snapshot = getSettingsSnapshot(testDatabase.db, environment)
    const changed = setFolder(testDatabase.db, 'cleanLibrary', elsewhere, environment)
    const cleared = setFolder(testDatabase.db, 'libraryRoot', null, environment)

    // Assert
    expect(snapshot.settings.library.rootFolder).toBe(root)
    expect(changed.ok).toBe(true)
    expect(cleared.ok && cleared.value.settings.library.rootFolder).toBeNull()
  })

  it('treats a child folder whose name starts with two dots as inside its parent', () => {
    // Arrange
    const root = makeFolder('Music')
    const oddChild = makeFolder('Music', '..clean')
    setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Act
    const result = setFolder(testDatabase.db, 'cleanLibrary', oddChild, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('stores a picked symlink as the folder it points to', () => {
    // Arrange
    const real = makeFolder('Exports')
    const link = join(real, '..', 'Exports Link')
    symlinkSync(real, link)

    // Act
    const result = setFolder(testDatabase.db, 'exportedXml', link, environment)

    // Assert
    expect(result.ok && result.value.settings.rekordbox.exportedXmlFolder).toBe(real)
  })

  it('refuses a backup folder inside the library', () => {
    // Arrange
    const root = makeFolder('Music')
    const inside = makeFolder('Music', 'Backups')
    setFolder(testDatabase.db, 'libraryRoot', root, environment)

    // Act
    const result = setFolder(testDatabase.db, 'backup', inside, environment)

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })

  it('accepts sibling folders for the library, its clean copy and its backups', () => {
    // Arrange
    const root = makeFolder('Music')
    const copy = makeFolder('Music Clean')
    const backup = makeFolder('Backups')

    // Act
    const results = [
      setFolder(testDatabase.db, 'libraryRoot', root, environment),
      setFolder(testDatabase.db, 'cleanLibrary', copy, environment),
      setFolder(testDatabase.db, 'backup', backup, environment)
    ]

    // Assert
    expect(results.map((result) => result.ok)).toEqual([true, true, true])
  })
})

describe('unsuitable library roots', () => {
  it('refuses the home folder and every folder above it as the library', () => {
    // Arrange
    const home = makeFolder('Users', 'dj')
    const local: SettingsEnvironment = { homeDir: home, cpuCount: 8 }
    const above = makeFolder('Users')

    // Act
    const results = [home, above].map((folder) =>
      setFolder(testDatabase.db, 'libraryRoot', folder, local)
    )

    // Assert
    expect(results).toEqual([
      { ok: false, code: 'LIBRARY_ROOT_UNSUITABLE' },
      { ok: false, code: 'LIBRARY_ROOT_UNSUITABLE' }
    ])
    expect(getSettingsSnapshot(testDatabase.db, local).settings.library.rootFolder).toBeNull()
  })

  it('accepts a folder inside the home folder', () => {
    // Arrange
    const home = makeFolder('Users', 'dj')
    const music = makeFolder('Users', 'dj', 'Music')

    // Act
    const result = setFolder(testDatabase.db, 'libraryRoot', music, { homeDir: home, cpuCount: 8 })

    // Assert
    expect(result.ok).toBe(true)
  })

  it('refuses /Volumes itself, but not a folder on a drive', () => {
    // Act
    const volumes = isUnsuitableLibraryRoot('/Volumes', environment)
    const drive = isUnsuitableLibraryRoot('/Volumes/DJ SSD', environment)
    const root = isUnsuitableLibraryRoot('/', environment)

    // Assert
    expect([volumes, drive, root]).toEqual([true, false, true])
  })

  it('refuses the data volume, which holds the home folder under a second path', () => {
    // Act
    const dataVolume = isUnsuitableLibraryRoot('/System/Volumes/Data', environment)
    const usersThere = isUnsuitableLibraryRoot('/System/Volumes/Data/Users', environment)

    // Assert
    expect([dataVolume, usersThere]).toEqual([true, true])
  })

  it('reports folders that came to overlap after they were chosen', () => {
    // Arrange
    const library = makeFolder('Music')
    const settings = {
      ...DEFAULT_SETTINGS,
      library: {
        ...DEFAULT_SETTINGS.library,
        rootFolder: library,
        backupFolder: join(library, 'Backups')
      }
    }

    // Act
    const overlap = libraryFoldersOverlap(settings, environment)

    // Assert
    expect(overlap).toBe(true)
  })
})

describe('styles', () => {
  const asInput = (): StyleInput[] =>
    listStyles(testDatabase.db).map(({ id, name, color, isHouse }) => ({
      id,
      name,
      color,
      isHouse
    }))

  beforeEach(() => {
    ensureDefaultStyles(testDatabase.db)
  })

  it('starts with the documented styles in order, and does not add them twice', () => {
    // Act
    ensureDefaultStyles(testDatabase.db)
    const stored = listStyles(testDatabase.db)

    // Assert
    expect(stored.map(({ name, color, isHouse }) => ({ name, color, isHouse }))).toEqual(
      DEFAULT_STYLES
    )
  })

  it('saves edits, a new style, a removal and the new order in one go', () => {
    // Arrange
    const [afro, organic, ...rest] = asInput()
    const list = [
      { ...(organic as StyleInput), color: '#000000' },
      { name: 'Deep House', color: '#111111', isHouse: true },
      ...rest
    ]

    // Act
    const result = saveStyles(testDatabase.db, list)

    // Assert
    expect(result.ok && result.value.map((style) => style.name)).toEqual([
      'Organic House',
      'Deep House',
      'Melodic House',
      'Tech House',
      'Latin House',
      'Unsorted'
    ])
    expect(result.ok && result.value[0]).toMatchObject({ id: organic?.id, color: '#000000' })
    expect(listStyles(testDatabase.db).some((style) => style.id === afro?.id)).toBe(false)
  })

  it('lets two styles swap names in one save', () => {
    // Arrange
    const [first, second, ...rest] = asInput() as [StyleInput, StyleInput, ...StyleInput[]]
    const swapped = [{ ...first, name: second.name }, { ...second, name: first.name }, ...rest]

    // Act
    const result = saveStyles(testDatabase.db, swapped)

    // Assert
    expect(result.ok && result.value.slice(0, 2).map((style) => [style.id, style.name])).toEqual([
      [first.id, second.name],
      [second.id, first.name]
    ])
  })

  it('refuses to remove a style that a track has, and keeps the whole list', () => {
    // Arrange
    const [afro, ...rest] = asInput()
    insertTracks(testDatabase.db, [
      {
        path: '/Music/a.mp3',
        originalPath: '/Music/a.mp3',
        format: 'mp3',
        primaryStyleId: afro?.id
      }
    ])
    const renamedRest = rest.map((style, index) =>
      index === 0 ? { ...style, color: '#000000' } : style
    )

    // Act
    const result = saveStyles(testDatabase.db, renamedRest)

    // Assert
    expect(result).toEqual({ ok: false, code: 'STYLE_IN_USE' })
    expect(listStyles(testDatabase.db).map((style) => style.color)).toEqual(
      DEFAULT_STYLES.map((style) => style.color)
    )
  })

  it.each([
    [
      'a list without Unsorted',
      (list: StyleInput[]) => list.filter((style) => style.name !== 'Unsorted')
    ],
    [
      'an id that does not exist',
      (list: StyleInput[]) => [{ ...(list[0] as StyleInput), id: 999 }, ...list.slice(1)]
    ],
    [
      'the same style twice',
      (list: StyleInput[]) => [{ ...(list[0] as StyleInput), name: 'Copy' }, ...list]
    ],
    [
      'Unsorted renamed and replaced by a new row of that name',
      (list: StyleInput[]) => [
        ...list.map((style) => (style.name === 'Unsorted' ? { ...style, name: 'Renamed' } : style)),
        { name: 'Unsorted', color: '#000000', isHouse: false }
      ]
    ],
    [
      'a name with an invisible character',
      (list: StyleInput[]) => [
        { ...(list[0] as StyleInput), name: 'Afro\u200bHouse' },
        ...list.slice(1)
      ]
    ],
    ['something that is not a list', () => 'styles']
  ])('refuses %s', (_name, change) => {
    // Act
    const result = saveStyles(testDatabase.db, change(asInput()))

    // Assert
    expect(result).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(listStyles(testDatabase.db)).toHaveLength(DEFAULT_STYLES.length)
  })
})

describe('the backup folder while a batch can still be undone', () => {
  const local = { homeDir: '/Users/dj', cpuCount: 8 }

  function withBackup(): void {
    const [trackId] = insertTracks(testDatabase.db, [
      { path: '/m/a.mp3', originalPath: '/m/a.mp3', format: 'mp3' }
    ])
    const batchId = createBatch(testDatabase.db, { type: 'run', mode: 'in_place', items: [] })
    setBatchStatus(testDatabase.db, batchId, 'applied')
    insertBackup(testDatabase.db, {
      batchId,
      trackId: trackId as number,
      originalPath: '/m/a.mp3',
      backupPath: '/b/1/1.mp3'
    })
  }

  it('cannot be changed', () => {
    // Arrange
    const first = makeFolder('Backups A')
    const second = makeFolder('Backups B')
    setFolder(testDatabase.db, 'backup', first, local)
    withBackup()

    // Act
    const result = setFolder(testDatabase.db, 'backup', second, local)

    // Assert
    expect(result).toEqual({ ok: false, code: 'BACKUPS_IN_USE' })
    expect(getSettingsSnapshot(testDatabase.db, local).settings.library.backupFolder).toBe(first)
  })

  it('does not move with the library either, when it is the default one next to it', () => {
    // Arrange
    const music = makeFolder('Music A')
    const other = makeFolder('Elsewhere', 'Music B')
    setFolder(testDatabase.db, 'libraryRoot', music, local)
    withBackup()

    // Act
    const result = setFolder(testDatabase.db, 'libraryRoot', other, local)

    // Assert
    expect(result).toEqual({ ok: false, code: 'BACKUPS_IN_USE' })
    expect(getSettingsSnapshot(testDatabase.db, local).settings.library.rootFolder).toBe(music)
  })

  it('can be changed once no backup is left', () => {
    // Arrange
    const first = makeFolder('Backups A')
    const second = makeFolder('Backups B')
    setFolder(testDatabase.db, 'backup', first, local)

    // Act
    const result = setFolder(testDatabase.db, 'backup', second, local)

    // Assert
    expect(result.ok).toBe(true)
  })
})

describe('the folders of the library while a batch is open', () => {
  const local = { homeDir: '/Users/dj', cpuCount: 8 }

  it.each(['computing', 'preview', 'applying'] as const)(
    'cannot change while a batch is %s',
    (status) => {
      // Arrange
      const music = makeFolder('Music A')
      const other = makeFolder('Music B')
      setFolder(testDatabase.db, 'libraryRoot', music, local)
      const batchId = createBatch(testDatabase.db, { type: 'run', mode: 'in_place', items: [] })
      setBatchStatus(testDatabase.db, batchId, status)

      // Act
      const result = setFolder(testDatabase.db, 'libraryRoot', other, local)

      // Assert
      expect(result).toEqual({ ok: false, code: 'RUN_ACTIVE' })
      expect(getSettingsSnapshot(testDatabase.db, local).settings.library.rootFolder).toBe(music)
    }
  )

  it('can change again once the batch was given up, and other folders are never held', () => {
    // Arrange
    const music = makeFolder('Music A')
    const xml = makeFolder('Xml')
    const batchId = createBatch(testDatabase.db, { type: 'run', mode: 'in_place', items: [] })
    setBatchStatus(testDatabase.db, batchId, 'preview')

    // Act
    const whileOpen = setFolder(testDatabase.db, 'generatedXml', xml, local)
    setBatchStatus(testDatabase.db, batchId, 'cancelled')
    const afterwards = setFolder(testDatabase.db, 'libraryRoot', music, local)

    // Assert
    expect(whileOpen.ok).toBe(true)
    expect(afterwards.ok).toBe(true)
  })
})
