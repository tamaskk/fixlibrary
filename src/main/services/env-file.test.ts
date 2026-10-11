import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readEnvFile } from './env-file'

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'fixlibrary-env-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('readEnvFile', () => {
  it('reads names and values, skipping comments and empty values', () => {
    // Arrange
    const file = join(folder, '.env.local')
    writeFileSync(
      file,
      '# a comment\nACOUSTID_API_KEY=abc123\nDISCOGS_CONSUMER_KEY="quoted value"\nEMPTY=\n'
    )

    // Act
    const values = readEnvFile(file)

    // Assert
    expect(values).toEqual({ ACOUSTID_API_KEY: 'abc123', DISCOGS_CONSUMER_KEY: 'quoted value' })
  })

  it('does not put the values into the environment of the process', () => {
    // Arrange
    const file = join(folder, '.env.local')
    writeFileSync(file, 'FIXLIB_ENV_FILE_TEST=secret\n')

    // Act
    readEnvFile(file)

    // Assert
    expect(process.env.FIXLIB_ENV_FILE_TEST).toBeUndefined()
  })

  it('is empty when the file does not exist', () => {
    // Act
    const values = readEnvFile(join(folder, 'missing.env'))

    // Assert
    expect(values).toEqual({})
  })
})
