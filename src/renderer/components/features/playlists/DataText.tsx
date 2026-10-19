import * as React from 'react'

/** A number in the Data role: mono, tabular figures. */
export function Data({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="font-mono text-data tabular-nums">{children}</span>
}
