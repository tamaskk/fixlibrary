import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { KEYS } from '@shared/keys'
import type { PreviewValue } from '@shared/preview'
import type { Style } from '@shared/settings'
import type { PreviewEditor } from './preview-columns'

type CellEditorProps = {
  editor: PreviewEditor
  /** Names the field: the row and the column it stands in. */
  label: string
  value: PreviewValue
  styles: readonly Style[]
  /**
   * `byKey` is true when the user saved with a key or a choice, false when the field
   * was simply left: the focus is then already where the user put it.
   */
  onCommit: (value: PreviewValue, byKey: boolean) => void
  onCancel: (byKey: boolean) => void
}

/** What was typed for an energy: a whole number, or nothing. Anything else is left to main to refuse. */
function parseEnergy(text: string): PreviewValue {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/**
 * The field a cell of the preview turns into while it is edited. Enter and leaving
 * the field save, Escape gives up; a style is saved as soon as it is chosen.
 */
export function CellEditor({
  editor,
  label,
  value,
  styles,
  onCommit,
  onCancel
}: CellEditorProps): React.JSX.Element {
  const [text, setText] = React.useState(value === null ? '' : String(value))
  // Leaving the field saves, but not when it is left because the edit was given up
  // or already saved.
  const settled = React.useRef(false)

  function settle(action: () => void): void {
    if (settled.current) return
    settled.current = true
    action()
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      settle(() => onCancel(true))
    }
  }

  if (editor === 'style') {
    return (
      <div className="w-full">
        <Select
          label={label}
          labelHidden
          autoFocus
          className="h-7 px-1"
          value={value === null ? '' : String(value)}
          onKeyDown={handleKeyDown}
          onBlur={() => settle(() => onCancel(false))}
          onChange={(event) => {
            const chosen = event.target.value
            settle(() => onCommit(chosen === '' ? null : Number(chosen), true))
          }}
        >
          <option value="">Nincs stílus</option>
          {styles.map((style) => (
            <option key={style.id} value={style.id}>
              {style.name}
            </option>
          ))}
        </Select>
      </div>
    )
  }

  if (editor === 'key') {
    return (
      <div className="w-full">
        <Select
          label={label}
          labelHidden
          autoFocus
          className="h-7 px-1"
          value={value === null ? '' : String(value)}
          onKeyDown={handleKeyDown}
          onBlur={() => settle(() => onCancel(false))}
          onChange={(event) => {
            const chosen = event.target.value
            settle(() => onCommit(chosen === '' ? null : chosen, true))
          }}
        >
          <option value="">Nincs key</option>
          {KEYS.map((key) => (
            <option key={key.camelot} value={key.camelot}>
              {key.camelot} {key.musical}
            </option>
          ))}
        </Select>
      </div>
    )
  }

  const commit = (byKey: boolean): void =>
    settle(() => onCommit(editor === 'energy' ? parseEnergy(text) : text.trim() || null, byKey))

  return (
    <div className="w-full">
      <Input
        label={label}
        labelHidden
        autoFocus
        className="h-7 px-2"
        inputMode={editor === 'energy' ? 'numeric' : undefined}
        maxLength={editor === 'energy' ? 2 : 300}
        value={text}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => commit(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(true)
          } else {
            handleKeyDown(event)
          }
        }}
      />
    </div>
  )
}
