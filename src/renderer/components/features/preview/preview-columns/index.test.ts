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
})
