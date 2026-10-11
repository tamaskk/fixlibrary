import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listMountedVolumes } from './volumes'

describe('listMountedVolumes', () => {
  let root: string

  // Stands in for stat().dev: folders named here are on their own device, like a mounted drive.
  function devices(mountedNames: string[]): (path: string) => number {
    return (path) => (mountedNames.includes(basename(path)) ? 2 : 1)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fixlibrary-volumes-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('lists the mount points under the volumes root', () => {
    // Arrange
    mkdirSync(join(root, 'DJ SSD'))
    mkdirSync(join(root, 'Backup'))

    // Act
    const volumes = listMountedVolumes(root, devices(['DJ SSD', 'Backup']))

    // Assert
    expect(volumes).toEqual(new Set(['DJ SSD', 'Backup']))
  })

  it('leaves out a folder that an unclean eject left behind', () => {
    // Arrange
    mkdirSync(join(root, 'DJ SSD'))
    mkdirSync(join(root, 'Old Drive'))

    // Act
    const volumes = listMountedVolumes(root, devices(['DJ SSD']))

    // Assert
    expect(volumes).toEqual(new Set(['DJ SSD']))
  })

  it('counts the startup disk, which is a symlink, and ignores plain files', () => {
    // Arrange
    symlinkSync('/', join(root, 'Macintosh HD'))
    writeFileSync(join(root, '.DS_Store'), '')

    // Act
    const volumes = listMountedVolumes(root, devices([]))

    // Assert
    expect(volumes).toEqual(new Set(['Macintosh HD']))
  })

  it('returns a decomposed volume name composed, like stored track paths', () => {
    // Arrange
    const decomposedName = 'Zenék'.normalize('NFD')
    mkdirSync(join(root, decomposedName))

    // Act
    const volumes = listMountedVolumes(root, () => {
      // Every folder on its own device, whatever spelling the file system reports.
      return Math.random()
    })

    // Assert
    expect(volumes.has('Zenék'.normalize('NFC'))).toBe(true)
  })

  it('reports no volumes when the root does not exist', () => {
    // Arrange
    const missingRoot = join(root, 'missing')

    // Act
    const volumes = listMountedVolumes(missingRoot)

    // Assert
    expect(volumes.size).toBe(0)
  })

  it('reports no volumes, and does not throw, when the root cannot be read', () => {
    // Arrange
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const denied = (): number => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }

    // Act
    const volumes = listMountedVolumes(root, denied)

    // Assert
    expect(volumes.size).toBe(0)
    expect(logged).toHaveBeenCalledOnce()
  })
})
