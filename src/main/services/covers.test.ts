import {
  chmodSync,
  mkdirSync,
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
import { createCoverStore, type CoverStore } from './covers'

const STEM = '0123456789abcdef0123456789abcdef01234567'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

let folder: string
let store: CoverStore

beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'fixlibrary-store-')))
  store = createCoverStore(join(folder, 'covers'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('the covers folder', () => {
  it('keeps what is saved under its name, whole, and gives it up again', async () => {
    // Arrange
    await store.ensure()

    // Act
    await store.save(`${STEM}.download`, 'download', JPEG)
    const kept = await store.has(`${STEM}.download`, 'download')
    await store.remove(`${STEM}.download`, 'download')
    await store.remove(`${STEM}.download`, 'download')

    // Assert
    expect(kept).toBe(true)
    expect(readdirSync(store.folder)).toEqual([])
  })

  it('takes only a name the app builds, never a path', async () => {
    // Arrange
    await store.ensure()

    // Act
    const saved = store.save('../escape.download', 'download', JPEG)

    // Assert
    await expect(saved).rejects.toThrow('not the name of a download')
    expect(readdirSync(folder)).toEqual(['covers'])
  })

  it('keeps the folder to the user alone, also one that was there before', async () => {
    // Arrange
    mkdirSync(store.folder, { mode: 0o755 })
    chmodSync(store.folder, 0o755)

    // Act
    await store.ensure()

    // Assert
    expect(statSync(store.folder).mode & 0o777).toBe(0o700)
  })

  it('shows no thumbnail larger than a thumbnail is', async () => {
    // Arrange
    await store.ensure()
    writeFileSync(
      join(store.folder, `${STEM}.thumb.jpg`),
      Buffer.concat([JPEG, Buffer.alloc(256 * 1024)])
    )

    // Act
    const shown = await store.thumbnail(`${STEM}.thumb.jpg`)

    // Assert
    expect(shown).toBeNull()
  })

  it('refuses a folder that is a link', async () => {
    // Arrange
    const elsewhere = join(folder, 'elsewhere')
    symlinkSync(folder, elsewhere)
    const linked = createCoverStore(elsewhere)

    // Act
    const ensured = linked.ensure()

    // Assert
    await expect(ensured).rejects.toThrow('not a folder')
  })

  it('gives a thumbnail as a data address, and nothing for what is no JPEG', async () => {
    // Arrange
    await store.ensure()
    writeFileSync(join(store.folder, `${STEM}.thumb.jpg`), JPEG)
    const other = 'fedcba9876543210fedcba9876543210fedcba98.thumb.jpg'
    writeFileSync(join(store.folder, other), '<svg onload="x"/>')

    // Act
    const shown = await store.thumbnail(`${STEM}.thumb.jpg`)
    const refused = await store.thumbnail(other)
    const missing = await store.thumbnail('ffffffffffffffffffffffffffffffffffffffff.thumb.jpg')
    const named = await store.thumbnail('../x.thumb.jpg')

    // Assert
    expect(shown).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`)
    expect([refused, missing, named]).toEqual([null, null, null])
  })
})
