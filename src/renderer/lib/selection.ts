/** The selected rows of a list, and the row a range selection starts from. */
export interface Selection {
  ids: ReadonlySet<number>
  anchor: number | null
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null }

export interface SelectModifiers {
  /** Shift: select the range from the anchor to this row. */
  range: boolean
  /** Cmd: add or remove this row, keeping the others. */
  toggle: boolean
}

/**
 * The selection after a click on `id`, as Finder and Rekordbox do it. `orderedIds`
 * is the list as it is shown, so a range follows the current sorting and filter.
 */
export function selectRow(
  selection: Selection,
  id: number,
  modifiers: SelectModifiers,
  orderedIds: readonly number[]
): Selection {
  if (modifiers.range) {
    const from = selection.anchor === null ? -1 : orderedIds.indexOf(selection.anchor)
    const to = orderedIds.indexOf(id)
    // Without a usable anchor a range is just this row.
    if (from === -1 || to === -1) return { ids: new Set([id]), anchor: id }
    const range = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1)
    // The anchor stays, so a second Shift click changes the same range.
    return {
      ids: new Set(modifiers.toggle ? [...selection.ids, ...range] : range),
      anchor: selection.anchor
    }
  }
  if (modifiers.toggle) {
    const ids = new Set(selection.ids)
    if (!ids.delete(id)) ids.add(id)
    return { ids, anchor: id }
  }
  return { ids: new Set([id]), anchor: id }
}

/** Every row that is shown. The anchor stays where it was. */
export function selectAll(selection: Selection, orderedIds: readonly number[]): Selection {
  return { ids: new Set(orderedIds), anchor: selection.anchor ?? orderedIds[0] ?? null }
}

/** Drops rows that no longer exist, after the list was loaded again. */
export function keepExisting(selection: Selection, existingIds: ReadonlySet<number>): Selection {
  const ids = new Set([...selection.ids].filter((id) => existingIds.has(id)))
  const anchor =
    selection.anchor !== null && existingIds.has(selection.anchor) ? selection.anchor : null
  return ids.size === selection.ids.size && anchor === selection.anchor
    ? selection
    : { ids, anchor }
}

/** The selected ids in the order of the list, which is the order a run processes them in. */
export function selectedInOrder(selection: Selection, orderedIds: readonly number[]): number[] {
  return orderedIds.filter((id) => selection.ids.has(id))
}
