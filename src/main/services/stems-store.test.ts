import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStemsStore } from './stems-store'

let root: string
let folder: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fixlibrary-stems-store-')))
  folder = join(root, 'stems')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the stems store', () => {
  it('makes its folder for the user alone', async () => {
    // Act
    await createStemsStore(folder).ensure(() => new Set())

    // Assert
    expect(statSync(folder).mode & 0o777).toBe(0o700)
  })

  it('removes, once, the temp files a stopped sidecar left and the envelopes of tracks that are gone', async () => {
    // Arrange
    const store = createStemsStore(folder)
    await store.ensure(() => new Set([1, 2]))
    const other = join(root, 'other.npz')
    writeFileSync(other, 'mine')
    for (const name of [
      '1.npz',
      '3.npz',
      '.3.npz.123.456.fixlib-tmp',
      'notes.txt',
      '.3.npz.x.fixlib-tmp'
    ]) {
      writeFileSync(join(folder, name), 'x')
    }
    symlinkSync(other, join(folder, '4.npz'))
    const fresh = createStemsStore(folder)

    // Act
    await fresh.ensure(() => new Set([1, 2]))
    writeFileSync(join(folder, '5.npz'), 'x')
    await fresh.ensure(() => new Set([1, 2]))

    // Assert
    expect(readdirSync(folder).sort()).toEqual([
      '.3.npz.x.fixlib-tmp',
      '1.npz',
      '4.npz',
      '5.npz',
      'notes.txt'
    ])
    expect(readdirSync(root)).toContain('other.npz')
  })

  it('tells whether the envelopes of a track are there as a plain file', async () => {
    // Arrange
    const store = createStemsStore(folder)
    await store.ensure(() => new Set([1]))
    writeFileSync(join(folder, '1.npz'), 'x')
    symlinkSync(join(folder, '1.npz'), join(folder, '2.npz'))

    // Act
    const answers = await Promise.all([store.has(1), store.has(2), store.has(3)])

    // Assert
    expect(answers).toEqual([true, false, false])
  })
})
