import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  keepExisting,
  selectAll,
  selectedInOrder,
  selectRow,
  type Selection
} from './selection'

const ORDER = [10, 20, 30, 40, 50, 60]
const CLICK = { range: false, toggle: false }
const SHIFT = { range: true, toggle: false }
const CMD = { range: false, toggle: true }

function selected(selection: Selection): number[] {
  return [...selection.ids].sort((a, b) => a - b)
}

describe('selectRow', () => {
  it('selects only the clicked row on a plain click', () => {
    // Arrange
    const before = selectRow(EMPTY_SELECTION, 10, CLICK, ORDER)

    // Act
    const after = selectRow(before, 40, CLICK, ORDER)

    // Assert
    expect(selected(after)).toEqual([40])
    expect(after.anchor).toBe(40)
  })

  it('selects the range between the last click and a Shift click, in either direction', () => {
    // Arrange
    const anchored = selectRow(EMPTY_SELECTION, 40, CLICK, ORDER)

    // Act
    const down = selectRow(anchored, 60, SHIFT, ORDER)
    const up = selectRow(anchored, 20, SHIFT, ORDER)

    // Assert
    expect(selected(down)).toEqual([40, 50, 60])
    expect(selected(up)).toEqual([20, 30, 40])
  })

  it('changes the same range on a second Shift click, from the same starting row', () => {
    // Arrange
    const first = selectRow(selectRow(EMPTY_SELECTION, 30, CLICK, ORDER), 60, SHIFT, ORDER)

    // Act
    const second = selectRow(first, 10, SHIFT, ORDER)

    // Assert
    expect(selected(second)).toEqual([10, 20, 30])
  })

  it('follows the order in which the rows are shown', () => {
    // Arrange
    const sorted = [60, 10, 50, 20, 40, 30]
    const anchored = selectRow(EMPTY_SELECTION, 10, CLICK, sorted)

    // Act
    const range = selectRow(anchored, 20, SHIFT, sorted)

    // Assert
    expect(selected(range)).toEqual([10, 20, 50])
  })

  it('adds and removes single rows with Cmd', () => {
    // Arrange
    const one = selectRow(EMPTY_SELECTION, 10, CLICK, ORDER)

    // Act
    const three = selectRow(selectRow(one, 30, CMD, ORDER), 50, CMD, ORDER)
    const two = selectRow(three, 30, CMD, ORDER)

    // Assert
    expect(selected(three)).toEqual([10, 30, 50])
    expect(selected(two)).toEqual([10, 50])
  })

  it('adds a range to the selection with Cmd and Shift together', () => {
    // Arrange
    const start = selectRow(selectRow(EMPTY_SELECTION, 10, CLICK, ORDER), 40, CMD, ORDER)

    // Act
    const after = selectRow(start, 60, { range: true, toggle: true }, ORDER)

    // Assert
    expect(selected(after)).toEqual([10, 40, 50, 60])
  })

  it('selects just the row on a Shift click when nothing was clicked before', () => {
    // Act
    const after = selectRow(EMPTY_SELECTION, 30, SHIFT, ORDER)

    // Assert
    expect(selected(after)).toEqual([30])
    expect(after.anchor).toBe(30)
  })

  it('selects just the row when the starting row is filtered out', () => {
    // Arrange
    const anchored = selectRow(EMPTY_SELECTION, 20, CLICK, ORDER)

    // Act
    const after = selectRow(anchored, 50, SHIFT, [10, 30, 50])

    // Assert
    expect(selected(after)).toEqual([50])
  })
})

describe('selectAll', () => {
  it('selects every row that is shown', () => {
    // Act
    const all = selectAll(EMPTY_SELECTION, ORDER)

    // Assert
    expect(selected(all)).toEqual(ORDER)
  })

  it('selects 20 rows with a click and a Shift click, and counts 20', () => {
    // Arrange
    const order = Array.from({ length: 3000 }, (_, index) => index + 1)

    // Act
    const range = selectRow(selectRow(EMPTY_SELECTION, 101, CLICK, order), 120, SHIFT, order)

    // Assert
    expect(range.ids.size).toBe(20)
  })
})

describe('keepExisting', () => {
  it('drops rows that are gone and keeps the rest', () => {
    // Arrange
    const selection: Selection = { ids: new Set([10, 20, 30]), anchor: 20 }

    // Act
    const kept = keepExisting(selection, new Set([10, 30, 40]))

    // Assert
    expect(selected(kept)).toEqual([10, 30])
    expect(kept.anchor).toBeNull()
  })

  it('returns the same selection when nothing is gone', () => {
    // Arrange
    const selection: Selection = { ids: new Set([10, 20]), anchor: 20 }

    // Act
    const kept = keepExisting(selection, new Set(ORDER))

    // Assert
    expect(kept).toBe(selection)
  })
})

describe('selectedInOrder', () => {
  it('lists the selected rows in the order of the list', () => {
    // Arrange
    const selection: Selection = { ids: new Set([50, 10, 30]), anchor: 50 }

    // Act
    const ids = selectedInOrder(selection, [30, 20, 50, 10])

    // Assert
    expect(ids).toEqual([30, 50, 10])
  })
})
