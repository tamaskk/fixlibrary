import type * as React from 'react'

/** For a field that saves when it loses focus: Enter saves it too. */
export function commitOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') event.currentTarget.blur()
}
