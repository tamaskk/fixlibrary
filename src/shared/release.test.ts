import { describe, expect, it } from 'vitest'
import { compareVersions, updateDownloads, type ReleaseManifest } from './release'

describe('compareVersions', () => {
  it.each([
    ['0.0.2', '0.0.1', 1],
    ['v0.1.0', '0.0.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['0.9.10', '0.10.0', -1],
    ['2026.10.10', '2026.08.19', 1],
    ['2026.10.10.1', '2026.10.10', 1]
  ])('%s against %s', (a, b, sign) => {
    // Act
    const compared = Math.sign(compareVersions(a, b))

    // Assert
    expect(compared).toBe(sign)
  })
})

describe('updateDownloads', () => {
  const manifest: ReleaseManifest = {
    appVersion: '0.0.2',
    runtimeVersion: 2,
    files: [
      { name: 'FixLibrary-0.0.2-arm64.dmg', sha256: 'a'.repeat(64), size: 3 },
      { name: 'FixLibrary-0.0.2-arm64-lite.dmg', sha256: 'b'.repeat(64), size: 2 },
      { name: 'python-runtime-2.tar.gz', sha256: 'c'.repeat(64), size: 1 }
    ]
  }

  it('takes the lite DMG alone when the runtime stays, and the runtime too when it changed', () => {
    // Act
    const same = updateDownloads(manifest, 2)?.map((file) => file.name)
    const changed = updateDownloads(manifest, 1)?.map((file) => file.name)

    // Assert
    expect(same).toEqual(['FixLibrary-0.0.2-arm64-lite.dmg'])
    expect(changed).toEqual(['FixLibrary-0.0.2-arm64-lite.dmg', 'python-runtime-2.tar.gz'])
  })

  it('takes nothing from a release that lacks a file it needs', () => {
    // Act
    const missing = updateDownloads({ ...manifest, files: manifest.files.slice(0, 2) }, 1)

    // Assert
    expect(missing).toBeNull()
  })
})
