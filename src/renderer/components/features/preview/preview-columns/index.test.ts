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
})
