import { describe, expect, it } from 'vitest'
import { columnsFor } from './index'

describe('columnsFor', () => {
  it('shows the cover column only for a batch that looked for covers, before the source', () => {
    // Act
    const plain = columnsFor('run').map((column) => column.id)
    const covered = columnsFor('run', { covers: true }).map((column) => column.id)

    // Assert
    expect(plain).not.toContain('cover')
    expect(covered.slice(-3)).toEqual(['energy', 'cover', 'source'])
    expect(covered.filter((id) => id !== 'cover')).toEqual(plain)
  })

  it('shows the folder column only for a batch that sorts files, right after the file name', () => {
    // Act
    const plain = columnsFor('run').map((column) => column.id)
    const both = columnsFor('run', { covers: true, folders: true }).map((column) => column.id)

    // Assert
    expect(plain).not.toContain('folder')
    expect(both.slice(both.indexOf('fileName'), both.indexOf('fileName') + 2)).toEqual([
      'fileName',
      'folder'
    ])
    expect(both.slice(-2)).toEqual(['cover', 'source'])
    expect(both.filter((id) => id !== 'folder' && id !== 'cover')).toEqual(plain)
  })

  it('shows the loudness columns only for a batch that normalizes, after the cover, before the source', () => {
    // Act
    const plain = columnsFor('run').map((column) => column.id)
    const loud = columnsFor('run', { covers: true, loudness: true })

    // Assert
    expect(loud.map((column) => column.id).slice(-8)).toEqual([
      'cover',
      'lufs',
      'gain',
      'truePeak',
      'listen',
      'normalizeMethod',
      'normalizeState',
      'source'
    ])
    // The values at every width, the method and the state where the table has room.
    expect(loud.filter((column) => column.wideOnly).map((column) => column.id)).toEqual(
      expect.arrayContaining(['normalizeMethod', 'normalizeState'])
    )
    expect(
      loud.filter(
        (column) => ['lufs', 'gain', 'truePeak', 'listen'].includes(column.id) && column.wideOnly
      )
    ).toEqual([])
    expect(plain).not.toContain('lufs')
  })
})
